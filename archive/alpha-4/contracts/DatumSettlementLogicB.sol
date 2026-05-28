// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumSettlementStorage.sol";
import "./interfaces/IDatumSettlement.sol";

/// @title  DatumSettlementLogicB
/// @notice Second half of the Settlement bytecode split (alpha-4 EIP-170
///         phase 8d-3). Owns the inner pipeline (`processBatch`) that
///         processes one user/campaign batch end-to-end: identity gates,
///         per-claim validation + rate-limit + nullifier checks, chain-
///         state writes, payment math, budget deduction, paymentVault
///         credit, optional token-reward credit, mint coordination, and
///         reputation recording.
///
/// @dev    Invoked exclusively via DELEGATECALL from DatumSettlement (and,
///         in phase 8d-4, from DatumSettlementLogicA's relay loops).
///         The shared `DatumSettlementStorage` base guarantees identical
///         storage layout so every SLOAD/SSTORE hits the caller's slot.
///         Calling LogicB directly is harmless — its own storage has
///         `_budgetLedger == address(0)`, so the first external dependency
///         touch reverts.
///
/// @dev    NO `nonReentrant` modifier here. Settlement holds the
///         ReentrancyGuard lock for the outer entry point; LogicB runs
///         inside that same guard via DELEGATECALL (the `_status` slot
///         lives on DatumSettlementStorage and is shared).
///
/// @dev    LAYOUT INVARIANT: never declare additional state in this
///         contract. New state goes on DatumSettlementStorage.
contract DatumSettlementLogicB is DatumSettlementStorage {
    function version() public pure override returns (uint256) { return 1; }

    /// @notice Process one (user, campaignId, claims[]) batch. Returns
    ///         the deltas the outer entry should fold into its
    ///         SettlementResult accumulator.
    /// @dev    Called via DELEGATECALL, so `msg.sender` is the original
    ///         caller of the outer settle entry point (relay, attestation
    ///         verifier, or user EOA / publisher relay), not Settlement.
    ///         All emits originate from Settlement's address.
    function processBatch(
        address user,
        uint256 campaignId,
        IDatumSettlement.Claim[] calldata claims,
        bool advertiserConsented
    ) external returns (uint256 settled, uint256 rejected, uint256 paid) {
        IDatumSettlement.SettlementResult memory result;

        if (!(claims.length <= _maxBatchSize)) revert E28();

        // CB2 (2026-05-13): user self-pause kill switch. Reject the whole
        // batch when the user has paused their own account — emits per-claim
        // ClaimRejected so observers can see the cause.
        if (_userPaused[user]) {
            for (uint256 j = 0; j < claims.length; j++) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, claims[j].nonce, 27);
            }
            return (result.settledCount, result.rejectedCount, result.totalPaid);
        }

        // CB1: user-side advertiser blocklist. Advertiser is per-campaign, so
        // we can check at batch entry (one read per batch). Publisher block
        // happens per-claim below since the publisher can vary per claim.
        // Hedge #4: use the non-reverting safe variant so a captured Campaigns
        // upgrade can't selectively revert this getter to block specific
        // users' batches.
        if (address(_campaigns) != address(0)) {
            (bool advOk, address adv) = _campaigns.getCampaignAdvertiserSafe(campaignId);
            if (advOk && adv != address(0) && _userBlocksAdvertiser[user][adv]) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, claims[j].nonce, 28);
                }
                emit UserBlocklistRejected(user, adv);
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        // M1-fix (2026-05-13): user-floor L3 = ZK-only. Applies regardless of
        // submission path (relay, publisher-relay, dual-sig). The user opted
        // in to ZK-verified settlement for themselves; an advertiser cosig
        // does NOT satisfy this floor. Reject if campaign doesn't require ZK.
        if (_userMinAssurance[user] >= 3 && address(_campaigns) != address(0)) {
            // SAFETY (M1-fix gradient, hedge #4): non-reverting safe getter
            //         means "campaign unknown" returns (ok=false) as a normal
            //         value, NOT a revert. Both ok=false AND reqZk=false
            //         reach the !reqZk reject path -- correct for the M1-fix
            //         L3-only floor: user demands ZK, campaign doesn't
            //         require it (or doesn't exist), reject.
            //         A revert here would be a Campaigns contract bug, and
            //         falls through Solidity's natural reverting path --
            //         the outer settle entry bubbles the revert to the
            //         caller, which is the desired fail-closed default.
            (bool zkOk, bool reqZk) = _campaigns.getCampaignRequiresZkProofSafe(campaignId);
            if (!zkOk || !reqZk) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit ZKAssuranceFailed(campaignId, user);
                    emit IDatumSettlement.ClaimRejected(campaignId, user, claims[j].nonce, 26);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        // People Chain identity gate (2026-05-16). Effective minimum identity
        // level is the OR-merge of the campaign-side and user-side floors.
        // When non-zero, the user MUST have a non-expired cached attestation
        // at >= that level in DatumPeopleChainIdentity, regardless of which
        // submission path is in use (relay, dual-sig, publisher-relay).
        //
        // Fail-CLOSED on (a) unreadable Campaigns ref and (b) identity
        // registry unwired — matches H2-fix gradient: a misconfiguration
        // can't silently downgrade an identity-gated campaign to no gate.
        {
            uint8 campaignMinId = 0;
            if (address(_campaigns) != address(0)) {
                // SAFETY (H2-fix gradient, hedge #4): the safe variant returns
                //         (ok, level) without reverting. ok=false means
                //         "campaign unknown" -- treat as the default (level
                //         0, no identity gate from the campaign side, but
                //         the user-side floor below may still raise effMinId
                //         to non-zero). ok=true uses the returned level
                //         directly.
                //         A revert here is a Campaigns contract bug and
                //         falls through naturally -- caller sees the revert
                //         and the batch fails, which is the desired
                //         fail-closed posture.
                (bool idOk, uint8 lvl) = _campaigns.getCampaignMinIdentityLevelSafe(campaignId);
                if (idOk) {
                    campaignMinId = lvl;
                }
            }
            uint8 userMinId = _userMinIdentityLevel[user];
            uint8 effMinId = campaignMinId > userMinId ? campaignMinId : userMinId;
            if (effMinId > 0) {
                bool ok = false;
                if (address(_identityRegistry) != address(0)) {
                    // SAFETY: fail-CLOSED on revert. ok stays false, reject
                    //         the batch. The opposite (assume verified on
                    //         revert) would silently allow unidentified
                    //         users to settle on identity-gated campaigns.
                    try _identityRegistry.isVerified(user, effMinId) returns (bool v) {
                        ok = v;
                    } catch {
                        ok = false;
                    }
                }
                if (!ok) {
                    for (uint256 j = 0; j < claims.length; j++) {
                        result.rejectedCount++;
                        emit IDatumSettlement.ClaimRejected(campaignId, user, claims[j].nonce, 30);
                    }
                    return (result.settledCount, result.rejectedCount, result.totalPaid);
                }
            }
        }

        // M2-fix (2026-05-13): compute the effective campaign level once for
        // use by both the assurance gate AND the per-claim blocklist gate
        // below. Dual-sig batches satisfy the path requirement but still need
        // a level value so the blocklist gate can choose fail-open (L0) vs
        // fail-closed (L1+).
        uint8 effectiveLevel = 0;
        if (address(_campaigns) != address(0)) {
            // SAFETY (H2-fix gradient, hedge #4): the safe variant returns
            //         (ok, level). ok=true uses the level directly. ok=false
            //         means "campaign unknown" -- effectiveLevel stays 0
            //         (the default level on the user side covers L1+ via
            //         _userMinAssurance, and per-claim blocklist at L0 is
            //         fail-open by design).
            //         A revert here indicates a Campaigns contract bug and
            //         bubbles up naturally -- the batch fails closed.
            (bool lvlOk, uint8 l) = _campaigns.getCampaignAssuranceLevelSafe(campaignId);
            if (lvlOk) {
                effectiveLevel = l;
            }
        }

        // A3: AssuranceLevel gate. The gradient (campaign level + user
        // floor + submission path) is extracted into the pure
        // `_assuranceDecision` helper on DatumSettlementStorage (phase 8d
        // hedge #5) so it can be table-tested in isolation. Inputs that
        // aren't pure (msg.sender comparisons, _isPublisherRelay) are
        // resolved here and passed in.
        if (address(_campaigns) != address(0)) {
            (bool accept, uint8 reasonCode) = _assuranceDecision(
                effectiveLevel,
                _userMinAssurance[user],
                advertiserConsented,
                msg.sender == _relayContract,
                _isPublisherRelay(claims)
            );
            if (!accept) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, claims[j].nonce, reasonCode);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        // All claims in a batch must share the same actionType (validated by chain state key)
        // We read actionType from the first claim for batch-level checks
        uint8 batchActionType = 0;
        if (claims.length > 0) {
            batchActionType = claims[0].actionType;
        }

        // BM-10: Min claim interval
        uint16 interval = _minClaimInterval;
        if (interval > 0) {
            uint256 lastBlock = _lastSettlementBlock[user][campaignId][batchActionType];
            if (lastBlock != 0 && block.number < lastBlock + interval) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, claims[j].nonce, 18);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        // Safe rollout: reputation gate (delegated to DatumPublisherReputation)
        if (address(_reputation) != address(0) && claims.length > 0) {
            if (!_reputation.canSettle(claims[0].publisher)) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(claims[j].campaignId, user, claims[j].nonce, 20);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        uint256 prevSettledCount = result.settledCount;
        uint256 prevRejectedCount = result.rejectedCount;
        bool gapFound = false;

        BatchAggregate memory agg;

        // Cache token reward config once per batch (view claims only).
        // Hedge #4: switched to safe variants. Token rewards are an opt-in
        // additive credit on top of DOT settlement; if Campaigns is mis-wired
        // or the campaign is unknown, the reward block below is skipped --
        // DOT settlement must not be DoS-able by a non-critical reward path.
        if (claims.length > 0 && address(_tokenRewardVault) != address(0) && address(_campaigns) != address(0) && batchActionType == 0) {
            (bool tokOk, address rt) = _campaigns.getCampaignRewardTokenSafe(campaignId);
            if (tokOk && rt != address(0)) {
                agg.rewardToken = rt;
                (bool rpiOk, uint256 rpi) = _campaigns.getCampaignRewardPerImpressionSafe(campaignId);
                if (rpiOk) {
                    agg.rewardPerImpression = rpi;
                }
            }
        }

        for (uint256 i = 0; i < claims.length; i++) {
            IDatumSettlement.Claim calldata claim = claims[i];

            if (claim.campaignId != campaignId) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 0);
                continue;
            }

            if (gapFound) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 1);
                continue;
            }

            // S12: Settlement-level blocklist check.
            // M2-fix (2026-05-13): trust gradient — fail-open at L0, fail-closed
            // at L1+. H-3 audit fix (2026-05-13): use isBlockedStrict at L1+ so
            // a curator revert actually reaches this try/catch (the fail-open
            // isBlocked variant swallowed reverts internally, making the
            // fail-closed branch unreachable). isBlocked (fail-open) still used
            // at L0 where liveness is preferred.
            if (address(_publishers) != address(0)) {
                if (effectiveLevel >= 1) {
                    // SAFETY (M2-fix + H-3 gradient at L1+): fail-CLOSED on
                    //         revert. The blocklist is part of the L1+
                    //         guarantee surface; if the curator reverts we
                    //         must treat the publisher as blocked rather
                    //         than fall through. Uses isBlockedStrict (not
                    //         isBlocked) because isBlocked swallows curator
                    //         reverts internally, which would make this
                    //         catch unreachable and silently bypass the gate.
                    try _publishers.isBlockedStrict(claim.publisher) returns (bool blocked) {
                        if (blocked) {
                            result.rejectedCount++;
                            emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                            gapFound = true;
                            continue;
                        }
                    } catch {
                        result.rejectedCount++;
                        emit BlocklistFailedClosed(claim.campaignId, claim.publisher);
                        emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                } else {
                    // SAFETY (M2-fix gradient at L0): fail-OPEN. L0
                    //         campaigns prioritize liveness over strict
                    //         curation. _publishers.isBlocked swallows
                    //         curator reverts and returns false (no try/
                    //         catch needed) -- a captured curator can NOT
                    //         block payouts on an L0 campaign by reverting,
                    //         which is the intended L0 contract.
                    if (_publishers.isBlocked(claim.publisher)) {
                        result.rejectedCount++;
                        emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 11);
                        gapFound = true;
                        continue;
                    }
                }
            }

            // CB1: per-claim publisher block from user's self-managed list.
            // Treated as a hard reject (gap-set) so chain state stays linear.
            if (_userBlocksPublisher[user][claim.publisher]) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 28);
                emit UserBlocklistRejected(user, claim.publisher);
                gapFound = true;
                continue;
            }

            // Delegate validation to ClaimValidator satellite (SE-1)
            uint256 expectedNonce  = _lastNonce[user][claim.campaignId][claim.actionType] + 1;
            bytes32 expectedPrevHash = _lastClaimHash[user][claim.campaignId][claim.actionType];

            (bool ok, uint8 reasonCode, uint16 cTakeRate, bytes32 computedHash) =
                _claimValidator.validateClaim(claim, user, expectedNonce, expectedPrevHash);

            if (!ok) {
                if (reasonCode == 7) gapFound = true;
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, reasonCode);
                continue;
            }

            // BM-2: Per-user settlement cap check (per actionType)
            uint256 newTotal = _userCampaignSettled[user][claim.campaignId][claim.actionType] + claim.eventCount;
            if (newTotal > MAX_USER_EVENTS) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 13);
                gapFound = true;
                continue;
            }
            _userCampaignSettled[user][claim.campaignId][claim.actionType] = newTotal;

            // #1: Per-user per-campaign per-window cap (advertiser-set).
            //     Hedge #4: switched to safe variant. Returns (ok=true,
            //     max, win) when known; (ok=false, 0, 0) when unknown.
            //     Both branches treat "no cap" identically (skip the block),
            //     so we just check max > 0 after the safe call.
            if (address(_campaigns) != address(0)) {
                (, uint32 capMax, uint32 capWin) = _campaigns.getCampaignUserCapSafe(claim.campaignId);
                if (capMax > 0) {
                    if (capWin > 0) {
                        uint256 wid = block.number / uint256(capWin);
                        uint256 cur = _userCampaignWindowEvents[user][claim.campaignId][claim.actionType][wid];
                        if (cur + claim.eventCount > uint256(capMax)) {
                            result.rejectedCount++;
                            emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 29);
                            gapFound = true;
                            continue;
                        }
                        _userCampaignWindowEvents[user][claim.campaignId][claim.actionType][wid] = cur + claim.eventCount;
                    }
                }
            }

            // C1: Per-advertiser cross-campaign user pacing cap. The
            // advertiser publishes one (maxEvents, windowBlocks) bucket
            // applying across their entire portfolio. Reject reason 35.
            if (address(_campaigns) != address(0)) {
                address advertiser = _campaigns.getCampaignAdvertiser(claim.campaignId);
                if (advertiser != address(0)) {
                    (uint32 advMax, uint32 advWin) = _campaigns.getAdvertiserPacing(advertiser);
                    if (advMax > 0 && advWin > 0) {
                        uint256 awid = block.number / uint256(advWin);
                        uint256 acur = _advertiserUserWindowEvents[advertiser][user][awid];
                        if (acur + claim.eventCount > uint256(advMax)) {
                            result.rejectedCount++;
                            emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 35);
                            gapFound = true;
                            continue;
                        }
                        _advertiserUserWindowEvents[advertiser][user][awid] = acur + claim.eventCount;
                    }
                }
            }

            // BM-5: Per-publisher window rate limit (view claims only).
            //       Delegated to DatumSettlementRateLimiter (atomic try-consume).
            if (address(_rateLimiter) != address(0) && claim.actionType == 0) {
                if (!_rateLimiter.tryConsume(claim.publisher, claim.eventCount)) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 14);
                    gapFound = true;
                    continue;
                }
            }

            // FP-1: Publisher stake adequacy check (optional)
            if (address(_publisherStake) != address(0)) {
                if (!_publisherStake.isAdequatelyStaked(claim.publisher)) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 15);
                    gapFound = true;
                    continue;
                }
            }

            // FP-5: Nullifier replay check + register (atomic; view claims only).
            //       Delegated to DatumNullifierRegistry.tryConsume which marks
            //       the nullifier used and returns false on replay collision.
            if (
                address(_nullifiers) != address(0) &&
                claim.actionType == 0 &&
                claim.nullifier != bytes32(0)
            ) {
                if (!_nullifiers.tryConsume(claim.campaignId, claim.nullifier)) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(claim.campaignId, user, claim.nonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI): update chain state before external calls
            _lastClaimHash[user][claim.campaignId][claim.actionType] = computedHash;
            _lastNonce[user][claim.campaignId][claim.actionType] = claim.nonce;

            // CPC: mark click session as claimed (type-1 only)
            if (claim.actionType == 1 && address(_clickRegistry) != address(0) && claim.clickSessionHash != bytes32(0)) {
                _clickRegistry.markClaimed(user, claim.campaignId, claim.clickSessionHash);
            }

            // Compute payment
            uint256 totalPayment;
            if (claim.actionType == 0) {
                totalPayment = (claim.ratePlanck * claim.eventCount) / 1000;
            } else {
                totalPayment = claim.ratePlanck * claim.eventCount;
            }

            uint256 publisherPayment = (totalPayment * cTakeRate) / BPS_DENOMINATOR;
            uint256 rem = totalPayment - publisherPayment;
            uint256 userPayment = (rem * uint256(_userShareBps)) / BPS_DENOMINATOR;
            uint256 protocolFee = rem - userPayment;

            // Deduct from budget ledger and transfer DOT to payment vault
            bool exhausted = _budgetLedger.deductAndTransfer(
                claim.campaignId, claim.actionType, totalPayment, address(_paymentVault)
            );
            if (exhausted) {
                agg.exhausted = true;
                agg.campaignIdExhausted = campaignId;
                gapFound = true;
            }

            agg.total += totalPayment;
            agg.publisherPayment += publisherPayment;
            agg.userPayment += userPayment;
            agg.protocolFee += protocolFee;
            if (agg.publisher == address(0)) agg.publisher = claim.publisher;

            // Token reward (view claims only)
            if (claim.actionType == 0 && agg.rewardToken != address(0) && agg.rewardPerImpression > 0) {
                agg.tokenReward += claim.eventCount * agg.rewardPerImpression;
            }

            // Track events for publisher stake bonding curve
            agg.eventsSettled += claim.eventCount;

            // #2-extension: cumulative settled events across all campaigns.
            _userTotalSettled[user] += claim.eventCount;

            result.settledCount++;
            result.totalPaid += totalPayment;

            emit IDatumSettlement.ClaimSettled(
                claim.campaignId,
                user,
                claim.publisher,
                claim.eventCount,
                claim.ratePlanck,
                claim.actionType,
                claim.nonce,
                publisherPayment,
                userPayment,
                protocolFee
            );
        }

        // #5: PoW leaky-bucket update — one engine call per batch.
        if (address(_powEngine) != address(0) && agg.eventsSettled > 0) {
            _powEngine.consumeFor(user, agg.eventsSettled);
        }

        // L-7: Global per-block circuit breaker
        if (agg.total > 0 && _maxSettlementPerBlock > 0) {
            if (_cbBlock != block.number) {
                _cbBlock = block.number;
                _cbTotal = 0;
            }
            _cbTotal += agg.total;
            if (!(_cbTotal <= _maxSettlementPerBlock)) revert E80();
        }

        // Aggregate paymentVault credit
        if (agg.total > 0) {
            _paymentVault.creditSettlement(
                agg.publisher, agg.publisherPayment, user, agg.userPayment, agg.protocolFee
            );
        }

        // ── DATUM token mint — delegated to DatumMintCoordinator ──
        // Hedge #4: safe variant. advertiser address is best-effort -- the
        // coordinator's split bps tolerates address(0) (no advertiser share).
        if (address(_mintCoordinator) != address(0) && agg.total > 0) {
            address advertiser;
            if (address(_campaigns) != address(0)) {
                (, advertiser) = _campaigns.getCampaignAdvertiserSafe(campaignId);
            }
            _mintCoordinator.coordinate(user, agg.publisher, advertiser, agg.total);
        }

        // Aggregate token reward credit (view claims only, non-critical)
        if (agg.tokenReward > 0) {
            // SAFETY: fail-SOFT on revert (L-4). Token reward is additive on
            //         top of DOT settlement and the user has already been
            //         credited their DOT share. If the vault is out of
            //         tokens or mis-wired, we emit RewardCreditFailed so
            //         off-chain monitors can detect + refund, but we don't
            //         revert the whole batch -- DOT settlement is the
            //         primary value flow and must not be DoS-able by a
            //         non-critical reward credit.
            try _tokenRewardVault.creditReward(campaignId, agg.rewardToken, user, agg.tokenReward) {}
            catch {
                emit RewardCreditFailed(campaignId, user, agg.rewardToken, agg.tokenReward);
            }
        }

        // FP-1: Record settled events on publisher stake bonding curve
        if (address(_publisherStake) != address(0) && agg.eventsSettled > 0 && agg.publisher != address(0)) {
            _publisherStake.recordImpressions(agg.publisher, agg.eventsSettled);
        }

        // CB4: Record DOT spent on advertiser stake bonding curve. Best-effort.
        // Hedge #4: safe variant. If the campaign is unknown, advertiser_
        // stays address(0) and the bonding curve update is skipped.
        if (_advertiserStake != address(0) && agg.total > 0 && address(_campaigns) != address(0)) {
            (, address advertiser_) = _campaigns.getCampaignAdvertiserSafe(campaignId);
            if (advertiser_ != address(0)) {
                // SAFETY: fail-SOFT via low-level call (CB4 best-effort).
                //         A misconfigured advertiser-stake target -- whether
                //         a hostile target, a missing recordBudgetSpent,
                //         or an out-of-gas revert -- must NOT DoS the
                //         settlement. The boolean return is intentionally
                //         suppressed. Stake bonding curve advancement is a
                //         secondary economic signal; the primary value flow
                //         (paymentVault credit) has already completed.
                (bool ok2, ) = _advertiserStake.call(abi.encodeWithSignature(
                    "recordBudgetSpent(address,uint256)",
                    advertiser_, agg.total
                ));
                ok2;
            }
        }

        // FP-16: Record reputation stats via the carved-out module.
        if (address(_reputation) != address(0) && agg.publisher != address(0)) {
            uint256 batchSettled  = result.settledCount  - prevSettledCount;
            uint256 batchRejected = result.rejectedCount - prevRejectedCount;
            if (batchSettled > 0 || batchRejected > 0) {
                _reputation.recordSettlement(agg.publisher, campaignId, batchSettled, batchRejected);
            }
        }

        // Auto-complete campaign if budget exhausted
        if (agg.exhausted) {
            _lifecycle.completeCampaign(agg.campaignIdExhausted);
        }

        // BM-10: Record block of last successful settlement
        if (interval > 0 && result.settledCount > prevSettledCount) {
            _lastSettlementBlock[user][campaignId][batchActionType] = block.number;
        }

        return (result.settledCount, result.rejectedCount, result.totalPaid);
    }
}
