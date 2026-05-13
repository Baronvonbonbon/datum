// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumCampaignsMinimal.sol";
import "./interfaces/IDatumCampaignLifecycle.sol";

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

    /// @notice M4-fix: monotonic phase floor. setGovernor refuses any proposal
    ///         that would move `phase` below `phaseFloor`. Permanently writes
    ///         the current phase as a floor when raisePhaseFloor() is called.
    ///         Anyone can call to ratchet the floor up to the current phase.
    ///         There is no path to lower the floor.
    GovernancePhase public phaseFloor;

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyGovernor() {
        require(msg.sender == governor, "E19");
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
        pendingGovernor = newGovernor;
        pendingPhase = newPhase;
        emit GovernorProposed(newPhase, newGovernor);
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
    function lockPlumbing() external onlyOwner {
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

    /// @notice Owner-only campaign termination (Phase 0 only — see G-M1).
    function adminTerminateCampaign(uint256 campaignId) external nonReentrant onlyOwner onlyAdminPhase {
        lifecycle.terminateCampaign(campaignId);
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

    /// @notice CB5: wire the Council contract authorized to veto. Lock-free
    ///         by design — Council rotation IS routed through the Router-
    ///         owner (Timelock), which is the appropriate authority to
    ///         change which body holds the veto. Setting address(0) disables
    ///         the veto check (auto-execute after window) — intended only
    ///         for bootstrap before Council exists.
    function setCouncil(address newCouncil) external onlyOwner {
        council = newCouncil;
        emit CouncilSet(newCouncil);
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
}
