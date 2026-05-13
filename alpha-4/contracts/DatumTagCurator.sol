// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./interfaces/IDatumTagCurator.sol";

/// @title DatumTagCurator
/// @notice M5-fix: council-driven tag-approval registry. Plugs into
///         DatumCampaigns as `setTagCurator(this)`. Mutations are gated to a
///         designated council address (typically the DatumCouncil contract),
///         which drives approve/remove via its propose+vote+execute pipeline.
///
///         Mirrors the cypherpunk lock pattern of DatumCouncilBlocklistCurator:
///         the owner (Timelock) can rotate the council pointer up until
///         `lockCouncil()` is called, after which the pointer is permanently
///         frozen.
///
///         Backwards-compat: when no curator is wired on Campaigns, the
///         legacy Campaigns.approvedTags mapping is the source of truth. A
///         curator is queried IN ADDITION to (an OR over) the legacy mapping
///         so a Phase-0 rollout can pre-seed via Campaigns.approveTag, then
///         transition to curator-driven approvals without losing state.
contract DatumTagCurator is IDatumTagCurator, DatumOwnable {
    address public council;
    bool public councilLocked;

    mapping(bytes32 => bool) private _approved;

    event CouncilSet(address indexed council);
    event CouncilLocked();
    event TagApproved(bytes32 indexed tag);
    event TagRemoved(bytes32 indexed tag);

    modifier onlyCouncil() {
        require(council != address(0) && msg.sender == council, "E18");
        _;
    }

    function setCouncil(address newCouncil) external onlyOwner {
        require(!councilLocked, "council-locked");
        council = newCouncil;
        emit CouncilSet(newCouncil);
    }

    function lockCouncil() external onlyOwner {
        require(!councilLocked, "already locked");
        require(council != address(0), "council unset");
        councilLocked = true;
        emit CouncilLocked();
    }

    function approveTag(bytes32 tag) external onlyCouncil {
        require(tag != bytes32(0), "E00");
        _approved[tag] = true;
        emit TagApproved(tag);
    }

    function removeTag(bytes32 tag) external onlyCouncil {
        require(tag != bytes32(0), "E00");
        _approved[tag] = false;
        emit TagRemoved(tag);
    }

    /// @inheritdoc IDatumTagCurator
    function isTagApproved(bytes32 tag) external view returns (bool) {
        return _approved[tag];
    }
}
