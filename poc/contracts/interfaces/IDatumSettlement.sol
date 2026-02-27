// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDatumSettlement
/// @notice Interface for DATUM claim settlement and payment distribution
interface IDatumSettlement {
    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    /// @notice A single claim submitted for settlement
    struct Claim {
        uint256 campaignId;
        address publisher;
        uint256 impressionCount;
        uint256 clearingCpmPlanck;   // Actual clearing CPM (must be <= campaign bidCpmPlanck)
        uint256 nonce;               // Sequential claim nonce per user per campaign
        bytes32 previousClaimHash;   // Hash of prior claim (bytes32(0) for genesis)
        bytes32 claimHash;           // Hash of this claim (computed and verified on-chain)
        bytes zkProof;               // ZK proof of auction outcome — reserved, not validated in MVP
    }

    /// @notice A batch of claims for one user on one campaign
    /// @dev A4 fix: campaignId field enforces all claims in the batch belong to the same campaign
    struct ClaimBatch {
        address user;
        uint256 campaignId;  // All claims in this batch must have this campaignId
        Claim[] claims;
    }

    /// @notice Result summary from a settleClaims() call
    struct SettlementResult {
        uint256 settledCount;   // Number of claims successfully settled
        uint256 rejectedCount;  // Number of claims rejected (gap or invalid)
        uint256 totalPaid;      // Total DOT (in planck) paid out across all parties
    }

    // -------------------------------------------------------------------------
    // Rejection reason codes (replaces string reason in ClaimRejected event)
    // -------------------------------------------------------------------------

    // 0 = campaignId mismatch
    // 1 = subsequent to gap
    // 2 = zero impressions
    // 3 = campaign not found
    // 4 = campaign not active
    // 5 = publisher mismatch
    // 6 = CPM exceeds bid
    // 7 = nonce gap
    // 8 = genesis must have zero previousHash
    // 9 = invalid previousClaimHash
    // 10 = invalid claimHash
    // 11 = insufficient budget

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
    event PublisherWithdrawal(address indexed publisher, uint256 amount);
    event UserWithdrawal(address indexed user, uint256 amount);
    event ProtocolWithdrawal(address indexed recipient, uint256 amount);

    // -------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------

    /// @notice Settle a batch of claims; must be called by batch.user
    /// @dev Processes claims in nonce order; stops at first gap; hash chain verified
    /// @param batches Array of per-user claim batches
    /// @return result Summary of settled vs rejected counts and total paid
    function settleClaims(ClaimBatch[] calldata batches) external returns (SettlementResult memory result);

    // -------------------------------------------------------------------------
    // Pull payment withdrawals
    // -------------------------------------------------------------------------

    /// @notice Withdraw accumulated publisher payments
    function withdrawPublisher() external;

    /// @notice Withdraw accumulated user payments
    function withdrawUser() external;

    /// @notice Withdraw accumulated protocol fees (owner only)
    /// @param recipient Address to send fees to
    function withdrawProtocol(address recipient) external;

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function publisherBalance(address publisher) external view returns (uint256);
    function userBalance(address user) external view returns (uint256);
    function protocolBalance() external view returns (uint256);
    function lastNonce(address user, uint256 campaignId) external view returns (uint256);
    function lastClaimHash(address user, uint256 campaignId) external view returns (bytes32);
}
