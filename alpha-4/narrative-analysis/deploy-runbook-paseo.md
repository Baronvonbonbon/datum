# Phase D Deploy Runbook — Paseo

End-to-end procedure for deploying the People Chain identity bridge
+ cache + Diana daemon on Paseo Hub. Goalpost: a click on
`/me/identity` "Request refresh" results in a verified attestation
landing in the cache within ~30 seconds.

**Reference docs:**
- `/home/k/.claude/plans/fizzy-plotting-lerdorf.md` — the master plan
- `narrative-analysis/people-chain-return-leg.md` — return-leg research
- `narrative-analysis/bonded-reporter-identity.md` — single-Diana mitigation design
- `MAINNET-DEFERRED-ITEMS.md` — what NOT to do on Paseo (e.g.
  `lockOracleReporter`)

---

## 0. Pre-deploy checks

Run all from `alpha-4/`.

### 0a. Compile + tests are green

```bash
cd alpha-4
npx hardhat compile
npx hardhat test
# Expected: 1142 passing, 1 pending
```

### 0b. Deployer funded on Paseo

```bash
node -e "
const { JsonRpcProvider, Wallet, formatEther } = require('ethers');
const p = new JsonRpcProvider('https://eth-rpc-testnet.polkadot.io/');
const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
p.getBalance(w.address).then(b => console.log(w.address, formatEther(b), 'PAS'));
"
# Expected: ≥ 100 PAS. Faucet: https://faucet.polkadot.io/
```

### 0c. People Chain RPC reachable

```bash
node -e "
const { createClient } = require('polkadot-api');
const { getWsProvider } = require('polkadot-api/ws');
const c = createClient(getWsProvider('wss://paseo-people-rpc.polkadot.io'));
c.getUnsafeApi().query.System.Number.getValue()
  .then(n => { console.log('People Chain head block:', n); c.destroy(); });
" 2>&1 | tail
# Expected: a recent block number
```

### 0d. ZK artifacts present (for unrelated contracts)

```bash
ls circuits/setVK-calldata.json circuits/impression.zkey
ls circuits-identity/identity-vk-calldata.json
```

### 0e. Bridge addresses fields blank in deployed-addresses.json

If you're deploying fresh, ensure `peopleChainXcmBridge` is absent or
empty in `deployed-addresses.json`. If re-running, deploy.ts uses
`deployOrReuse` so it'll skip existing addresses.

```bash
jq '.peopleChainXcmBridge // "absent"' deployed-addresses.json
```

---

## 1. Deploy contracts (deploys 29-contract set)

```bash
cd alpha-4
export DEPLOYER_PRIVATE_KEY="0x..."   # Alice
npx hardhat run scripts/deploy.ts --network polkadotTestnet
```

Expected output ends with:

```
=== All 30 contracts deployed ===
```

then phase 2-3 wiring logs, then ownership transfers.

`deployed-addresses.json` should now have all three:
- `peopleChainIdentity`: 0x...
- `peopleChainXcmBridge`: 0x...
- `peopleChainBondedReporter`: 0x... (deployed but NOT wired as cache writer — see §11)

The wiring section should log:
```
SET   PeopleChainIdentity.xcmDispatcher       -> 0x... (bridge)
SET   PeopleChainXcmBridge.campaignsContract  -> 0x... (campaigns)
SET   PeopleChainXcmBridge.peopleChainSovereign -> 0x... (deployer = Diana)
TRANSFERRED: PeopleChainXcmBridge -> Timelock (pending; Timelock must call acceptOwnership)
```

### Verify

```bash
npx hardhat run scripts/check-wiring.ts --network polkadotTestnet
```

Or manually:

```bash
node -e "
const { JsonRpcProvider, Contract } = require('ethers');
const a = require('./deployed-addresses.json');
const p = new JsonRpcProvider('https://eth-rpc-testnet.polkadot.io/');
const cache = new Contract(a.peopleChainIdentity, [
  'function xcmDispatcher() view returns (address)',
  'function oracleReporter() view returns (address)',
], p);
const bridge = new Contract(a.peopleChainXcmBridge, [
  'function peopleChainSovereign() view returns (address)',
  'function campaignsContract() view returns (address)',
], p);
Promise.all([
  cache.xcmDispatcher(),
  cache.oracleReporter(),
  bridge.peopleChainSovereign(),
  bridge.campaignsContract(),
]).then(([d, r, s, c]) => console.log({ dispatcher: d, oracleReporter: r, sovereign: s, campaigns: c }));
"
```

Expected: `dispatcher == bridge address`, `oracleReporter` and
`sovereign` both equal the deployer EOA (Alice). `campaigns` equals
the DatumCampaigns address.

---

## 2. Smoke test 1 — outbound XCM dispatch (SMOKE_MODE=request)

This tests that the bridge encodes and dispatches a valid XCM message
via the IXcm precompile. **Does NOT wait for a return leg** — that's
gated on Diana being running. This is the "encoder works on the real
precompile" smoke.

```bash
export DEPLOYER_PRIVATE_KEY="0x..."
export SMOKE_MODE=request
npx hardhat run scripts/smoke-bridge.ts --network polkadotTestnet
```

**Expected outcomes:**

- **PASS:** `RefreshDispatched` + `RefreshInFlight` events emitted; tx
  succeeds; Paseo block explorer shows an outbound `pallet_xcm`-related
  event in the same tx.
- **FAIL at `weighMessage`:** encoder produced malformed bytes; check
  the dispatched payload prefix. If first byte != `0x05`, the encoder
  is wrong somewhere.
- **FAIL at `execute` (insufficient fee):** raise `refreshFee` via the
  Timelock or `bridge.setRefreshFee` from the deployer if ownership
  hasn't been accepted yet.
- **REVERT at `_dispatch`:** check the precompile address constant.
  Paseo's IXcm is `0x..0a0000` per the docs but verify against the
  current network config.

**Paseo block explorer:** https://blockscout-testnet.polkadot.io/
Look for `IXcm.MessageDispatched` or substrate-side `xcmpQueue` events
in the same tx.

---

## 3. Smoke test 2 — Diana stand-in callback (SMOKE_MODE=callback)

This tests the cache write path. **Diana (= deployer) calls
`bridge.xcmCallback` directly.** Verifies the cache record updates
and `isVerified` flips.

```bash
export DEPLOYER_PRIVATE_KEY="0x..."   # must equal peopleChainSovereign
export SMOKE_MODE=callback
export SMOKE_TARGET="0xDeployerAddressHere..."
export SMOKE_LEVEL=1
export SMOKE_VALIDITY_BLOCKS=432000
npx hardhat run scripts/smoke-bridge.ts --network polkadotTestnet
```

**Expected:** cache `getIdentity(target)` returns `(1, expiryBlock,
lastUpdatedBlock)` where `expiryBlock ≈ current + 432_000`. `isVerified(target, 1)` returns true.

If this passes, the contract code path is fully proven.

---

## 4. Diana daemon setup

The daemon lives in `relay-bot/` (gitignored). Configure and run:

### 4a. Create `.env` in `relay-bot/`

```bash
cat > relay-bot/.env <<EOF
HUB_RPC=https://eth-rpc-testnet.polkadot.io/
DIANA_KEY=0x...                        # Same EOA as peopleChainSovereign
CACHE_ADDRESS=0x...                    # From deployed-addresses.json
BRIDGE_ADDRESS=0x...                   # From deployed-addresses.json
PEOPLE_CHAIN_RPC=wss://paseo-people-rpc.polkadot.io
POLL_INTERVAL_SEC=30
DEFAULT_VALIDITY_BLOCKS=432000
LOOKBACK_BLOCKS=1000
EOF
```

### 4b. Install deps + dry run

```bash
cd relay-bot
npm install
npm run diana-identity
```

Expected logs:

```
[diana-identity] Hub signer: 0x...
[diana-identity] Cache:  0x...
[diana-identity] Bridge: 0x...
[diana-identity] People Chain RPC: wss://...
[diana-identity] polling every 30s, lookback 1000 blocks
[diana-identity] bridge sovereign = 0x... (diana IS sovereign)
```

### 4c. (Optional) systemd unit

If running as a service like the main relay-bot:

```bash
sudo tee /etc/systemd/user/datum-diana-identity.service <<EOF
[Unit]
Description=DATUM Diana Identity Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/datum/relay-bot
EnvironmentFile=/home/datum/relay-bot/.env
ExecStart=/usr/bin/node diana-identity.mjs
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now datum-diana-identity
journalctl --user -fu datum-diana-identity
```

---

## 5. Smoke test 3 — end-to-end (SMOKE_MODE=e2e)

Daemon must be running. This calls `requestRefresh`, waits for Diana
to handle the event, and asserts `RefreshCallback` fires + cache
updates.

```bash
export DEPLOYER_PRIVATE_KEY="0x..."     # Use any test account with PAS
export SMOKE_MODE=e2e
export SMOKE_TARGET=""                  # default to signer self
npx hardhat run scripts/smoke-bridge.ts --network polkadotTestnet
```

Expected timeline:

| Time   | Event                                         |
|-------:|-----------------------------------------------|
| T=0    | `requestRefresh` tx submitted                 |
| T+10s  | Tx confirmed; `RefreshInFlight` event emitted |
| T+30s  | Diana daemon next poll cycle picks up event   |
| T+35s  | Diana queries People Chain identity           |
| T+45s  | Diana submits `xcmCallback` tx                |
| T+60s  | Tx confirmed; `RefreshCallback` event emitted |
| T+60s  | Smoke script reports PASS                     |

If the target has no People Chain identity, the daemon writes
`level=0` and the smoke reports PASS with that note. To test a
positive case, register an identity on Paseo People Chain first:

```bash
# Off-chain via PAPI / polkadot.js UI on https://polkadot.js.org/apps/?rpc=wss://paseo-people-rpc.polkadot.io
# Set Identity → request Reasonable judgement from registrar #0
```

---

## 6. Web UI manual test

Browser:
1. Open the deployed web app on Paseo.
2. Connect a wallet with PAS.
3. Navigate to `/me/identity`.
4. Click "Request refresh (1000000000 planck)".
5. Approve the tx (which sends 0.1 PAS as the refresh fee).
6. UI shows "Verifying… awaiting People Chain response" badge.
7. ~30–60s later, badge clears, cached attestation updates.

If the cached attestation level is non-zero, identity-gated campaigns
will now accept settlement for this user.

---

## 7. Verification checklist

Tick each as you complete it:

- [ ] `deploy.ts` finished with "All 29 contracts deployed" + ownership transfers
- [ ] `cache.xcmDispatcher == bridge` (manual check)
- [ ] `bridge.peopleChainSovereign == deployer` (Alice)
- [ ] `bridge.campaignsContract == campaigns`
- [ ] SMOKE_MODE=request PASS
- [ ] SMOKE_MODE=callback PASS
- [ ] Diana daemon running + logs healthy
- [ ] SMOKE_MODE=e2e PASS for a user with no identity (level=0 write)
- [ ] SMOKE_MODE=e2e PASS for a user with a Reasonable judgement (level=1 write)
- [ ] Web UI `/me/identity` shows the cached level + expiry
- [ ] Web UI Refresh button works end-to-end without errors

Once all green: Phase D complete. The bridge is fully operational on
Paseo with Diana standing in for the People Chain sovereign.

---

## 8. What NOT to do on Paseo

Per `MAINNET-DEFERRED-ITEMS.md` §2 and the research findings:

- ❌ **Do NOT call `bridge.lockSovereign()`** — the sovereign is Diana
  on Paseo, not the real People Chain sovereign. Locking would mean
  Diana stays sovereign forever.
- ❌ **Do NOT call `cache.lockXcmDispatcher()`** — the bridge address
  may change as we iterate. Locking permanently pins the current bridge.
- ❌ **Do NOT call `cache.lockOracleReporter()`** — Diana's direct
  cache-write path is the fallback during validation. Keep both paths
  active.
- ❌ **Do NOT transfer ownership of the bridge to a non-Timelock
  address.** The deploy script already routes ownership to Timelock,
  but if you re-deploy, ensure the new address gets the same routing.

These locks are operational, irreversible commitments and belong on
**mainnet only**, after the trustless return leg is real (see
`people-chain-return-leg.md` Options 1 / 4 / 5).

---

## 9. Troubleshooting

### Symptom: `requestRefresh` reverts with E03

`msg.value` is below `refreshFee`. Check:
```bash
node -e "
const { JsonRpcProvider, Contract } = require('ethers');
const a = require('./deployed-addresses.json');
const p = new JsonRpcProvider('https://eth-rpc-testnet.polkadot.io/');
const b = new Contract(a.peopleChainXcmBridge,
  ['function estimatedRefreshFee() view returns (uint256)'], p);
b.estimatedRefreshFee().then(v => console.log(v.toString()));
"
```

Default is `1_000_000_000` planck (0.1 PAS at 10^10 denomination). Send
that or more.

### Symptom: `requestRefresh` reverts with E96 (cooldown)

User refreshed recently. Either wait `refreshCooldownBlocks` (default 600 ≈ 1h) or, on Paseo, lower the cooldown via deployer:
```bash
bridge.setRefreshCooldownBlocks(60)  # ~6 min, minimum allowed
```

### Symptom: `xcmCallback` reverts with E18

`msg.sender != peopleChainSovereign`. Either:
- Sign from the right EOA, OR
- `bridge.setSovereign(signerAddress)` from the owner first

### Symptom: Diana daemon writes `level=0` even for verified identities

The EVM ↔ Substrate account derivation is the standard pallet-revive
padding (`evm_address[..20] + 0xee * 12`). If the user registered
their identity on People Chain under a DIFFERENT Substrate account,
Diana won't find it. This is the EVM/Substrate binding problem noted
in `people-chain-return-leg.md` §5 and in the daemon source. Workaround
options:
- User registers identity under their derived AccountId32 (matches
  Hub flow).
- Override `evmToSubstrateAccount` in the daemon for a specific test
  case.

### Symptom: Daemon never reacts to events

Check:
1. `journalctl --user -u datum-diana-identity` for poll errors.
2. The daemon's `useBridgePath` boolean — it logs at boot whether
   Diana is the sovereign.
3. `LOOKBACK_BLOCKS` — if first run, scans 1000 blocks back; might
   miss older events. Increase if needed.
4. RPC liveness — Hub RPC + People Chain RPC both reachable.

### Symptom: Outbound XCM dispatched but no callback arrives

This is expected when no People Chain pallet exists (every Phase D
state). The XCM Transact targets a non-existent dispatchable and is
silently dropped. Diana handles the off-chain side; no on-chain return
is expected.

If you want a return-leg test, run a forked People Chain devnet with
the `pallet-datum-identity-relay` skeleton from
`plans/fizzy-plotting-lerdorf.md` §Follow-up.

---

## 10. Next phases (not Phase D)

After Phase D succeeds and validates the architecture:

- **Track B:** Develop `pallet-datum-identity-relay` on a People Chain
  fork; design OpenGov referendum. Months-scale.
- **Track C:** Spike whether pallet-revive can read relay-chain state
  for state-proof verification. 1-2 weeks.
- **Bonded reporter:** Build `DatumBondedIdentityReporter` per
  `bonded-reporter-identity.md`. Replaces Diana with permissionless
  set. ~2 weeks contract work.

When ANY of those mature, the migration is:

1. Stop Diana daemon.
2. `cache.setOracleReporter(0)` (or just leave wired, then
   `cache.lockOracleReporter()` to retire).
3. `bridge.setSovereign(newSovereignAddress)` — points at custom
   pallet's sovereign OR bonded-reporter contract.
4. `bridge.lockSovereign()`.
5. `cache.lockXcmDispatcher()`.

After step 5, the system is fully trustless under whichever Option
matured first. No web changes required — bridge ABI is stable.

---

## 11. Bonded reporter — deployed but not wired

`DatumBondedIdentityReporter` ships in the 30-contract deploy
(commit landing this section) but is deliberately NOT wired as a
cache writer during Phase D.

**Current wiring at deploy time:**
- `cache.xcmDispatcher = bridge` (bridge writes attestations from
  Diana's xcmCallback)
- `cache.oracleReporter = deployer` (Diana fallback)
- `bondedReporter.cache = cache` (reporter knows where to finalize)
- `bondedReporter.owner = Timelock` (ownership routed for governance
  arbitration of slash/dismiss)
- **NOT WIRED:** `cache.setXcmDispatcher(bondedReporter)`. The
  reporter cannot write to the cache yet — `finalizeAttestation`
  reverts E18 from the cache.

**Why not wire on Paseo:** the reporter introduces an additional
trust surface (challenge-window UX, multi-reporter coordination, owner-
arbitrated slashing). Validate it in isolation first, then decide
which of two wiring options to deploy:

1. **3rd cache writer slot (additive).** Modify
   `DatumPeopleChainIdentity` to accept writes from a new
   `bondedReporter` slot alongside `xcmDispatcher` (bridge) and
   `oracleReporter` (Diana). Both the bridge and bonded reporter
   become parallel writer paths. Bridge stays for fast user-triggered
   refresh; bonded reporter becomes the trustless attestation source.

2. **Dispatcher swap.** `cache.setXcmDispatcher(bondedReporter)`,
   `cache.lockXcmDispatcher()`. Bridge writes are now routed THROUGH
   the bonded reporter (bridge submits an attestation, fast-finalizes
   via its own authority). More complex; tighter trust binding.

Tracked in `narrative-analysis/bonded-reporter-identity.md` §4.

**To exercise the reporter on Paseo without wiring** (smoke its
internal flow): deploy a separate test cache, wire the reporter to
that cache only, run join → submit → approve → finalize → claim
through the testnet. No effect on the production cache.

**To wire it for real** (post-Phase D validation):
```bash
# Option 1 (additive):
#   needs a cache contract update + redeploy
# Option 2 (dispatcher swap):
#   from Timelock:
#     cache.setXcmDispatcher(addresses.peopleChainBondedReporter)
#   ...then ratify with cache.lockXcmDispatcher() after stable operation.
```
