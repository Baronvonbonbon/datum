// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";

/// @dev F-009: minimal interface for the atomic freeze+migrate path on
///      upgradeContract. Both calls are try-catched so a non-Upgradable
///      registered target won't break the registry flip.
interface IDatumUpgradable_Router {
    function freeze() external;
    function migrate(address oldContract) external;
}

/// @title DatumGovernanceRouter
/// @notice Stable-address proxy that sits between campaigns/lifecycle and the
///         currently active governance contract.
///
///         Both campaigns.governanceContract and lifecycle.governanceContract
///         are pointed at this Router once and never changed.  Phase transitions
///         only require updating `governor` here (via the owner, who is the Timelock).
///
///         Governance ladder:
///           Phase 0 (Admin)   — DatumAdminGovernance: team multisig direct approval
///           Phase 1 (Council) — DatumCouncil: N-of-M trusted council voting
///           Phase 2 (OpenGov) — DatumGovernanceV2: full conviction-weighted open governance
///
///         GovernanceV2 (Phase 2) compatibility:
///           Set govV2.campaigns = router  (Router implements IDatumCampaignsMinimal)
///           Set govV2.lifecycle = router  (Router implements terminateCampaign + demoteCampaign)
///           → govV2 calls router.activateCampaign/terminateCampaign/demoteCampaign
///           → Router checks msg.sender == governor, then forwards to the real contracts.
contract DatumGovernanceRouter is DatumOwnable, PaseoSafeSender {

    // -------------------------------------------------------------------------
    // Phase enum
    // -------------------------------------------------------------------------

    enum GovernancePhase { Admin, Council, OpenGov }

    // -------------------------------------------------------------------------
    // Config
    // -------------------------------------------------------------------------

    GovernancePhase public phase;
    address public governor;

    /// @notice Admin/upgrade authority, separate from the campaign `governor`.
    ///         `upgradeContract` and the phase-regression functions are gated on
    ///         this — NOT on `governor` — so the campaign governor can advance to
    ///         OpenGov (`DatumGovernanceV2`, which has no upgrade/regression call
    ///         path) while a standing admin executor (the Council) retains the
    ///         ability to upgrade contracts and drive emergency phase regression.
    ///         Defaults to the constructor `_governor` (Phase-0 deployer) so
    ///         existing single-key behavior holds until `setAdminGovernor` points
    ///         it at the Council. Set by the owner (Timelock). See
    ///         CONTROL-MATRIX-MEMO.md §8.
    address public adminGovernor;

    // A10: pending governor must call acceptGovernor() from its own address
    // to complete the handoff. Prevents owner from accidentally locking the
    // router behind an EOA or a contract that doesn't actually exist.
    address public pendingGovernor;
    GovernancePhase public pendingPhase;

    IDatumCampaignsMinimal public campaigns;
    IDatumCampaignLifecycle public lifecycle;

    /// @notice D1a cypherpunk plumbing lock. Router is a forwarding plumbing
    ///         contract; both protocol-ref setters live under this one switch.
    ///         Pre-lock: owner can swap to fix wiring. Post-lock: frozen forever.
    bool public plumbingLocked;
    event PlumbingLocked();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event PhaseTransitioned(GovernancePhase indexed newPhase, address indexed newGovernor);
    event GovernorProposed(GovernancePhase indexed newPhase, address indexed newGovernor);
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);
    event PhaseFloorRaised(GovernancePhase indexed newFloor);
    event AdminGovernorSet(address indexed oldAdminGovernor, address indexed newAdminGovernor);

    /// @notice M4-fix: monotonic phase floor. setGovernor refuses any proposal
    ///         that would move `phase` below `phaseFloor`. Permanently writes
    ///         the current phase as a floor when raisePhaseFloor() is called.
    ///         Anyone can call to ratchet the floor up to the current phase.
    ///         There is no path to lower the floor.
    /// @dev    `phaseFloor` is the SOFT floor — `executeRegression` resets
    ///         it back to the regressed-to phase so re-promotion via
    ///         setGovernor is unblocked.
    GovernancePhase public phaseFloor;

    /// @notice F-006 fix (2026-05-20): HARD floor — the highest phase ever
    ///         reached, monotonically non-decreasing. Survives regression.
    ///         `setGovernor` requires `newPhase >= hardFloor`, so a
    ///         compromised governor that proposes a regression to Admin
    ///         cannot then re-stage any new governor below the hardest
    ///         level the protocol has ever attained. Emergency step-back
    ///         is preserved (the soft `phaseFloor` still resets); the
    ///         hard floor only prevents full unwind past previous
    ///         decentralization commitments.
    ///
    ///         Set to Admin at construction; ratchets up whenever
    ///         acceptGovernor or executeRegression observes a phase >=
    ///         current hardFloor. Cannot be lowered.
    GovernancePhase public hardFloor;

    event HardFloorRaised(GovernancePhase indexed newHardFloor);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyGovernor() {
        require(msg.sender == governor, "E19");
        _;
    }

    /// @notice Admin/upgrade authority gate. Mirror of `onlyGovernor` but keyed
    ///         on `adminGovernor`. Used by `upgradeContract` + the regression
    ///         functions so admin/upgrade control is independent of the campaign
    ///         governor (which advances to OpenGov).
    modifier onlyAdminGovernor() {
        require(msg.sender == adminGovernor, "E19");
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _campaigns,
        address _lifecycle,
        address _governor
    ) {
        require(_campaigns != address(0), "E00");
        require(_lifecycle != address(0), "E00");
        require(_governor != address(0), "E00");
        campaigns = IDatumCampaignsMinimal(_campaigns);
        lifecycle = IDatumCampaignLifecycle(_lifecycle);
        governor = _governor;
        // Admin/upgrade authority defaults to the campaign governor so Phase-0
        // single-key behavior is unchanged until setAdminGovernor points it at
        // the Council (Option 2 — see CONTROL-MATRIX-MEMO.md §8).
        adminGovernor = _governor;
        phase = GovernancePhase.Admin;
    }

    /// @dev Accept ETH — slash payouts from lifecycle.terminateCampaign land here.
    receive() external payable {}

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice A10: Stage a new governor. The proposed address must subsequently
    ///         call `acceptGovernor()` from its own context to complete the handoff.
    ///         Called by the owner (Timelock) to advance through the ladder.
    function setGovernor(GovernancePhase newPhase, address newGovernor) external onlyOwner {
        require(newGovernor != address(0), "E00");
        // M4-fix: enforce monotonic decentralization. Once the floor has been
        // ratcheted (e.g. to Council), the Timelock owner cannot stage a
        // regression back to Admin. Honors the protocol's stated invariant
        // that governance becomes more community-driven over time.
        require(uint8(newPhase) >= uint8(phaseFloor), "below phase floor");
        // F-006 fix (2026-05-20): hard floor — survives executeRegression
        // resets of the soft phaseFloor. A compromised governor that
        // regresses to Admin cannot then re-stage any governor below the
        // highest decentralization level the protocol previously reached.
        require(uint8(newPhase) >= uint8(hardFloor), "below hard floor");
        pendingGovernor = newGovernor;
        pendingPhase = newPhase;
        emit GovernorProposed(newPhase, newGovernor);
    }

    /// @notice Point the admin/upgrade authority at a new address (the Council,
    ///         under Option 2). Owner-gated (Timelock), so the hand-off is
    ///         itself a timelocked governance action. Independent of the campaign
    ///         `governor` ladder. Direct set (no two-step): the campaign-governor
    ///         two-step exists to avoid bricking campaign routing on a dead
    ///         address; `adminGovernor` only gates upgrade/regression and a
    ///         mis-set value is correctable by a follow-up owner call.
    function setAdminGovernor(address newAdminGovernor) external onlyOwner {
        require(newAdminGovernor != address(0), "E00");
        emit AdminGovernorSet(adminGovernor, newAdminGovernor);
        adminGovernor = newAdminGovernor;
    }

    /// @notice M4-fix: permanently raise the phase floor to the current phase.
    ///         Anyone can call — there's no information asymmetry, and the
    ///         only state change is to LOCK the gradient at where it already is.
    ///         Refuses if the floor is already at or above the current phase.
    function raisePhaseFloor() external {
        require(uint8(phase) > uint8(phaseFloor), "floor already at phase");
        phaseFloor = phase;
        emit PhaseFloorRaised(phase);
    }

    /// @notice A10: The pending governor finalises the handoff. Proves the
    ///         caller controls the address (i.e., it isn't a typo'd EOA, an
    ///         unimplemented contract, or an attacker's stand-in).
    function acceptGovernor() external {
        address candidate = pendingGovernor;
        require(candidate != address(0), "E00");
        require(msg.sender == candidate, "E19");
        governor = candidate;
        phase = pendingPhase;
        pendingGovernor = address(0);
        // F-006 fix: ratchet hardFloor upward when we reach a higher
        // phase than ever before. Never decreases.
        if (uint8(pendingPhase) > uint8(hardFloor)) {
            hardFloor = pendingPhase;
            emit HardFloorRaised(pendingPhase);
        }
        emit PhaseTransitioned(pendingPhase, candidate);
    }

    /// @dev D1a plumbing-lock pattern: both setters gated by `plumbingLocked`.
    function setCampaigns(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("campaigns", address(campaigns), addr);
        campaigns = IDatumCampaignsMinimal(addr);
    }

    function setLifecycle(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("lifecycle", address(lifecycle), addr);
        lifecycle = IDatumCampaignLifecycle(addr);
    }

    /// @notice D1a: commit both Router refs permanently.
    /// @dev    Phase-gated on OpenGov to match the rest of the lock-once
    ///         surface (Stage 4). The router is the phase source so it
    ///         checks its own `phase` enum directly rather than going
    ///         through the IDatumRouter_Upgradable modifier.
    function lockPlumbing() external onlyOwner {
        require(phase == GovernancePhase.OpenGov, "not-opengov");
        require(!plumbingLocked, "already locked");
        require(address(campaigns) != address(0), "campaigns unset");
        require(address(lifecycle) != address(0), "lifecycle unset");
        plumbingLocked = true;
        emit PlumbingLocked();
    }

    /// @notice Sweep accumulated slash DOT to `to` (treasury/governance contract).
    /// @dev    Paseo-dust-safe via `_safeSend`; trailing dust queues for pull.
    function sweepTo(address payable to) external onlyOwner {
        require(to != address(0), "E00");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            _safeSend(to, bal);
        }
    }

    // -------------------------------------------------------------------------
    // Governance routing — called by the active governor
    // -------------------------------------------------------------------------

    /// @notice Activate a Pending campaign. Called by governor → campaigns.activateCampaign.
    function activateCampaign(uint256 campaignId) external onlyGovernor {
        campaigns.activateCampaign(campaignId);
    }

    /// @notice Terminate a campaign via governance. 10% slash ETH goes to this Router.
    function terminateCampaign(uint256 campaignId) external nonReentrant onlyGovernor {
        lifecycle.terminateCampaign(campaignId);
    }

    /// @notice Demote Active/Paused → Pending. Called by governor → lifecycle.demoteCampaign.
    function demoteCampaign(uint256 campaignId) external nonReentrant onlyGovernor {
        lifecycle.demoteCampaign(campaignId);
    }

    // -------------------------------------------------------------------------
    // Phase 0 (Admin) convenience — owner acts as governor directly.
    // Merged from DatumAdminGovernance. Gated on `phase == Admin` so the owner
    // (Timelock) cannot bypass the active governor in Phase 1 / Phase 2 (G-M1).
    // -------------------------------------------------------------------------

    modifier onlyAdminPhase() {
        require(phase == GovernancePhase.Admin, "E19");
        _;
    }

    /// @notice Owner-only campaign activation (Phase 0 only — see G-M1).
    function adminActivateCampaign(uint256 campaignId) external onlyOwner onlyAdminPhase {
        campaigns.activateCampaign(campaignId);
    }

    /// @notice Owner-only fault-free campaign termination (Phase 0 only — G-M1).
    /// @dev    Routes through lifecycle.adminTerminateCampaign: FULL refund to the
    ///         advertiser, NO slash. The 10% slash stays on the adjudicated
    ///         governor path (terminateCampaign) so an operator cannot skim escrow
    ///         by killing a campaign for spam/safety. reasonCode is an on-chain
    ///         transparency tag emitted in CampaignAdminTerminated.
    function adminTerminateCampaign(uint256 campaignId, uint16 reasonCode) external nonReentrant onlyOwner onlyAdminPhase {
        lifecycle.adminTerminateCampaign(campaignId, reasonCode);
    }

    /// @notice Owner-only campaign demotion (Phase 0 only — see G-M1).
    function adminDemoteCampaign(uint256 campaignId) external nonReentrant onlyOwner onlyAdminPhase {
        lifecycle.demoteCampaign(campaignId);
    }

    // -------------------------------------------------------------------------
    // CB5: Bicameral veto-window gate for high-tier OpenGov actions
    // -------------------------------------------------------------------------
    //
    // Linear governance ladder concentrates all authority in OpenGov once
    // reached. CB5 reintroduces the Council as a check on existential actions
    // (issuer transfer, policy locks, governance plumbing) without forcing
    // every routine action through dual approval.
    //
    // Flow:
    //   1. OpenGov passes a proposal that calls router.proposeHighTier(target, data)
    //   2. Router stages the call with a Council veto deadline = block + window
    //   3. Council can vetoHighTier(proposalId) during the window (msg.sender
    //      must be the wired Council contract — Council votes internally to
    //      reach that call). Stage is cancelled.
    //   4. If no veto, anyone calls executeHighTier(proposalId) after the
    //      window expires; router invokes target.call(data).
    //
    // Operators decide WHICH targets to route via high-tier by transferring
    // those contracts' ownership (or restricting their critical function
    // selectors) to the Router. Until that transfer, this surface exists
    // unused; once transferred, those calls MUST flow through here.

    address public council;
    uint256 public councilVetoWindowBlocks = 100800;          // ~7 days @ 6s blocks
    uint256 public constant MIN_COUNCIL_VETO_WINDOW = 14400;  // ~24h floor
    uint256 public constant MAX_COUNCIL_VETO_WINDOW = 302400; // ~21d ceiling

    struct HighTierProposal {
        address target;
        uint256 value;
        bytes   data;
        uint256 executableAfterBlock;
        bool    vetoed;
        bool    executed;
    }
    uint256 public nextHighTierId;
    mapping(uint256 => HighTierProposal) public highTierProposals;

    event CouncilSet(address indexed council);
    event CouncilVetoWindowSet(uint256 blocks);
    event HighTierProposed(uint256 indexed id, address indexed target, uint256 executableAfterBlock);
    event HighTierVetoed(uint256 indexed id);
    event HighTierExecuted(uint256 indexed id, bool success, bytes returndata);

    /// @notice CB5: wire the Council contract authorized to veto. Setting
    ///         address(0) disables the veto check (auto-execute after
    ///         window) — intended only for bootstrap before Council exists.
    /// @dev    F-007 fix (2026-05-20): post-`councilLocked`, the Council
    ///         pointer is frozen — no further mutation, including silent
    ///         re-zeroing — so the CB5 bicameral veto becomes a credible
    ///         commitment. Pre-lock owner-only as before.
    function setCouncil(address newCouncil) external onlyOwner {
        require(!councilLocked, "council-locked");
        council = newCouncil;
        emit CouncilSet(newCouncil);
    }

    /// @notice F-007 fix: cypherpunk lock — freeze the council pointer
    ///         permanently. After this fires, the Router owner (Timelock)
    ///         can no longer change or zero out the council, and the CB5
    ///         high-tier veto is anchored to a single Council contract
    ///         forever. Pattern matches lockBlocklistCurator /
    ///         lockTagCurator. Requires council to be non-zero at lock
    ///         time so the protocol cannot self-lock into "no veto".
    bool public councilLocked;
    event CouncilLocked();
    function lockCouncil() external onlyOwner {
        require(phase == GovernancePhase.OpenGov, "not-opengov");
        require(!councilLocked, "already-locked");
        require(council != address(0), "council unset");
        councilLocked = true;
        emit CouncilLocked();
    }

    function setCouncilVetoWindow(uint256 blocks) external onlyOwner {
        require(blocks >= MIN_COUNCIL_VETO_WINDOW, "below min");
        require(blocks <= MAX_COUNCIL_VETO_WINDOW, "above max");
        councilVetoWindowBlocks = blocks;
        emit CouncilVetoWindowSet(blocks);
    }

    /// @notice CB5: stage a high-tier action. Callable only by the current
    ///         governor (so OpenGov's vote outcome reaches this surface
    ///         through the same authorization path as activateCampaign etc.).
    ///         Refuses to stage when phase < Council since the veto-window
    ///         primitive presumes a Council exists.
    function proposeHighTier(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyGovernor returns (uint256 id) {
        require(uint8(phase) >= uint8(GovernancePhase.Council), "phase too low");
        require(target != address(0), "E00");
        require(target != address(this), "self-target"); // prevent reentrant config changes

        id = ++nextHighTierId;
        highTierProposals[id] = HighTierProposal({
            target: target,
            value: value,
            data: data,
            executableAfterBlock: block.number + councilVetoWindowBlocks,
            vetoed: false,
            executed: false
        });
        emit HighTierProposed(id, target, block.number + councilVetoWindowBlocks);
    }

    /// @notice CB5: Council vetoes a staged action. Council reaches this call
    ///         via its propose/vote/execute pipeline, so the veto is itself
    ///         threshold-gated — no unilateral council member can block.
    function vetoHighTier(uint256 id) external {
        require(council != address(0) && msg.sender == council, "E18");
        HighTierProposal storage p = highTierProposals[id];
        require(p.target != address(0), "E01");
        require(!p.executed && !p.vetoed, "E50");
        require(block.number < p.executableAfterBlock, "window closed");
        p.vetoed = true;
        emit HighTierVetoed(id);
    }

    /// @notice CB5: execute a staged action after the veto window expires.
    ///         Permissionless — anyone can pay the gas once eligible.
    function executeHighTier(uint256 id) external nonReentrant returns (bytes memory) {
        HighTierProposal storage p = highTierProposals[id];
        require(p.target != address(0), "E01");
        require(!p.executed && !p.vetoed, "E50");
        require(block.number >= p.executableAfterBlock, "still in veto window");
        p.executed = true;
        (bool ok, bytes memory ret) = p.target.call{value: p.value}(p.data);
        emit HighTierExecuted(id, ok, ret);
        require(ok, "high-tier exec failed");
        return ret;
    }

    // -------------------------------------------------------------------------
    // IDatumCampaignsMinimal passthrough
    // Used by DatumGovernanceV2 when govV2.campaigns = address(router)
    // -------------------------------------------------------------------------

    function getCampaignForSettlement(uint256 campaignId) external view returns (
        uint8 status,
        address publisher,
        uint16 snapshotTakeRateBps
    ) {
        return campaigns.getCampaignForSettlement(campaignId);
    }

    // -------------------------------------------------------------------------
    // Upgrade ladder (Stage 1) — registry of replaceable contracts
    //
    // Each contract in the deployment registers its canonical address here
    // (keyed by keccak256("name")). Governance-phase-gated upgrades replace
    // the live pointer while preserving history. Consumers can read
    // `currentAddrOf` to discover the live address of any registered
    // contract; setters across the codebase get re-wired by governance
    // batches at upgrade time.
    //
    // Authorization: `onlyAdminGovernor` — NOT the campaign `governor`.
    // Defaults to the deployer in Admin phase (one-tx iteration). Under
    // Option 2 the owner (Timelock) points `adminGovernor` at the Council, so
    // upgrades stay Council-driven even after the campaign governor advances to
    // OpenGov (GovernanceV2 has no upgrade call path). Each body's natural
    // delays apply (Council vote / veto window).
    //
    // See narrative-analysis/upgrade-ladder-design.md + CONTROL-MATRIX-MEMO.md §8.
    // -------------------------------------------------------------------------

    mapping(bytes32 => address)   public currentAddrOf;
    mapping(bytes32 => uint256)   public versionOf;
    mapping(bytes32 => address[]) public addressHistory;

    event ContractRegistered(bytes32 indexed name, address indexed addr);
    event ContractUpgraded(
        bytes32 indexed name,
        address indexed oldAddr,
        address indexed newAddr,
        uint256 newVersion
    );
    /// @notice Outcome of the best-effort freeze+migrate hooks inside
    ///         upgradeContract. False values are expected for targets that
    ///         pre-ran the two-tx flow (already-frozen / already-migrated)
    ///         or don't implement DatumUpgradable; operators alert on this
    ///         event instead of verifying out-of-band.
    event UpgradeHooksFired(bytes32 indexed name, bool freezeOk, bool migrateOk);

    /// @notice Initial registration of a contract address. Owner-only so the
    ///         deploy script can populate the registry post-deploy. Cannot
    ///         overwrite an existing entry — use upgradeContract for that.
    function register(bytes32 name, address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(currentAddrOf[name] == address(0), "already registered");
        currentAddrOf[name] = addr;
        versionOf[name] = 1;
        addressHistory[name].push(addr);
        emit ContractRegistered(name, addr);
    }

    /// @notice Phase-gated upgrade of a registered contract. Replaces the
    ///         live address, increments version, appends to history.
    ///         Re-wiring consumers (e.g., cache.setXcmDispatcher) is the
    ///         caller's responsibility — usually done as a batch in the
    ///         same governance proposal.
    /// @dev    F-009 fix (2026-05-20): atomically calls
    ///         `old.freeze()` and `new.migrate(old)` so the v2 carries
    ///         the predecessor's state and the v1 cannot serve writes
    ///         after the registry flips. Both calls wrapped in try/catch
    ///         because some registered contracts (e.g., mocks, future
    ///         module types) may not implement the Upgradable interface;
    ///         operators see the try-failure events and can react.
    function upgradeContract(bytes32 name, address newAddr) external onlyAdminGovernor {
        require(newAddr != address(0), "E00");
        address old = currentAddrOf[name];
        require(old != address(0), "not registered");
        require(newAddr != old, "no change");
        currentAddrOf[name] = newAddr;
        versionOf[name] += 1;
        addressHistory[name].push(newAddr);
        emit ContractUpgraded(name, old, newAddr, versionOf[name]);
        // F-009: best-effort freeze + migrate. Low-level `.call` so the
        // function gracefully no-ops for non-Upgradable targets (EOAs,
        // mocks, future module types) instead of bubbling solc's
        // "address has no code" check. High-level try/catch wouldn't
        // catch that solidity panic. Targets accept these calls via
        // onlyGovernanceOrRouter (U1 fix — msg.sender here is the router).
        // The two-tx flow (governor calls freeze/migrate directly before
        // rotating) stays valid: the hooks then revert already-frozen /
        // already-migrated and report false, which is benign.
        (bool freezeOk, ) = old.call(abi.encodeWithSignature("freeze()"));
        (bool migrateOk, ) = newAddr.call(abi.encodeWithSignature("migrate(address)", old));
        emit UpgradeHooksFired(name, freezeOk, migrateOk);
    }

    function addressHistoryLength(bytes32 name) external view returns (uint256) {
        return addressHistory[name].length;
    }

    // -------------------------------------------------------------------------
    // Phase regression (timelocked emergency step-back)
    //
    // The forward path (setGovernor → acceptGovernor) enforces
    // `newPhase >= phaseFloor` for monotonic decentralization. Regression
    // bypasses that floor by definition: the current-phase governor
    // proposes a step back, a 48h timelock fires, then anyone can execute.
    //
    // After execution, phaseFloor follows the regression downward, so
    // re-promotion via setGovernor + raisePhaseFloor is unblocked.
    //
    // Authorization: only the current governor can propose or cancel.
    // Execution is permissionless after timelock — anyone pays the gas.
    // -------------------------------------------------------------------------

    /// @notice Block delay between proposeRegression and executeRegression.
    ///         Tunable by owner (Timelock) within [MIN, MAX] bounds.
    ///         Default 28800 ≈ 48h at 6s/block. Tests on hardhat-local set
    ///         to MIN to keep mining cheap.
    uint256 public regressionTimelockBlocks = 28800;
    uint256 public constant MIN_REGRESSION_TIMELOCK = 14400;   // ~24h floor
    uint256 public constant MAX_REGRESSION_TIMELOCK = 100800;  // ~7d ceiling

    GovernancePhase public pendingRegressionPhase;
    address public pendingRegressionGovernor;
    uint256 public pendingRegressionExecutableAfterBlock;

    event RegressionTimelockSet(uint256 blocks);
    event RegressionProposed(
        GovernancePhase indexed newPhase,
        address indexed newGovernor,
        uint256 executableAfterBlock
    );
    event RegressionCancelled();
    event RegressionExecuted(
        GovernancePhase indexed newPhase,
        address indexed newGovernor
    );

    function setRegressionTimelock(uint256 blocks_) external onlyOwner {
        require(
            blocks_ >= MIN_REGRESSION_TIMELOCK && blocks_ <= MAX_REGRESSION_TIMELOCK,
            "E11"
        );
        regressionTimelockBlocks = blocks_;
        emit RegressionTimelockSet(blocks_);
    }

    /// @notice Stage a phase regression. Only the `adminGovernor` (Council under
    ///         Option 2) can call — the standing emergency body, not the campaign
    ///         governor (which at OpenGov has no call path here).
    ///         `newPhase` must be strictly below current phase.
    ///         `newGovernor` is the address that will take over at the new
    ///         phase (e.g., Council contract address when regressing
    ///         OpenGov → Council).
    function proposeRegression(GovernancePhase newPhase, address newGovernor)
        external onlyAdminGovernor
    {
        require(newGovernor != address(0), "E00");
        require(uint8(newPhase) < uint8(phase), "not a regression");
        require(pendingRegressionGovernor == address(0), "regression pending");
        pendingRegressionPhase = newPhase;
        pendingRegressionGovernor = newGovernor;
        pendingRegressionExecutableAfterBlock = block.number + regressionTimelockBlocks;
        emit RegressionProposed(newPhase, newGovernor, pendingRegressionExecutableAfterBlock);
    }

    /// @notice Cancel a pending regression. Only the `adminGovernor` —
    ///         the same authority that proposed it. Prevents a malicious
    ///         executor from waiting out the timelock on an aborted proposal.
    function cancelRegression() external onlyAdminGovernor {
        require(pendingRegressionGovernor != address(0), "no pending");
        pendingRegressionPhase = GovernancePhase.Admin;  // reset
        pendingRegressionGovernor = address(0);
        pendingRegressionExecutableAfterBlock = 0;
        emit RegressionCancelled();
    }

    /// @notice F-008 fix (2026-05-20): executeRegression now stages the
    ///         regressed-to governor as `pendingGovernor`; the candidate
    ///         must call `acceptGovernor()` from its own context to
    ///         finalize. Mirrors the forward `setGovernor` two-step,
    ///         protecting against typo'd / dead-contract regression
    ///         targets that would leave the router with a non-existent
    ///         governor and no recovery path.
    function executeRegression() external {
        require(pendingRegressionGovernor != address(0), "no pending");
        require(block.number >= pendingRegressionExecutableAfterBlock, "still in timelock");

        GovernancePhase newPhase = pendingRegressionPhase;
        address newGovernor = pendingRegressionGovernor;

        // F-008: stage as pendingGovernor; require acceptGovernor() to
        // finalize. Phase + soft floor reset happen here (the regression
        // intent is committed) but actual governor transfer waits on the
        // candidate's accept. During the window, the existing governor
        // remains active.
        pendingGovernor = newGovernor;
        pendingPhase = newPhase;
        // Soft floor follows the regression down to unblock re-promotion.
        // Hard floor (F-006) is unaffected; the candidate's setGovernor
        // attempts remain bounded by it.
        phaseFloor = newPhase;

        pendingRegressionPhase = GovernancePhase.Admin;
        pendingRegressionGovernor = address(0);
        pendingRegressionExecutableAfterBlock = 0;

        emit RegressionExecuted(newPhase, newGovernor);
        // Note: governor / phase flip happens at acceptGovernor time, not
        // here. acceptGovernor performs the actual transition + emits
        // PhaseTransitioned.
    }
}
