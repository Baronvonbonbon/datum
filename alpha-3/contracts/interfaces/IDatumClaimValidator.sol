// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./IDatumSettlement.sol";

/// @title IDatumClaimValidator
/// @notice Validates settlement claims — extracted from Settlement for PVM headroom.
interface IDatumClaimValidator {
    /// @notice Validate a single claim against on-chain state.
    /// @param claim The claim to validate
    /// @param user The claiming user
    /// @param expectedNonce The expected nonce (lastNonce + 1)
    /// @param expectedPrevHash The expected previous claim hash (lastClaimHash)
    /// @return valid Whether the claim passed all checks
    /// @return reasonCode Rejection reason (0 = valid)
    /// @return takeRate Publisher take rate in bps
    /// @return computedHash The computed claim hash for storage
    function validateClaim(
        IDatumSettlement.Claim calldata claim,
        address user,
        uint256 expectedNonce,
        bytes32 expectedPrevHash
    ) external view returns (bool valid, uint8 reasonCode, uint16 takeRate, bytes32 computedHash);
}
