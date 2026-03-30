// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/ISystem.sol";

/// @title DatumClaimValidator
/// @notice Validates settlement claims: campaign lookup, publisher match, blocklist,
///         nonce chain, hash chain (Blake2-256 on PolkaVM / keccak256 on EVM).
///         Extracted from DatumSettlement (SE-1) to free PVM headroom.
contract DatumClaimValidator is IDatumClaimValidator {
    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);
    address private constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

    address public owner;
    address public campaigns;
    address public publishers;
    address public pauseRegistry;

    constructor(address _campaigns, address _publishers, address _pauseRegistry) {
        require(_campaigns != address(0), "E00");
        require(_publishers != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        owner = msg.sender;
        campaigns = _campaigns;
        publishers = _publishers;
        pauseRegistry = _pauseRegistry;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        campaigns = addr;
    }

    function setPublishers(address addr) external {
        require(msg.sender == owner, "E18");
        require(addr != address(0), "E00");
        publishers = addr;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "E18");
        require(newOwner != address(0), "E00");
        owner = newOwner;
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
        // Check 1: non-zero impressions
        if (claim.impressionCount == 0) return (false, 2, 0, bytes32(0));

        // Check 2: campaign exists and is active
        (bool cOk, bytes memory cRet) = campaigns.staticcall(
            abi.encodeWithSelector(bytes4(0xe3c76d2e), claim.campaignId)
        );
        require(cOk, "E01");
        (uint8 status, address cPublisher, uint256 cBidCpm, uint16 cTakeRate)
            = abi.decode(cRet, (uint8, address, uint256, uint16));

        if (cBidCpm == 0) return (false, 3, 0, bytes32(0));
        if (status != 1) return (false, 4, 0, bytes32(0));

        // Check 3: publisher match
        if (cPublisher != address(0)) {
            if (claim.publisher != cPublisher) return (false, 5, 0, bytes32(0));
        } else {
            if (claim.publisher == address(0)) return (false, 5, 0, bytes32(0));
        }

        // Check 4: S12 blocklist
        (bool blOk, bytes memory blRet) = publishers.staticcall(
            abi.encodeWithSelector(bytes4(0xfbac3951), claim.publisher)  // isBlocked(address)
        );
        if (blOk && blRet.length >= 32 && abi.decode(blRet, (bool))) return (false, 11, 0, bytes32(0));

        // Check 5: clearing CPM <= bid CPM
        if (claim.clearingCpmPlanck > cBidCpm) return (false, 6, 0, bytes32(0));

        // Check 6: nonce chain
        if (claim.nonce != expectedNonce) return (false, 7, 0, bytes32(0));

        // Check 7: previous hash chain
        if (claim.nonce == 1) {
            if (claim.previousClaimHash != bytes32(0)) return (false, 8, 0, bytes32(0));
        } else {
            if (claim.previousClaimHash != expectedPrevHash) return (false, 9, 0, bytes32(0));
        }

        // Check 8: claim hash (Blake2-256 on PolkaVM, keccak256 on EVM)
        bytes memory packed = abi.encodePacked(
            claim.campaignId,
            claim.publisher,
            user,
            claim.impressionCount,
            claim.clearingCpmPlanck,
            claim.nonce,
            claim.previousClaimHash
        );
        bytes32 computedHash;
        if (SYSTEM_ADDR.code.length > 0) {
            computedHash = SYSTEM.hashBlake256(packed);
        } else {
            computedHash = keccak256(packed);
        }
        if (claim.claimHash != computedHash) return (false, 10, 0, bytes32(0));

        return (true, 0, cTakeRate, computedHash);
    }
}
