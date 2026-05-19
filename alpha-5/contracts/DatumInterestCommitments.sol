// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title DatumInterestCommitments
/// @notice Path A: per-user Merkle root commitments over the user's chosen
///         interest categories. The ZK circuit proves `requiredCategory` is a
///         leaf under `interestRoot` without revealing the rest of the set.
///
///         Users may update their commitment at will — doing so invalidates
///         any in-flight proofs that referenced the previous root. To avoid
///         claim losses, wallets should regenerate proofs immediately after
///         calling `setInterestCommitment` and before submitting batches.
contract DatumInterestCommitments {
    /// @notice One commitment per user.
    mapping(address => bytes32) public interestRoot;

    /// @notice block.number at which the user last updated their commitment.
    ///         Surfaced so settlement / validation can optionally enforce a
    ///         freshness window (e.g. "must be at least N blocks old to use")
    ///         which mitigates last-second commitment swaps to dodge targeting.
    mapping(address => uint256) public lastSetBlock;

    event InterestCommitmentSet(address indexed user, bytes32 root, uint256 atBlock);

    /// @notice Publish a commitment to your interest set.
    ///         `root` is a 4-level Merkle root over your 16 chosen category ids.
    ///         Reset by calling again. Set to bytes32(0) to clear.
    function setInterestCommitment(bytes32 root) external {
        interestRoot[msg.sender] = root;
        lastSetBlock[msg.sender] = block.number;
        emit InterestCommitmentSet(msg.sender, root, block.number);
    }
}
