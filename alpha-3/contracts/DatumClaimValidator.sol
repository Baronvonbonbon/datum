// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/ISystem.sol";

/// @title DatumClaimValidator
/// @notice Validates settlement claims — extracted from Settlement (SE-1) for PVM headroom.
///
///         Alpha-3 multi-pricing changes:
///           - Claim struct: impressionCount→eventCount, clearingCpmPlanck→ratePlanck,
///             plus actionType and clickSessionHash fields.
///           - Hash preimage is now 9 fields (was 7): adds actionType + clickSessionHash.
///           - Rate check calls getCampaignPot(campaignId, actionType) instead of
///             reading bidCpmPlanck from getCampaignForSettlement.
///           - Type-1 (click): checks clickRegistry.hasUnclaimed for session validity.
///           - Type-2 (remote-action): ecrecover checks actionSig against pot.actionVerifier.
///           - getCampaignForSettlement now returns a 3-tuple (no bidCpmPlanck).
contract DatumClaimValidator is IDatumClaimValidator, Ownable2Step {
    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);
    address private constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

    // BM-2: Matches Settlement.MAX_USER_EVENTS — prevents overflow in payment calc
    uint256 private constant MAX_CLAIM_EVENTS = 100000;

    address public campaigns;
    address public publishers;
    address public pauseRegistry;
    address public zkVerifier;
    // AUDIT-005: CampaignValidator for allowlist snapshot checks
    address public campaignValidator;
    // FP-CPC: ClickRegistry for type-1 session validation (address(0) = disabled)
    address public clickRegistry;
    // EVM mode: force keccak256 hashing (0x900 precompile stub exists but doesn't work with EVM bytecode)
    bool public forceKeccak;

    constructor(address _campaigns, address _publishers, address _pauseRegistry) Ownable(msg.sender) {
        require(_campaigns != address(0), "E00");
        require(_publishers != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        campaigns = _campaigns;
        publishers = _publishers;
        pauseRegistry = _pauseRegistry;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    function setPublishers(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        publishers = addr;
    }

    function setZKVerifier(address addr) external onlyOwner {
        zkVerifier = addr;
    }

    function setCampaignValidator(address addr) external onlyOwner {
        campaignValidator = addr;
    }

    function setClickRegistry(address addr) external onlyOwner {
        clickRegistry = addr;
    }

    function setForceKeccak(bool _forceKeccak) external onlyOwner {
        forceKeccak = _forceKeccak;
    }

    function _checkOwner() internal view override {
        require(owner() == msg.sender, "E18");
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "E00");
        super.transferOwnership(newOwner);
    }

    function acceptOwnership() public override {
        require(msg.sender == pendingOwner(), "E18");
        _transferOwnership(msg.sender);
    }

    function renounceOwnership() public override onlyOwner {
        revert("E18");
    }

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDatumClaimValidator
    function validateClaim(
        IDatumSettlement.Claim calldata claim,
        address user,
        uint256 expectedNonce,
        bytes32 expectedPrevHash
    ) external view override returns (bool, uint8, uint16, bytes32) {
        // Check 0: valid action type
        if (claim.actionType > 2) return (false, 21, 0, bytes32(0)); // E88 mapped to reason 21

        // Check 1: non-zero events within allowed range
        if (claim.eventCount == 0) return (false, 2, 0, bytes32(0));
        if (claim.eventCount > MAX_CLAIM_EVENTS) return (false, 17, 0, bytes32(0));

        // Check 2: campaign exists and is active; get publisher + take rate (3-tuple now)
        // getCampaignForSettlement(uint256) → (uint8 status, address publisher, uint16 takeRate)
        (bool cOk, bytes memory cRet) = campaigns.staticcall(
            abi.encodeWithSelector(bytes4(0xe3c76d2e), claim.campaignId)
        );
        require(cOk && cRet.length >= 96, "E01");
        (uint8 status, address cPublisher, uint16 cTakeRate)
            = abi.decode(cRet, (uint8, address, uint16));

        if (status != 1) return (false, 4, 0, bytes32(0));

        // Check 3: publisher match
        if (cPublisher != address(0)) {
            if (claim.publisher != cPublisher) return (false, 5, 0, bytes32(0));
            // AUDIT-005: For targeted campaigns, verify advertiser is still in allowlist snapshot
            if (campaignValidator != address(0)) {
                (bool alEnOk, bytes memory alEnRet) = campaignValidator.staticcall(
                    abi.encodeWithSignature("campaignAllowlistEnabled(uint256)", claim.campaignId)
                );
                if (alEnOk && alEnRet.length >= 32 && abi.decode(alEnRet, (bool))) {
                    (bool advOk, bytes memory advRet) = campaigns.staticcall(
                        abi.encodeWithSignature("getCampaignAdvertiser(uint256)", claim.campaignId)
                    );
                    if (advOk && advRet.length >= 32) {
                        address advertiser = abi.decode(advRet, (address));
                        (bool snapOk, bytes memory snapRet) = campaignValidator.staticcall(
                            abi.encodeWithSignature("campaignAllowlistSnapshot(uint256,address)", claim.campaignId, advertiser)
                        );
                        if (!snapOk || snapRet.length < 32 || !abi.decode(snapRet, (bool))) return (false, 15, 0, bytes32(0));
                    }
                }
            }
        } else {
            if (claim.publisher == address(0)) return (false, 5, 0, bytes32(0));
            // Open campaigns cannot be served by publishers with allowlist enabled (BM-7)
            (bool alOk, bytes memory alRet) = publishers.staticcall(
                abi.encodeWithSignature("allowlistEnabled(address)", claim.publisher)
            );
            if (alOk && alRet.length >= 32 && abi.decode(alRet, (bool))) return (false, 15, 0, bytes32(0));
        }

        // Check 4: S12 blocklist — fail-safe: treat call failure as blocked
        (bool blOk, bytes memory blRet) = publishers.staticcall(
            abi.encodeWithSelector(bytes4(0xfbac3951), claim.publisher)  // isBlocked(address)
        );
        if (!blOk || blRet.length < 32 || abi.decode(blRet, (bool))) return (false, 11, 0, bytes32(0));

        // Check 5: rate check — fetch pot config for this action type
        // getCampaignPot(uint256 campaignId, uint8 actionType) → ActionPotConfig
        (bool pOk, bytes memory pRet) = campaigns.staticcall(
            abi.encodeWithSignature("getCampaignPot(uint256,uint8)", claim.campaignId, claim.actionType)
        );
        if (!pOk || pRet.length < 160) return (false, 3, 0, bytes32(0)); // pot not found
        // ActionPotConfig: (uint8 actionType, uint256 budgetPlanck, uint256 dailyCapPlanck, uint256 ratePlanck, address actionVerifier)
        // ABI decode — note: uint8 is padded to 32 bytes in ABI encoding
        (,,,uint256 potRate, address potActionVerifier) =
            abi.decode(pRet, (uint8, uint256, uint256, uint256, address));
        if (potRate == 0) return (false, 3, 0, bytes32(0));
        if (claim.ratePlanck > potRate) return (false, 6, 0, bytes32(0));

        // Check 6: nonce chain
        if (claim.nonce != expectedNonce) return (false, 7, 0, bytes32(0));

        // Check 7: previous hash chain
        if (claim.nonce == 1) {
            if (claim.previousClaimHash != bytes32(0)) return (false, 8, 0, bytes32(0));
        } else {
            if (claim.previousClaimHash != expectedPrevHash) return (false, 9, 0, bytes32(0));
        }

        // Check 8: claim hash (9-field preimage: adds actionType + clickSessionHash)
        // Blake2-256 on PolkaVM, keccak256 on EVM
        bytes memory packed = abi.encodePacked(
            claim.campaignId,
            claim.publisher,
            user,
            claim.eventCount,
            claim.ratePlanck,
            claim.actionType,
            claim.clickSessionHash,
            claim.nonce,
            claim.previousClaimHash
        );
        bytes32 computedHash;
        if (!forceKeccak && SYSTEM_ADDR.code.length > 0) {
            computedHash = SYSTEM.hashBlake256(packed);
        } else {
            computedHash = keccak256(packed);
        }
        if (claim.claimHash != computedHash) return (false, 10, 0, bytes32(0));

        // Check 9: ZK proof (view claims only, if campaign requires it)
        if (claim.actionType == 0 && zkVerifier != address(0)) {
            (bool zkReqOk, bytes memory zkReqRet) = campaigns.staticcall(
                abi.encodeWithSignature("getCampaignRequiresZkProof(uint256)", claim.campaignId)
            );
            if (zkReqOk && zkReqRet.length >= 32 && abi.decode(zkReqRet, (bool))) {
                // all-zero = no proof supplied; bytes32[8] is always 256 bytes when non-zero
                bool proofPresent = false;
                for (uint256 i = 0; i < 8; i++) { if (claim.zkProof[i] != bytes32(0)) { proofPresent = true; break; } }
                if (!proofPresent) return (false, 16, 0, bytes32(0));
                (bool zvOk, bytes memory zvRet) = zkVerifier.staticcall(
                    abi.encodeWithSignature("verify(bytes,bytes32,bytes32,uint256)", abi.encodePacked(claim.zkProof), computedHash, claim.nullifier, claim.eventCount)
                );
                if (!zvOk || zvRet.length < 32 || !abi.decode(zvRet, (bool))) {
                    return (false, 16, 0, bytes32(0));
                }
            }
        }

        // Check 10 (type-1 only): verify click session exists and is unclaimed
        if (claim.actionType == 1) {
            if (clickRegistry == address(0)) return (false, 22, 0, bytes32(0)); // E90 → reason 22
            if (claim.clickSessionHash == bytes32(0)) return (false, 22, 0, bytes32(0));
            // hasUnclaimed(address user, uint256 campaignId, bytes32 impressionNonce) → bool
            // Note: clickSessionHash in the claim IS the impressionNonce used to compute the session
            (bool crOk, bytes memory crRet) = clickRegistry.staticcall(
                abi.encodeWithSignature("hasUnclaimed(address,uint256,bytes32)", user, claim.campaignId, claim.clickSessionHash)
            );
            if (!crOk || crRet.length < 32 || !abi.decode(crRet, (bool))) return (false, 22, 0, bytes32(0));
        }

        // Check 11 (type-2 only): verify actionSig from the pot's actionVerifier EOA
        if (claim.actionType == 2) {
            if (potActionVerifier == address(0)) return (false, 23, 0, bytes32(0)); // E94 → reason 23
            // bytes32[3]: [r, s, v-as-bytes32]; all-zero = no sig provided
            // sig is over computedHash (the full claim hash)
            bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", computedHash));
            (bytes32 r, bytes32 s, uint8 v) = _splitSig(claim.actionSig);
            if (v != 27 && v != 28) return (false, 23, 0, bytes32(0));
            if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return (false, 23, 0, bytes32(0));
            address recovered = ecrecover(ethHash, v, r, s);
            if (recovered == address(0) || recovered != potActionVerifier) return (false, 23, 0, bytes32(0));
        }

        return (true, 0, cTakeRate, computedHash);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _splitSig(bytes32[3] calldata sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        r = sig[0];
        s = sig[1];
        v = uint8(uint256(sig[2]));
    }
}
