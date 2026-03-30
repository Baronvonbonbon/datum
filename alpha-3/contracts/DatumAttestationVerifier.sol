// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaignsSettlement.sol";

/// @title DatumAttestationVerifier
/// @notice P1: Mandatory publisher attestation for direct claim settlement.
///         Wraps settleClaims() and enforces EIP-712 publisher co-signature
///         for ALL campaigns. Targeted campaigns verify against the campaign's
///         designated publisher. Open campaigns (publisher=address(0)) verify
///         against claims[0].publisher (the actual serving publisher).
///
///         Users call settleClaimsAttested() instead of Settlement.settleClaims()
///         directly. This contract verifies publisher attestation then forwards
///         to Settlement. Relay also enforces attestation when a co-sig is
///         provided; this contract makes it mandatory.
contract DatumAttestationVerifier {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

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
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _settlement, address _campaigns) {
        require(_settlement != address(0), "E00");
        require(_campaigns != address(0), "E00");
        settlement = IDatumSettlement(_settlement);
        campaigns = IDatumCampaignsSettlement(_campaigns);
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DatumAttestationVerifier"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // -------------------------------------------------------------------------
    // Attested settlement
    // -------------------------------------------------------------------------

    struct AttestedBatch {
        address user;
        uint256 campaignId;
        IDatumSettlement.Claim[] claims;
        bytes publisherSig;
    }

    /// @notice Settle claims with mandatory publisher attestation.
    ///         publisherSig must be a valid EIP-712 signature from the publisher.
    ///         Targeted campaigns: verified against campaign's designated publisher.
    ///         Open campaigns: verified against claims[0].publisher (the serving publisher).
    function settleClaimsAttested(AttestedBatch[] calldata batches)
        external
        returns (IDatumSettlement.SettlementResult memory result)
    {
        IDatumSettlement.ClaimBatch[] memory forwardBatches =
            new IDatumSettlement.ClaimBatch[](batches.length);

        for (uint256 b = 0; b < batches.length; b++) {
            AttestedBatch calldata ab = batches[b];
            require(msg.sender == ab.user, "E32");
            require(ab.claims.length > 0, "E28");

            // Determine expected publisher signer
            (, address cPublisher,,) = campaigns.getCampaignForSettlement(ab.campaignId);
            address expectedPublisher = cPublisher;
            if (expectedPublisher == address(0)) {
                // Open campaign: verify against the actual serving publisher
                expectedPublisher = ab.claims[0].publisher;
            }
            require(expectedPublisher != address(0), "E00");

            // Mandatory: verify publisher co-signature
            bytes32 structHash = keccak256(abi.encode(
                PUBLISHER_ATTESTATION_TYPEHASH,
                ab.campaignId,
                ab.user,
                ab.claims[0].nonce,
                ab.claims[ab.claims.length - 1].nonce,
                ab.claims.length
            ));
            bytes32 digest = keccak256(abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                structHash
            ));

            bytes calldata sig = ab.publisherSig;
            require(sig.length == 65, "E33");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(sig.offset)
                s := calldataload(add(sig.offset, 32))
                v := byte(0, calldataload(add(sig.offset, 64)))
            }
            require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "E30");
            address pubSigner = ecrecover(digest, v, r, s);
            require(pubSigner != address(0) && pubSigner == expectedPublisher, "E34");

            // Build ClaimBatch for forwarding
            IDatumSettlement.Claim[] memory memoryClaims =
                new IDatumSettlement.Claim[](ab.claims.length);
            for (uint256 i = 0; i < ab.claims.length; i++) {
                memoryClaims[i] = ab.claims[i];
            }
            forwardBatches[b] = IDatumSettlement.ClaimBatch({
                user: ab.user,
                campaignId: ab.campaignId,
                claims: memoryClaims
            });
        }

        result = settlement.settleClaims(forwardBatches);
    }
}
