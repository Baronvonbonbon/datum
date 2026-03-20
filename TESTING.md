# DATUM Alpha Testing Guide

**Version:** 1.3
**Date:** 2026-03-19
**Status:** Ready for live browser E2E testing on Paseo testnet.
**Prerequisites:** Extension built (`alpha-extension/dist/`). For Paseo live testing, no local Docker required — contracts are already deployed and a campaign is active.

---

## Prerequisites

### Option A: Paseo Testnet (recommended — no local setup needed)

Everything is already deployed and live. You just need the extension.

```bash
cd alpha-extension && npm run build
```

Output in `alpha-extension/dist/`. The build is pre-configured with Paseo contract addresses and defaults to the Paseo network.

### Option B: Local Devnet

```bash
# 1. Start substrate + eth-rpc Docker containers
docker ps  # should show substrate + eth-rpc
# If not running:
cd alpha && ./scripts/start-substrate.sh

# 2. Deploy contracts
cd alpha && npx hardhat run scripts/deploy.ts --network substrate

# 3. Fund test accounts
npx hardhat run scripts/fund-test-accounts.ts --network substrate

# 4. Build extension
cd alpha-extension && npm run build
```

---

---

## Paseo Live Testing (A3.4)

This is the primary testing path. All contracts are deployed, a campaign is active, and Diana's publisher relay is running.

### Testnet Details

| Item | Value |
|------|-------|
| Network | Paseo (Chain ID 420420417) |
| RPC | `https://eth-rpc-testnet.polkadot.io/` |
| Explorer | https://blockscout-testnet.polkadot.io/ |
| Faucet | https://faucet.polkadot.io/ (select "Paseo") |
| Currency | PAS (testnet DOT) |
| Demo page | https://baronvonbonbon.github.io/datum/ |

### Published Testnet State

| Role | Name | Address |
|------|------|---------|
| Deployer | Alice | `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Publisher | Diana | `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` |

- Diana is registered with 50% take rate, all 26 categories
- Campaign #1 is Active (Bob→Diana, 10 PAS budget)
- Diana's publisher relay is live, co-signing attestations + processing claims

### Live Testing Flow

#### Step 1: Load the Extension

1. Build: `cd alpha-extension && npm run build`
2. Open `chrome://extensions` → **Developer mode** on
3. **Load unpacked** → select `alpha-extension/dist/`
4. Pin the DATUM icon to toolbar

#### Step 2: Get Testnet PAS

1. Go to https://faucet.polkadot.io/ (select "Paseo")
2. The faucet uses substrate addresses — convert your extension address using https://hoonsubin.github.io/evm-substrate-address-converter/ (EVM → Substrate)
3. Request PAS — you need at least 1 PAS to submit claims directly, or 0 if using publisher relay

#### Step 3: Configure Extension

1. Open extension → **Settings** tab
2. **Network** should default to "Paseo" — verify
3. Contract addresses are pre-loaded in the build (no manual entry needed)
4. Click **Test Connection** — should show "Connected — block #N"
5. Click **Save**

#### Step 4: Create a Wallet

1. Extension → **Import Private Key** (or create new)
2. Enter an account name (e.g. "Test User")
3. Paste or generate a private key
4. Set a password (min 8 chars)
5. Verify your address appears in the header

#### Step 5: Visit the Demo Page

Go to **https://baronvonbonbon.github.io/datum/**

The page runs the DATUM SDK with Diana's publisher address and `data-relay` pointing to her relay endpoint:

```html
<script src="datum-sdk.js"
  data-categories="1,2,...,26"
  data-publisher="0xcA5668fB864Acab0aC7f4CFa73949174720b58D0"
  data-relay="https://index-routine-cent-choice.trycloudflare.com">
</script>
```

**What the extension does on page load:**
1. Detects the SDK tag, reads `data-relay` URL
2. Stores `publisherDomain:0xca566...` → relay domain in local storage (no rebuild needed if relay URL changes)
3. Fetches active campaigns from the Paseo chain
4. Runs campaign matching + Vickrey auction
5. Performs challenge-response handshake with the SDK
6. Injects the winning campaign's ad into `<div id="datum-ad-slot">`

**What to look for:**
- Ad creative appears in the slot (IPFS metadata rendered: title, body, CTA button)
- SDK status panel shows: Publisher Relay online, SDK Ready, handshake complete
- Extension popup → **Campaigns** tab shows Campaign #1 as Active

#### Step 6: Verify Claim Building

After the ad has been visible for a few seconds with the tab focused:

1. Quality scoring runs: dwell 35% + focus 25% + viewability 25% + scroll 15%
2. Thresholds (relaxed for alpha): dwell ≥ 200ms, focus ≥ 100ms, composite ≥ 0.05
3. Claim hash chain is built: `keccak256(campaignId, publisher, user, impressionCount, clearingCpm, nonce, prevHash)`
4. Claim appears in extension → **Claims** tab

> **Tip:** Refresh the page and wait ~10 seconds with the tab focused. Claims are de-duped per (campaign, hostname) for 5 minutes, so each visit after the cooldown can generate one claim.

#### Step 7: Submit Claims via Publisher Relay (zero gas)

The easiest path — no PAS required:

1. Extension → **Claims** tab
2. Click **Sign for Publisher (zero gas)**
3. Enter your wallet password to sign the EIP-712 `ClaimBatch`
4. The extension requests a publisher co-signature from Diana's relay endpoint (`/.well-known/datum-attest`)
5. The signed batch is sent to Diana's relay endpoint (`/relay/submit`)
6. Diana's relay processes it and submits on-chain

**What happens on-chain:**
- `DatumRelay.settleClaimsFor()` is called by Diana's relay (she pays gas)
- `DatumSettlement` validates the hash chain, splits revenue:
  - Diana (publisher): 50% take rate
  - You (user): 75% of remainder = 37.5% of total
  - Protocol: 25% of remainder = 12.5%

**Check relay status:** https://baronvonbonbon.github.io/datum/ → Publisher Relay indicator shows online/offline + uptime.

#### Step 8: Direct On-Chain Submission (requires PAS)

If you have PAS in your wallet:

1. Extension → **Claims** tab
2. Click **Submit All (you pay gas)**
3. Enter password, confirm transaction
4. Claims settle in 1-2 blocks

#### Step 9: Check Earnings and Withdraw

1. Extension → **Earnings** tab
2. Balance shows accumulated PAS from settled claims
3. Click **Withdraw** to send to your wallet
4. Verify in explorer: https://blockscout-testnet.polkadot.io/

#### Step 10: Run Your Own Publisher Relay (optional)

Want to test with your own publisher registration and relay endpoint?

1. Register as a publisher via the extension **Publisher** tab (requires PAS for gas)
2. Copy the reference relay template: `docs/relay-bot-template/`
3. Configure with your publisher key + contract addresses (see `.env.example`)
4. Start: `node relay-bot.mjs`
5. Expose via Cloudflare tunnel: `cloudflared tunnel --url http://127.0.0.1:3400`
6. Add `data-relay="https://your-tunnel.trycloudflare.com"` to your publisher page's SDK tag
7. The extension picks up the new relay URL automatically — no rebuild needed

How you implement your relay is up to you — the template is a reference automated service, but any HTTPS endpoint exposing the required routes will work.

---

## Dev Accounts

Pre-funded accounts from the Hardhat config. Alith and Baltathar are pre-funded on the devchain; all others are funded by `fund-test-accounts.ts` (10^24 planck each).

| Name | Role | Address | Private Key |
|------|------|---------|-------------|
| Alith | Deployer, advertiser | `0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac` | `0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133` |
| Baltathar | Publisher | `0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0` | `0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b` |
| Charleth | User/viewer | `0x798d4Ba9baf0064Ec19eB4F0a1a45785ae9D6DFc` | `0x0b6e18cafb6ed99687ec547bd28139cafdd2bffe70e6b688025de6b445aa5c5b` |
| Dorothy | Voter | `0x773539d4Ac0e786233D90A233654ccEE26a613D9` | `0x39539ab1876910bbf3a223d84a29e28f1cb4e2e456503e7e91ed39b2e7223d68` |
| Ethan | Spare | `0xFf64d3F6efE2317EE2807d223a0Bdc4c0c49dfDB` | `0x7dce9bc8babb68fec1409be38c8e1a52650206a7ed90ff956ae8a6d15eeaaef4` |
| Faith | Spare | `0xFE930971D6D2136a89b4CF6f681Ac2f929f0bD0F` | `0xb9d2ea9a615f3165812e8d44de0d24da9bbd164b65c4f0573e1572827c55c3a4` |
| Goliath | Spare | `0x897dE69eb9E0053caa773C685D44CC8205605900` | `0x96b8a38e12e1a31dee1eab2fffdf9d9990045f5b37e44d8cc27766ef294d74e2` |
| Heath | Spare | `0x931f3600a299fd9B24cEfB3BfF79388D19804BeA` | `0x0d6dcaaef49272a5411896be8ad16c01c35d6f8c18873387b71fbc734759b0ab` |

Additional random test accounts (advertisers, viewers, publishers, voters) are generated by `fund-test-accounts.ts` and written to `test-accounts.json`.

---

## Contract Addresses (current local deployment)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0x621F5Dc6937c335d15C02811B9057fA81BfbA86E` |
| Timelock | `0xA9f6d3Ad1a9Ea6A1318c5Ada002Ff6200DFF8693` |
| Publishers | `0x197CB6129617EF4Cc64f23852507B008bC6f9BAa` |
| Campaigns | `0x3cB0048299bcA8438B244A50cCA30eC7d7C3564A` |
| GovernanceV2 | `0x4Bbc6e3f3022c63778665bc45c2885A2b52d0bFB` |
| GovernanceSlash | `0xA7e6a4D8eD27F9FC045E409694b2eE5c209EFCE5` |
| Settlement | `0xc9316a2732C693043E91Cb7b67F7eba74d80a1B4` |
| Relay | `0xDd432D78E3F42d1f8B61d38b77B655A90c2e16D9` |
| ZKVerifier | `0xCB34c5228aF4463C7E1b49EbFcAE7f7D171fADB2` |

These change every time you redeploy. `deploy.ts` writes them to `alpha/deployed-addresses.json` and `alpha-extension/deployed-addresses.json`.

---

## Walkthrough

### Step 1: Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select `alpha-extension/dist/`
4. Pin the DATUM extension to the toolbar

### Step 2: Configure Settings

1. Click the DATUM extension icon → **Settings** tab
2. Set **Network** to `local` (RPC: `http://127.0.0.1:8545`)
3. Click **Load Deployed Addresses** — auto-loads from `deployed-addresses.json`
4. If auto-load fails, paste addresses manually from the table above
5. Click **Save**

### Step 3: Create a Wallet

The extension supports **multiple named accounts** (MA-1 through MA-4). You can import several test keys and switch between them without separate Chrome profiles.

1. Click the DATUM extension icon
2. Click **Import Private Key**
3. Enter an **Account Name** (e.g., "User - Charleth")
4. Paste Charleth's key (user/viewer role):
   ```
   0x0b6e18cafb6ed99687ec547bd28139cafdd2bffe70e6b688025de6b445aa5c5b
   ```
5. Set a password (minimum 8 characters)
6. Verify the address `0x798d4Ba9...` shows as connected

**Multi-account workflow:** From the locked screen or header account dropdown, click **Add Account** to import additional keys. Use **Switch** to change active account (requires password re-entry). Each account's private key is encrypted independently.

### Step 4: Register a Publisher

The E2E script already registered Baltathar as a publisher. To verify or register manually:

**Option A (already done):** Baltathar was registered with take rate 5000 (50%) during `e2e-full-flow.ts`. Skip this step.

**Option B (manual):** Open a second Chrome profile, load the extension, import Baltathar's key:
```
0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b
```
Go to **Publisher** tab → **Register** with take rate 5000. Check some categories (e.g., "Computers & Electronics").

### Step 5: Create and Activate a Campaign

#### 5a. Create the campaign

Use Alith (deployer) in a Chrome profile:
```
0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133
```

Go to **My Ads** tab → **Create Campaign**:
- **Publisher:** leave empty for open campaign, or paste `0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0` (Baltathar)
- **Budget:** 100 DOT
- **Daily cap:** 100 DOT
- **Bid CPM:** 0.016 DOT
- **Category:** pick one matching the publisher (e.g., "Computers & Electronics")
- **Creative:** fill in title, body, CTA label, landing URL (use HTTPS — non-HTTPS URLs render as non-clickable text)

Submit. Campaign is now **Pending**.

#### 5b. Vote to activate

Switch to Dorothy's profile:
```
0x39539ab1876910bbf3a223d84a29e28f1cb4e2e456503e7e91ed39b2e7223d68
```

Go to **Govern** tab → find the Pending campaign → Vote **Aye** with 150+ DOT at conviction 0. The stake must exceed the 100 DOT quorum.

Click **Evaluate Campaign**. Status should change to **Active**.

#### Alternative: Use the setup script

```bash
cd alpha && npx hardhat run scripts/setup-test-campaign.ts --network substrate
```

This registers the publisher, creates a campaign, votes aye, evaluates, and sets metadata in one shot.

### Step 6: Serve the Publisher Page

The SDK example page needs to be served over HTTP (content scripts don't inject on `file://`):

```bash
cd /home/k/Documents/datum/sdk
python3 -m http.server 8080
```

Open `http://localhost:8080/example-publisher.html` in Chrome.

The page has the SDK embed:
```html
<script src="datum-sdk.js"
  data-categories="6,26"
  data-publisher="0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0"
  data-relay="https://your-relay.example.com">
</script>
<div id="datum-ad-slot"></div>
```

**`data-publisher`** must match a registered publisher address. Edit `example-publisher.html` and set it to Baltathar's address.

**`data-relay`** is the URL of the publisher's relay endpoint. When the extension detects this attribute, it automatically stores the relay domain for attestation requests — no extension rebuild needed when the URL changes. Leave blank if the publisher has no relay (claims will settle in degraded trust mode, or the user submits directly).

### Step 7: Verify Ad Display

With the extension loaded and Charleth's wallet connected, visiting the publisher page should trigger:

1. **SDK detection** — content script finds the `datum-sdk.js` tag (+ fetches campaigns in parallel)
2. **Campaign matching** — filters active campaigns by publisher categories (bitmask overlap)
3. **Auction** — background selects winner: solo campaign pays 70% of bid CPM; multiple campaigns run second-price
4. **Handshake** — extension sends `datum:challenge` CustomEvent, SDK responds with SHA-256 signed `datum:response`
5. **Ad injection** — creative renders in `<div id="datum-ad-slot">` via Shadow DOM

**If no campaigns match:** a default house ad (Polkadot philosophy link) appears instead.

**What to check:**
- Ad creative appears inside the publisher's ad slot
- Extension popup → **Campaigns** tab shows the campaign as active
- No errors in service worker console (`chrome://extensions` → DATUM → "Inspect views: service worker")

### Step 8: Verify Impression Recording

After the ad displays for 1+ second with the tab focused:

1. IntersectionObserver tracks viewport visibility
2. Engagement tracker measures dwell time, focus, viewability, scroll depth
3. Background computes quality score: `dwell 35% + focus 25% + viewability 25% + scroll 15%`
4. If quality >= 0.05 (and dwell >= 200ms, focus >= 100ms): claim is built and queued (thresholds relaxed for alpha)
5. Claim hash: `keccak256(campaignId, publisher, user, impressionCount, clearingCpm, nonce, previousClaimHash)`

**Check:** Extension popup → **Claims** tab should show pending claims.

### Step 9: Submit Claims

From the **Claims** tab:

- **Submit All (you pay gas)** — sends batch on-chain
- **Sign for Publisher (zero gas)** — creates EIP-712 signed batch for publisher to relay

After submission:
- Claims tab shows claims as settled
- **Earnings** tab shows accumulated user balance

### Step 10: Withdraw Earnings

1. Go to **Earnings** tab
2. User balance should show accumulated DOT
3. Click **Withdraw**
4. Transaction confirms, balance goes to 0

### Step 11: Publisher Withdrawal

In the publisher's Chrome profile (Baltathar):

1. Go to **Publisher** tab
2. Publisher balance should show accumulated DOT (take rate portion)
3. Click **Withdraw**

### Step 12: Governance Termination Flow

1. Create a second campaign (Step 5a)
2. Vote **Aye** to activate it (Step 5b)
3. Switch to another voter, vote **Nay** with a larger stake (e.g., 200 DOT)
4. Click **Evaluate** — if nay >= 50%, campaign terminates
5. **Govern** tab → **Finalize Slash** distributes the losing-side slash (10% of stakes)
6. Winning-side voters can **Claim Slash Reward**

### Step 13: Timelock Flow

Timelock operations require the deployer (Alith), since DatumCampaigns and DatumSettlement ownership was transferred to the Timelock, and the Timelock is owned by Alith.

1. This is best tested via the script:
   ```bash
   cd alpha && npx hardhat run scripts/e2e-full-flow.ts --network substrate
   ```
   Section 6 tests: propose → execute (reverts, 48h delay) → cancel.

2. On devchain you cannot fast-forward 48h, so full propose→execute is not testable in the browser. The Hardhat EVM tests (T1-T15) cover this with `evm_increaseTime`.

### Step 14: Claim Export/Import (P6)

1. Go to **Claims** tab (with some pending or settled claims)
2. Click **Export Claims** → wallet signs authentication → downloads encrypted `.dat` file
3. Clear claims or switch device
4. Click **Import Claims** → select `.dat` file → decrypts with wallet signature → merges state
5. Import validates: address match, on-chain nonce check, deduplication, keeps higher nonce

### Step 15: Auto-Submit (B1)

1. Go to **Settings** → enable **Auto-submit**
2. A warning banner appears: "Auto-submit not authorized" (WS-3)
3. Enter your wallet password to create a session-encrypted key
4. The extension submits claims automatically every few minutes
5. Session key lives in service worker memory — lost on browser restart
6. After browser restart, the warning banner reappears — re-authorize to resume

### Step 16: Settings Connectivity (SI-1, SI-2)

1. Go to **Settings** → click **Test Connection** next to the RPC URL
2. Should show "Connected — block #N (Xms)" with latency
3. If campaigns contract is configured, it also validates the contract ABI (SI-2)
4. If there's a mismatch (wrong network or stale addresses), a warning appears
5. Try entering an invalid RPC URL → should show the connection error

---

## Multi-Account Testing Matrix

The extension now supports **multi-account wallets** (MA-1 through MA-4). You can import all test keys into a single browser profile and switch between them. Separate Chrome profiles are no longer required (but still useful for simultaneous browsing as different users).

**Single-profile approach** (recommended for quick testing):
1. Import all 4 test keys as named accounts: "Advertiser (Alith)", "Publisher (Baltathar)", "User (Charleth)", "Voter (Dorothy)"
2. Use the header dropdown to switch between accounts
3. Each switch requires re-entering the target account's password

**Multi-profile approach** (for simultaneous browsing):

| Profile | Wallet | Role | Tests |
|---------|--------|------|-------|
| Profile 1 | Alith | Advertiser | Create campaigns (open + fixed), set metadata, complete/expire |
| Profile 2 | Baltathar | Publisher | Register, set categories, serve SDK page, relay claims, withdraw |
| Profile 3 | Charleth | User/Viewer | Browse ads, submit claims, withdraw earnings, export/import |
| Profile 4 | Dorothy | Voter | Vote aye/nay, evaluate campaigns, withdraw stakes, claim slash |

---

## Devchain Quirks

**Gas costs are enormous.** Pallet-revive gas is in weight units (~10^15). Each contract call costs ~5x10^21 planck. Test accounts need ~10^24 planck each. If transactions fail with "insufficient funds," re-run `fund-test-accounts.ts`.

**Denomination rounding.** The eth-rpc adapter rejects value transfers where `value % 10^6 >= 500_000`. All DOT amounts (campaign budgets, vote stakes, withdrawals) must be clean multiples of 10^6 planck. For example:
- 1,000,000 planck (1M) — OK
- 999,000 planck — REJECTED
- 500,000 planck — REJECTED
- 1,000 planck — OK (below threshold)

**Block time.** ~3-6 seconds per block. Transactions take a few seconds to confirm.

**No time travel.** Cannot fast-forward blocks on the live devchain. Timelock 48h delays and governance lockups cannot be tested end-to-end in the browser. Use Hardhat EVM tests for those.

**Precompile at 0x900.** The system precompile (`minimumBalance()`) exists on the devchain but returns empty data via eth-rpc `eth_call`. The GovernanceV2 contract guards this with `SYSTEM_ADDR.code.length > 0`, so it gracefully skips the dust check on devchain.

**Contract addresses change on redeploy.** Every `deploy.ts` run creates fresh contracts. Update the extension Settings after each redeploy, or rely on auto-load from `deployed-addresses.json`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Extension doesn't detect SDK | Page served over `file://` | Serve via `python3 -m http.server 8080` |
| "Invalid Transaction" | Account not funded enough | Run `fund-test-accounts.ts` |
| "E46" on evaluate | Quorum not met | Vote with 150+ DOT (conviction 0) |
| "E02" on settlement | Payment below denomination rounding floor | Increase impressions or CPM so each split >= 10^6 planck |
| Claims rejected (reason 10) | Hash mismatch | Verify claim hash field order: campaignId, publisher, user |
| Claims rejected (reason 7) | Nonce gap | Claims must be sequential: nonce = lastNonce + 1 |
| Ad doesn't appear | Category mismatch | Ensure campaign and publisher categories overlap |
| Ad doesn't appear | Campaign not Active | Check campaign status in Govern tab; evaluate if Pending |
| No pending claims | Quality too low | Keep tab focused for 200ms+ with ad visible; thresholds relaxed for alpha (dwell ≥ 200ms, focus ≥ 100ms, score ≥ 0.05) |
| Service worker errors | Devchain restarted, addresses changed | Redeploy and update Settings |
| Balance shows 0 | Wrong network | Verify Settings → Network is `local` |
| Auto-submit stopped working | Browser restarted, session key lost | Re-authorize in Settings (WS-3 warning banner) |
| "Contract not found" warning | Network/address mismatch | Click Test Connection in Settings (SI-1/SI-2) |
| Can't withdraw small balance | Below denomination rounding floor | Balance must be >= 1M planck (0.0001 DOT) — see EA-4 |
| Password rejected on import | Too short | Minimum 8 characters required (WS-2) |

---

## Automated E2E (Contract-Level)

The full contract-level E2E can be re-run at any time:

```bash
cd alpha
npx hardhat run scripts/e2e-full-flow.ts --network substrate
```

This tests all 6 sections without needing the browser:
1. Campaign lifecycle (create → vote → activate → metadata)
2. Settlement (1M impressions, hash chain, 16 DOT payment)
3. Withdrawals (publisher 8 DOT + user 6 DOT)
4. Pause/unpause (circuit breaker)
5. Governance slash (aye → nay → terminate → finalize)
6. Timelock (propose → execute reverts → cancel)
