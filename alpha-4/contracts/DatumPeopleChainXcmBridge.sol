// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./lib/XcmTransactEncoder.sol";
import "./interfaces/IXcm.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";

/// @dev Minimal write-side view of DatumPeopleChainIdentity for the bridge.
///      Kept inline so the read-only IDatumPeopleChainIdentity interface
///      (consumed by Settlement) stays focused on the read surface.
interface IPeopleChainIdentityWrite {
    function submitAttestation(address user, uint8 level, uint64 validityBlocks) external;
}

/// @title DatumPeopleChainXcmBridge
/// @notice Hub-side bridge that dispatches People Chain identity queries
///         via the Polkadot IXcm precompile, and receives the response as
///         a Transact callback from People Chain.
///
///         Architecture:
///
///           user ──requestRefresh(user)─► bridge ──IXcm.execute──► precompile
///                                                                     │
///                                                              outbound XCM
///                                                                     ▼
///                                                            People Chain runtime
///                                                                     │
///                                                              return XCM
///                                                                     ▼
///                                                              bridge.xcmCallback
///                                                                     │
///                                                          cache.submitAttestation
///
///         The bridge becomes `xcmDispatcher` on DatumPeopleChainIdentity.
///         On Paseo, `peopleChainSovereign` is Diana (off-chain oracle
///         standing in) until the People Chain pallet ships; the contract
///         code path is identical to the production trustless flow.
///         `lockSovereign` and `cache.lockOracleReporter` ratify the
///         lockdown after testnet validation.
///
/// @dev    Fee model:
///           - `requestRefresh(user) payable` — user pays own XCM weight.
///           - `requestRefreshFromCampaign(cid, user)` — pulls from
///             `campaignXcmRefreshEscrow[cid]` (advertiser-subsidized).
///         Per-user cooldown blocks flapping. Per-user lookup, not
///         per-(user, requester), since cooldown is anti-grief, not
///         anti-Sybil.
contract DatumPeopleChainXcmBridge is DatumOwnable, PaseoSafeSender {

    // ─────────────────────────────────────────────────────────────────────────
    // Immutable wiring
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Polkadot XCM precompile. Production: 0x0a0000. Mock in tests.
    IXcm public immutable xcmPrecompile;

    /// @notice Identity cache that this bridge writes attestations into.
    IPeopleChainIdentityWrite public immutable cache;

    // ─────────────────────────────────────────────────────────────────────────
    // Lock-once configuration
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Address that People Chain Transact callbacks arrive AS on Hub.
    ///         Owner-set; on Paseo this is Diana stand-in. `lockSovereign`
    ///         makes it permanent for mainnet.
    address public peopleChainSovereign;
    bool    public sovereignLocked;

    /// @notice DatumCampaigns reference for advertiser auth on
    ///         `withdrawXcmRefreshEscrow`. Lock-once via the
    ///         `campaignsContract == address(0)` guard.
    address public campaignsContract;

    /// @notice People Chain pallet index for `datum_identity_relay`.
    ///         Owner-tunable until the pallet ships on mainnet, then locked.
    uint8 public palletIndex;
    /// @notice Call index of `identity_query` within that pallet.
    uint8 public callIndex;
    bool  public palletCallIndicesLocked;

    // ─────────────────────────────────────────────────────────────────────────
    // Tunable parameters (owner; bounded)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Per-user cooldown between refresh requests (in Hub blocks).
    ///         Defaults to ~1 hour at 6s blocks. Bounded [60, 14_400].
    uint64 public refreshCooldownBlocks = 600;

    /// @notice Validity window baked into the outbound query — the People
    ///         Chain pallet writes records valid this many Hub blocks.
    ///         Defaults to ~30 days (432_000 @ 6s blocks). Bounded
    ///         by the cache's MIN_VALIDITY_BLOCKS / MAX_VALIDITY_BLOCKS.
    uint64 public defaultValidityBlocks = 432_000;

    /// @notice Hardcoded refresh fee upper bound (planck). Tunable post-Paseo
    ///         once measured weight cost is known.
    uint256 public refreshFee = 1_000_000_000; // 0.1 DOT / PAS at 10^10 planck

    /// @notice Transact ref_time + proof_size baked into outbound XCM.
    uint64 public transactRefTime = 5_000_000_000;
    uint64 public transactProofSize = 100_000;

    // ─────────────────────────────────────────────────────────────────────────
    // Runtime state
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Per-user last refresh block. Drives cooldown.
    mapping(address => uint64) public lastRefreshBlock;

    /// @notice Per-campaign refresh budget (mirrors DatumCampaigns'
    ///         BulletinRenewalEscrow pattern).
    mapping(uint256 => uint256) public campaignXcmRefreshEscrow;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event SovereignSet(address indexed sovereign);
    event SovereignLocked();
    event CampaignsContractSet(address indexed campaigns);
    event PalletCallIndicesSet(uint8 palletIndex, uint8 callIndex);
    event PalletCallIndicesLocked();
    event RefreshFeeSet(uint256 fee);
    event RefreshCooldownBlocksSet(uint64 blocks);
    event DefaultValidityBlocksSet(uint64 blocks);
    event TransactWeightSet(uint64 refTime, uint64 proofSize);

    event RefreshDispatched(address indexed user, address indexed requester, uint256 feePaid);
    event RefreshFromCampaign(uint256 indexed campaignId, address indexed user,
                              address indexed requester, uint256 feePaid);
    event RefreshInFlight(address indexed user);
    event RefreshCallback(address indexed user, uint8 level, uint64 validityBlocks);
    event XcmRefreshEscrowFunded(uint256 indexed campaignId, address indexed funder,
                                 uint256 amount, uint256 newBalance);
    event XcmRefreshEscrowWithdrawn(uint256 indexed campaignId, address indexed recipient,
                                    uint256 amount);

    // ─────────────────────────────────────────────────────────────────────────
    // Construction
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _xcmPrecompile, address _cache) {
        require(_xcmPrecompile != address(0) && _cache != address(0), "E00");
        xcmPrecompile = IXcm(_xcmPrecompile);
        cache = IPeopleChainIdentityWrite(_cache);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner config
    // ─────────────────────────────────────────────────────────────────────────

    function setSovereign(address s) external onlyOwner {
        require(!sovereignLocked, "sovereign-locked");
        require(s != address(0), "E00");
        peopleChainSovereign = s;
        emit SovereignSet(s);
    }

    /// @notice One-way lock for the sovereign address. Call after Paseo
    ///         validation confirms the real People Chain sovereign.
    function lockSovereign() external onlyOwner {
        require(peopleChainSovereign != address(0), "E00");
        sovereignLocked = true;
        emit SovereignLocked();
    }

    /// @notice Lock-once Campaigns wiring for advertiser auth on escrow withdraw.
    function setCampaignsContract(address c) external onlyOwner {
        require(campaignsContract == address(0), "already set");
        require(c != address(0), "E00");
        campaignsContract = c;
        emit CampaignsContractSet(c);
    }

    /// @notice Tune the People Chain pallet+call indices used in outbound XCM.
    ///         Tunable until the pallet is known-stable on mainnet, then locked.
    function setPalletCallIndices(uint8 _palletIndex, uint8 _callIndex) external onlyOwner {
        require(!palletCallIndicesLocked, "indices-locked");
        palletIndex = _palletIndex;
        callIndex   = _callIndex;
        emit PalletCallIndicesSet(_palletIndex, _callIndex);
    }

    function lockPalletCallIndices() external onlyOwner {
        palletCallIndicesLocked = true;
        emit PalletCallIndicesLocked();
    }

    function setRefreshFee(uint256 fee) external onlyOwner {
        require(fee > 0, "E11");
        refreshFee = fee;
        emit RefreshFeeSet(fee);
    }

    function setRefreshCooldownBlocks(uint64 v) external onlyOwner {
        require(v >= 60 && v <= 14_400, "E11");
        refreshCooldownBlocks = v;
        emit RefreshCooldownBlocksSet(v);
    }

    function setDefaultValidityBlocks(uint64 v) external onlyOwner {
        // Mirror the cache's bounds so writes don't get rejected downstream.
        require(v >= 600 && v <= 1_440_000, "E11");
        defaultValidityBlocks = v;
        emit DefaultValidityBlocksSet(v);
    }

    function setTransactWeight(uint64 refTime, uint64 proofSize) external onlyOwner {
        require(refTime > 0 && proofSize > 0, "E11");
        transactRefTime = refTime;
        transactProofSize = proofSize;
        emit TransactWeightSet(refTime, proofSize);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Refresh paths
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice User-paid refresh. msg.value funds the XCM execution; any
    ///         surplus over `refreshFee` is forwarded to the precompile too.
    function requestRefresh(address user) external payable {
        require(user != address(0), "E00");
        require(msg.value >= refreshFee, "E03");
        _requireOffCooldown(user);
        _dispatch(user, msg.value);
        emit RefreshDispatched(user, msg.sender, msg.value);
        emit RefreshInFlight(user);
    }

    /// @notice Advertiser-subsidized refresh. Anyone can call but the fee
    ///         is drawn from the campaign's escrow.
    function requestRefreshFromCampaign(uint256 campaignId, address user) external {
        require(user != address(0), "E00");
        uint256 fee = refreshFee;
        uint256 bal = campaignXcmRefreshEscrow[campaignId];
        require(bal >= fee, "E03");
        _requireOffCooldown(user);
        campaignXcmRefreshEscrow[campaignId] = bal - fee;
        _dispatch(user, fee);
        emit RefreshFromCampaign(campaignId, user, msg.sender, fee);
        emit RefreshInFlight(user);
    }

    function _dispatch(address user, uint256 fee) internal {
        bytes memory message = XcmTransactEncoder.encodeIdentityQueryXcm(
            bytes32(uint256(uint160(user)) << 96),
            uint128(fee),
            transactRefTime,
            transactProofSize,
            palletIndex,
            callIndex
        );
        IXcm.Weight memory w = xcmPrecompile.weighMessage(message);
        xcmPrecompile.execute{value: fee}(message, w);
        lastRefreshBlock[user] = uint64(block.number);
    }

    function _requireOffCooldown(address user) internal view {
        uint64 last = lastRefreshBlock[user];
        // last == 0 means the user has never been refreshed; allow.
        // Saturating add guards against any underflow on overflow-prone
        // block numbers in tests.
        if (last == 0) return;
        require(block.number >= uint256(last) + uint256(refreshCooldownBlocks), "E96");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Return-leg callback
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice People Chain Transact callback. Only callable as the
    ///         configured sovereign address. Writes the attestation
    ///         straight to the cache.
    function xcmCallback(address user, uint8 level, uint64 validityBlocks) external {
        require(peopleChainSovereign != address(0), "sovereign-unset");
        require(msg.sender == peopleChainSovereign, "E18");
        require(user != address(0), "E00");
        require(level <= 2, "E11");
        uint64 vb = validityBlocks == 0 ? defaultValidityBlocks : validityBlocks;
        cache.submitAttestation(user, level, vb);
        emit RefreshCallback(user, level, vb);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Campaign refresh escrow (mirrors BulletinRenewalEscrow pattern)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permissionless top-up. Advertiser, anyone funds a campaign's
    ///         refresh budget so the refresh button is free for users.
    function fundXcmRefreshEscrow(uint256 campaignId) external payable {
        require(msg.value > 0, "E11");
        uint256 newBal = campaignXcmRefreshEscrow[campaignId] + msg.value;
        campaignXcmRefreshEscrow[campaignId] = newBal;
        emit XcmRefreshEscrowFunded(campaignId, msg.sender, msg.value, newBal);
    }

    /// @notice Advertiser-only withdraw of unspent campaign escrow. Requires
    ///         `campaignsContract` to be wired so we can resolve advertiser
    ///         identity.
    function withdrawXcmRefreshEscrow(
        uint256 campaignId,
        address payable recipient,
        uint256 amount
    ) external nonReentrant {
        require(campaignsContract != address(0), "campaigns-unset");
        require(recipient != address(0), "E00");
        address adv = IDatumCampaignsAdvertiser(campaignsContract)
            .getCampaignAdvertiser(campaignId);
        require(adv != address(0) && msg.sender == adv, "E18");
        uint256 bal = campaignXcmRefreshEscrow[campaignId];
        require(amount > 0 && amount <= bal, "E03");
        campaignXcmRefreshEscrow[campaignId] = bal - amount;
        _safeSend(recipient, amount);
        emit XcmRefreshEscrowWithdrawn(campaignId, recipient, amount);
    }

    /// @notice Estimate the refresh fee a user (or campaign) must supply.
    ///         Used by web UIs to populate the payable value field.
    function estimatedRefreshFee() external view returns (uint256) {
        return refreshFee;
    }
}
