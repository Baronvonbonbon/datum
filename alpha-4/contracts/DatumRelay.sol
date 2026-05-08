// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./DatumOwnable.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumRelay
/// @notice Publisher relay for claim settlement via EIP-712 user signatures.
///         H-4: Optional authorized relayer list with liveness fallback.
///         H-6: Settlement and campaigns references are now mutable (Ownable2Step).
///         L-1: Inherits OZ EIP712 so the domain separator rebuilds on chainid
///              mismatch (chain-fork safe).
contract DatumRelay is DatumOwnable, EIP712 {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    bytes32 private constant BATCH_TYPEHASH = keccak256(
        "ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,uint256 lastNonce,uint256 claimCount,uint256 deadline)"
    );

    bytes32 private constant PUBLISHER_ATTESTATION_TYPEHASH = keccak256(
        "PublisherAttestation(uint256 campaignId,address user,uint256 firstNonce,uint256 lastNonce,uint256 claimCount)"
    );

    // -------------------------------------------------------------------------
    // State (H-6: mutable references instead of immutable)
    // -------------------------------------------------------------------------

    IDatumSettlement public settlement;
    IDatumCampaignsSettlement public campaigns;

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public immutable pauseRegistry;

    // -------------------------------------------------------------------------
    // H-4: Authorized relayers
    // -------------------------------------------------------------------------

    mapping(address => bool) public authorizedRelayers;
    uint256 public authorizedRelayerCount;
    /// @notice If relay is down for > livenessThresholdBlocks, anyone can submit (liveness guarantee).
    ///         0 = permissionless (no relayer restriction).
    uint256 public livenessThresholdBlocks;
    /// @notice Last block at which an authorized relayer submitted a batch.
    uint256 public lastRelayBlock;

    event RelayerAuthorized(address indexed relayer, bool authorized);
    event SettlementUpdated(address indexed newSettlement);
    event CampaignsUpdated(address indexed newCampaigns);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _settlement, address _campaigns, address _pauseRegistry)
        EIP712("DatumRelay", "1")
    {
        require(_settlement != address(0), "E00");
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        settlement = IDatumSettlement(_settlement);
        campaigns = IDatumCampaignsSettlement(_campaigns);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
    }

    /// @notice Returns the current EIP-712 domain separator. Rebuilds automatically
    ///         on chainid mismatch via OZ EIP712 (L-1).
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // -------------------------------------------------------------------------
    // Admin (H-6)
    // -------------------------------------------------------------------------

    function setSettlement(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlement = IDatumSettlement(addr);
        emit SettlementUpdated(addr);
    }

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaigns = IDatumCampaignsSettlement(addr);
        emit CampaignsUpdated(addr);
    }

    /// @notice Add or remove an authorized relayer (H-4).
    function setRelayerAuthorized(address relayer, bool authorized) external onlyOwner {
        require(relayer != address(0), "E00");
        if (authorized && !authorizedRelayers[relayer]) {
            authorizedRelayers[relayer] = true;
            authorizedRelayerCount++;
        } else if (!authorized && authorizedRelayers[relayer]) {
            authorizedRelayers[relayer] = false;
            authorizedRelayerCount--;
        }
        emit RelayerAuthorized(relayer, authorized);
    }

    /// @notice Set the liveness fallback threshold. If no authorized relayer submits
    ///         within this many blocks, anyone can submit. 0 = always permissionless.
    function setLivenessThreshold(uint256 blocks) external onlyOwner {
        livenessThresholdBlocks = blocks;
    }

    // -------------------------------------------------------------------------
    // Relay settlement
    // -------------------------------------------------------------------------

    function settleClaimsFor(IDatumSettlement.SignedClaimBatch[] calldata batches)
        external
        returns (IDatumSettlement.SettlementResult memory result)
    {
        require(!pauseRegistry.paused(), "P");

        // H-4: Relayer authorization check with liveness fallback
        if (authorizedRelayerCount > 0) {
            if (authorizedRelayers[msg.sender]) {
                lastRelayBlock = block.number;
            } else {
                // Liveness fallback: if no authorized relayer submitted recently, allow anyone
                require(
                    livenessThresholdBlocks > 0 &&
                    block.number > lastRelayBlock + livenessThresholdBlocks,
                    "E18"
                );
            }
        }

        require(batches.length <= 10, "E28");
        IDatumSettlement.ClaimBatch[] memory forwardBatches = new IDatumSettlement.ClaimBatch[](batches.length);

        for (uint256 b = 0; b < batches.length; b++) {
            IDatumSettlement.SignedClaimBatch calldata sb = batches[b];
            require(block.number <= sb.deadline, "E29");
            require(sb.claims.length > 0, "E28");

            // EIP-712 user signature verification.
            // L-1: digest built via OZ EIP712 base (`_hashTypedDataV4`) so the
            // domain separator rebuilds on chainid mismatch (chain-fork safe).
            // Recovery uses manual ecrecover to preserve E30/E31 error codes
            // that off-chain clients depend on.
            bytes32 structHash = keccak256(abi.encode(
                BATCH_TYPEHASH,
                sb.user,
                sb.campaignId,
                sb.claims[0].nonce,
                sb.claims[sb.claims.length - 1].nonce,
                sb.claims.length,
                sb.deadline
            ));
            bytes32 digest = _hashTypedDataV4(structHash);

            bytes calldata sig = sb.userSig;
            require(sig.length == 65, "E30");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(sig.offset)
                s := calldataload(add(sig.offset, 32))
                v := byte(0, calldataload(add(sig.offset, 64)))
            }
            require(v == 27 || v == 28, "E30"); // AUDIT-006: validate v before ecrecover
            require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "E30");
            address signer = ecrecover(digest, v, r, s);
            require(signer != address(0) && signer == sb.user, "E31");

            // Publisher co-signature (3-value return)
            if (sb.publisherSig.length > 0) {
                (, address cPublisher,) = campaigns.getCampaignForSettlement(sb.campaignId);
                address expectedPub = cPublisher;
                if (expectedPub == address(0)) {
                    expectedPub = sb.claims[0].publisher;
                    // SM-1: Verify all claims target the same publisher for open campaigns
                    for (uint256 i = 1; i < sb.claims.length; i++) {
                        require(sb.claims[i].publisher == expectedPub, "E34");
                    }
                }
                if (expectedPub != address(0)) {
                    bytes32 pubStructHash = keccak256(abi.encode(
                        PUBLISHER_ATTESTATION_TYPEHASH,
                        sb.campaignId,
                        sb.user,
                        sb.claims[0].nonce,
                        sb.claims[sb.claims.length - 1].nonce,
                        sb.claims.length
                    ));
                    bytes32 pubDigest = _hashTypedDataV4(pubStructHash);

                    bytes calldata pubSig = sb.publisherSig;
                    require(pubSig.length == 65, "E33");
                    bytes32 pr;
                    bytes32 ps;
                    uint8 pv;
                    assembly {
                        pr := calldataload(pubSig.offset)
                        ps := calldataload(add(pubSig.offset, 32))
                        pv := byte(0, calldataload(add(pubSig.offset, 64)))
                    }
                    require(pv == 27 || pv == 28, "E30"); // AUDIT-006: validate v before ecrecover
                    require(uint256(ps) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "E30");
                    address pubSigner = ecrecover(pubDigest, pv, pr, ps);
                    require(pubSigner != address(0) && pubSigner == expectedPub, "E34");
                }
            }

            // Build ClaimBatch for forwarding
            IDatumSettlement.Claim[] memory memoryClaims = new IDatumSettlement.Claim[](sb.claims.length);
            for (uint256 i = 0; i < sb.claims.length; i++) {
                memoryClaims[i] = sb.claims[i];
            }
            forwardBatches[b] = IDatumSettlement.ClaimBatch({
                user: sb.user,
                campaignId: sb.campaignId,
                claims: memoryClaims
            });
        }

        result = settlement.settleClaims(forwardBatches);
    }
}
