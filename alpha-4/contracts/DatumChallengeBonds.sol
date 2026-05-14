// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumChallengeBonds.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DatumChallengeBonds
/// @notice FP-2: Optional advertiser challenge bonds.
///
///         **Per-publisher bonds (multi-publisher campaign support).**
///         A single campaign may have multiple allowlisted publishers (see
///         DatumCampaigns), and the advertiser may post an independent bond
///         per (campaign, publisher) pair. Each bond is associated with the
///         specific publisher's bonus pool; fraud upheld against one publisher
///         in the set only affects that publisher's bond claims.
///
///         The single-publisher case (legacy "closed" campaign) is just the
///         degenerate case where one (campaign, publisher) pair is bonded.
///
///         lockBond   — called by DatumCampaigns on creation OR when adding a
///                      publisher to the allowlist mid-campaign with a bond.
///         returnBond — called by DatumCampaignLifecycle on complete/expire;
///                      iterates all bonded publishers for the campaign.
///         addToPool  — called by DatumPublisherGovernance on fraud resolution;
///                      per-publisher (unchanged).
///         claimBonus — called by advertiser per-(campaign, publisher).
contract DatumChallengeBonds is IDatumChallengeBonds, PaseoSafeSender, DatumOwnable {

    /// @notice Campaigns contract — authorised to call lockBond.
    address public campaignsContract;

    /// @notice Lifecycle contract — authorised to call returnBond.
    address public lifecycleContract;

    /// @notice PublisherGovernance — authorised to call addToPool.
    address public governanceContract;

    /// @notice Per-campaign max distinct publishers that may be bonded.
    ///         Caps the gas cost of returnBond iteration. Governance must
    ///         keep this ≥ DatumCampaigns.maxAllowedPublishers (same proposal)
    ///         so addAllowedPublisher with a bond can't exceed this limit.
    uint256 public constant MAX_BONDED_PUBLISHERS_CEILING = 256;
    uint256 public maxBondedPublishers = 64; // was hard-coded 32
    event MaxBondedPublishersSet(uint256 value);
    function setMaxBondedPublishers(uint256 v) external onlyOwner {
        require(v > 0 && v <= MAX_BONDED_PUBLISHERS_CEILING, "E11");
        maxBondedPublishers = v;
        emit MaxBondedPublishersSet(v);
    }

    // ── State ──────────────────────────────────────────────────────────────────

    // Per-(campaign, publisher) bond storage.
    mapping(uint256 => mapping(address => uint256)) private _bond;
    mapping(uint256 => mapping(address => address)) private _bondOwner;
    mapping(uint256 => mapping(address => bool))    private _bonusClaimed;

    // Per-campaign enumeration of bonded publishers, for returnBond iteration.
    mapping(uint256 => address[]) private _bondedPublishers;
    mapping(uint256 => mapping(address => bool)) private _isBondedPublisher;

    mapping(address => uint256) private _totalBonds;
    mapping(address => uint256) private _bonusPool;

    /// @dev M-1: Pull-pattern queue for bond returns. returnBond records here
    ///      so a contract advertiser with a reverting fallback cannot DoS Lifecycle.
    mapping(address => uint256) public pendingBondReturn;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor() DatumOwnable() {}

    // ── Admin ──────────────────────────────────────────────────────────────────

    /// @dev Cypherpunk lock-once: ChallengeBonds holds advertiser DOT.
    function setCampaignsContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(campaignsContract == address(0), "already set");
        campaignsContract = addr;
    }

    function setLifecycleContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(lifecycleContract == address(0), "already set");
        lifecycleContract = addr;
    }

    function setGovernanceContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(governanceContract == address(0), "already set");
        governanceContract = addr;
    }

    receive() external payable { revert("E03"); }

    // ── Core actions ───────────────────────────────────────────────────────────

    /// @inheritdoc IDatumChallengeBonds
    /// @dev Per-publisher: multiple lockBond calls allowed for distinct
    ///      publishers on the same campaign. Reverts if (campaignId, publisher)
    ///      is already bonded.
    function lockBond(uint256 campaignId, address advertiser, address publisher) external payable {
        require(msg.sender == campaignsContract, "E18");
        require(msg.value > 0, "E11");
        require(publisher != address(0), "E00");
        require(_bond[campaignId][publisher] == 0, "E71"); // already bonded for this pair
        require(_bondedPublishers[campaignId].length < maxBondedPublishers, "E11");

        _bondOwner[campaignId][publisher] = advertiser;
        _bond[campaignId][publisher] = msg.value;
        _totalBonds[publisher] += msg.value;

        if (!_isBondedPublisher[campaignId][publisher]) {
            _isBondedPublisher[campaignId][publisher] = true;
            _bondedPublishers[campaignId].push(publisher);
        }

        emit BondLocked(campaignId, advertiser, publisher, msg.value);
    }

    /// @inheritdoc IDatumChallengeBonds
    /// @dev M-1: Records returns into `pendingBondReturn` instead of pushing.
    ///      Multi-publisher: iterates the bonded set and returns each
    ///      unclaimed bond to the corresponding advertiser pull-queue.
    function returnBond(uint256 campaignId) external nonReentrant {
        require(msg.sender == lifecycleContract, "E18");
        address[] storage publishers = _bondedPublishers[campaignId];
        uint256 n = publishers.length;
        for (uint256 i = 0; i < n; i++) {
            address publisher = publishers[i];
            uint256 amount = _bond[campaignId][publisher];
            if (amount == 0) continue;       // already claimed as bonus
            if (_bonusClaimed[campaignId][publisher]) continue;

            address advertiser = _bondOwner[campaignId][publisher];

            // Clear state before queueing the refund.
            _bond[campaignId][publisher] = 0;
            _bondOwner[campaignId][publisher] = address(0);
            if (_totalBonds[publisher] >= amount) {
                _totalBonds[publisher] -= amount;
            } else {
                _totalBonds[publisher] = 0;
            }

            pendingBondReturn[advertiser] += amount;
            emit BondReturned(campaignId, advertiser, amount);
        }
    }

    /// @notice M-1: Pull a queued bond return to msg.sender.
    function claimBondReturn() external nonReentrant {
        _claimBondReturn(msg.sender);
    }

    /// @notice M-1: Pull a queued bond return to a chosen recipient (cold wallet).
    function claimBondReturnTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claimBondReturn(recipient);
    }

    function _claimBondReturn(address recipient) internal {
        uint256 amount = pendingBondReturn[msg.sender];
        require(amount > 0, "E03");
        pendingBondReturn[msg.sender] = 0;
        emit BondReturnClaimed(msg.sender, recipient, amount);
        _safeSend(recipient, amount);
    }

    /// @inheritdoc IDatumChallengeBonds
    function addToPool(address publisher) external payable {
        require(msg.sender == governanceContract, "E18");
        require(msg.value > 0, "E11");
        _bonusPool[publisher] += msg.value;
        emit BonusAdded(publisher, msg.value, _bonusPool[publisher]);
    }

    /// @inheritdoc IDatumChallengeBonds
    /// @dev Legacy single-publisher claimBonus. Resolves the publisher from the
    ///      campaign's bonded set:
    ///        - 0 bonded publishers → preserve legacy E01 (no bond).
    ///        - 1 bonded publisher  → claim against that pair (may E72 if
    ///                                  already claimed).
    ///        - 2+ bonded publishers → "ambiguous"; caller must use the
    ///                                  per-publisher claim variant.
    function claimBonus(uint256 campaignId) external nonReentrant {
        address publisher = _resolveLegacyPublisher(campaignId);
        _claimBonus(campaignId, publisher, msg.sender);
    }

    /// @notice M-1 cold-wallet variant.
    function claimBonusTo(uint256 campaignId, address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        address publisher = _resolveLegacyPublisher(campaignId);
        _claimBonus(campaignId, publisher, recipient);
    }

    /// @dev Legacy resolver. Reverts E01 when no bonds exist (preserving
    ///      legacy semantics). Reverts "ambiguous" only when >1 distinct
    ///      bonded publishers exist for the campaign.
    function _resolveLegacyPublisher(uint256 campaignId) internal view returns (address) {
        address[] storage pubs = _bondedPublishers[campaignId];
        if (pubs.length == 0) revert("E01"); // no bond ever existed
        if (pubs.length == 1) return pubs[0];
        // >1 — must be ambiguous OR all-but-one already claimed.
        address found = address(0);
        for (uint256 i = 0; i < pubs.length; i++) {
            address p = pubs[i];
            // Consider any non-claimed slot, OR the currently-claimed slot
            // (so a double-claim attempt resolves to that slot and surfaces E72).
            if (!_bonusClaimed[campaignId][p]) {
                if (_bond[campaignId][p] > 0) {
                    if (found != address(0)) revert("ambiguous");
                    found = p;
                }
            } else {
                // claimed entry — fall back to it if it's the only one
                if (found == address(0)) found = p;
            }
        }
        return found == address(0) ? pubs[0] : found;
    }

    /// @notice Per-publisher claim — required for multi-publisher campaigns
    ///         where multiple bonds are locked.
    function claimBonusForPublisher(uint256 campaignId, address publisher) external nonReentrant {
        _claimBonus(campaignId, publisher, msg.sender);
    }

    /// @notice Per-publisher cold-wallet variant.
    function claimBonusForPublisherTo(uint256 campaignId, address publisher, address recipient)
        external nonReentrant
    {
        require(recipient != address(0), "E00");
        _claimBonus(campaignId, publisher, recipient);
    }

    function _claimBonus(uint256 campaignId, address publisher, address recipient) internal {
        require(!_bonusClaimed[campaignId][publisher], "E72");
        uint256 bondAmt = _bond[campaignId][publisher];
        require(bondAmt > 0, "E01");
        address advertiser = _bondOwner[campaignId][publisher];
        require(msg.sender == advertiser, "E18");

        uint256 total = _totalBonds[publisher];
        uint256 pool  = _bonusPool[publisher];
        require(pool > 0, "E03");

        // AUDIT-013: Use proportional share calculation; cap to pool balance.
        uint256 share = (bondAmt * pool) / total;
        if (share > pool) share = pool;

        // Mark claimed and burn the bond (bond is NOT returned).
        _bonusClaimed[campaignId][publisher] = true;
        _bond[campaignId][publisher] = 0;
        _bondOwner[campaignId][publisher] = address(0);
        if (_totalBonds[publisher] >= bondAmt) {
            _totalBonds[publisher] -= bondAmt;
        } else {
            _totalBonds[publisher] = 0;
        }

        _bonusPool[publisher] -= share;

        emit BonusClaimed(campaignId, advertiser, share);
        _safeSend(recipient, share);
    }

    /// @dev Returns the publisher iff exactly one publisher is bonded on this
    ///      campaign and that bond is still active; otherwise returns address(0).
    function _singleBondedPublisher(uint256 campaignId) internal view returns (address) {
        address[] storage pubs = _bondedPublishers[campaignId];
        address found = address(0);
        for (uint256 i = 0; i < pubs.length; i++) {
            address p = pubs[i];
            if (_bond[campaignId][p] > 0) {
                if (found != address(0)) return address(0); // ambiguous
                found = p;
            }
        }
        return found;
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    /// @dev Legacy view: returns the owner of the single bond if exactly one
    ///      bond is active on this campaign. Returns address(0) if ambiguous
    ///      or none. For multi-publisher campaigns, callers should use
    ///      `bondOwnerForPublisher`.
    function bondOwner(uint256 campaignId) external view returns (address) {
        address publisher = _singleBondedPublisher(campaignId);
        if (publisher == address(0)) return address(0);
        return _bondOwner[campaignId][publisher];
    }

    /// @dev Legacy view: returns the amount of the single bond if exactly
    ///      one bond is active. Returns 0 if ambiguous or none.
    function bond(uint256 campaignId) external view returns (uint256) {
        address publisher = _singleBondedPublisher(campaignId);
        if (publisher == address(0)) return 0;
        return _bond[campaignId][publisher];
    }

    /// @dev Legacy view: returns the publisher if exactly one bond is active.
    function bondPublisher(uint256 campaignId) external view returns (address) {
        return _singleBondedPublisher(campaignId);
    }

    /// @notice Per-publisher views.
    function bondForPublisher(uint256 campaignId, address publisher) external view returns (uint256) {
        return _bond[campaignId][publisher];
    }

    function bondOwnerForPublisher(uint256 campaignId, address publisher) external view returns (address) {
        return _bondOwner[campaignId][publisher];
    }

    function bonusClaimedForPublisher(uint256 campaignId, address publisher) external view returns (bool) {
        return _bonusClaimed[campaignId][publisher];
    }

    function bondedPublishers(uint256 campaignId) external view returns (address[] memory) {
        return _bondedPublishers[campaignId];
    }

    function totalBonds(address publisher) external view returns (uint256) {
        return _totalBonds[publisher];
    }

    function bonusPool(address publisher) external view returns (uint256) {
        return _bonusPool[publisher];
    }

    /// @dev Legacy view: claimed status of the single-publisher bond.
    function bonusClaimed(uint256 campaignId) external view returns (bool) {
        address publisher = _singleBondedPublisher(campaignId);
        if (publisher == address(0)) {
            // Either ambiguous or no active bonds — check any historical claim.
            address[] storage pubs = _bondedPublishers[campaignId];
            for (uint256 i = 0; i < pubs.length; i++) {
                if (_bonusClaimed[campaignId][pubs[i]]) return true;
            }
            return false;
        }
        return _bonusClaimed[campaignId][publisher];
    }
}
