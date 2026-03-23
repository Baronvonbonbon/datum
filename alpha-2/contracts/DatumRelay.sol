// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";
import "./interfaces/IDatumPauseRegistry.sol";

/// @title DatumRelay
/// @notice Publisher relay for claim settlement via EIP-712 user signatures.
///         Alpha-2: getCampaignForSettlement returns 4 values (no remainingBudget).
contract DatumRelay {
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
    // Immutables
    // -------------------------------------------------------------------------

    IDatumSettlement public immutable settlement;
    IDatumCampaignsSettlement public immutable campaigns;
    bytes32 public immutable DOMAIN_SEPARATOR;

    // -------------------------------------------------------------------------
    // Global pause registry
    // -------------------------------------------------------------------------

    IDatumPauseRegistry public pauseRegistry;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _settlement, address _campaigns, address _pauseRegistry) {
        require(_settlement != address(0), "E00");
        require(_campaigns != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        settlement = IDatumSettlement(_settlement);
        campaigns = IDatumCampaignsSettlement(_campaigns);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DatumRelay"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // -------------------------------------------------------------------------
    // Relay settlement
    // -------------------------------------------------------------------------

    function settleClaimsFor(IDatumSettlement.SignedClaimBatch[] calldata batches)
        external
        returns (IDatumSettlement.SettlementResult memory result)
    {
        require(!pauseRegistry.paused(), "P");
        IDatumSettlement.ClaimBatch[] memory forwardBatches = new IDatumSettlement.ClaimBatch[](batches.length);

        for (uint256 b = 0; b < batches.length; b++) {
            IDatumSettlement.SignedClaimBatch calldata sb = batches[b];
            require(block.number <= sb.deadline, "E29");

            // EIP-712 user signature verification
            bytes32 structHash = keccak256(abi.encode(
                BATCH_TYPEHASH,
                sb.user,
                sb.campaignId,
                sb.claims[0].nonce,
                sb.claims[sb.claims.length - 1].nonce,
                sb.claims.length,
                sb.deadline
            ));
            bytes32 digest = keccak256(abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                structHash
            ));

            bytes calldata sig = sb.signature;
            require(sig.length == 65, "E30");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(sig.offset)
                s := calldataload(add(sig.offset, 32))
                v := byte(0, calldataload(add(sig.offset, 64)))
            }
            address signer = ecrecover(digest, v, r, s);
            require(signer != address(0) && signer == sb.user, "E31");

            // Publisher co-signature (4-value return)
            if (sb.publisherSig.length > 0) {
                (, address cPublisher,,) = campaigns.getCampaignForSettlement(sb.campaignId);
                if (cPublisher != address(0)) {
                    bytes32 pubStructHash = keccak256(abi.encode(
                        PUBLISHER_ATTESTATION_TYPEHASH,
                        sb.campaignId,
                        sb.user,
                        sb.claims[0].nonce,
                        sb.claims[sb.claims.length - 1].nonce,
                        sb.claims.length
                    ));
                    bytes32 pubDigest = keccak256(abi.encodePacked(
                        "\x19\x01",
                        DOMAIN_SEPARATOR,
                        pubStructHash
                    ));

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
                    address pubSigner = ecrecover(pubDigest, pv, pr, ps);
                    require(pubSigner != address(0) && pubSigner == cPublisher, "E34");
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
