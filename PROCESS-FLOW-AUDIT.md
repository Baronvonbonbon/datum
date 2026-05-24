# DATUM Process Flow Audit

Per-role enumeration of every process flow on the **webapp**
(`web/`) and the **extension** (`alpha-5/extension/`), with
step-by-step descriptions, contract touches, expected state changes,
and common error modes. Followed by a **Legacy + unused content**
section that flags dead code uncovered during the walk.

Generated 2026-05-23 against alpha-5 v5 (deployedAt
`2026-05-23T12:23:32Z`). Re-run this audit on any major rev to keep
the runbook current.

## Conventions

- **Surface** = webapp page (e.g., `/me/history`) or extension tab
  (e.g., `Earnings`).
- **Contracts touched** = canonical `Datum*` contract names.
  Resolution is via `DatumGovernanceRouter` registry where the
  webapp uses `useContracts`; direct addresses are noted otherwise.
- **State change** = on-chain (storage write, event emit), local
  storage (extension), or both.
- **Error modes** = the documented revert codes (E00–E76 + custom)
  or surface-level errors a user would see.

## Surface inventory

### Webapp routes (94 routes from `web/src/App.tsx`)

Grouped by persona:

| Persona | Routes |
|---|---|
| Explorer | `/`, `/explorer`, `/campaigns`, `/campaigns/:id`, `/publishers`, `/publishers/:address`, `/advertisers/:address`, `/how-it-works`, `/philosophy` (+ `/explorer/*` aliases) |
| About | `/about`, `/about/me`, `/about/advertiser`, `/about/publisher`, `/about/governance`, `/about/token`, `/about/identity`, `/about/protocol` |
| Me | `/me`, `/me/history`, `/me/identity`, `/me/assurance`, `/me/dust` |
| Advertiser | `/advertiser`, `/advertiser/create`, `/advertiser/campaign/:id`, `/advertiser/campaign/:id/metadata`, `/advertiser/campaign/:id/bulletin`, `/advertiser/analytics` |
| Publisher | `/publisher`, `/publisher/register`, `/publisher/rate`, `/publisher/categories`, `/publisher/allowlist`, `/publisher/earnings`, `/publisher/sdk`, `/publisher/profile`, `/publisher/stake` |
| Governance | `/governance`, `/governance/activation-bonds`, `/governance/vote/:id`, `/governance/my-votes`, `/governance/parameters`, `/governance/publisher-fraud`, `/governance/advertiser-fraud`, `/governance/protocol`, `/governance/council`, `/governance/fraud-claims`, `/governance/phase`, `/governance/phase-ladder` |
| Token | `/token`, `/token/wrapper`, `/token/fee-share`, `/token/bootstrap`, `/token/vesting`, `/token/mint-coordinator` |
| Identity | `/identity`, `/identity/people-chain`, `/identity/zk` |
| Protocol | `/protocol`, `/protocol/upgrades`, `/protocol/tag-curator`, `/protocol/pause-registry`, `/protocol/parameter-governance`, `/protocol/sybil-defense`, `/protocol/publisher-stake`, `/protocol/challenge-bonds`, `/protocol/blocklist`, `/protocol/protocol-fees`, `/protocol/timelock`, `/protocol/mint-authority` |
| Admin (legacy aliases) | `/admin`, `/admin/timelock`, `/admin/pause`, `/admin/blocklist`, `/admin/protocol`, `/admin/rate-limiter`, `/admin/reputation`, `/admin/parameter-governance`, `/admin/publisher-stake`, `/admin/publisher-governance`, `/admin/challenge-bonds`, `/admin/nullifier-registry`, `/admin/sybil-defense`, `/admin/mint-authority` |
| Settings | `/settings`, `/settings/house-ads` |
| Demo | `/demo` |

### Extension popup tabs (6 active, `alpha-5/extension/src/popup/App.tsx`)

| Tab | Component | Purpose |
|---|---|---|
| Accounts | `wallet/AccountsTab` | Wallet management — list accounts, switch active, import/export |
| Send | `wallet/SendTab` | Send DOT to an address |
| Receive | `wallet/ReceiveTab` | Show active address + QR for receiving DOT |
| History | `wallet/TxHistoryTab` | Broadcast-TX log (signed via this wallet) |
| Earnings | `wallet/EarningsTab` | Protocol-side: pending PaymentVault balance + withdraw |
| Settings | `wallet/SettingsTab` | Wallet password, recovery, AssuranceLevel, permissions, theme |

### Roles served

| Role | Webapp surface | Extension surface |
|---|---|---|
| User | `/me/*`, `/about/me`, Explorer (read-only) | All popup tabs |
| Advertiser | `/advertiser/*`, `/about/advertiser` | Send (fund campaigns), Earnings (view pending refunds) |
| Publisher | `/publisher/*`, `/about/publisher` | Send (fund stake), Earnings (withdraw take-rate) |
| Voter | `/governance/*`, `/about/governance` | Send (fund vote stake) |
| Council member | `/governance/council`, `/protocol/*` | n/a |
| Curator | `/protocol/blocklist`, `/protocol/tag-curator` | n/a |
| Admin / guardian | `/protocol/pause-registry`, `/admin/*` aliases | n/a |
| Relay operator | n/a (operates server-side) | n/a (off-chain bot, separate repo) |
| Reporter (V1/V2) | `/protocol/*` (read-only) | n/a |
| Token holder | `/token/*`, `/about/token` | Send (transfer DATUM), Earnings (claim fee share) |
| Vesting beneficiary | `/token/vesting` | Send (release vested tokens) |

---

## Per-role flows

### Role: User

End-user with the extension installed. Sees ads, accrues claims,
withdraws DOT + (optional) DATUM rewards.

#### Flow U-1: First-time onboarding

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Extension popup (first launch) | `OnboardingFlow` → `SetPasswordScreen` → `GenerateMnemonic` OR `ImportWallet` | none | local: encrypted wallet seed stored in `chrome.storage.local` |
| 2 | Extension Accounts | User confirms active address shown | none | local: `connectedAddress` |
| 3 | Extension Settings | (optional) User toggles `usePine` ON, `rpcEnabled` OFF — cypherpunk default | none | local: settings updated |
| 4 | Webapp `/me` | User connects same wallet via "Connect" header button | none | Wallet provider session |

Error modes: password mismatch on set; mnemonic length wrong on
import; pine cold-start delay (~30s on first network connect).

#### Flow U-2: Ad served + claim recorded (passive)

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Browser tab | User loads a page running the DATUM SDK | `DatumCampaigns` (read), `DatumPublishers` (read) via `campaignPoller.poll` | local: `activeCampaigns`, `campaignIndex` |
| 2 | Extension content script | SDK ↔ extension handshake; extension matches a campaign to the page's tags | `DatumTagSystem` (read) for tag match | local: per-tab impression tracking |
| 3 | Extension background | Records the impression in a hash-chained claim queue | none (off-chain only) | local: `claimQueue` |
| 4 | Extension background (auto-submit, if enabled) | When queue threshold hit, builds `SignedClaimBatch` and submits | `DatumSettlement.settleClaims` (write) | on-chain: claim settled, `PaymentVault` credited |

Error modes: SDK not loaded on the page (silent skip); no matching
campaign (no impression); claim chain integrity failure (E14); rate
limit (E68); stake below required (E15).

#### Flow U-3: Manual submit claims

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Extension popup → Earnings | (in current build, manual submit moved out of popup) | n/a | n/a |
| 2 | Extension popup → ClaimQueue (LEGACY — only in App.legacy) | Submit pending claims | `DatumSettlement.settleClaims` | on-chain |

**Audit note:** in the active popup (`App.tsx`), there is no manual
"submit claims" surface; only auto-submit and the relay-path
publisher-side cosig flow. The legacy `ClaimQueue.tsx` covered the
manual path. Reintroducing manual submission to the new popup is a
separate UX decision.

#### Flow U-4: Withdraw pending DOT

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Extension popup → Earnings | Tab loads; reads pending balance | `DatumPaymentVault.userBalance` | none |
| 2 | Extension popup → Earnings | "Withdraw to active account" button | `DatumPaymentVault.withdrawUser` (write) | on-chain: balance → wallet |
| 3 | Webapp `/me/dust` (alternative) | Same call exposed as web UI | `DatumPaymentVault.withdrawUser` | on-chain |

Error modes: E03 (zero balance), insufficient gas, network unreachable.

#### Flow U-5: View earnings history

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/me/history` | Page loads, displays cached scan | n/a | none |
| 2 | Webapp `/me/history` | If pine window doesn't cover requested range, `EnableRpcCta` renders | n/a | none |
| 3 | Webapp `/me/history` | Click "Pull once via RPC" → temp-enable RPC, run scan, disable | `DatumSettlement` event logs | local: `EarningsIndex` updated |
| 4 | Extension popup → Earnings | Pending balance shown, but historical settlement list is empty in v5 (event-stream wiring deferred) | `DatumPaymentVault` | none |

**Audit note (legacy):** the legacy `HistoryTab.tsx` had a richer
scan UI that's not exposed in the new popup. The "Refresh history"
button added in commit `f618b89` lives in `HistoryTab.tsx` for
future reintroduction; not currently wired into `App.tsx`.

#### Flow U-6: Set assurance floor (self-protect)

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/me/assurance` | Page loads, reads current floor | `DatumSettlement.userMinAssurance` | none |
| 2 | Webapp `/me/assurance` | Pick level (0=Permissive, 1=Publisher-signed, 2=Dual-signed), Save | `DatumSettlement.setUserMinAssurance` (write) | on-chain |
| 3 | Extension popup → Settings → AssuranceSection (parallel surface) | Same setter exposed in popup | same | same |

Error modes: invalid level (out of range); wallet not connected.

#### Flow U-7: Manage People Chain identity

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/me/identity` | Read cached identity attestation | `DatumPeopleChainIdentity` | none |
| 2 | Webapp `/me/identity` | Refresh — dispatches XCM to People Chain | `DatumPeopleChainXcmBridge.requestRefresh` (write) | on-chain: XCM dispatched |
| 3 | Webapp `/me/identity` | (async, ~minutes later) Cache updates from oracle callback | `DatumPeopleChainBondedReporter.attest` or oracle | on-chain |
| 4 | Webapp `/me/identity` | Set identity floor (require Reasonable / KnownGood) | self-floor setter on PeopleChainIdentity | on-chain |

Error modes: XCM bridge unreachable; identity not registered on
People Chain (level stays 0); refresh fee insufficient.

#### Flow U-8: Report a campaign or publisher

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/campaigns/:id` or `/publishers/:address` | "Report" button | `DatumReports.reportPage` or `reportAd` | on-chain: report emitted |
| 2 | Extension popup → ReportsTab (LEGACY) | Same reporting surface | same | same |

**Audit note (legacy):** `ReportsTab.tsx` is only used by
`App.legacy.tsx`. Active popup has no report flow.

---

### Role: Advertiser

Creates and operates ad campaigns. Funds campaigns with DOT,
optionally ERC-20 reward tokens.

#### Flow A-1: Register as advertiser (implicit)

Advertisers don't explicitly register on-chain — first
`createCampaign` call establishes them. The CB4 `AdvertiserStake`
contract requires a one-time bond before serious campaign volume:

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | n/a (currently no webapp UI) | Stake DOT via `DatumAdvertiserStake.stake()` | `DatumAdvertiserStake` | on-chain |

**Audit note:** no `/advertiser/stake` page exists yet. The
contract is deployed (alpha-5 v5) but ungated in the UI. Mirrors
`publisher/stake` should be added in a future iteration.

#### Flow A-2: Create a campaign

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/advertiser/create` | Multi-pot wizard: name, budget, daily cap, CPM bid, optional CPC + CPA pots, publisher target (open or pinned), tag requirements, creative content (text + CTA + image/video), optional ERC-20 reward sidecar | `DatumCampaigns.minimumCpmFloor` (read), `DatumTagSystem.isTagApproved` (read) | none |
| 2 | Webapp `/advertiser/create` | Submit → IPFS pin creative → call `createCampaign` | `DatumCampaigns.createCampaign` (write), `DatumBudgetLedger.initializeBudget` (write), `DatumChallengeBonds.lockBond` (write) | on-chain: campaign in Pending; budget escrowed; activation bond locked |
| 3 | Webapp `/advertiser/campaign/:id` | View created campaign (Pending state) | `DatumCampaigns.getCampaign` | none |
| 4 | After governance vote (see V-2) | Activated by anyone via `governance.evaluateCampaign` | `DatumGovernanceV2.evaluateCampaign` | on-chain: status Pending → Active |

Error modes: E27 (below CPM floor), E15 (publisher not registered),
E66 (too many tags), E11 (zero value), IPFS pin failure, governance
rejection (vote terminates).

#### Flow A-3: Set campaign metadata (post-create)

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/advertiser/campaign/:id/metadata` | Update text, CTA, landing URL | `DatumCampaigns.setMetadata` (write) | on-chain: metadata hash updated |

#### Flow A-4: Bulletin Chain creative manager

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/advertiser/campaign/:id/bulletin` | Pin / renew / migrate creative to Bulletin Chain | `DatumCampaignCreative.pin` / `.renew` | on-chain |

#### Flow A-5: View campaign analytics

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/advertiser/analytics` | Aggregated: total spend, impressions, top publishers, rejection rates | `DatumSettlement` event logs (via pine or RPC) | none |

#### Flow A-6: Terminate / refund a campaign

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/advertiser/campaign/:id` | "Terminate" button (only after governance approves) | `DatumCampaignLifecycle.terminateCampaign` | on-chain: status → Terminated; budget refunded |
| 2 | Same surface | "Refund pending" (after auto-expiry) | `DatumCampaignLifecycle.expirePending` | on-chain |

Error modes: E64 (still active), E18 (not advertiser), E62 (paused).

---

### Role: Publisher

Operates a site or app running the DATUM SDK. Earns a take-rate per
settled impression.

#### Flow P-1: Register as publisher

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/publisher/register` | Form: pick take rate (30-80%); optional whitelist gating | `DatumPublishers.whitelistMode`, `.stakeGate` (read) | none |
| 2 | Webapp `/publisher/register` | Submit | `DatumPublishers.registerPublisher` (write) | on-chain: publisher registered |
| 3 | Webapp `/publisher/profile` | Set profile metadata (display name, contact) | `DatumPublishers.setProfile` | on-chain |
| 4 | Webapp `/publisher/sdk` | Copy SDK snippet, add to site | n/a (off-chain) | none |

Error modes: E15 (already registered), whitelist restricted without
stake, take rate out of bounds [3000, 8000].

#### Flow P-2: Configure tags

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/publisher/categories` | Pick from curated tag dictionary | `DatumTagSystem.isTagApproved` (read) | none |
| 2 | Webapp `/publisher/categories` | Save | `DatumTagSystem.setPublisherTags` (write) | on-chain |

#### Flow P-3: Set per-campaign allowlist

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/publisher/allowlist` | View current allowlist + recently-active campaigns | `DatumCampaignAllowlist.getAllowed` | none |
| 2 | Webapp `/publisher/allowlist` | Allow / deny specific campaigns | `DatumCampaignAllowlist.allowCampaign` / `.denyCampaign` (write) | on-chain |

#### Flow P-4: Manage stake

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/publisher/stake` | View current stake + required | `DatumPublisherStake.staked`, `.requiredStake` | none |
| 2 | Webapp `/publisher/stake` | Stake more DOT | `DatumPublisherStake.stake` (payable) | on-chain |
| 3 | Webapp `/publisher/stake` | Request unstake | `DatumPublisherStake.requestUnstake` | on-chain: lock period starts |
| 4 | Webapp `/publisher/stake` | Withdraw after lockup | `DatumPublisherStake.withdrawPending` | on-chain |

Error modes: E03 (zero stake), E64 (lockup not elapsed), stake-gate
underflow.

#### Flow P-5: Adjust take rate

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/publisher/rate` | Slider [3000, 8000] bps | none | none |
| 2 | Webapp `/publisher/rate` | Save | `DatumPublishers.setTakeRate` | on-chain (new rate applies to future activations only) |

#### Flow P-6: Withdraw earnings

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/publisher/earnings` | Read accrued DOT | `DatumPaymentVault.publisherBalance` | none |
| 2 | Webapp `/publisher/earnings` | Withdraw | `DatumPaymentVault.withdrawPublisher` | on-chain |

---

### Role: Voter (Governance)

Conviction-weighted DOT staker. Votes on campaign activation; earns
from slash pools on correct nay-votes; pays a small slash on
incorrect aye-votes.

#### Flow V-1: Browse open votes

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance` | Dashboard — phase, council size, recent activity | `DatumGovernanceRouter.phase`, `DatumCouncil.memberCount` | none |
| 2 | Webapp `/campaigns` filtered by Pending | List of campaigns awaiting vote | `DatumCampaigns.getCampaign` | none |

#### Flow V-2: Cast a vote

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/vote/:id` | View campaign + creative; pick aye/nay + conviction (0-8) | `DatumCampaigns.getCampaign`, `DatumGovernanceV2.convictionLockup` | none |
| 2 | Webapp `/governance/vote/:id` | Submit vote with attached DOT | `DatumGovernanceV2.vote` (payable) | on-chain: vote recorded; DOT locked per conviction |
| 3 | Anyone | `evaluateCampaign` once quorum + grace elapsed | `DatumGovernanceV2.evaluateCampaign` | on-chain: status flips |

Error modes: E40 (already voted), E27 (below quorum at evaluation),
E64 (grace not elapsed), E18 (campaign already evaluated).

#### Flow V-3: Track my votes + claim from slash pool

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/my-votes` | Per-vote: my conviction, lockup remaining, outcome, claimable slash share | `DatumGovernanceV2.getVote`, `.pendingPayout` | none |
| 2 | Webapp `/governance/my-votes` | Claim slash share | `DatumGovernanceV2.claimPayout` | on-chain |
| 3 | Webapp `/governance/my-votes` | Withdraw unlocked stake | `DatumGovernanceV2.withdrawUnlockedStake` | on-chain |

#### Flow V-4: Activation bonds

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/activation-bonds` | List of open bonds; spam-challenge a bond | `DatumActivationBonds.challenge` | on-chain |

#### Flow V-5: Publisher fraud track

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/publisher-fraud` | List open proposals; propose new fraud claim | `DatumPublisherGovernance.propose` | on-chain |
| 2 | Same surface | Vote on existing proposal | `DatumPublisherGovernance.vote` | on-chain |

#### Flow V-6: Advertiser fraud track (mirror)

Same shape as V-5, using `DatumAdvertiserGovernance`. Webapp:
`/governance/advertiser-fraud`.

---

### Role: Council member

N-of-M emergency multisig. Phase-1 fast-path governance. Can pause
the protocol per category, propose router upgrades, manage blocklist
curators.

#### Flow C-1: View council state

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/council` | Members, threshold, open proposals | `DatumCouncil.members`, `.threshold`, `.nextProposalId` | none |

#### Flow C-2: Propose / vote / execute a council action

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/council` | "New proposal" form: target, calldata, description | none | none |
| 2 | Same | Submit | `DatumCouncil.propose` (write, member-only) | on-chain |
| 3 | Same | Other members vote | `DatumCouncil.vote` | on-chain |
| 4 | Same | After voting window + execution delay + veto window, anyone can execute | `DatumCouncil.execute` | on-chain: target call dispatched |

Error modes: E18 (not member), E40 (insufficient votes), E64
(execution delay not elapsed), veto cancelled.

---

### Role: Curator (blocklist / tag)

Council-delegated role with fast-path authority over the blocklist
and the curated tag dictionary.

#### Flow Cu-1: Block / unblock an address

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/protocol/blocklist` | List currently blocked addresses | `DatumCouncilBlocklistCurator.isBlocked` | none |
| 2 | Same | Add an address with a reason hash | `DatumCouncilBlocklistCurator.blockAddr` | on-chain |
| 3 | Same | Remove an address | `DatumCouncilBlocklistCurator.unblockAddr` | on-chain |

#### Flow Cu-2: Approve / remove a tag

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/protocol/tag-curator` | List approved tags | `DatumTagCurator.isTagApproved` | none |
| 2 | Same | Approve a tag (council member only) | `DatumTagCurator.approveTag` | on-chain |
| 3 | Same | Remove a tag | `DatumTagCurator.removeTag` | on-chain |

---

### Role: Admin / Guardian

Pause and unpause the protocol. Manage emergency response. Wired to
deployer in Phase 0; transitions to Council / Timelock per the
governance ladder.

#### Flow Ad-1: Emergency pause

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/protocol/pause-registry` | Trigger pause (whole protocol or per category) | `DatumPauseRegistry.pause` or `.pauseCategory` | on-chain: pause flag set |
| 2 | Same | Guardian proposes unpause; 2nd guardian approves (2-of-3) | `.proposeCategoryUnpause`, `.approve` | on-chain |

Error modes: E18 (not owner / not guardian), E11 (invalid category
bitmask).

#### Flow Ad-2: Re-tune a governable parameter (owner path)

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/protocol/*` (per contract) | Direct `setX` call (Phase 0 only; otherwise Timelock) | varies | on-chain |
| 2 | Webapp `/protocol/parameter-governance` | Alternative: route through PG bicameral flow | `DatumParameterGovernance.propose` → vote → execute | on-chain |

#### Flow Ad-3: Phase transition

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/governance/phase-ladder` | View current phase per contract | `DatumGovernanceRouter.phase` | none |
| 2 | Timelock | Stage a setGovernor call to advance phase | `DatumGovernanceRouter.setGovernor` (timelocked) | on-chain |
| 3 | New governor | `acceptGovernor` from their own context | `DatumGovernanceRouter.acceptGovernor` | on-chain: phase advanced |

---

### Role: Relay operator

Operates an off-chain relay (separate `relay-bot/` repo). On-chain
state tracked via `DatumRelay` + `DatumRelayStake`.

#### Flow R-1: Stake to become a bonded relay

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | n/a (no webapp UI) | Stake DOT directly | `DatumRelayStake.stake` (payable) | on-chain |

#### Flow R-2: Submit settlement batch

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Off-chain | Collect signed claim batches from users | n/a | n/a |
| 2 | Off-chain | Submit | `DatumSettlement.settleClaims` (write) | on-chain |

**Audit note:** there is no `/relay/*` webapp surface. The relay
runs as a server-side process; its on-chain state is observable via
`/protocol` dashboards but not directly managed there.

---

### Role: Reporter (V1 / V2)

Oracle reporter for off-chain attested state. Two generations
coexist during the cutover.

#### Flow Rp-1: V1 reporter — commit stake root

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Off-chain script | Compute root, sign | n/a | n/a |
| 2 | Direct call | `commitStakeRoot` (1-of-1 or N-of-M) | `DatumStakeRoot.commitStakeRoot` | on-chain |

#### Flow Rp-2: V2 reporter — propose / approve / finalize

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Off-chain | One-time stake to join | `DatumStakeRootV2.joinReporters` | on-chain |
| 2 | Each epoch | Propose | `DatumStakeRootV2.proposeRoot` | on-chain |
| 3 | Each epoch | Other reporters approve | `DatumStakeRootV2.approveRoot` | on-chain |
| 4 | After challenge window | Anyone finalizes | `DatumStakeRootV2.finalizeRoot` | on-chain |
| 5 | Anyone | Challenge a fraudulent root | `DatumStakeRootV2.challengePhantomLeaf` | on-chain |

**Audit note:** no `/protocol/stake-root` page — operational only.

---

### Role: Token holder / DATUM-side participant

DATUM token operations. Currently most contracts are deployed via
`deploy-token.ts` separately from the base deploy. Token plane not
yet on Paseo alpha-5 v5; pages render with disabled-state notices.

#### Flow T-1: Wrap canonical DATUM → WDATUM

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/token/wrapper` | Approve wrapper to pull canonical DATUM | `precompile.approve` | on-chain (Asset Hub) |
| 2 | Same | `wrap(amount)` — atomic pull + mint WDATUM | `DatumWrapper.wrap` | on-chain |

#### Flow T-2: Unwrap WDATUM → canonical DATUM (Asset Hub recipient)

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/token/wrapper` | `unwrap(amount, ahRecipient)` | `DatumWrapper.unwrap` | on-chain: WDATUM burned, canonical released |

#### Flow T-3: Stake WDATUM for fee share

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/token/fee-share` | Approve fee-share to pull | WDATUM `approve` | on-chain |
| 2 | Same | `stake(amount)` | `DatumFeeShare.stake` | on-chain |
| 3 | Same | `claim()` periodic dividend | `DatumFeeShare.claim` | on-chain |
| 4 | Same | `unstake(amount)` | `DatumFeeShare.unstake` | on-chain |

#### Flow T-4: Vesting release

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | Webapp `/token/vesting` | View vesting schedule + claimable | `DatumVesting.vestedAmount` | none |
| 2 | Same | `release()` (beneficiary-only) | `DatumVesting.release` | on-chain |

#### Flow T-5: Bootstrap claim (house ads)

| Step | Surface | Action | Contracts touched | State change |
|---|---|---|---|---|
| 1 | n/a (background path — house ads trigger this) | `bootstrap.claim(user, campaignId)` | `DatumBootstrapPool.claim` | on-chain |

---

## Legacy + unused content (conservative findings)

Confirmed dead or replaced surfaces, with the evidence trail. Each
entry is verifiable via the cited grep / inspection.

### Webapp

#### W-LEG-1: `/admin/*` route aliases (13 routes)

Every `/admin/*` route has a `/protocol/*` equivalent. The
`/admin` index redirects to `/admin/timelock`. The Layout's nav
sidebar (line ~144 `matchPrefixes: ["/protocol", "/admin"]`)
includes both prefixes for the Protocol section, so both work, but
all UI navigation points at `/protocol/*`.

**Evidence:**
```
$ grep -E "^\s+\"/admin/" web/src/App.tsx | wc -l
13
$ grep -rE "to=\"/admin/" web/src/ | head
   (zero results — no UI navigates to /admin/* routes)
```

**Recommendation:** keep as redirects for back-compat with stale
bookmarks. If you want stricter hygiene, replace each `/admin/*`
`<Route element=...>` with a `<Navigate to="/protocol/...">`.

#### W-LEG-2: `Dashboard.legacy.tsx` files

Three were deleted in commit `7e25c26`:
- `web/src/pages/advertiser/Dashboard.legacy.tsx`
- `web/src/pages/publisher/Dashboard.legacy.tsx`
- `web/src/pages/governance/Dashboard.legacy.tsx`

Verified no remaining `.legacy.tsx` files in webapp:
```
$ find web/src -name "*.legacy.tsx" | wc -l
0
```

**Status:** already cleaned.

#### W-LEG-3: `/governance/phase` vs `/governance/phase-ladder`

Both routes exist (App.tsx lines 151–152) and resolve to the same
`PhaseLadder` component. Likely a holdover from a rename.

**Recommendation:** keep `/phase-ladder` as canonical, replace
`/phase` with a `<Navigate>`.

#### W-LEG-4: Settings ipfsGateway migration cruft

`web/src/context/SettingsContext.tsx` lines 53-60 contains a
migration block for 3 stale gateway URLs (`ipfs.datum.javcon.io`,
etc.) — defensive but adds lines. Acceptable; the migration is one
of the few that can't be removed without breaking existing user
storage.

**Status:** keep.

### Extension

#### E-LEG-1: `popup/App.legacy.tsx` (active dead-code)

The whole legacy popup app file is preserved "for reference until
the rewrite settles" per a comment in the active `App.tsx` line 8.
It imports `ClaimQueue`, `FiltersTab`, `HistoryTab`, `ReportsTab`,
`UserPanel`, `PendingDust` — none of which are imported by the
active `App.tsx` or anywhere else (other than each other).

**Evidence:**
```
$ grep -rE "from.*App\.legacy" alpha-5/extension/src | wc -l
0
$ grep -E "import.*App\.legacy" alpha-5/extension/webpack.config.ts
   (zero results — webpack does not bundle it)
```

**Recommendation:** delete the following six files when the rewrite
is considered stable. Currently dead code, ~1000+ lines:
- `alpha-5/extension/src/popup/App.legacy.tsx`
- `alpha-5/extension/src/popup/ClaimQueue.tsx`
- `alpha-5/extension/src/popup/FiltersTab.tsx`
- `alpha-5/extension/src/popup/HistoryTab.tsx` *(my Refresh-history edit lives here; preserved against a future EarningsTab merge)*
- `alpha-5/extension/src/popup/ReportsTab.tsx`
- `alpha-5/extension/src/popup/UserPanel.tsx`
- `alpha-5/extension/src/popup/PendingDust.tsx` *(only used by UserPanel)*

#### E-LEG-2: `wallet/walletClient.ts` vs `shared/walletManager.ts`

Two parallel wallet abstraction layers. `walletClient` is the new
shape (used by the active popup); `walletManager` is the legacy
shape (used by the legacy popup + parts of the background).

**Recommendation:** assess overlap. If they truly are duplicates,
plan a consolidation in a follow-up. Don't touch in this audit pass.

#### E-LEG-3: `EarningsTab` settled-events display is stubbed

Lines 76-86 of `wallet/EarningsTab.tsx` explicitly note "for now we
list an empty array and surface the pending balance ... (Adding an
eventBus equivalent for the extension popup is tracked as part of
Stage 8 polish.)"

**Status:** acknowledged TODO, not legacy. Calling it out because
the **user flow U-5 "View earnings history"** is incomplete in the
active popup as a result. Webapp `/me/history` is the workaround.

### Contracts

#### C-LEG-1: `DatumOwnable`, `DatumUpgradable`, `DatumSettlementStorage`

Abstract bases. Not deployable, not in `deployed-addresses.json`.
Correctly identified by `alpha-5/DEPLOY-COVERAGE.md`.

**Status:** by design.

#### C-LEG-2: `DatumTagRegistry`, `DatumZKStake`

Deferred to token-plane deploy. Documented in
`alpha-5/DEPLOY-COVERAGE.md`.

**Status:** by design.

#### C-LEG-3: Mock contracts in production tree

`contracts/Mock*.sol` — `MockAssuranceProbe`, `MockCallTarget`,
`MockCampaignLifecycle`, `MockCampaigns`, `MockERC20`,
`MockIdentityVerifier`, `MockMsgSenderProbe`, `MockOpenGovRouter`,
`MockRejectingReceiver`, `MockRevertingCurator`, `MockUpgradable`,
`MockXcmEncoderHarness`, `MockXcmPrecompile`, `MockZKVerifier`.

All used by the test suite. `AssetHubPrecompileMock` lives under
`contracts/token/`. These compile into the production target but
should not deploy.

**Status:** by design. Verify with deploy-script audit that none of
these are accidentally in `deployOrReuse` calls (cross-checked
`alpha-5/DEPLOY-COVERAGE.md` — none are).

### Cross-cutting

#### X-LEG-1: Multiple alpha builds (`alpha-3`, `alpha-4`, `alpha-5`)

- `alpha-3/` — frozen PVM reference (resolc target). Tests still
  run; deploy script preserved.
- `alpha-4/` — superseded by alpha-5. Still has the active
  `PRE-MAINNET-CHECKLIST.md` (per recent edits). Most other content
  is reference.
- `alpha-5/` — active.

**Recommendation:** consolidate `alpha-4/PRE-MAINNET-CHECKLIST.md`
into `alpha-5/` (or move to a top-level `PRE-MAINNET-CHECKLIST.md`)
to avoid the "is alpha-4 still active?" confusion when reading the
checklist title. Otherwise alpha-3 and alpha-4 trees are reasonable
to keep as historical reference.

#### X-LEG-2: `PROCESS-FLOW-AUDIT.md` (this document)

Living doc. Re-run on any major rev.

**Maintenance trigger:** any commit that adds a new role, page, or
flow → update this doc in the same PR. Conservative legacy section
gets fresh evidence from grep at the same time.

## Coverage gaps (not legacy — TODO)

Flows the audit found referenced but not yet implemented as UI:

| ID | Gap |
|---|---|
| GAP-1 | No `/advertiser/stake` page despite `DatumAdvertiserStake` deployed (CB4, alpha-5 v5) |
| GAP-2 | No manual "submit claims" surface in active extension popup (legacy `ClaimQueue.tsx` covered this) |
| GAP-3 | EarningsTab historical settlement display stubbed (Stage 8 polish TODO) |
| GAP-4 | No `/relay/*` webapp surface (operator-only — possibly intentional) |
| GAP-5 | No `/identity/people-chain` refresh-flow UI for triggering XCM bridge from the webapp |
| GAP-6 | No webapp UI for `DatumPublisherReputation.recordSettlement` (reporter-only, but inspection page useful) |

## Verification

Run the inventory checks any time:

```sh
# Webapp route count
grep -oE 'path="/[^"]*"' web/src/App.tsx | sort -u | wc -l   # → 94 today

# Popup active tabs
grep -E 'type Tab' alpha-5/extension/src/popup/App.tsx -A 7

# Dead legacy files in webapp
find web/src -name "*.legacy.tsx"   # → 0 today

# Legacy popup files (dead — see E-LEG-1)
grep -rE "from.*App\.legacy" alpha-5/extension/src | wc -l   # → 0 today
```

## Document maintenance

Updated 2026-05-23 against alpha-5 v5. Re-walk on:
- Any new role addition (e.g., advertiser fraud track unlocks new
  GAP-1 surface)
- Any deploy script change that adds or removes contract surface
- Any major popup or webapp restructure
- Pre-mainnet pre-flight (this doc should be one of the final
  read-throughs)
