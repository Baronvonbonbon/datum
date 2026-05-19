// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./interfaces/IXcm.sol";

/// @title MockXcmPrecompile
/// @notice Test-only stand-in for the Polkadot XCM precompile.
///         Records dispatched messages so tests can assert on them,
///         and forwards `weighMessage` to a configurable response so
///         tests can simulate weight-too-low / weight-OK paths.
///
///         Mirrors the AssetHubPrecompileMock pattern used elsewhere
///         in the codebase (storage + onlyOwner setters + events).
contract MockXcmPrecompile is IXcm {
    struct Dispatch {
        address caller;
        uint256 value;
        bytes   message;
        Weight  weight;
    }

    Dispatch[] private _dispatched;

    /// @notice Weight returned by `weighMessage` for any payload. Tests can
    ///         tune this to simulate the precompile's estimate.
    Weight public weighResponse = Weight({refTime: 1_000_000_000, proofSize: 100_000});

    /// @notice If true, `execute` reverts with "weight-too-low" when the
    ///         caller supplies a Weight below `weighResponse`. Off by default
    ///         (most tests don't care about exact weight semantics).
    bool public strictWeight;

    event MessageDispatched(address indexed caller, uint256 value, uint256 messageLen);
    event WeighRequested(uint256 messageLen);

    /// @inheritdoc IXcm
    function weighMessage(bytes calldata message) external view returns (Weight memory) {
        message; // silence unused
        return weighResponse;
    }

    /// @inheritdoc IXcm
    function execute(bytes calldata message, Weight calldata weight) external payable {
        if (strictWeight) {
            require(weight.refTime   >= weighResponse.refTime,   "weight-too-low");
            require(weight.proofSize >= weighResponse.proofSize, "weight-too-low");
        }
        _dispatched.push(Dispatch({
            caller:  msg.sender,
            value:   msg.value,
            message: message,
            weight:  weight
        }));
        emit MessageDispatched(msg.sender, msg.value, message.length);
    }

    /// @inheritdoc IXcm
    function send(bytes calldata destination, bytes calldata message) external payable {
        // Not used by the identity bridge; declared for completeness.
        destination; message;
    }

    // ── Test introspection ───────────────────────────────────────────────

    function dispatchedCount() external view returns (uint256) {
        return _dispatched.length;
    }

    function dispatchedAt(uint256 i) external view returns (Dispatch memory) {
        return _dispatched[i];
    }

    function lastDispatch() external view returns (Dispatch memory) {
        require(_dispatched.length > 0, "no-dispatch");
        return _dispatched[_dispatched.length - 1];
    }

    // ── Test configuration ───────────────────────────────────────────────

    function setWeighResponse(uint64 refTime, uint64 proofSize) external {
        weighResponse = Weight({refTime: refTime, proofSize: proofSize});
    }

    function setStrictWeight(bool v) external {
        strictWeight = v;
    }

    function resetDispatched() external {
        delete _dispatched;
    }
}
