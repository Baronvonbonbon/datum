// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

// EIP712 + ECDSA moved to DatumDualSigSettlement (alpha-4 EIP-170 carve-out).
// State, errors, non-Claim events, and the inline ICampaignsUserCapView
// interface live on DatumSettlementStorage (alpha-4 phase 8d-1) so the
// future LogicA/LogicB contracts can share Settlement's storage layout
// via DELEGATECALL. The storage base inherits ReentrancyGuard +
// DatumUpgradable; IDatumSettlement stays on Settlement so the public
// settle ABI surface lives at the Settlement contract address and Logic
// stubs don't have to satisfy it.
import "./DatumSettlementStorage.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumClickRegistry.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumBudgetLedger.sol";
import "./interfaces/IDatumPaymentVault.sol";
import "./interfaces/IDatumTokenRewardVault.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";
import "./interfaces/IDatumPeopleChainIdentity.sol";
import "./interfaces/IDatumPowEngine.sol";
import "./interfaces/IDatumPublisherReputation.sol";
import "./interfaces/IDatumNullifierRegistry.sol";
import "./interfaces/IDatumSettlementRateLimiter.sol";
import "./interfaces/IDatumMintCoordinator.sol";

/// IDatumMintAuthority_Settle / IDatumEmissionEngine interface refs moved
/// to DatumMintCoordinator (alpha-4 EIP-170 carve-out). Settlement now
/// holds a single mintCoordinator pointer and calls `coordinate` once
/// per batch.

/// @title DatumSettlement
/// @notice Processes claim batches and distributes payments.
///
///         Alpha-3 multi-pricing changes:
///           - Claim struct: impressionCount→eventCount, clearingCpmPlanck→ratePlanck,
///             plus actionType, clickSessionHash, actionSig fields.
///           - Chain state triple-keyed: (user, campaignId, actionType).
///           - Payment formula: view (type-0) = (ratePlanck × eventCount) / 1000;
///             click/action (type-1/2) = ratePlanck × eventCount.
///           - BudgetLedger.deductAndTransfer now takes actionType.
///           - Type-1 claims: Settlement calls clickRegistry.markClaimed after success.
///           - rateLimiter.checkAndIncrement now takes actionType.
///
///         Revenue formula:
///           totalPayment    = (ratePlanck × eventCount / 1000) for view
///                           = (ratePlanck × eventCount) for click/action
///           publisherPayment = totalPayment × snapshotTakeRateBps / 10000
///           remainder       = totalPayment - publisherPayment
///           userPayment     = remainder × 7500 / 10000   (75%)
///           protocolFee     = remainder - userPayment     (25%)
contract DatumSettlement is IDatumSettlement, DatumSettlementStorage {

    function version() public pure override returns (uint256) { return 1; }


    /// @notice CB4: advertiser-side stake contract. When non-zero, Settlement
    ///         calls recordBudgetSpent on each settled batch so the bonding
    ///         curve advances. Lock-once below.

    // ── DATUM token mint — carved out to DatumMintCoordinator ───────────
    // Mint authority, emission engine pointer, legacy flat-rate fallback,
    // dust threshold, reward split bps, and the per-batch orchestration
    // logic all moved to DatumMintCoordinator (alpha-4 EIP-170 carve-out).
    // Settlement holds one lock-once pointer and calls coordinate() once
    // per batch at the end of _processBatch. The coordinator runs the
    // engine-or-fallback path, applies the dust gate, splits the result,
    // and delegates the actual mint to the wired MintAuthority.

    // ── BM-5: Rate limiter — carved out to DatumSettlementRateLimiter ──
    // ── FP-5: Nullifier registry — carved out to DatumNullifierRegistry ──
    // Both were alpha-3 satellites that got merged in for PVM bytecode
    // pressure; un-merged for mainnet EIP-170. Settlement keeps lock-once
    // pointers and consults each module per claim.

    // ── BM-8/BM-9: Publisher reputation — carved out to DatumPublisherReputation
    // Reputation state, the per-publisher acceptance counters, and the
    // anomaly views moved to DatumPublisherReputation so the module can be
    // upgraded independently. Settlement calls canSettle() before
    // processing a batch and recordSettlement() at the end. The pointer is
    // lock-once; address(0) disables the gate (and recording) entirely.

    // ── Settlement batch size (governable, was hard-coded 10 in alpha-3) ──
    // Original cap was 10 due to PVM cross-contract staticcall weight pressure.
    // Alpha-4 satellite merge eliminated those staticcalls, and the EVM gas
    // budget comfortably fits much larger batches. Governance can re-tune via
    // setMaxBatchSize, bounded by MAX_BATCH_SIZE_CEILING.

    // B5-fix (2026-05-12): per-user minimum acceptable AssuranceLevel. A user
    // writes their own floor (0..2) and Settlement rejects batches addressed to
    // that user when the campaign's effective AssuranceLevel is below it. This
    // extends the AssuranceLevel choice from advertiser-only to user-as-well:
    // users can refuse low-proof settlement (e.g. demand publisher cosig) on
    // their own behalf without relying on each campaign's advertiser to opt in.
    // Default 0 = accept any level (current behavior). Self-set only.

    /// @notice People Chain identity gate (user-side floor). Symmetric to the
    ///         campaign-side `campaignMinIdentityLevel` — the user can demand
    ///         that any campaign they settle on must require identity at this
    ///         minimum level. The effective gate is the OR-merge:
    ///             effectiveMinLevel = max(campaignMinIdentityLevel, userMinIdentityLevel)
    ///         0 = disabled (default). Self-set only.

    /// @notice People Chain identity cache. Settlement queries `isVerified` on
    ///         the hot path. Set once via `setIdentityRegistry` (lock-once;
    ///         hot-swapping the identity source mid-flight would let an
    ///         attacker rotate to a permissive cache and bypass the gate).
    ///         Address(0) means the identity gate is dormant: any non-zero
    ///         effective-min-level reverts batches CLOSED — operators must
    ///         wire the registry before any campaign or user opts in.

    /// @notice CB1: per-user counterparty blocklists. Self-set; only the user
    ///         themselves can mutate. Checked in _processBatch — any batch
    ///         routed to a user who has blocked the counterparty is rejected
    ///         regardless of AssuranceLevel. Symmetric to the publisher's
    ///         per-advertiser allowlist.

    /// @notice CB2: per-user self-pause flag. Self-set; only the user. While
    ///         true, every settlement to this user is rejected — a kill-switch
    ///         the user can hit during suspected key compromise without
    ///         needing protocol-level action.

    // -------------------------------------------------------------------------
    // #5: Per-impression PoW — carved out to DatumPowEngine
    // -------------------------------------------------------------------------
    // PoW state, difficulty curve, admin, and views moved to DatumPowEngine
    // so the module can be upgraded independently and Settlement fits under
    // EIP-170. Settlement keeps a pointer and calls `consumeFor` once per
    // batch in `_processBatch`. ClaimValidator reads `enforcePow` and
    // `powTargetForUser` directly from the engine.

    // #2-extension (2026-05-12): cumulative settled events per user, all
    // campaigns + actionTypes. Drives per-campaign minUserSettledHistory
    // filters (proof-of-on-chain-history as a soft sybil bar).

    /// @notice L-4: Emitted when the non-critical token-reward credit reverts so off-chain
    ///         monitors can flag mis-wired or under-funded reward configs.
    /// @notice A4-fix: Emitted when publishers.isBlocked() reverts during a batch.
    ///         Advisory only — settlement continues. Monitors should re-wire / fix the
    ///         publishers ref. Not a rejection.

    /// @notice H2-fix: emitted when the AssuranceLevel lookup on Campaigns
    ///         reverts. The batch is failed CLOSED (treated as max-enforced),
    ///         but operators should see this and repair the Campaigns wiring.

    /// @notice M2-fix: emitted when an L1+ campaign's blocklist lookup reverts.
    ///         At L1 or above the batch is rejected; at L0 it falls through
    ///         (advisory BlocklistCheckFailed above).

    /// @notice M1-fix: emitted when an L3 campaign settles without a valid ZK
    ///         proof. The user opted in to ZK-only settlement via _userMinAssurance=3.

    /// @notice CB1: emitted when a user's self-managed blocklist rejects a batch.

    /// @notice CB2: emitted on user self-pause toggle.

    // Triple-keyed chain state: (user, campaignId, actionType)

    // BM-2: Per-user per-campaign per-actionType cumulative settlement tracking

    // #1 (2026-05-12): Per-user per-campaign per-actionType per-window event
    // counter. Window length is per-campaign (Campaigns.userCapWindowBlocks).
    // windowId = block.number / windowBlocks.

    // M-1: Revenue split — user gets `_userShareBps / 10000` of remainder after
    //      publisher take rate. Governance-tunable within [MIN_USER_SHARE_BPS,
    //      MAX_USER_SHARE_BPS] via setUserShareBps. Defaults to 75%.

    // BM-10: Minimum blocks between settlement batches per user per campaign (0 = disabled)

    // L-7: Global per-block settlement circuit breaker (0 = disabled)

    // A1+A9: EIP-712 typehash binds the relay-signer the publisher expected at
    // sign time + a block-number deadline (parity with DatumRelay). Both
    // protect against state mutations between sign and submit:
    //   - relaySigner: if the publisher rotates their relay key after signing,
    //     submission fails — the advertiser's cosig is over a *specific* publisher
    //     authority, not whoever the publishers contract returns at exec time.
    //   - deadlineBlock: block.number is cheaper to predict than block.timestamp
    //     and removes the unit-ambiguity vs. the Relay path.
    // CLAIM_BATCH_TYPEHASH + EIP712 base moved to DatumDualSigSettlement
    // (alpha-4 EIP-170 carve-out). Settlement no longer hashes / recovers
    // signatures itself; the DualSig contract does both and then calls
    // `processVerifiedBatch` below.

    /// @notice The carved-out DualSig settlement module. Set once via
    ///         `setDualSig` (lock-once). When non-zero, this is the only
    ///         caller allowed to invoke `processVerifiedBatch`.

    constructor(address pauseRegistry_) {
        if (!(pauseRegistry_ != address(0))) revert E00();
        _pauseRegistry = IDatumPauseRegistry(pauseRegistry_);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev B8-fix (2026-05-12): structural references are lock-once. Settlement
    ///      cannot have its budget ledger, payment vault, _lifecycle, or relay
    ///      hot-swapped post-bootstrap — every swap point is a rug surface and
    ///      none of these have a legitimate change reason once wired. Deploy a
    ///      fresh Settlement if you genuinely need to re-point.
    function configure(
        address budgetLedger_,
        address paymentVault_,
        address lifecycle_,
        address relay_
    ) external onlyOwner {
        if (!(address(_budgetLedger) == address(0))) revert AlreadySet();
        if (!(budgetLedger_ != address(0))) revert E00();
        if (!(paymentVault_ != address(0))) revert E00();
        if (!(lifecycle_ != address(0))) revert E00();
        if (!(relay_ != address(0))) revert E00();
        _budgetLedger = IDatumBudgetLedger(budgetLedger_);
        _paymentVault = IDatumPaymentVault(paymentVault_);
        _lifecycle = IDatumCampaignLifecycle(lifecycle_);
        _relayContract = relay_;
        emit SettlementConfigured(budgetLedger_, paymentVault_, lifecycle_, relay_);
    }

    /// @dev Cypherpunk lock-once: validators are settlement-critical. A malicious
    ///      owner swap to a permissive validator is the single largest rug
    ///      surface (fake rates → drain budgets). One write, then frozen.
    function setClaimValidator(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(_claimValidator) == address(0))) revert AlreadySet();
        _claimValidator = IDatumClaimValidator(addr);
    }

    /// @dev Cypherpunk lock-once: same rationale as setClaimValidator —
    ///      a swappable attestation verifier lets an owner forge dual-sig.
    function setAttestationVerifier(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(_attestationVerifier == address(0))) revert AlreadySet();
        _attestationVerifier = addr;
    }

    /// @notice Wire the carved-out rate limiter module. Lock-once.
    function setRateLimiter(address addr) external onlyOwner {
        if (addr == address(0)) revert E00();
        if (address(_rateLimiter) != address(0)) revert AlreadySet();
        _rateLimiter = IDatumSettlementRateLimiter(addr);
        emit RateLimiterSet(addr);
    }

    function setMinClaimInterval(uint16 interval) external onlyOwner {
        _minClaimInterval = interval;
    }

    /// @dev Cypherpunk lock-once: publishers ref drives blocklist + stake gates.
    ///      A swap could silently disable those (point to a permissive contract).
    ///      address(0) is a valid initial state ("feature off"); once set non-zero
    ///      it is frozen for the life of this Settlement.
    function setPublishers(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(_publishers) == address(0))) revert AlreadySet();
        _publishers = IDatumPublishers(addr);
    }

    /// @dev D3: Cypherpunk lock-once on optional feature. tokenRewardVault holds
    ///      advertiser-deposited ERC20s; a hot-swap could redirect credit() to
    ///      a hostile vault that quietly absorbs rewards. address(0) leaves the
    ///      feature off; once set non-zero it's frozen.
    function setTokenRewardVault(address addr) external onlyOwner {
        if (!(address(_tokenRewardVault) == address(0))) revert AlreadySet();
        _tokenRewardVault = IDatumTokenRewardVault(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        // B8-fix: structural ref, lock-once.
        if (!(address(_campaigns) == address(0))) revert AlreadySet();
        if (!(addr != address(0))) revert E00();
        _campaigns = IDatumCampaigns(addr);
    }

    /// @dev Cypherpunk lock-once: stake adequacy gate. Hot-swap could neuter it.
    function setPublisherStake(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(_publisherStake) == address(0))) revert AlreadySet();
        _publisherStake = IDatumPublisherStake(addr);
    }

    /// @dev CB4 lock-once: advertiser-stake callback target. Hot-swap could
    ///      forge budget-spent on rivals to drive their required-stake up.
    function setAdvertiserStake(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(_advertiserStake == address(0))) revert AlreadySet();
        _advertiserStake = addr;
    }

    /// @notice Wire the carved-out nullifier-registry module. Lock-once.
    function setNullifierRegistry(address addr) external onlyOwner {
        if (addr == address(0)) revert E00();
        if (address(_nullifiers) != address(0)) revert AlreadySet();
        _nullifiers = IDatumNullifierRegistry(addr);
        emit NullifierRegistrySet(addr);
    }

    function setMaxBatchSize(uint256 v) external onlyOwner {
        if (!(v > 0 && v <= MAX_BATCH_SIZE_CEILING)) revert E11();
        _maxBatchSize = v;
        emit MaxBatchSizeSet(v);
    }

    /// @notice Wire the carved-out reputation module. Lock-once.
    function setReputationContract(address rep) external onlyOwner {
        if (rep == address(0)) revert E00();
        if (address(_reputation) != address(0)) revert AlreadySet();
        _reputation = IDatumPublisherReputation(rep);
        emit ReputationContractSet(rep);
    }

    /// @notice B5-fix + M1-fix: user sets their own minimum AssuranceLevel
    ///         floor (0..3). Self-only; no admin or counterparty can lower or raise.
    ///         0 = accept any (default).
    ///         1 = require publisher cosig (relay path or publisher's own relay).
    ///         2 = require dual-sig (publisher + advertiser EIP-712 cosig).
    ///         3 = require dual-sig AND campaign must require valid ZK proofs.
    function setUserMinAssurance(uint8 level) external whenNotFrozen {
        if (!(level <= 3)) revert E11();
        _userMinAssurance[msg.sender] = level;
        emit UserMinAssuranceSet(msg.sender, level);
    }

    /// @notice User-side People Chain identity floor (0/1/2). Mirrors
    ///         `setUserMinAssurance`: self-only, instant effect, no admin
    ///         override. The effective gate in `_processBatch` is
    ///         `max(campaignMinIdentityLevel, userMinIdentityLevel)`.
    function setUserMinIdentityLevel(uint8 level) external whenNotFrozen {
        if (!(level <= 2)) revert E11();
        _userMinIdentityLevel[msg.sender] = level;
        emit UserMinIdentityLevelSet(msg.sender, level);
    }

    /// @notice Wire the People Chain identity cache. Lock-once: rotating the
    ///         identity source after deploy would let a captured owner point
    ///         at a permissive registry and bypass every campaign's identity
    ///         gate in flight. Redeploy Settlement if rotation is needed.
    function setIdentityRegistry(address addr) external onlyOwner {
        if (!(addr != address(0))) revert E00();
        if (!(address(_identityRegistry) == address(0))) revert AlreadySet();
        _identityRegistry = IDatumPeopleChainIdentity(addr);
        emit IdentityRegistrySet(addr);
    }

    /// @notice CB1: self-managed publisher blocklist. Caller is the user.
    ///         Blocked publishers cannot settle claims to this user.
    function setUserBlocksPublisher(address publisher, bool blocked) external whenNotFrozen {
        if (!(publisher != address(0))) revert E00();
        _userBlocksPublisher[msg.sender][publisher] = blocked;
        emit UserBlocksPublisherSet(msg.sender, publisher, blocked);
    }

    /// @notice CB1: self-managed advertiser blocklist. Caller is the user.
    function setUserBlocksAdvertiser(address advertiser, bool blocked) external whenNotFrozen {
        if (!(advertiser != address(0))) revert E00();
        _userBlocksAdvertiser[msg.sender][advertiser] = blocked;
        emit UserBlocksAdvertiserSet(msg.sender, advertiser, blocked);
    }

    /// @notice CB2: user self-pause kill switch. While true, no batches settle
    ///         to this user regardless of submission path or AssuranceLevel.
    ///         Self-set; only the user.
    function setUserPaused(bool paused_) external whenNotFrozen {
        _userPaused[msg.sender] = paused_;
        emit UserPausedSet(msg.sender, paused_);
    }

    // -------------------------------------------------------------------------
    // #5: PoW — moved to DatumPowEngine
    // -------------------------------------------------------------------------

    /// @notice Wire the carved-out PoW engine. Lock-once.
    function setPowEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert E00();
        if (address(_powEngine) != address(0)) revert AlreadySet();
        _powEngine = IDatumPowEngine(engine);
        emit PowEngineSet(engine);
    }

    function setClickRegistry(address addr) external onlyOwner {
        // A13: lock once set. Re-pointing to a fresh registry would create a
        // replay window for already-claimed click sessions. Deploy a new
        // Settlement if a registry swap is genuinely required.
        if (!(address(_clickRegistry) == address(0))) revert AlreadySet();
        if (!(addr != address(0))) revert E00();
        _clickRegistry = IDatumClickRegistry(addr);
    }

    /// @notice L-7: Set global per-block settlement cap in planck. 0 = disabled.
    function setMaxSettlementPerBlock(uint256 cap) external onlyOwner {
        _maxSettlementPerBlock = cap;
    }

    /// @notice One-time wiring of the carved-out mint coordinator. Lock-once.
    function setMintCoordinator(address coordinator) external onlyOwner {
        if (coordinator == address(0)) revert E00();
        if (address(_mintCoordinator) != address(0)) revert AlreadySet();
        _mintCoordinator = IDatumMintCoordinator(coordinator);
        emit MintCoordinatorSet(coordinator);
    }

    // setMintAuthority / setEmissionEngine / setMintRate / setDustMintThreshold /
    // setDatumRewardSplit moved to DatumMintCoordinator.

    /// @notice Governance: set the user's share of `remainder` (after publisher
    ///         take rate). Bounded to [MIN_USER_SHARE_BPS, MAX_USER_SHARE_BPS]
    ///         so neither user nor protocol can be governance-pushed to 0.
    function setUserShareBps(uint16 bps) external onlyOwner {
        if (!(bps >= MIN_USER_SHARE_BPS && bps <= MAX_USER_SHARE_BPS)) revert E11();
        _userShareBps = bps;
        emit UserShareBpsSet(bps);
    }

    // setDatumRewardSplit moved to DatumMintCoordinator.

    receive() external payable { revert("E03"); }

    // -------------------------------------------------------------------------
    // H-7: Configuration validation
    // -------------------------------------------------------------------------

    /// @notice Check that all required references are configured. Returns (valid, missingField).
    ///         Call after deploy/wiring as a smoke test.
    function validateConfiguration() external view returns (bool valid, string memory missingField) {
        if (address(_budgetLedger) == address(0)) return (false, "budgetLedger");
        if (address(_paymentVault) == address(0)) return (false, "paymentVault");
        if (address(_lifecycle) == address(0)) return (false, "lifecycle");
        if (_relayContract == address(0)) return (false, "relayContract");
        if (address(_pauseRegistry) == address(0)) return (false, "pauseRegistry");
        if (address(_claimValidator) == address(0)) return (false, "claimValidator");
        if (address(_campaigns) == address(0)) return (false, "campaigns");
        // A1: off-chain ZK clients derive windowId via the nullifier registry's
        // configured window. Require both the registry wired AND its window set
        // when the verifier path is in play (claimValidator implies ZK).
        if (address(_nullifiers) == address(0)) return (false, "nullifiers");
        if (_nullifiers.nullifierWindowBlocks() == 0) return (false, "nullifierWindowBlocks");
        // Optional references (address(0) = disabled feature, not misconfigured):
        // publishers, tokenRewardVault, publisherStake, clickRegistry,
        // attestationVerifier, rateLimiter, reputation, powEngine
        return (true, "");
    }

    // -------------------------------------------------------------------------
    // Two-Logic split routing (alpha-4 EIP-170 phase 8d-2)
    // -------------------------------------------------------------------------
    //
    // DatumSettlementLogicA and DatumSettlementLogicB inherit the same
    // DatumSettlementStorage abstract base as Settlement, so DELEGATECALL
    // into either contract operates on Settlement's storage. The pointers
    // are updated as a pair via `setLogic` to keep the two Logic contracts
    // in lockstep — an A/B mismatch on storage layout would corrupt slots
    // at the first cross-call.
    //
    // Pointers are governance-rotatable (not lock-once): the whole point of
    // this split is that Logic is the upgradable surface. Settlement itself
    // is the stable slot owner. Owner under OpenGov is the Timelock, so
    // rotation flows through a 48h governance proposal.
    //
    // Phase 8d-2 (this commit): wiring only. No functions are routed yet.

    /// @notice Wire the LogicA + LogicB pair. Both must be non-zero; both
    ///         must be deployed against the SAME storage layout
    ///         (DatumSettlementStorage). Owner-settable; later upgrade-ladder
    ///         phases will gate this behind the Timelock.
    function setLogic(address logicA_, address logicB_) external onlyOwner {
        if (_logicLocked) revert AlreadySet();
        if (logicA_ == address(0) || logicB_ == address(0)) revert E00();
        _logicA = logicA_;
        _logicB = logicB_;
        emit LogicSet(logicA_, logicB_);
    }

    /// @notice Production cypherpunk lock. After this fires, the Logic
    ///         pair is frozen and any future setLogic call reverts. Matches
    ///         the lockLanes / lockSlashers / lockMintAuthority cluster.
    ///         Owner-only -- in production the owner is the OpenGov
    ///         Timelock so the lock decision flows through a 48h proposal.
    function lockLogic() external onlyOwner {
        _logicLocked = true;
        emit LogicLocked();
    }

    function logicA() external view returns (address) { return _logicA; }
    function logicB() external view returns (address) { return _logicB; }
    function logicLocked() external view returns (bool) { return _logicLocked; }

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumSettlement
    /// @dev Thin dispatcher. The relay-side outer loop lives in
    ///      DatumSettlementLogicA, which in turn delegatecalls
    ///      DatumSettlementLogicB.processBatch for each batch. Both
    ///      Logic contracts share Settlement's storage via the
    ///      DatumSettlementStorage abstract base, so every SLOAD /
    ///      SSTORE through the chain hits Settlement's slots. LogicA
    ///      pointer must be wired via `setLogic` (E00 if unset). The
    ///      `nonReentrant` / `whenNotFrozen` guards live on LogicA's
    ///      entry rather than here -- applying them twice would
    ///      double-lock the shared `_status` slot.
    function settleClaims(ClaimBatch[] calldata)
        external
        returns (SettlementResult memory)
    {
        return _delegateToLogicA();
    }

    /// @inheritdoc IDatumSettlement
    /// @dev See `settleClaims` for the dispatcher / chained delegatecall
    ///      notes.
    function settleClaimsMulti(UserClaimBatch[] calldata)
        external
        returns (SettlementResult memory)
    {
        return _delegateToLogicA();
    }

    /// @dev Forward the current `msg.data` (selector + calldata) into
    ///      DatumSettlementLogicA via DELEGATECALL. Both relay entry
    ///      points share this body since the only thing that varies is
    ///      the calldata shape -- LogicA's overload selector handles
    ///      the dispatch.
    function _delegateToLogicA() internal returns (SettlementResult memory) {
        address target = _logicA;
        if (target == address(0)) revert E00();
        (bool ok, bytes memory ret) = target.delegatecall(msg.data);
        if (!ok) {
            assembly {
                let size := mload(ret)
                revert(add(ret, 0x20), size)
            }
        }
        return abi.decode(ret, (SettlementResult));
    }

    /// @notice Wire the carved-out DualSig settlement module. Lock-once.
    function setDualSig(address addr) external onlyOwner {
        if (addr == address(0)) revert E00();
        if (_dualSig != address(0)) revert AlreadySet();
        _dualSig = addr;
        emit DualSigSet(addr);
    }

    /// @inheritdoc IDatumSettlement
    /// @dev Called by DatumDualSigSettlement after both EIP-712 signatures
    ///      have been verified. Gated to `_dualSig` so no other contract or
    ///      EOA can invoke the dual-sig settle path.
    function processVerifiedBatch(
        address user,
        uint256 campaignId,
        Claim[] calldata claims
    ) external nonReentrant whenNotFrozen returns (SettlementResult memory result) {
        if (msg.sender != _dualSig) revert OnlyDualSig();
        if (address(_claimValidator) == address(0)) revert E00();
        if (_pauseRegistry.pausedSettlement()) revert Paused();
        if (claims.length == 0) revert E28();
        if (claims.length > _maxBatchSize) revert E28();
        _delegateProcessBatch(user, campaignId, claims, true, result);
    }


    // -------------------------------------------------------------------------
    // Rate-limiter, nullifier, and reputation views all moved to their
    // respective carve-out modules.

    // ─────────────────────────────────────────────────────────────────────
    // Public getters — preserve the pre-Phase-1.3 public ABI. Each one
    // returns the corresponding underscore-prefixed storage slot defined
    // on DatumSettlementStorage. Webapp, extension, SDK, relay-bot, and
    // tests address these by their original names; the storage rename is
    // internal-only.
    // ─────────────────────────────────────────────────────────────────────

    function budgetLedger() external view returns (IDatumBudgetLedger) { return _budgetLedger; }
    function paymentVault() external view returns (IDatumPaymentVault) { return _paymentVault; }
    function lifecycle() external view returns (IDatumCampaignLifecycle) { return _lifecycle; }
    function relayContract() external view returns (address) { return _relayContract; }
    function pauseRegistry() external view returns (IDatumPauseRegistry) { return _pauseRegistry; }
    function attestationVerifier() external view returns (address) { return _attestationVerifier; }
    function claimValidator() external view returns (IDatumClaimValidator) { return _claimValidator; }
    function publishers() external view returns (IDatumPublishers) { return _publishers; }
    function tokenRewardVault() external view returns (IDatumTokenRewardVault) { return _tokenRewardVault; }
    function campaigns() external view returns (IDatumCampaigns) { return _campaigns; }
    function publisherStake() external view returns (IDatumPublisherStake) { return _publisherStake; }
    function advertiserStake() external view returns (address) { return _advertiserStake; }
    function clickRegistry() external view returns (IDatumClickRegistry) { return _clickRegistry; }
    function mintCoordinator() external view returns (IDatumMintCoordinator) { return _mintCoordinator; }
    function rateLimiter() external view returns (IDatumSettlementRateLimiter) { return _rateLimiter; }
    function nullifiers() external view returns (IDatumNullifierRegistry) { return _nullifiers; }
    function reputation() external view returns (IDatumPublisherReputation) { return _reputation; }
    function identityRegistry() external view returns (IDatumPeopleChainIdentity) { return _identityRegistry; }
    function powEngine() external view returns (IDatumPowEngine) { return _powEngine; }
    function dualSig() external view returns (address) { return _dualSig; }

    function maxBatchSize() external view returns (uint256) { return _maxBatchSize; }
    function userShareBps() external view returns (uint16) { return _userShareBps; }
    function minClaimInterval() external view returns (uint16) { return _minClaimInterval; }
    function maxSettlementPerBlock() external view returns (uint256) { return _maxSettlementPerBlock; }

    function userMinAssurance(address user) external view returns (uint8) { return _userMinAssurance[user]; }
    function userMinIdentityLevel(address user) external view returns (uint8) { return _userMinIdentityLevel[user]; }
    function userPaused(address user) external view returns (bool) { return _userPaused[user]; }
    function userTotalSettled(address user) external view returns (uint256) { return _userTotalSettled[user]; }

    function userBlocksPublisher(address user, address publisher_) external view returns (bool) {
        return _userBlocksPublisher[user][publisher_];
    }
    function userBlocksAdvertiser(address user, address advertiser_) external view returns (bool) {
        return _userBlocksAdvertiser[user][advertiser_];
    }

    function lastNonce(address user, uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _lastNonce[user][campaignId][actionType];
    }
    function lastClaimHash(address user, uint256 campaignId, uint8 actionType) external view returns (bytes32) {
        return _lastClaimHash[user][campaignId][actionType];
    }
    function userCampaignSettled(address user, uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _userCampaignSettled[user][campaignId][actionType];
    }
    function lastSettlementBlock(address user, uint256 campaignId, uint8 actionType) external view returns (uint256) {
        return _lastSettlementBlock[user][campaignId][actionType];
    }
    function userCampaignWindowEvents(address user, uint256 campaignId, uint8 actionType, uint256 windowId)
        external view returns (uint256)
    {
        return _userCampaignWindowEvents[user][campaignId][actionType][windowId];
    }

}
