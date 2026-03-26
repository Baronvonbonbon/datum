# DATUM Alpha-2 — Paseo TestNet Deployment

**Deployed:** 2026-03-26
**Network:** Paseo (Chain ID 420420417)
**RPC:** `https://eth-rpc-testnet.polkadot.io/`
**Explorer:** https://blockscout-testnet.polkadot.io/
**Faucet:** https://faucet.polkadot.io/ (select "Paseo")
**Currency:** PAS (testnet DOT)

---

## Contract Addresses (13 contracts)

| Contract | Address |
|----------|---------|
| PauseRegistry | `0xEE1C347bDd5A552DC7CEDFdC51903ec7C82EC52D` |
| Timelock | `0x7CE40Ff62073f64fA6061A39023342Ab6Cf7c8Cc` |
| ZKVerifier (stub) | `0x80C547a15C59e26317C85C32C730e85F8067D87D` |
| Publishers | `0x903D787B06B4b1E0036b162C3EfFd9984e73620b` |
| BudgetLedger | `0xbCB853B7306fa27866717847FAD0a11f5bd65261` |
| PaymentVault | `0x31D64e88318937CeA791A4E54Bc9abCeab51d23C` |
| Campaigns | `0xd14f889c1DafC1AD47788bfA47890353596380b9` |
| CampaignLifecycle | `0xb789c62b90d525871ECCF54E5d0D5Eae87BF62fe` |
| Settlement | `0x13bF0d24C67b7a5354c675e00D7154bcc4A5738E` |
| GovernanceV2 | `0xcb2B5b586E0726A7422eb4E5bD049382a19769A4` |
| GovernanceSlash | `0x7A3032672bd5AeA348aD203287DedA58A62401ae` |
| Relay | `0x4D8B2CE56D40a3c423A7C1b91861C6186ceb59Ef` |
| AttestationVerifier | `0x1d84219251e8750FB7121AE92b2994887dDd9E18` |

**Ownership:** Campaigns + Settlement transferred to Timelock.
**Deployer:** Alice `0x94CC36412EE0c099BfE7D61a35092e40342F62D7`

---

## Test Accounts (Addresses Only)

| Name | Role | Address |
|------|------|---------|
| Alice | Deployer / Admin | `0x94CC36412EE0c099BfE7D61a35092e40342F62D7` |
| Bob | Advertiser 1 | `0xfE091a42BCE57f3f9Acd92D21C8F9DbC4E5c7CE6` |
| Charlie | Advertiser 2 | `0x09ce34740bCE52FB3cAa4A2D50cC2fbAD6F32C5b` |
| Diana | Publisher 1 | `0xcA5668fB864Acab0aC7f4CFa73949174720b58D0` |
| Eve | Publisher 2 | `0xD633C470d075Af508f4895e21A986183fEf35745` |
| Frank | Voter (Aye) | `0x92622970Bd48dD26c53bCCd09Aa6a0245dbc7620` |
| Grace | Voter (Nay) | `0xa9e2bd7Bd5a14E8add0023B4Ab56ed27BeABC92F` |
| Hank | User / Viewer 1 | `0x615BcbE62B43bB033e65533bB6FcCC8b6FcB5BbD` |
| Iris | User / Viewer 2 | `0xC59101dab8d0899F74d19a4f13bb2D9A030065af` |
| Jack | User / Viewer 3 | `0x705f35BC60EE574FA5d1D38Ef2CD4784dE9371d3` |

**Private keys:** See gitignored `TESTNET-KEYS.md` (never commit).

---

## Registered Publishers

| Publisher | Take Rate | Categories |
|-----------|-----------|------------|
| Diana | 50% (5000 bps) | All 26 (bitmask `0x7fffffe`) |
| Eve | 40% (4000 bps) | Category 26 only (Other) |

---

## Test Campaign

| Field | Value |
|-------|-------|
| Campaign ID | 1 |
| Status | Active |
| Advertiser | Bob (`0xfE091a42BCE57f3f9Acd92D21C8F9DbC4E5c7CE6`) |
| Publisher | Diana (`0xcA5668fB864Acab0aC7f4CFa73949174720b58D0`) |
| Budget | 10 PAS |
| Daily Cap | 10 PAS |
| Bid CPM | 0.016 PAS |
| Category | 1 (Crypto) |
| Metadata Hash | `0x07338d0926a787c6...` |
| Aye Voter | Frank, 100 PAS stake, conviction 0 |

---

## Deployment Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| MIN_CPM_FLOOR | 0.001 PAS | Per 1000 impressions |
| PENDING_TIMEOUT | 100,800 blocks | ~7 days |
| TAKE_RATE_UPDATE_DELAY | 14,400 blocks | ~24h |
| QUORUM_WEIGHTED | 100 PAS | Conviction-weighted |
| SLASH_BPS | 1000 (10%) | Losing side penalty |
| TERMINATION_QUORUM | 100 PAS | Nay-weighted minimum |
| BASE_GRACE_BLOCKS | 14,400 | ~24h cooldown |
| GRACE_PER_QUORUM | 14,400 | Additional per quorum-unit |
| MAX_GRACE_BLOCKS | 100,800 | ~7d cap |
| INACTIVITY_TIMEOUT | 432,000 blocks | 30 days (P20) |
| Settlement Batch Cap | 50 claims | Sub-linear scaling confirmed |

---

## How to Reproduce

```bash
cd /home/k/Documents/datum/alpha-2
export DEPLOYER_PRIVATE_KEY="<alice-private-key>"

# Deploy 13 contracts + wire + ownership transfer
npx hardhat run scripts/deploy.ts --network polkadotTestnet

# Fund accounts, register publishers, create campaign, vote
npx hardhat run scripts/setup-testnet.ts --network polkadotTestnet
```

---

## Extension Configuration

1. Build: `cd alpha-2/extension && npm run build`
2. Load unpacked: `chrome://extensions/` → `alpha-2/extension/dist/`
3. Addresses auto-load from `alpha-2/extension/deployed-addresses.json`
4. Set network to "Paseo" in Settings

---

## Web App

Live at: https://datum.javcon.io
Addresses hardcoded in `web/src/shared/networks.ts` (polkadotTestnet config).

---

## Relay Bot

Addresses updated in `relay-bot/relay-bot.mjs` (gitignored).
Restart: `systemctl --user restart datum-relay-bot`
