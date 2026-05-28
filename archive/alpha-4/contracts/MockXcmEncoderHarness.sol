// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./lib/XcmTransactEncoder.sol";

/// @title MockXcmEncoderHarness
/// @notice Test-only wrapper exposing XcmTransactEncoder's internal functions
///         as externals so unit tests can call them directly.
contract MockXcmEncoderHarness {
    function compact(uint256 v) external pure returns (bytes memory) {
        return XcmTransactEncoder.compact(v);
    }

    function locationParentRelay() external pure returns (bytes memory) {
        return XcmTransactEncoder.locationParentRelay();
    }

    function fungibleRelayAsset(uint128 amount) external pure returns (bytes memory) {
        return XcmTransactEncoder.fungibleRelayAsset(amount);
    }

    function fungibleRelayAssets(uint128 amount) external pure returns (bytes memory) {
        return XcmTransactEncoder.fungibleRelayAssets(amount);
    }

    function withdrawAsset(uint128 amount) external pure returns (bytes memory) {
        return XcmTransactEncoder.withdrawAsset(amount);
    }

    function buyExecutionUnlimited(uint128 fees) external pure returns (bytes memory) {
        return XcmTransactEncoder.buyExecutionUnlimited(fees);
    }

    function payFees(uint128 fees) external pure returns (bytes memory) {
        return XcmTransactEncoder.payFees(fees);
    }

    function transactSovereign(uint64 refTime, uint64 proofSize, bytes calldata callData)
        external pure returns (bytes memory)
    {
        return XcmTransactEncoder.transactSovereign(refTime, proofSize, callData);
    }

    function encodeIdentityQueryCall(uint8 palletIndex, uint8 callIndex, bytes32 user)
        external pure returns (bytes memory)
    {
        return XcmTransactEncoder.encodeIdentityQueryCall(palletIndex, callIndex, user);
    }

    function encodeIdentityQueryXcm(
        bytes32 user,
        uint128 feePlanck,
        uint64  refTime,
        uint64  proofSize,
        uint8   palletIndex,
        uint8   callIndex
    ) external pure returns (bytes memory) {
        return XcmTransactEncoder.encodeIdentityQueryXcm(
            user, feePlanck, refTime, proofSize, palletIndex, callIndex
        );
    }
}
