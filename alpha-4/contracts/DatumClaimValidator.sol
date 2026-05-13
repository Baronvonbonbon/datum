// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./interfaces/IDatumClaimValidator.sol";
import "./interfaces/IDatumSettlement.sol";
import "./interfaces/IDatumCampaigns.sol";
import "./interfaces/IDatumPublishers.sol";
import "./interfaces/IDatumZKVerifier.sol";
import "./interfaces/IDatumClickRegistry.sol";
import "./interfaces/IDatumStakeRoot.sol";
import "./interfaces/IDatumInterestCommitments.sol";

/// @dev #5 + #2-extension (2026-05-12): minimal Settlement view interface for
///      the PoW difficulty target and the per-user cumulative settled-events
///      counter. Kept inline — only two functions; not worth a separate file.
interface ISettlementSybilGate {
    function enforcePow() external view returns (bool);
    function powTargetForUser(address user, uint256 eventCount) external view returns (uint256);
    function userTotalSettled(address user) external view returns (uint256);
}

/// @dev #1 + #2-extension: minimal Campaigns view interface for per-campaign
///      sybil knobs. Calls are try/catch-wrapped — falls back to no-op when
///      Campaigns doesn't expose these yet (staged migration).
interface ICampaignsSybilKnobs {
    function minUserSettledHistory(uint256 campaignId) external view returns (uint32);
}

/// @dev Path A: campaign-level ZK gate knobs (minStake, requiredCategory).
///      try/catch-wrapped so Campaigns without these getters keep working.
interface ICampaignsZkKnobs {
    function getCampaignMinStake(uint256 campaignId) external view returns (uint256);
    function getCampaignRequiredCategory(uint256 campaignId) external view returns (bytes32);
}

/// @title DatumClaimValidator
/// @notice Validates settlement claims — extracted from Settlement (SE-1).
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
contract DatumClaimValidator is IDatumClaimValidator, DatumOwnable {
    // BM-2: Matches Settlement.MAX_USER_EVENTS — prevents overflow in payment calc
    uint256 private constant MAX_CLAIM_EVENTS = 100000;

    IDatumCampaigns public campaigns;
    IDatumPublishers public publishers;
    address public immutable pauseRegistry;
    IDatumZKVerifier public zkVerifier;
    // FP-CPC: ClickRegistry for type-1 session validation (address(0) = disabled)
    IDatumClickRegistry public clickRegistry;
    // #5 + #2: optional Settlement ref for PoW target + history total reads.
    //          address(0) = sybil gates disabled (default before wiring).
    address public settlement;

    // Path A (ZK): stake-root + interest-commitment refs. Both optional —
    //              when unset, Check 9 falls back to the legacy 3-pub verify()
    //              entrypoint and the stake/interest gates are effectively off.
    IDatumStakeRoot public stakeRoot;
    IDatumInterestCommitments public interestCommitments;

    /// @notice D1a cypherpunk plumbing lock. ClaimValidator is a pure-validation
    ///         plumbing contract; all protocol-ref setters live under this one
    ///         switch. Pre-lock: owner can swap refs to fix wiring mistakes.
    ///         Post-lock: every setter on this contract reverts forever.
    ///         Deploy scripts should call `lockPlumbing()` once all wiring is
    ///         verified and the protocol is ready to commit.
    bool public plumbingLocked;
    event PlumbingLocked();

    constructor(address _campaigns, address _publishers, address _pauseRegistry) {
        require(_campaigns != address(0), "E00");
        require(_publishers != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        campaigns = IDatumCampaigns(_campaigns);
        publishers = IDatumPublishers(_publishers);
        pauseRegistry = _pauseRegistry;
    }

    // -------------------------------------------------------------------------
    // Admin (all setters gated by plumbingLocked)
    // -------------------------------------------------------------------------

    function setCampaigns(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        campaigns = IDatumCampaigns(addr);
    }

    function setPublishers(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        publishers = IDatumPublishers(addr);
    }

    function setZKVerifier(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        zkVerifier = IDatumZKVerifier(addr);
    }

    function setClickRegistry(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        clickRegistry = IDatumClickRegistry(addr);
    }

    function setSettlement(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        settlement = addr;
    }

    /// @notice Path A: wire the stake-root commitment contract.
    function setStakeRoot(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        stakeRoot = IDatumStakeRoot(addr);
    }

    /// @notice Path A: wire the per-user interest-commitment contract.
    function setInterestCommitments(address addr) external onlyOwner {
        require(!plumbingLocked, "locked");
        require(addr != address(0), "E00");
        interestCommitments = IDatumInterestCommitments(addr);
    }

    /// @notice Commit every protocol-ref on this contract permanently.
    /// @dev    Requires every ref to be set non-zero first — protects against
    ///         locking with a critical ref still unwired. Optional refs that
    ///         remain zero are *committed to staying zero* by the lock.
    function lockPlumbing() external onlyOwner {
        require(!plumbingLocked, "already locked");
        require(address(campaigns) != address(0), "campaigns unset");
        require(address(publishers) != address(0), "publishers unset");
        // zkVerifier, clickRegistry, settlement are optional — zero is a valid
        // post-lock state (feature off forever) so we don't require them.
        plumbingLocked = true;
        emit PlumbingLocked();
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

        // Check 2: campaign exists and is active; get publisher + take rate
        (uint8 status, address cPublisher, uint16 cTakeRate)
            = campaigns.getCampaignForSettlement(claim.campaignId);

        if (status != 1) return (false, 4, 0, bytes32(0));

        // Check 3: publisher match
        if (cPublisher != address(0)) {
            if (claim.publisher != cPublisher) return (false, 5, 0, bytes32(0));
            // AUDIT-005: For targeted campaigns, verify advertiser is still in allowlist snapshot
            try campaigns.campaignAllowlistEnabled(claim.campaignId) returns (bool alEnabled) {
                if (alEnabled) {
                    address advertiser = campaigns.getCampaignAdvertiser(claim.campaignId);
                    try campaigns.campaignAllowlistSnapshot(claim.campaignId, advertiser) returns (bool allowed) {
                        if (!allowed) return (false, 15, 0, bytes32(0));
                    } catch {
                        return (false, 15, 0, bytes32(0));
                    }
                }
            } catch {}
        } else {
            if (claim.publisher == address(0)) return (false, 5, 0, bytes32(0));
            // Open campaigns cannot be served by publishers with allowlist enabled (BM-7)
            try publishers.allowlistEnabled(claim.publisher) returns (bool alEnabled) {
                if (alEnabled) return (false, 15, 0, bytes32(0));
            } catch {}
        }

        // Check 4: S12 blocklist.
        // A4-fix (2026-05-12): fail-OPEN on revert. Mirrors Settlement: the
        //   blocklist is a policy layer, not a critical safety invariant, and
        //   silently DoS'ing every settlement on a single misconfigured ref
        //   is more harmful than letting a single batch through.
        try publishers.isBlocked(claim.publisher) returns (bool blocked) {
            if (blocked) return (false, 11, 0, bytes32(0));
        } catch {
            // Liveness: continue validation rather than rejecting.
        }

        // Check 5: rate check — fetch pot config for this action type
        uint256 potRate;
        address potActionVerifier;
        try campaigns.getCampaignPot(claim.campaignId, claim.actionType) returns (IDatumCampaigns.ActionPotConfig memory pot) {
            potRate = pot.ratePlanck;
            potActionVerifier = pot.actionVerifier;
        } catch {
            return (false, 3, 0, bytes32(0)); // pot not found
        }
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

        // Check 8: claim hash (9-field preimage: campaignId, publisher, user,
        // eventCount, ratePlanck, actionType, clickSessionHash, nonce, prevHash).
        // L-2: Uses abi.encode (32-byte aligned) rather than abi.encodePacked so the
        // schema is unambiguous if fields are added later. Off-chain mirrors must use
        // ethers AbiCoder.defaultAbiCoder().encode(...) — not solidityPacked.
        bytes32 computedHash = keccak256(abi.encode(
            claim.campaignId,
            claim.publisher,
            user,
            claim.eventCount,
            claim.ratePlanck,
            claim.actionType,
            claim.clickSessionHash,
            claim.nonce,
            claim.previousClaimHash,
            claim.stakeRootUsed
        ));
        if (claim.claimHash != computedHash) return (false, 10, 0, bytes32(0));

        // Check 8b: #5 — Per-impression PoW with scaling difficulty.
        //   keccak256(claimHash || powNonce) <= target(user, eventCount).
        //   Target tightens with the user's recent settled rate AND scales
        //   inversely with eventCount so bots can't amortize across batched
        //   impressions. Gated by settlement.enforcePow; skipped entirely
        //   when settlement isn't wired (early bootstrap).
        // Check 8c: #2-extension — proof-of-on-chain-history filter. The
        //   campaign can require the reporter has settled N events historically
        //   (across any campaign) before participating. Soft sybil bar that
        //   doesn't lock out real users with prior protocol activity.
        if (settlement != address(0)) {
            ISettlementSybilGate s = ISettlementSybilGate(settlement);
            // PoW (reason 27)
            try s.enforcePow() returns (bool enf) {
                if (enf) {
                    try s.powTargetForUser(user, claim.eventCount) returns (uint256 target) {
                        if (uint256(keccak256(abi.encodePacked(computedHash, claim.powNonce))) > target) {
                            return (false, 27, 0, bytes32(0));
                        }
                    } catch {
                        return (false, 27, 0, bytes32(0));
                    }
                }
            } catch {}

            // History gate (reason 28): per-campaign minUserSettledHistory
            try ICampaignsSybilKnobs(address(campaigns)).minUserSettledHistory(claim.campaignId) returns (uint32 minHist) {
                if (minHist > 0) {
                    try s.userTotalSettled(user) returns (uint256 totalSettled) {
                        if (totalSettled < uint256(minHist)) return (false, 28, 0, bytes32(0));
                    } catch {
                        return (false, 28, 0, bytes32(0));
                    }
                }
            } catch {}
        }

        // Check 9: ZK proof (view claims only, if campaign requires it).
        //          Path A: 7 public inputs — claimHash, nullifier, impressions,
        //                  stakeRoot, minStake, interestRoot, requiredCategory.
        //          Wallets/relays must build proofs against `stakeRoot.rootAt(latestEpoch)`
        //          and the user's own interestRoot at proof-generation time. Brief
        //          rollover races (root rotates between gen and verify) are expected;
        //          relays should retry with a fresh proof on reason 16.
        if (claim.actionType == 0 && address(zkVerifier) != address(0)) {
            try campaigns.getCampaignRequiresZkProof(claim.campaignId) returns (bool reqZk) {
                if (reqZk) {
                    bool proofPresent = false;
                    for (uint256 i = 0; i < 8; i++) { if (claim.zkProof[i] != bytes32(0)) { proofPresent = true; break; } }
                    if (!proofPresent) return (false, 16, 0, bytes32(0));
                    if (!_verifyPathA(claim, user, computedHash)) return (false, 16, 0, bytes32(0));
                }
            } catch {
                // M-4: fail closed — if we can't determine whether a ZK proof is required,
                // refuse the claim rather than silently treating it as not-required.
                return (false, 16, 0, bytes32(0));
            }
        }

        // Check 10 (type-1 only): verify click session exists and is unclaimed
        if (claim.actionType == 1) {
            if (address(clickRegistry) == address(0)) return (false, 22, 0, bytes32(0)); // E90 → reason 22
            if (claim.clickSessionHash == bytes32(0)) return (false, 22, 0, bytes32(0));
            try clickRegistry.hasUnclaimed(user, claim.campaignId, claim.clickSessionHash) returns (bool unclaimed) {
                if (!unclaimed) return (false, 22, 0, bytes32(0));
            } catch {
                return (false, 22, 0, bytes32(0));
            }
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

    /// @dev Path A: build the 7-pub array and call DatumZKVerifier.verifyA.
    ///      Returns false on any lookup failure or pairing mismatch.
    function _verifyPathA(IDatumSettlement.Claim calldata claim, address user, bytes32 computedHash)
        internal view returns (bool)
    {
        // Pub 3: stake root — wallet/relay submits which root the proof was
        //         generated against (claim.stakeRootUsed). Validator checks
        //         it's within the configured lookback window. If stakeRoot
        //         contract isn't wired, fall back to bytes32(0) — circuit
        //         expects 0 when no stake gate is enforced.
        bytes32 sRoot = claim.stakeRootUsed;
        if (sRoot != bytes32(0)) {
            // require recency only when a non-zero root is asserted; otherwise
            // the campaign's minStake==0 path treats this as "no gate"
            if (address(stakeRoot) == address(0)) return false;
            if (!stakeRoot.isRecent(sRoot)) return false;
        }

        // Pub 4: min stake — campaign-set threshold (0 = no stake floor).
        uint256 minStake = 0;
        try ICampaignsZkKnobs(address(campaigns)).getCampaignMinStake(claim.campaignId) returns (uint256 v) {
            minStake = v;
        } catch {}

        // Pub 5: user's interest commitment.
        bytes32 iRoot = bytes32(0);
        if (address(interestCommitments) != address(0)) {
            iRoot = interestCommitments.interestRoot(user);
        }

        // Pub 6: required category (0 = any).
        bytes32 reqCat = bytes32(0);
        try ICampaignsZkKnobs(address(campaigns)).getCampaignRequiredCategory(claim.campaignId) returns (bytes32 c) {
            reqCat = c;
        } catch {}

        uint256[7] memory pubs = [
            uint256(computedHash),
            uint256(claim.nullifier),
            claim.eventCount,
            uint256(sRoot),
            minStake,
            uint256(iRoot),
            uint256(reqCat)
        ];
        try zkVerifier.verifyA(abi.encodePacked(claim.zkProof), pubs) returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }
}
