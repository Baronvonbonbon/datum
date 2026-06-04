// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaignCreative.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title  DatumCampaignCreative
/// @notice Unified per-campaign creative-mapping sidecar. Owns both the
///         legacy IPFS metadata hash and the Polkadot Bulletin Chain
///         reference for every campaign. Carved out of DatumCampaigns
///         for EIP-170; creative storage is fully orthogonal to the
///         campaign hot path (no settlement / validation / governance
///         flow reads creative data), so this module owns 100% of the
///         state and DatumCampaigns no longer references it.
///
/// @dev    Frontends consult this module by campaignId and prefer the
///         Bulletin Chain reference when set, falling back to the legacy
///         IPFS metadata hash otherwise.
///
///         Authorization comes from a read against DatumCampaigns:
///         `campaigns.getCampaignAdvertiser(id)` for advertiser-only
///         setters, and `campaigns.getCampaignStatus(id)` for the
///         cooldown logic on non-Pending creative updates.
contract DatumCampaignCreative is
    IDatumCampaignCreative,
    DatumUpgradable,
    PaseoSafeSender
{
    function version() public pure virtual override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────

    IDatumCampaigns public campaigns;
    IDatumPauseRegistry public pauseRegistry;
    bool public plumbingLocked;

    // ─────────────────────────────────────────────────────────────────────
    // Constants (mirror values that previously lived in DatumCampaigns)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Cap on per-renewal expiry advancement. Bulletin Chain
    ///         retention is ~2 weeks on Paseo; the bound prevents a single
    ///         fraudulent confirmation from claiming a year of retention.
    uint64 public constant MAX_RETENTION_ADVANCE_BLOCKS = 220_000; // ~15.3d @ 6s

    /// @notice Lead time before expiry for `requestBulletinRenewal` to fire.
    uint64 public constant BULLETIN_RENEWAL_LEAD_BLOCKS = 14_400; // ~1d @ 6s

    /// @notice Owner-tunable renewer-reward cap.
    uint256 public constant MAX_BULLETIN_RENEWER_REWARD = 10 * 10**10; // 10 DOT

    /// @notice Inter-update cooldown for non-Pending campaigns. Mirrors the
    ///         METADATA_COOLDOWN_BLOCKS on DatumCampaigns.setMetadata so
    ///         creative re-uploads can't be used to censor live impressions.
    uint256 public constant METADATA_COOLDOWN_BLOCKS = 14_400; // ~24h @ 6s

    // ─────────────────────────────────────────────────────────────────────
    // Parameters
    // ─────────────────────────────────────────────────────────────────────

    /// @notice DOT reward paid per confirmed non-advertiser renewal.
    uint256 public bulletinRenewerReward = 10**8; // 0.01 DOT default

    // ─────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────

    mapping(uint256 => BulletinRef) internal _ref;

    /// @notice Per-campaign DOT escrow for renewer reimbursement.
    mapping(uint256 => uint256) public bulletinRenewalEscrow;

    /// @notice Per-campaign renewer allowlist (advertiser-curated).
    mapping(uint256 => mapping(address => bool)) public approvedBulletinRenewer;

    /// @notice Fully-open renewal flag (advertiser opts in).
    mapping(uint256 => bool) public openBulletinRenewal;

    // ── Legacy IPFS metadata path (formerly Campaign.metadata + helpers) ──

    /// @notice Per-campaign IPFS metadata hash (multihash digest).
    ///         Frontends use this when no Bulletin reference is set.
    mapping(uint256 => bytes32) public campaignMetadata;

    /// @notice Mid-flight creative-swap counter for off-chain publishers.
    ///         Bumps on every successful `setMetadata`.
    mapping(uint256 => uint64) public campaignMetadataVersion;

    /// @notice Block of the most recent `setMetadata` call for a campaign.
    ///         Drives the cooldown gate on non-Pending status updates.
    mapping(uint256 => uint256) public campaignMetadataLastSetBlock;

    // ── Enumeration for upgrade migration (holds bulletin-renewal escrow) ──
    uint256[] private _creativeCampaigns;
    mapping(uint256 => bool) private _creativeTracked;
    mapping(uint256 => address[]) private _renewerList;
    mapping(uint256 => mapping(address => bool)) private _renewerTracked;
    bool public fundsMigratedOut;
    event FundsMigratedOut(address indexed successor, uint256 amount);

    function _trackCreative(uint256 cid) internal {
        if (!_creativeTracked[cid]) { _creativeTracked[cid] = true; _creativeCampaigns.push(cid); }
    }
    function _trackRenewer(uint256 cid, address r) internal {
        if (!_renewerTracked[cid][r]) { _renewerTracked[cid][r] = true; _renewerList[cid].push(r); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event BulletinCreativeSet(
        uint256 indexed campaignId,
        bytes32 indexed cidDigest,
        uint8 codec,
        uint32 bulletinBlock,
        uint32 bulletinIndex,
        uint64 expiryHubBlock,
        uint64 retentionHorizonBlock,
        uint32 version
    );
    event BulletinCreativeRenewed(
        uint256 indexed campaignId,
        address indexed renewer,
        uint32 newBlock,
        uint32 newIndex,
        uint64 newExpiryHubBlock,
        uint32 version
    );
    event BulletinRenewalDue(uint256 indexed campaignId, uint64 expiryHubBlock, uint256 escrowBalance);
    event BulletinRenewalEscrowFunded(uint256 indexed campaignId, address indexed funder, uint256 amount, uint256 totalEscrow);
    event BulletinRenewalEscrowWithdrawn(uint256 indexed campaignId, address indexed recipient, uint256 amount);
    event BulletinRenewerAuthorized(uint256 indexed campaignId, address indexed renewer, bool authorized);
    event BulletinRenewalModeChanged(uint256 indexed campaignId, bool open);
    event BulletinRenewerRewardUpdated(uint256 oldReward, uint256 newReward);
    event BulletinCreativeExpired(uint256 indexed campaignId);
    event CampaignMetadataSet(uint256 indexed campaignId, bytes32 metadataHash, uint64 version);
    event CampaignsSet(address indexed campaigns);
    event PauseRegistrySet(address indexed registry);
    event PlumbingLocked();

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error E00();
    error E01();
    error E11();
    error E18();
    error E21();
    error E22();
    error AboveCap();
    error Paused();
    error LockedAlready();

    // ─────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (address(pauseRegistry) != address(0) && pauseRegistry.paused()) revert Paused();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wiring setters
    // ─────────────────────────────────────────────────────────────────────

    function setCampaigns(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        campaigns = IDatumCampaigns(addr);
        emit CampaignsSet(addr);
    }

    function setPauseRegistry(address addr) external onlyOwner {
        if (plumbingLocked) revert LockedAlready();
        if (addr == address(0)) revert E00();
        pauseRegistry = IDatumPauseRegistry(addr);
        emit PauseRegistrySet(addr);
    }

    function lockPlumbing() external onlyOwner whenOpenGovPhase {
        if (plumbingLocked) revert LockedAlready();
        if (address(campaigns) == address(0)) revert E00();
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Renewer reward (owner-tunable, bounded)
    // ─────────────────────────────────────────────────────────────────────

    function setBulletinRenewerReward(uint256 newReward) external onlyOwner whenNotFrozen {
        if (newReward > MAX_BULLETIN_RENEWER_REWARD) revert AboveCap();
        uint256 old = bulletinRenewerReward;
        bulletinRenewerReward = newReward;
        emit BulletinRenewerRewardUpdated(old, newReward);
    }

    // ─────────────────────────────────────────────────────────────────────
    // IPFS metadata (advertiser-only)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Set the legacy IPFS metadata hash for a campaign.
    ///         Advertiser-only. Mirrors the historic `setMetadata` semantics:
    ///         - while Pending: free re-uploads
    ///         - while Active/Paused: subject to METADATA_COOLDOWN_BLOCKS
    ///         - bumps a per-campaign version counter on every successful call
    /// @dev    A14-note: intentionally NO global pause gate. Advertisers
    ///         retain the ability to update creative metadata during a pause
    ///         -- pause is for blocking settlement, not state.
    function setMetadata(uint256 campaignId, bytes32 metadataHash) external whenNotFrozen {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();

        // Cooldown applies once the campaign is visible to publishers.
        if (campaigns.getCampaignStatus(campaignId) != IDatumCampaigns.CampaignStatus.Pending) {
            uint256 last = campaignMetadataLastSetBlock[campaignId];
            if (!(last == 0 || block.number >= last + METADATA_COOLDOWN_BLOCKS)) revert E22();
        }
        campaignMetadata[campaignId] = metadataHash;
        campaignMetadataLastSetBlock[campaignId] = block.number;
        uint64 v = campaignMetadataVersion[campaignId] + 1;
        campaignMetadataVersion[campaignId] = v;
        _trackCreative(campaignId);
        emit CampaignMetadataSet(campaignId, metadataHash, v);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Advertiser-only creative setters
    // ─────────────────────────────────────────────────────────────────────

    function setBulletinCreative(
        uint256 campaignId,
        bytes32 cidDigest,
        uint8   cidCodec,
        uint32  bulletinBlock,
        uint32  bulletinIndex,
        uint64  retentionHorizonBlock
    ) external whenNotFrozen whenNotPaused {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        if (cidDigest == bytes32(0)) revert E00();
        if (bulletinBlock == 0) revert E11();
        if (retentionHorizonBlock <= block.number) revert E11();

        BulletinRef storage br = _ref[campaignId];

        // Cooldown only applies to subsequent updates on a non-Pending campaign.
        // Status read piggybacks on the Campaigns interface to keep this
        // module's storage bulletin-only.
        if (br.cidDigest != bytes32(0)) {
            IDatumCampaigns.CampaignStatus st = campaigns.getCampaignStatus(campaignId);
            if (st != IDatumCampaigns.CampaignStatus.Pending) {
                uint64 lastSet = br.expiryHubBlock > MAX_RETENTION_ADVANCE_BLOCKS
                    ? br.expiryHubBlock - MAX_RETENTION_ADVANCE_BLOCKS
                    : 0;
                if (block.number < lastSet + METADATA_COOLDOWN_BLOCKS) revert E22();
            }
        }

        uint64 expiry = uint64(block.number) + MAX_RETENTION_ADVANCE_BLOCKS;

        br.cidDigest = cidDigest;
        br.cidCodec = cidCodec;
        br.bulletinBlock = bulletinBlock;
        br.bulletinIndex = bulletinIndex;
        br.expiryHubBlock = expiry;
        br.retentionHorizonBlock = retentionHorizonBlock;
        br.version += 1;
        _trackCreative(campaignId);

        emit BulletinCreativeSet(
            campaignId, cidDigest, cidCodec, bulletinBlock, bulletinIndex,
            expiry, retentionHorizonBlock, br.version
        );
    }

    function confirmBulletinRenewal(
        uint256 campaignId,
        uint32  newBulletinBlock,
        uint32  newBulletinIndex
    ) external nonReentrant whenNotFrozen whenNotPaused {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        BulletinRef storage br = _ref[campaignId];
        if (br.cidDigest == bytes32(0)) revert E01();

        bool isAdvertiser = (msg.sender == advertiser);
        if (!isAdvertiser) {
            if (!(openBulletinRenewal[campaignId] || approvedBulletinRenewer[campaignId][msg.sender])) revert E18();
        }

        if (newBulletinBlock <= br.bulletinBlock) revert E11();
        if (newBulletinBlock == 0) revert E11();

        uint64 newExpiry = uint64(block.number) + MAX_RETENTION_ADVANCE_BLOCKS;

        br.bulletinBlock = newBulletinBlock;
        br.bulletinIndex = newBulletinIndex;
        br.expiryHubBlock = newExpiry;
        br.version += 1;

        if (!isAdvertiser) {
            uint256 reward = bulletinRenewerReward;
            uint256 escrow = bulletinRenewalEscrow[campaignId];
            if (reward > 0 && escrow >= reward) {
                bulletinRenewalEscrow[campaignId] = escrow - reward;
                _safeSend(msg.sender, reward);
            }
        }

        emit BulletinCreativeRenewed(
            campaignId, msg.sender, newBulletinBlock, newBulletinIndex, newExpiry, br.version
        );
    }

    function requestBulletinRenewal(uint256 campaignId) external whenNotFrozen whenNotPaused {
        BulletinRef storage br = _ref[campaignId];
        if (br.cidDigest == bytes32(0)) revert E01();
        if (!(br.expiryHubBlock > block.number && br.expiryHubBlock - block.number <= BULLETIN_RENEWAL_LEAD_BLOCKS)) revert E22();
        emit BulletinRenewalDue(campaignId, br.expiryHubBlock, bulletinRenewalEscrow[campaignId]);
    }

    function markBulletinExpired(uint256 campaignId) external whenNotFrozen whenNotPaused {
        BulletinRef storage br = _ref[campaignId];
        if (br.cidDigest == bytes32(0)) revert E01();
        if (block.number < br.expiryHubBlock) revert E22();
        br.cidDigest = bytes32(0);
        emit BulletinCreativeExpired(campaignId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Renewal escrow
    // ─────────────────────────────────────────────────────────────────────

    function fundBulletinRenewalEscrow(uint256 campaignId) external payable whenNotFrozen whenNotPaused {
        if (campaigns.getCampaignAdvertiser(campaignId) == address(0)) revert E01();
        if (msg.value == 0) revert E11();
        bulletinRenewalEscrow[campaignId] += msg.value;
        _trackCreative(campaignId);
        emit BulletinRenewalEscrowFunded(
            campaignId, msg.sender, msg.value, bulletinRenewalEscrow[campaignId]
        );
    }

    function withdrawBulletinRenewalEscrow(uint256 campaignId, address recipient, uint256 amount)
        external
        nonReentrant
        whenNotFrozen
        whenNotPaused
    {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        if (recipient == address(0)) revert E00();
        if (!(amount > 0 && amount <= bulletinRenewalEscrow[campaignId])) revert E11();
        bulletinRenewalEscrow[campaignId] -= amount;
        emit BulletinRenewalEscrowWithdrawn(campaignId, recipient, amount);
        _safeSend(recipient, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Renewer authorization
    // ─────────────────────────────────────────────────────────────────────

    function setApprovedBulletinRenewer(uint256 campaignId, address renewer, bool approved)
        external
        whenNotFrozen
        whenNotPaused
    {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        if (renewer == address(0)) revert E00();
        approvedBulletinRenewer[campaignId][renewer] = approved;
        if (approved) { _trackCreative(campaignId); _trackRenewer(campaignId, renewer); }
        emit BulletinRenewerAuthorized(campaignId, renewer, approved);
    }

    function setOpenBulletinRenewal(uint256 campaignId, bool open) external whenNotFrozen whenNotPaused {
        address advertiser = campaigns.getCampaignAdvertiser(campaignId);
        if (advertiser == address(0)) revert E01();
        if (msg.sender != advertiser) revert E21();
        openBulletinRenewal[campaignId] = open;
        emit BulletinRenewalModeChanged(campaignId, open);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Views (IDatumBulletinCreative)
    // ─────────────────────────────────────────────────────────────────────

    function getBulletinCreative(uint256 campaignId) external view returns (BulletinRef memory) {
        return _ref[campaignId];
    }

    function isBulletinRenewalDue(uint256 campaignId) external view returns (bool) {
        BulletinRef storage br = _ref[campaignId];
        if (br.cidDigest == bytes32(0)) return false;
        if (br.expiryHubBlock <= block.number) return false;
        return br.expiryHubBlock - block.number <= BULLETIN_RENEWAL_LEAD_BLOCKS;
    }

    /// @notice Public accessor matching the previous DatumCampaigns layout
    ///         (frontends bound to `campaignBulletin(id)` keep working
    ///         against this module without ABI churn).
    function campaignBulletin(uint256 campaignId) external view returns (BulletinRef memory) {
        return _ref[campaignId];
    }

    /// @inheritdoc IDatumCampaignCreative
    function getCampaignMetadata(uint256 campaignId) external view returns (bytes32) {
        return campaignMetadata[campaignId];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Upgrade migration (per-campaign creative + escrow; native sweep)
    // ─────────────────────────────────────────────────────────────────────

    function creativeCampaignCount() external view returns (uint256) { return _creativeCampaigns.length; }
    function creativeCampaignAt(uint256 i) external view returns (uint256) { return _creativeCampaigns[i]; }
    function renewerCount(uint256 cid) external view returns (uint256) { return _renewerList[cid].length; }
    function renewerAt(uint256 cid, uint256 i) external view returns (address) { return _renewerList[cid][i]; }

    /// @dev Copy renewer-reward config + every campaign's bulletin ref + renewal
    ///      escrow + open/metadata state + approved-renewer set from a frozen
    ///      predecessor. Structural refs (campaigns / pauseRegistry) are
    ///      re-wired. The escrow's native DOT moves via `migrateFundsTo`.
    function _migrate(address oldContract) internal override {
        DatumCampaignCreative old = DatumCampaignCreative(payable(oldContract));
        bulletinRenewerReward = old.bulletinRenewerReward();
        uint256 n = old.creativeCampaignCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 cid = old.creativeCampaignAt(i);
            _ref[cid] = old.getBulletinCreative(cid);
            bulletinRenewalEscrow[cid] = old.bulletinRenewalEscrow(cid);
            openBulletinRenewal[cid] = old.openBulletinRenewal(cid);
            campaignMetadata[cid] = old.campaignMetadata(cid);
            campaignMetadataVersion[cid] = old.campaignMetadataVersion(cid);
            campaignMetadataLastSetBlock[cid] = old.campaignMetadataLastSetBlock(cid);
            _trackCreative(cid);
            uint256 m = old.renewerCount(cid);
            for (uint256 j = 0; j < m; j++) {
                address r = old.renewerAt(cid, j);
                approvedBulletinRenewer[cid][r] = old.approvedBulletinRenewer(cid, r);
                _trackRenewer(cid, r);
            }
        }
    }

    /// @notice Sweep the bulletin-renewal escrow (native DOT) to a successor
    ///         during an upgrade. Governance-gated, frozen-only, one-shot.
    ///         (Hand-rolled rather than via DatumFundMigratable because this
    ///         contract keeps its own `plumbingLocked` umbrella.)
    function migrateFundsTo(address successor) external onlyGovernance nonReentrant {
        require(frozen, "not frozen");
        require(!fundsMigratedOut, "already swept");
        require(successor != address(0), "E00");
        fundsMigratedOut = true;
        uint256 bal = address(this).balance;
        emit FundsMigratedOut(successor, bal);
        if (bal > 0) DatumCampaignCreative(payable(successor)).acceptMigration{value: bal}();
    }

    function acceptMigration() external payable {
        require(msg.sender == migrationSource, "not-source");
    }
}
