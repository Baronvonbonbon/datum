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
