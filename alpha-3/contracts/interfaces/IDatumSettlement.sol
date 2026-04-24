// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumSettlement
/// @notice Interface for DATUM claim settlement (alpha-3 multi-pricing).
///         Supports view (CPM), click (CPC), and remote-action (CPA) claim types.
interface IDatumSettlement {
    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct Claim {
        uint256 campaignId;
        address publisher;
        uint256 eventCount;          // number of events (impressions, clicks, or actions)
        uint256 ratePlanck;          // clearing rate: per-1000 for view, flat per-event for click/action
        uint8   actionType;          // 0=view, 1=click, 2=remote-action
        bytes32 clickSessionHash;    // type-1 only: blake2(user, campaignId, impressionNonce); bytes32(0) for others
        uint256 nonce;
        bytes32 previousClaimHash;
        bytes32 claimHash;
        bytes   zkProof;             // Groth16 proof bytes; empty if not required
        bytes32 nullifier;           // FP-5: Poseidon(userSecret, campaignId, windowId); bytes32(0) = skip
        bytes   actionSig;           // type-2 only: ECDSA sig from actionVerifier EOA over claimHash
    }

    struct ClaimBatch {
        address user;
        uint256 campaignId;
        Claim[] claims;
    }

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
        uint256 eventCount,
        uint256 ratePlanck,
        uint8   actionType,
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
    // Views — triple-keyed by (user, campaignId, actionType)
    // -------------------------------------------------------------------------

    function lastNonce(address user, uint256 campaignId, uint8 actionType) external view returns (uint256);
    function lastClaimHash(address user, uint256 campaignId, uint8 actionType) external view returns (bytes32);
}
