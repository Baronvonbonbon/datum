// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumSettlement
/// @notice Interface for DATUM claim settlement (alpha-2).
///         Pull-payment balances and withdrawals moved to IDatumPaymentVault.
interface IDatumSettlement {
    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct Claim {
        uint256 campaignId;
        address publisher;
        uint256 impressionCount;
        uint256 clearingCpmPlanck;
        uint256 nonce;
        bytes32 previousClaimHash;
        bytes32 claimHash;
        bytes zkProof;
        bytes32 nullifier;   // FP-5: Poseidon(userSecret, campaignId, windowId); bytes32(0) = skip registry
    }

    struct ClaimBatch {
        address user;
        uint256 campaignId;
        Claim[] claims;
    }

    /// @notice Cross-campaign batching structs (settleClaimsMulti).
    struct CampaignClaims {
        uint256 campaignId;
        Claim[] claims;
    }

    struct UserClaimBatch {
        address user;
        CampaignClaims[] campaigns;
    }

    struct SignedClaimBatch {
        address user;
        uint256 campaignId;
        Claim[] claims;
        uint256 deadline;
        bytes signature;
        bytes publisherSig;
    }

    struct SettlementResult {
        uint256 settledCount;
        uint256 rejectedCount;
        uint256 totalPaid;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ClaimSettled(
        uint256 indexed campaignId,
        address indexed user,
        address indexed publisher,
        uint256 impressionCount,
        uint256 clearingCpmPlanck,
        uint256 nonce,
        uint256 publisherPayment,
        uint256 userPayment,
        uint256 protocolFee
    );
    event ClaimRejected(
        uint256 indexed campaignId,
        address indexed user,
        uint256 nonce,
        uint8 reasonCode
    );
    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    function settleClaims(ClaimBatch[] calldata batches) external returns (SettlementResult memory result);

    /// @notice Settle claims for multiple users across multiple campaigns in one TX.
    ///         Max 10 users, 10 campaigns per user, 50 claims per campaign.
    function settleClaimsMulti(UserClaimBatch[] calldata batches) external returns (SettlementResult memory result);

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function lastNonce(address user, uint256 campaignId) external view returns (uint256);
    function lastClaimHash(address user, uint256 campaignId) external view returns (bytes32);
}
