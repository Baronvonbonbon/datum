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

        // F-010 fix (2026-05-20): require Campaigns is wired. Several
        // assurance gates downstream (L3 ZK floor, AssuranceLevel, identity
        // gate, user-blocks-advertiser, per-window cap) bail out as no-ops
        // if `_campaigns == address(0)`. Settlement is not functional
        // without it; fail-closed at the top so an unconfigured Settlement
        // can never settle.
        if (address(_campaigns) == address(0)) revert E00();

        // F-001 / F-002 fix (2026-05-20): every claim in a batch must target
        // the same publisher as claims[0]. Aggregate payment math credits
        // agg.publisher = claims[0].publisher; a mixed-publisher batch would
        // silently misallocate publisher revenue, miscount events on the
        // bonding curve, mis-attribute reputation signal, and let a publisher
        // under reputation-throttling evade the canSettle gate by submitting
        // batches led by a clean publisher in slot 0. DualSig and Relay's
        // open-campaign path already enforce this; LogicB closes the
        // user-EOA / attestationVerifier / targeted-multi-publisher gaps.
        if (claims.length > 1) {
            address p0 = claims[0].publisher;
            for (uint256 i = 1; i < claims.length; i++) {
                if (claims[i].publisher != p0) revert E34();
            }
        }

        // SLIM (#2): the per-claim nonce no longer travels on the claim. For
        // whole-batch reject paths below (which run before batchActionType is
        // computed) we label the i-th rejected claim with startNonce + i,
        // derived from the chain head for the batch's action type. Purely
        // informational for the ClaimRejected events; nothing is consumed.
        uint256 startNonce = claims.length > 0
            ? _lastNonce[user][campaignId][claims[0].actionType] + 1
            : 0;

        // CB2 (2026-05-13): user self-pause kill switch. Reject the whole
        // batch when the user has paused their own account — emits per-claim
        // ClaimRejected so observers can see the cause.
        if (_userPaused[user]) {
            for (uint256 j = 0; j < claims.length; j++) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 27);
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
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 28);
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
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 26);
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
                        emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 30);
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
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, reasonCode);
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
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 18);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        // Safe rollout: reputation gate (delegated to DatumPublisherReputation)
        if (address(_reputation) != address(0) && claims.length > 0) {
            if (!_reputation.canSettle(claims[0].publisher)) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 20);
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

        // -----------------------------------------------------------------
        // HOIST (#1): resolve everything invariant across the batch ONCE,
        // before the per-claim loop. A batch shares one campaignId (per-claim
        // reason-0 guard), one publisher (E34 above), and one actionType
        // (per-claim guard below) -- so the publisher blocklist gates and the
        // validator's ~8 campaign/publisher staticcalls are identical for
        // every claim. Previously each ran once per claim.
        // -----------------------------------------------------------------
        address batchPublisher = claims.length > 0 ? claims[0].publisher : address(0);

        // S12 settlement-level blocklist (hoisted). Gradient preserved:
        // fail-CLOSED via isBlockedStrict at L1+, fail-OPEN via isBlocked at L0.
        if (batchPublisher != address(0) && address(_publishers) != address(0)) {
            bool blocked;
            bool failClosed;
            if (effectiveLevel >= 1) {
                try _publishers.isBlockedStrict(batchPublisher) returns (bool b) {
                    blocked = b;
                } catch {
                    blocked = true;
                    failClosed = true;
                }
            } else {
                blocked = _publishers.isBlocked(batchPublisher);
            }
            if (blocked) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    if (failClosed) emit BlocklistFailedClosed(campaignId, batchPublisher);
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 11);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        // CB1 user-side publisher block (hoisted — publisher invariant).
        if (batchPublisher != address(0) && _userBlocksPublisher[user][batchPublisher]) {
            for (uint256 j = 0; j < claims.length; j++) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, 28);
                emit UserBlocklistRejected(user, batchPublisher);
            }
            return (result.settledCount, result.rejectedCount, result.totalPaid);
        }

        // Resolve the once-per-batch validator context (campaign status, mute,
        // allowlist, take-rate snapshot, pot rate, ZK-required, PoW-enforced).
        // ctx.takeRate replaces the per-claim cTakeRate the monolithic
        // validateClaim used to return.
        IDatumClaimValidator.BatchContext memory ctx;
        if (claims.length > 0) {
            ctx = _claimValidator.resolveBatchContext(campaignId, batchPublisher, batchActionType, user);
            if (!ctx.ok) {
                for (uint256 j = 0; j < claims.length; j++) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, startNonce + j, ctx.reasonCode);
                }
                return (result.settledCount, result.rejectedCount, result.totalPaid);
            }
        }

        for (uint256 i = 0; i < claims.length; i++) {
            IDatumSettlement.Claim calldata claim = claims[i];

            // SLIM (#2): campaignId is the batch's; nonce/prevHash are derived
            // from chain state. The assigned nonce for this claim is the
            // current chain head + 1 -- used in the hash preimage, stored on
            // settle, and emitted in events. A rejected claim does not consume
            // the nonce, so the next claim reuses it (the chain stays linear).
            uint256 assignedNonce = _lastNonce[user][campaignId][batchActionType] + 1;
            bytes32 prevHash      = _lastClaimHash[user][campaignId][batchActionType];

            // HOIST (#1): single-actionType invariant. ctx (pot rate, ZK/PoW
            // flags) was resolved for batchActionType; a claim with a
            // different type would be validated against the wrong pot, so
            // reject it and abort the remainder (keeps the chain linear).
            if (claim.actionType != batchActionType) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 21);
                gapFound = true;
                continue;
            }

            if (gapFound) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 1);
                continue;
            }

            // S12 settlement-level blocklist + CB1 user-side publisher block
            // are HOISTED above the loop (#1): the publisher is invariant
            // across the batch (E34), so both gates run once before the loop
            // instead of once per claim.

            // Delegate per-claim validation to ClaimValidator satellite (SE-1),
            // threading the once-per-batch ctx + derived campaignId/nonce/prevHash
            // so no campaign/publisher staticcalls run here.
            (bool ok, uint8 reasonCode, bytes32 computedHash) =
                _claimValidator.validateClaimWithContext(claim, user, campaignId, assignedNonce, prevHash, ctx);

            if (!ok) {
                // SLIM (#2): any validation failure aborts the remainder. With
                // explicit nonces this happened implicitly (the next claim's
                // nonce no longer matched); with derived nonces we set it
                // explicitly to preserve the abort-on-first-rejection chain.
                gapFound = true;
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, reasonCode);
                continue;
            }

            // BM-2: Per-user settlement cap check (per actionType)
            uint256 newTotal = _userCampaignSettled[user][campaignId][claim.actionType] + claim.eventCount;
            if (newTotal > MAX_USER_EVENTS) {
                result.rejectedCount++;
                emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 13);
                gapFound = true;
                continue;
            }
            _userCampaignSettled[user][campaignId][claim.actionType] = newTotal;

            // #1: Per-user per-campaign per-window cap (advertiser-set).
            //     Hedge #4: switched to safe variant. Returns (ok=true,
            //     max, win) when known; (ok=false, 0, 0) when unknown.
            //     Both branches treat "no cap" identically (skip the block),
            //     so we just check max > 0 after the safe call.
            if (address(_campaigns) != address(0)) {
                (, uint32 capMax, uint32 capWin) = _campaigns.getCampaignUserCapSafe(campaignId);
                if (capMax > 0) {
                    if (capWin > 0) {
                        uint256 wid = block.number / uint256(capWin);
                        uint256 cur = _userCampaignWindowEvents[user][campaignId][claim.actionType][wid];
                        if (cur + claim.eventCount > uint256(capMax)) {
                            result.rejectedCount++;
                            emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 29);
                            gapFound = true;
                            continue;
                        }
                        _userCampaignWindowEvents[user][campaignId][claim.actionType][wid] = cur + claim.eventCount;
                    }
                }
            }

            // BM-5: Per-publisher window rate limit (view claims only).
            //       Delegated to DatumSettlementRateLimiter (atomic try-consume).
            if (address(_rateLimiter) != address(0) && claim.actionType == 0) {
                if (!_rateLimiter.tryConsume(claim.publisher, claim.eventCount)) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 14);
                    gapFound = true;
                    continue;
                }
            }

            // FP-1: Publisher stake adequacy check (optional)
            if (address(_publisherStake) != address(0)) {
                if (!_publisherStake.isAdequatelyStaked(claim.publisher)) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 15);
                    gapFound = true;
                    continue;
                }
            }

            // SLIM (#2b): nullifier + clickSessionHash live in the optional
            // proof sidecar (empty for plain view claims).
            bytes32 claimNullifier = claim.proof.length > 0 ? claim.proof[0].nullifier : bytes32(0);
            bytes32 claimClickSession = claim.proof.length > 0 ? claim.proof[0].clickSessionHash : bytes32(0);

            // FP-5: Nullifier replay check + register (atomic; view claims only).
            //       Delegated to DatumNullifierRegistry.tryConsume which marks
            //       the nullifier used and returns false on replay collision.
            if (
                address(_nullifiers) != address(0) &&
                claim.actionType == 0 &&
                claimNullifier != bytes32(0)
            ) {
                if (!_nullifiers.tryConsume(campaignId, claimNullifier)) {
                    result.rejectedCount++;
                    emit IDatumSettlement.ClaimRejected(campaignId, user, assignedNonce, 19);
                    gapFound = true;
                    continue;
                }
            }

            // Effects first (CEI): update chain state before external calls
            _lastClaimHash[user][campaignId][claim.actionType] = computedHash;
            _lastNonce[user][campaignId][claim.actionType] = assignedNonce;

            // CPC: mark click session as claimed (type-1 only)
            if (claim.actionType == 1 && address(_clickRegistry) != address(0) && claimClickSession != bytes32(0)) {
                _clickRegistry.markClaimed(user, campaignId, claimClickSession);
            }

            // Compute payment
            uint256 totalPayment;
            if (claim.actionType == 0) {
                totalPayment = (claim.rateWei * claim.eventCount) / 1000;
            } else {
                totalPayment = claim.rateWei * claim.eventCount;
            }

            uint256 publisherPayment = (totalPayment * ctx.takeRate) / BPS_DENOMINATOR;
            uint256 rem = totalPayment - publisherPayment;
            uint256 userPayment = (rem * uint256(_userShareBps)) / BPS_DENOMINATOR;
            uint256 protocolFee = rem - userPayment;

            // Deduct from budget ledger (state-only). The aggregate DOT is moved to the
            // PaymentVault once per batch via transferSettled() below — collapsing N
            // per-claim native transfers into one (pallet-revive storage-deposit fix).
            bool exhausted = _budgetLedger.deduct(
                campaignId, claim.actionType, totalPayment
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
                campaignId,
                user,
                claim.publisher,
                claim.eventCount,
                claim.rateWei,
                claim.actionType,
                assignedNonce,
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

        // Aggregate budget→vault transfer + vault credit — one of each per batch.
        // transferSettled moves the batch's summed DOT (== agg.total == sum of per-claim
        // deduct amounts) to the vault in a single native transfer; creditSettlement then
        // books the per-party split (which sums to agg.total).
        if (agg.total > 0) {
            _budgetLedger.transferSettled(address(_paymentVault), agg.total);
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

        // FP-1: Record settled events on publisher stake bonding curve.
        // F-011 fix (2026-05-20): fail-SOFT via try/catch. recordImpressions
        // currently only reverts on `msg.sender != settlementContract`,
        // which can't happen in normal operation — but a future
        // PublisherStake upgrade could tighten auth or add other reverts;
        // bonding-curve advancement is a secondary signal and must not
        // DoS the primary DOT settlement.
        if (address(_publisherStake) != address(0) && agg.eventsSettled > 0 && agg.publisher != address(0)) {
            try _publisherStake.recordImpressions(agg.publisher, agg.eventsSettled) {} catch {}
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
        // F-011 fix: fail-SOFT — reputation signal is secondary; future
        // upgrades shouldn't be able to DoS DOT settlement.
        if (address(_reputation) != address(0) && agg.publisher != address(0)) {
            uint256 batchSettled  = result.settledCount  - prevSettledCount;
            uint256 batchRejected = result.rejectedCount - prevRejectedCount;
            if (batchSettled > 0 || batchRejected > 0) {
                try _reputation.recordSettlement(agg.publisher, campaignId, batchSettled, batchRejected) {} catch {}
            }
        }

        // Auto-complete campaign if budget exhausted.
        // F-011 fix: fail-SOFT — DOT settlement has already credited
        // PaymentVault; if lifecycle.completeCampaign reverts for any
        // reason (future upgrade, status mismatch, etc.) we should not
        // unwind that credit. Lifecycle can be advanced manually later.
        if (agg.exhausted) {
            try _lifecycle.completeCampaign(agg.campaignIdExhausted) {} catch {}
        }

        // BM-10: Record block of last successful settlement
        if (interval > 0 && result.settledCount > prevSettledCount) {
            _lastSettlementBlock[user][campaignId][batchActionType] = block.number;
        }

        return (result.settledCount, result.rejectedCount, result.totalPaid);
    }
}
