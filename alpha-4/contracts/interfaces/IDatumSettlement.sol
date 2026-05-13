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
        bytes32 clickSessionHash;    // type-1 only: keccak256(user, campaignId, impressionNonce); bytes32(0) for others
        uint256 nonce;
        bytes32 previousClaimHash;
        bytes32 claimHash;
        bytes32[8] zkProof;          // Groth16/BN254: 8 × uint256 (256 bytes); all-zero = no proof
        bytes32 nullifier;           // FP-5: Poseidon(userSecret, campaignId, windowId); bytes32(0) = skip
        bytes32[3] actionSig;        // type-2 only: ECDSA [r, s, v-as-bytes32]; all-zero = no sig
        bytes32 powNonce;            // #5: PoW solver output; keccak256(claimHash||powNonce) must satisfy target when enforcePow is on
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

    /// @notice Multi-signed claim batch supporting two settlement paths:
    ///         1. Relay path (settleClaimsFor): userSig + optional publisherSig.
    ///            Relay verifies user EIP-712 sig, forwards to settleClaims.
    ///         2. Dual-sig path (settleSignedClaims): publisherSig + advertiserSig.
    ///            Both parties sign; anyone can submit (permissionless relay).
    ///            Either party can refute by withholding their signature.
    struct SignedClaimBatch {
        address user;
        uint256 campaignId;
        Claim[] claims;
        uint256 deadlineBlock;   // A9: block.number expiry — matches DatumRelay for unit-uniformity
        address expectedRelaySigner;            // A1: publisher's relay signer at sign time; address(0) = require strict publisher EOA sig
        address expectedAdvertiserRelaySigner;  // M6: advertiser's relay signer at sign time; address(0) = require strict advertiser EOA sig
        bytes userSig;           // EIP-712 ECDSA from the user (relay path)
        bytes publisherSig;      // EIP-712 ECDSA from the campaign's publisher (or their relaySigner)
        bytes advertiserSig;     // EIP-712 ECDSA from the campaign's advertiser (or their advertiserRelaySigner)
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

    /// @notice Settle claims with dual EIP-712 signatures from both publisher and advertiser.
    ///         Anyone can submit (permissionless relay). Both signatures must cover the
    ///         same (user, campaignId, claimsHash, deadline) typed data. Either party
    ///         can refute claims by withholding their signature.
    function settleSignedClaims(SignedClaimBatch[] calldata batches) external returns (SettlementResult memory result);

    // -------------------------------------------------------------------------
    // Views — triple-keyed by (user, campaignId, actionType)
    // -------------------------------------------------------------------------

    function lastNonce(address user, uint256 campaignId, uint8 actionType) external view returns (uint256);
    function lastClaimHash(address user, uint256 campaignId, uint8 actionType) external view returns (bytes32);
}
