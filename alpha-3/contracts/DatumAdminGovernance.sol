// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title DatumAdminGovernance
/// @notice Phase 0 governance: team multisig (owner) directly approves or
///         rejects campaigns with no on-chain voting delay.
///
///         In production the owner should be a Gnosis Safe multisig.
///         Deploy, then call router.setGovernor(Admin, address(this))
///         (via Timelock or directly during initial setup).
///
///         Transition to Phase 1 (Council):
///           owner → calls router.setGovernor(Council, councilAddr)
///           (The owner of the Router is the Timelock, so this goes through a 48h queue.)
contract DatumAdminGovernance is Ownable2Step {
    address public router;

    event CampaignActivated(uint256 indexed campaignId);
    event CampaignTerminated(uint256 indexed campaignId);
    event CampaignDemoted(uint256 indexed campaignId);

    constructor(address _router) Ownable(msg.sender) {
        require(_router != address(0), "E00");
        router = _router;
    }

    // -------------------------------------------------------------------------
    // Governance actions (called by owner — team multisig)
    // -------------------------------------------------------------------------

    /// @notice Approve a Pending campaign for activation.
    function activateCampaign(uint256 campaignId) external onlyOwner {
        (bool ok,) = router.call(
            abi.encodeWithSelector(bytes4(keccak256("activateCampaign(uint256)")), campaignId)
        );
        require(ok, "E02");
        emit CampaignActivated(campaignId);
    }

    /// @notice Terminate a campaign (10% slash to Router, 90% refund to advertiser).
    function terminateCampaign(uint256 campaignId) external onlyOwner {
        (bool ok,) = router.call(
            abi.encodeWithSelector(bytes4(keccak256("terminateCampaign(uint256)")), campaignId)
        );
        require(ok, "E02");
        emit CampaignTerminated(campaignId);
    }

    /// @notice Demote an Active/Paused campaign back to Pending for re-evaluation.
    function demoteCampaign(uint256 campaignId) external onlyOwner {
        (bool ok,) = router.call(
            abi.encodeWithSelector(bytes4(keccak256("demoteCampaign(uint256)")), campaignId)
        );
        require(ok, "E02");
        emit CampaignDemoted(campaignId);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "E00");
        router = _router;
    }

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }
}
