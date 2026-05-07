// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
contract DatumGovernanceRouter is DatumOwnable, ReentrancyGuard {

    // -------------------------------------------------------------------------
    // Phase enum
    // -------------------------------------------------------------------------

    enum GovernancePhase { Admin, Council, OpenGov }

    // -------------------------------------------------------------------------
    // Config
    // -------------------------------------------------------------------------

    GovernancePhase public phase;
    address public governor;

    IDatumCampaignsMinimal public campaigns;
    IDatumCampaignLifecycle public lifecycle;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event PhaseTransitioned(GovernancePhase indexed newPhase, address indexed newGovernor);
    event ContractReferenceChanged(string name, address oldAddr, address newAddr);

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

    /// @notice Update the active governance contract and phase label.
    ///         Called by the owner (Timelock) to advance through the ladder.
    function setGovernor(GovernancePhase newPhase, address newGovernor) external onlyOwner {
        require(newGovernor != address(0), "E00");
        governor = newGovernor;
        phase = newPhase;
        emit PhaseTransitioned(newPhase, newGovernor);
    }

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("campaigns", address(campaigns), addr);
        campaigns = IDatumCampaignsMinimal(addr);
    }

    function setLifecycle(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        emit ContractReferenceChanged("lifecycle", address(lifecycle), addr);
        lifecycle = IDatumCampaignLifecycle(addr);
    }

    /// @notice Sweep accumulated slash ETH to `to` (treasury/governance contract).
    function sweepTo(address payable to) external onlyOwner {
        require(to != address(0), "E00");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            require(ok, "E02");
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
    // Phase 0 (Admin) convenience — owner acts as governor directly
    // Merged from DatumAdminGovernance. In Admin phase, owner can bypass
    // the governor contract and call these directly.
    // -------------------------------------------------------------------------

    /// @notice Owner-only campaign activation (Phase 0 shortcut).
    function adminActivateCampaign(uint256 campaignId) external onlyOwner {
        campaigns.activateCampaign(campaignId);
    }

    /// @notice Owner-only campaign termination (Phase 0 shortcut).
    function adminTerminateCampaign(uint256 campaignId) external nonReentrant onlyOwner {
        lifecycle.terminateCampaign(campaignId);
    }

    /// @notice Owner-only campaign demotion (Phase 0 shortcut).
    function adminDemoteCampaign(uint256 campaignId) external nonReentrant onlyOwner {
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
