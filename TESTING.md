# DATUM Extension — G2 Test Walkthrough

This document walks through every step to test the DATUM Chrome extension end-to-end against a local devchain. Follow each step in order. Record pass/fail results at the end.

**Estimated time:** 30–45 minutes
**Prerequisites:** Docker installed, Chrome installed, SubWallet extension installed in Chrome

---

## Part 0 — Prerequisites

### 0.1 — Verify SubWallet is installed in Chrome

1. In Chrome, go to `chrome://extensions`
2. Confirm **SubWallet** is in the list and enabled
3. If not: install from https://subwallet.app — the Chrome Web Store link is on their homepage
4. Click the SubWallet icon in Chrome toolbar → create or import a wallet → note the EVM address (starts with `0x`)

> **Why SubWallet specifically?** The extension uses `window.ethereum` (EIP-1193) for signing, not the Polkadot.js API. SubWallet injects `window.ethereum` into popup pages. Polkadot.js extension does NOT inject `window.ethereum` and will not work for claim submission.

### 0.2 — Verify Docker is running

```bash
docker ps
```

Should return without error. If Docker is not running, start it.

### 0.3 — Verify the extension is built

```bash
ls /home/k/Documents/datum/extension/dist/
```

Expected output:
```
background.js  content.js  icons  manifest.json  offscreen.html  offscreen.js  popup.html  popup.js
```

If any files are missing, rebuild:
```bash
cd /home/k/Documents/datum/extension
npm run build
```

---

## Part 1 — Start the Local Devchain

### 1.1 — Start substrate node + eth-rpc adapter

```bash
cd /home/k/Documents/datum/poc
./scripts/start-substrate.sh
```

Wait for output:
```
eth-rpc adapter ready on http://127.0.0.1:8545
```

This takes about 10–15 seconds. If it times out, check Docker logs:
```bash
docker logs substrate
docker logs eth-rpc
```

### 1.2 — Verify the chain is responding

```bash
curl -sf -H "Content-Type: application/json" \
  -d '{"id":1,"jsonrpc":"2.0","method":"eth_chainId","params":[]}' \
  http://127.0.0.1:8545
```

Expected: `{"result":"0x1926354",...}` (chainId 420420420 in hex = `0x1926354`)

---

## Part 2 — Deploy Contracts

### 2.1 — Fund your SubWallet address on the devchain

The devchain has pre-funded accounts (Alith, Baltathar, etc.) but your SubWallet address needs DOT to pay gas and act as the test user. Run this script to send funds from the Alith dev account to your address:

```bash
cd /home/k/Documents/datum/poc
```

Create a one-time funding script. Replace `YOUR_SUBWALLET_ADDRESS` with your actual address (from SubWallet → copy EVM address, starts with `0x`):

```bash
cat > /tmp/fund.ts << 'EOF'
import { ethers } from "hardhat";
async function main() {
  const [alith] = await ethers.getSigners();
  const target = "YOUR_SUBWALLET_ADDRESS";
  const tx = await alith.sendTransaction({
    to: target,
    value: ethers.parseUnits("1000000", 12), // 100 DOT in planck
  });
  await tx.wait();
  console.log("Funded:", target);
  const bal = await ethers.provider.getBalance(target);
  console.log("Balance:", ethers.formatUnits(bal, 12), "DOT");
}
main().catch(console.error);
EOF
```

> **Note:** The devchain uses planck (1 DOT = 10^10 planck). Passing `ethers.parseUnits("1000000", 12)` = 10^18 = 100 DOT in planck terms.

Actually, since the devchain denomination is non-standard, use this simpler approach — import the dot helper:

```bash
npx hardhat run --network substrate - << 'EOF'
const { ethers } = require("hardhat");
async function main() {
  const [alith] = await ethers.getSigners();
  const target = "YOUR_SUBWALLET_ADDRESS";
  // Send 100 DOT = 10^12 planck (value must be multiple of 10^6)
  const tx = await alith.sendTransaction({ to: target, value: 1_000_000_000_000n });
  await tx.wait();
  console.log("Funded. Balance:", await ethers.provider.getBalance(target));
}
main().catch(console.error);
EOF
```

Expected: `Funded. Balance: 1000000000000n` (or similar large number)

### 2.2 — Add SubWallet to Hardhat config (one-time)

The deploy script uses the first Hardhat signer (Alith) to deploy. You need your SubWallet private key added so it can be used as `publisher` in tests.

**Skip this for now** — the deployer (Alith) will act as both advertiser and publisher for this walkthrough.

### 2.3 — Deploy all 6 contracts

```bash
cd /home/k/Documents/datum/poc
npx hardhat run scripts/deploy.ts --network substrate
```

This takes 3–5 minutes on the devchain (each PVM contract deploy = ~60s).

Watch for output like:
```
Deploying DATUM contracts with: 0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac
[1/6] Deploying DatumPublishers...
  DatumPublishers: 0x...
[2/6] Deploying DatumCampaigns...
  DatumCampaigns: 0x...
[3/6] Deploying DatumGovernanceVoting...
  DatumGovernanceVoting: 0x...
[4/6] Deploying DatumGovernanceRewards...
  DatumGovernanceRewards: 0x...
[5/6] Deploying DatumSettlement...
  DatumSettlement: 0x...
[6/6] Deploying DatumRelay...
  DatumRelay: 0x...
Wiring contracts...
=== DATUM Deployment Complete ===
{
  DatumPublishers: '0x...',
  DatumCampaigns: '0x...',
  DatumGovernanceVoting: '0x...',
  DatumGovernanceRewards: '0x...',
  DatumSettlement: '0x...',
  DatumRelay: '0x...'
}
```

**Copy all 6 addresses.** You will paste them into the extension Settings in Part 3.

If it fails partway through, check `docker logs eth-rpc` for errors and re-run.

### 2.4 — Create and activate a test campaign

The extension needs at least one **Active** campaign to display. Create one using Hardhat console:

```bash
cd /home/k/Documents/datum/poc
npx hardhat console --network substrate
```

In the console, run these commands one by one. Replace the contract addresses with your actual deployed addresses from Step 2.3:

```javascript
// Load contracts
const campaigns = await ethers.getContractAt("DatumCampaigns", "0xCAMPAIGNS_ADDRESS");
const voting = await ethers.getContractAt("DatumGovernanceVoting", "0xVOTING_ADDRESS");
const publishers = await ethers.getContractAt("DatumPublishers", "0xPUBLISHERS_ADDRESS");
const [alith] = await ethers.getSigners();

// Register Alith as publisher (50% take rate = 5000 bps)
await publishers.connect(alith).registerPublisher(5000);
console.log("Publisher registered");

// Create a campaign: budget=10 DOT, bidCPM=0.016 DOT, taxonomy="technology", publisherAddr=Alith
// 10 DOT = 100_000_000_000 planck; bidCPM 0.016 DOT = 160_000_000 planck
const tx = await campaigns.connect(alith).createCampaign(
  100_000_000_000n,  // budget: 10 DOT in planck
  160_000_000n,      // bidCpmPlanck: 0.016 DOT per 1000 impressions
  "technology",      // taxonomyId
  alith.address,     // publisherAddress (using Alith as publisher for test)
  { value: 100_000_000_000n }  // msg.value = budget
);
const receipt = await tx.wait();
console.log("Campaign created, receipt:", receipt.hash);

// Extract campaign ID from CampaignCreated event
const iface = campaigns.interface;
let campaignId;
for (const log of receipt.logs) {
  try {
    const parsed = iface.parseLog(log);
    if (parsed?.name === "CampaignCreated") {
      campaignId = parsed.args.campaignId;
      console.log("Campaign ID:", campaignId.toString());
    }
  } catch {}
}

// Vote aye to activate (needs enough stake to meet activationThreshold=100 DOT)
// Alith has plenty of dev DOT
await voting.connect(alith).voteAye(
  campaignId,
  2,                             // conviction level 2 (4x multiplier)
  { value: 30_000_000_000n }     // 30 DOT stake × 4 = 120 DOT weighted > 100 DOT threshold
);
console.log("Voted aye");

// Check campaign status (1 = Active)
const campaign = await campaigns.getCampaign(campaignId);
console.log("Campaign status:", campaign.status.toString(), "(1 = Active)");
```

Expected final output: `Campaign status: 1`

Type `.exit` to leave the console.

### 2.5 — Note the campaign ID

From the output above, note `campaignId` (likely `1`). You'll see it in the extension's Campaigns tab.

---

## Part 3 — Load the Extension in Chrome

### 3.1 — Open Chrome Extensions page

1. Open Chrome
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** using the toggle in the top-right corner

### 3.2 — Load the extension

1. Click **Load unpacked**
2. In the file picker, navigate to `/home/k/Documents/datum/extension/dist/`
3. Click **Select** (or **Open**)

Expected: DATUM card appears in the extensions list with no error badge.

**If you see a red error badge**, click "Errors" on the card to see what failed. Common issues:
- `"service_worker" is invalid` → rebuild the extension
- `Could not load javascript` → check the dist/ files exist

### 3.3 — Verify service worker is active

1. On the DATUM extension card, click the **"service worker"** link (or "Inspect views: service worker")
2. A DevTools window opens for the background service worker
3. Check the **Console** tab — you should see:
   ```
   [DATUM] Extension installed/updated
   ```
4. Check the **Network** tab is not showing errors

**Keep this DevTools window open** throughout testing — it's the best debugging tool.

### 3.4 — Pin the extension to toolbar

1. Click the puzzle-piece icon in Chrome toolbar
2. Click the pin icon next to **DATUM**
3. The DATUM icon (purple square) should now appear in the toolbar

---

## Part 4 — Configure the Extension

### 4.1 — Open the popup

Click the DATUM icon in the Chrome toolbar. A popup window appears with tabs at the top: **Campaigns | Claims | Earnings | Publisher | Settings**.

It opens on the **Claims** tab by default.

### 4.2 — Go to Settings

Click the **Settings** tab.

### 4.3 — Set RPC and contract addresses

1. In the **Network** dropdown, select **local** — this auto-fills the RPC URL as `http://localhost:8545`
2. Verify the RPC URL field shows `http://localhost:8545`
3. Fill in the 6 contract address fields with the addresses from Step 2.3:
   - **Campaigns**: paste DatumCampaigns address
   - **Publishers**: paste DatumPublishers address
   - **Governance Voting**: paste DatumGovernanceVoting address
   - **Governance Rewards**: paste DatumGovernanceRewards address
   - **Settlement**: paste DatumSettlement address
   - **Relay**: paste DatumRelay address
4. Leave **Publisher address** blank (the extension will use your connected wallet address)
5. Leave **Auto-submit** unchecked for now
6. Click **Save Settings**

Expected: "Settings saved." confirmation message appears briefly.

### 4.4 — Connect your wallet

1. Click the back arrow or switch to the **Claims** tab
2. At the top of the popup, click **Connect Wallet**
3. SubWallet will show a permission prompt — click **Approve** or **Connect**
4. Your address appears in the header: `0x1234…abcd`

**If "No Polkadot wallet found" error appears:**
- SubWallet must be installed and have at least one account
- Try refreshing the popup: right-click the DATUM icon → "Reload extension", then re-open

---

## Part 5 — Verify Campaign List

### 5.1 — Switch to Campaigns tab

Click **Campaigns** in the tab bar.

Expected: The campaign you created in Step 2.4 appears as:
```
Campaign #1
Status: Active
Category: technology
Bid CPM: 0.016 DOT
```

If the list is empty:
- Check the service worker console for `[DATUM] campaign poll` log entries
- Verify the Campaigns contract address is correct in Settings
- The poller runs every 5 minutes; to trigger immediately, in the service worker DevTools console run:
  ```javascript
  chrome.alarms.onAlarm.dispatch({ name: "pollCampaigns" });
  ```

---

## Part 6 — Record an Impression (Content Script Test)

### 6.1 — Browse to a matching page

The campaign taxonomy is `"technology"`. The following domains and keywords trigger a match:

**Domain matches (reliable):**
- `github.com` — any page
- `stackoverflow.com` — any page
- `techcrunch.com` — any page

**Title keyword matches (if the page title contains):**
- "software", "developer", "programming", "open source", "linux", "ai", "machine learning", "cloud"

Navigate to `https://github.com` in the **same Chrome window** where the extension is loaded.

### 6.2 — Look for the ad banner

Within 1–2 seconds of the page loading, a dark banner should appear in the **bottom-right corner** of the page. It shows something like:
```
DATUM Ad | Campaign #1 | technology
[dismiss]
```

**If the banner does not appear:**
- Open Chrome DevTools for the GitHub page (F12 → Console)
- Look for `[DATUM]` log entries
- Check for errors like `Cannot read properties of undefined (reading 'campaigns')`
- If you see `GET_ACTIVE_CAMPAIGNS returned empty`, the campaign poller hasn't run yet — trigger it manually (see 5.1)

### 6.3 — Verify the claim was queued

1. Click the DATUM extension icon to open the popup
2. Switch to **Claims** tab
3. Expected:
   ```
   Pending Claims                    1 claim
   Campaign #1  1 impression
   ```

**If 0 claims appear:**
- Open service worker DevTools console
- Look for `[DATUM] claim built` or any errors in `claimBuilder`
- Verify the connected wallet address matches what the content script is sending (it reads `connectedAddress` from storage)

---

## Part 7 — Manual Claim Submission

### 7.1 — Submit claims

On the **Claims** tab with at least 1 pending claim:

1. Click **Submit All (you pay gas)**
2. SubWallet will show a transaction prompt with:
   - To: the Settlement contract address
   - Value: 0
   - Gas fee: some DOT amount
3. Click **Approve** in SubWallet

### 7.2 — Wait for confirmation

The button changes to **"Submitting…"**. This takes 5–15 seconds on the devchain.

Expected result after confirmation:
```
✓ Settled: 1 · Rejected: 0
Total paid: 0.000 DOT
```

> **Why 0.000 DOT paid?** The displayed `totalPaid` comes from `ClaimSettled` event `totalPayment` field. With `bidCpmPlanck = 160_000_000` and `impressionCount = 1`, `totalPayment = (160_000_000 × 1) / 1000 = 160_000` planck = 0.000016 DOT, which rounds to 0.000 in the 3-decimal display. This is correct.

**If "Submitting…" hangs for > 30 seconds:**
- Check service worker DevTools for errors
- SubWallet may have rejected silently — check SubWallet transaction history

**If "Claims rejected — chain state resynced" appears:**
- The nonce was out of sync — the extension auto-resynced. Click Submit All again.

**If "No EIP-1193 provider found" error:**
- SubWallet is not injecting `window.ethereum` into the extension popup
- Try: disable and re-enable SubWallet, then reload the DATUM extension

### 7.3 — Verify claims cleared

After submission, the Claims tab should show:
```
No pending claims. Browse pages to earn DOT.
```

---

## Part 8 — Publisher Balance and Withdrawal

### 8.1 — Check publisher balance

Click the **Publisher** tab.

Expected:
```
Publisher Balance
0.000... DOT   [Withdraw]

Registration: Active
Take rate: 50.00%
```

The balance may be very small (in the range of 0.000008 DOT for 1 impression at 0.016 CPM with 50% take rate). That's correct.

If balance shows 0.000000 DOT and you confirmed settlement succeeded, the publisher address in Settings may not match Alith's address. Verify: in Settings → Publisher address should be blank (uses connected wallet) or explicitly set to Alith's address (`0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac`).

### 8.2 — Withdraw publisher balance

1. Click **Withdraw** on the Publisher tab
2. SubWallet prompts for transaction approval
3. Click **Approve**
4. After confirmation: balance shows `0.000 DOT`

Expected: Balance zeroes out. ✓

---

## Part 9 — User Earnings and Withdrawal

### 9.1 — Check user balance

Click the **Earnings** tab.

Expected:
```
Your Earnings
0.000... DOT   [Withdraw]
```

The user receives 75% of `remainder` (remainder = totalPayment minus publisher cut). With the test numbers this is tiny but non-zero.

### 9.2 — Withdraw user balance

1. Click **Withdraw**
2. SubWallet prompts → **Approve**
3. After confirmation: balance zeroes

Expected: Balance zeroes out. ✓

---

## Part 10 — Sign for Publisher Relay

This tests the zero-gas path where a publisher submits on behalf of the user.

### 10.1 — Record another impression

Navigate to `github.com` again (or another matching page). Wait for the banner and confirm the Claims tab shows 1 pending claim.

### 10.2 — Sign for relay

On the **Claims** tab:

1. Click **Sign for Publisher (zero gas)**
2. SubWallet shows an **EIP-712 typed data signing prompt** (not a transaction) — it should display structured data including `"DatumRelay"`, `campaignId`, nonce range, and deadline
3. Click **Sign** in SubWallet

Expected result:
```
✓ Signed 1 batch for publisher relay.
The publisher will submit these on your behalf.
```

> **What this means:** The signed batch is stored in `chrome.storage.local` under `signedBatches`. In production, the publisher's server would pick this up and call `DatumRelay.settleClaimsFor()`. For this test, the signing succeeding is sufficient — the full relay submission requires a publisher server component that's out of scope for G2.

---

## Part 11 — Auto-Submit

### 11.1 — Record another impression

Navigate to `github.com`. Confirm 1 pending claim appears in Claims tab.

### 11.2 — Enable auto-submit

1. Go to **Settings** tab
2. Check **Auto submit**
3. Set interval to **1** minute
4. Click **Save Settings**

### 11.3 — Trigger the alarm manually

The Chrome alarms API fires on real time intervals — waiting 1 minute is slow for testing. Trigger it immediately from the service worker DevTools console:

1. Switch to the service worker DevTools window (from Step 3.3)
2. In the **Console** tab, run:
   ```javascript
   chrome.alarms.onAlarm.dispatch({ name: "flushClaims" });
   ```

### 11.4 — Check auto-flush result

Within 10–20 seconds, switch to the **Claims** tab. At the bottom:

```
Auto-submit ✓ 1 settled · 0 rejected  [timestamp]
```

Expected: Auto-submit shows settled count > 0. ✓

**If auto-submit shows an error "No EIP-1193 provider in offscreen context":**
- SubWallet does not inject `window.ethereum` into extension offscreen documents
- This is a known limitation — SubWallet may need to be configured to inject into all extension pages
- This does not block G2 if manual submit works (auto-submit is a best-effort feature)

**If auto-submit shows "No accounts available in offscreen context":**
- SubWallet wallet is locked — unlock it and try again

---

## Part 12 — Settings Persistence Test

### 12.1 — Close and reopen popup

1. Click somewhere outside the popup to close it
2. Click the DATUM icon to reopen it

Expected: Go to Settings tab — all contract addresses and settings are still populated. ✓

---

## Gate G2 — Checklist

Mark each item:

| # | Test | Result |
|---|------|--------|
| G2-1 | Extension loads in Chrome with no error badge | ☐ Pass / ☐ Fail |
| G2-2 | Service worker shows "active" on extension card | ☐ Pass / ☐ Fail |
| G2-3 | Wallet connects — address shown in header | ☐ Pass / ☐ Fail |
| G2-4 | Campaign list loads from local RPC | ☐ Pass / ☐ Fail |
| G2-5 | Ad banner appears on matching page | ☐ Pass / ☐ Fail |
| G2-6 | Impression recorded — claim appears in Claims tab | ☐ Pass / ☐ Fail |
| G2-7 | Manual submit succeeds — `settledCount >= 1` | ☐ Pass / ☐ Fail |
| G2-8 | Claims cleared from queue after settlement | ☐ Pass / ☐ Fail |
| G2-9 | Publisher balance appears — withdrawal succeeds | ☐ Pass / ☐ Fail |
| G2-10 | User (Earnings) balance appears — withdrawal succeeds | ☐ Pass / ☐ Fail |
| G2-11 | Sign for relay — EIP-712 prompt shown, signed successfully | ☐ Pass / ☐ Fail |
| G2-12 | Auto-submit fires — result shown in Claims tab | ☐ Pass / ☐ Fail |
| G2-13 | Settings persist across popup close/open | ☐ Pass / ☐ Fail |

**G2 passes when all 13 items are checked Pass.**

---

## Cleanup

When done testing:

```bash
# Stop the devchain
docker rm -f substrate eth-rpc
```

To remove the extension from Chrome:
- `chrome://extensions` → DATUM card → **Remove**

---

## Appendix — Troubleshooting Reference

### Service worker keeps becoming "inactive"

MV3 service workers are unloaded after 30 seconds of inactivity. This is normal Chrome behaviour. Click the "service worker" link on the extension card to re-activate it. The extension re-initialises correctly on next message.

### "Cannot read properties of undefined (reading 'settleClaims')"

The settlement contract address in Settings is wrong or empty. Go to Settings and verify all addresses match the deploy script output.

### Popup shows blank / white screen

Open popup DevTools: right-click inside the popup → **Inspect**. Check Console for React errors. Most likely cause: a runtime error in App.tsx on startup.

### "Invalid Transaction" on submission

The devchain has a denomination rounding bug: transfer amounts where `value % 10^6 >= 500_000` are rejected. The test campaign is configured with `bidCpmPlanck = 160_000_000` (160 × 10^6) to avoid this. If you used different values, you may hit this.

### SubWallet not showing EIP-712 typed data (shows hex blob instead)

SubWallet may need to be updated. The EIP-712 prompt requires SubWallet v0.7+ with typed data display support. If it shows a hex blob, signing still works — the display is cosmetic.

### How to reset extension state between test runs

In the service worker DevTools console:
```javascript
chrome.storage.local.clear();
```

Then reload the extension (`chrome://extensions` → DATUM → reload icon).

### Devchain account addresses

For reference — these are the pre-funded Hardhat signer addresses on the local substrate devchain:

| Name | Address |
|------|---------|
| Alith (deployer) | `0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac` |
| Baltathar | `0x3Cd0A705a2DC65e5b1E1205896BaA2be8A07c6e0` |
| Charleth | `0x798d4Ba9baf0064Ec19eB4F0a1a45785ae9D6DFc` |
