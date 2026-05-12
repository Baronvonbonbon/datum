// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumChallengeBonds.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DatumChallengeBonds
/// @notice FP-2: Optional advertiser challenge bonds.
///
///         Advertisers may lock a DOT bond when creating a campaign. On normal
///         campaign end (complete or expire), the bond is returned. If publisher
///         fraud is upheld by PublisherGovernance, a fraction of the slash
///         proceeds flows into that publisher's bonus pool. Bonded advertisers
///         can then claimBonus(), receiving bond * bonusPool / totalBonds
///         (proportional share of the pool, capped to pool balance).
///
///         When claimBonus() is called the bond is burned (not returned) — the
///         advertiser receives only the bonus.
///
///         lockBond  — called by DatumCampaigns on creation (msg.value = bond)
///         returnBond — called by DatumCampaignLifecycle on complete/expire
///         addToPool  — called by DatumPublisherGovernance on fraud resolution
///         claimBonus — called by advertiser directly
contract DatumChallengeBonds is IDatumChallengeBonds, PaseoSafeSender, DatumOwnable {

    /// @notice Campaigns contract — authorised to call lockBond.
    address public campaignsContract;

    /// @notice Lifecycle contract — authorised to call returnBond.
    address public lifecycleContract;

    /// @notice PublisherGovernance — authorised to call addToPool.
    address public governanceContract;

    // ── State ──────────────────────────────────────────────────────────────────

    mapping(uint256 => address) private _bondOwner;
    mapping(uint256 => uint256) private _bond;
    mapping(uint256 => address) private _bondPublisher;

    mapping(address => uint256) private _totalBonds;
    mapping(address => uint256) private _bonusPool;
    mapping(uint256 => bool)    private _bonusClaimed;

    /// @dev M-1: Pull-pattern queue for bond returns. returnBond records here
    ///      so a contract advertiser with a reverting fallback cannot DoS Lifecycle.
    mapping(address => uint256) public pendingBondReturn;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor() DatumOwnable() {}

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setCampaignsContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaignsContract = addr;
    }

    function setLifecycleContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        lifecycleContract = addr;
    }

    function setGovernanceContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        governanceContract = addr;
    }

    receive() external payable { revert("E03"); }

    // ── Core actions ───────────────────────────────────────────────────────────

    /// @inheritdoc IDatumChallengeBonds
    function lockBond(uint256 campaignId, address advertiser, address publisher) external payable {
        require(msg.sender == campaignsContract, "E18");
        require(msg.value > 0, "E11");
        require(_bond[campaignId] == 0, "E71"); // already bonded

        _bondOwner[campaignId] = advertiser;
        _bond[campaignId] = msg.value;
        _bondPublisher[campaignId] = publisher;
        _totalBonds[publisher] += msg.value;

        emit BondLocked(campaignId, advertiser, publisher, msg.value);
    }

    /// @inheritdoc IDatumChallengeBonds
    /// @dev M-1: Records return into `pendingBondReturn[advertiser]` instead of
    ///      pushing native DOT. Advertiser pulls via claimBondReturn[To].
    function returnBond(uint256 campaignId) external nonReentrant {
        require(msg.sender == lifecycleContract, "E18");
        uint256 amount = _bond[campaignId];
        if (amount == 0) return; // no bond — silently skip (optional bond)

        address advertiser = _bondOwner[campaignId];
        address publisher  = _bondPublisher[campaignId];

        // Clear bond state before queueing the refund
        _bond[campaignId] = 0;
        _bondOwner[campaignId] = address(0);
        _bondPublisher[campaignId] = address(0);
        if (_totalBonds[publisher] >= amount) {
            _totalBonds[publisher] -= amount;
        } else {
            _totalBonds[publisher] = 0;
        }

        pendingBondReturn[advertiser] += amount;
        emit BondReturned(campaignId, advertiser, amount);
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
    function claimBonus(uint256 campaignId) external nonReentrant {
        _claimBonus(campaignId, msg.sender);
    }

    /// @notice M-1 cold-wallet variant: claim bonus to a chosen recipient.
    ///         Only the bond owner (msg.sender) can call.
    function claimBonusTo(uint256 campaignId, address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claimBonus(campaignId, recipient);
    }

    function _claimBonus(uint256 campaignId, address recipient) internal {
        require(!_bonusClaimed[campaignId], "E72"); // already claimed
        uint256 bondAmt = _bond[campaignId];
        require(bondAmt > 0, "E01"); // no bond
        address advertiser = _bondOwner[campaignId];
        require(msg.sender == advertiser, "E18");
        address publisher = _bondPublisher[campaignId];

        uint256 total = _totalBonds[publisher];
        uint256 pool  = _bonusPool[publisher];
        require(pool > 0, "E03"); // no bonus pool yet

        // AUDIT-013: Use proportional share calculation; cap to pool balance
        uint256 share = (bondAmt * pool) / total;
        if (share > pool) share = pool;

        // Mark claimed and burn the bond (bond is NOT returned)
        _bonusClaimed[campaignId] = true;
        _bond[campaignId] = 0;
        _bondOwner[campaignId] = address(0);
        _bondPublisher[campaignId] = address(0);
        if (_totalBonds[publisher] >= bondAmt) {
            _totalBonds[publisher] -= bondAmt;
        } else {
            _totalBonds[publisher] = 0;
        }

        _bonusPool[publisher] -= share;

        emit BonusClaimed(campaignId, advertiser, share);
        _safeSend(recipient, share);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function bondOwner(uint256 campaignId) external view returns (address) {
        return _bondOwner[campaignId];
    }

    function bond(uint256 campaignId) external view returns (uint256) {
        return _bond[campaignId];
    }

    function bondPublisher(uint256 campaignId) external view returns (address) {
        return _bondPublisher[campaignId];
    }

    function totalBonds(address publisher) external view returns (uint256) {
        return _totalBonds[publisher];
    }

    function bonusPool(address publisher) external view returns (uint256) {
        return _bonusPool[publisher];
    }

    function bonusClaimed(uint256 campaignId) external view returns (bool) {
        return _bonusClaimed[campaignId];
    }
}
