# Secrets scrub — findings (2026-06-10, RUNBOOK Phase 6)

Scan of tracked files for private keys, API credentials, JWTs, and mnemonics.

## 🔴 CRITICAL — live API credential committed (action required: ROTATE)

`archive/alpha-2/TESTNET-KEYS.md` — a file whose own header reads *"GITIGNORED —
NEVER COMMIT THIS FILE"* — **was tracked in git** and contains the **live Pinata
IPFS-pinning credentials**:
- a Pinata **JWT** (byte-identical to the current `alpha-core/.env` `PINATA_JWT`),
- Pinata **API Key** + **API Secret**.

The repo is on GitHub, so these are effectively public. Pinata creds let anyone
pin/unpin/manage content on the account and run up usage.

**Done:** `git rm --cached` the file + gitignored it (removed from HEAD).
**MUST do (operator — cannot be done from the repo):**
1. **Rotate the Pinata key/secret/JWT now** in the Pinata dashboard (revoke the
   exposed one, issue a new one, update `alpha-core/.env`). Removal from HEAD does
   **not** scrub git history — the old credential is exposed forever in the log.
2. Audit recent Pinata usage for anything unexpected.

## 🟠 HIGH (testnet-scoped) — deployer + benchmark keys hardcoded in ~10 scripts

The Paseo benchmark account private keys are committed as literals in
`alpha-core/scripts/*` (`activate-pending`, `benchmark-paseo`, `check-testnet`,
`diag-campaign`, `e2e-token-rewards`, `fill-missing-creatives`, `gas-costs`,
`reseed-demo`, `seed-diana-campaigns`, `setup-demo`) and `sdk/` / `relay-bot.example/`.
`0x6eda…` is the **live Paseo deployment's deployer/owner/Phase-0 governor** — i.e.
whoever holds it controls the live testnet contracts (upgrade, lock, etc.).

Funds are valueless (Paseo), so immediate risk is low, **but**:
- **Never reuse any of these addresses/keys on mainnet** — treat them as burned.
- Recommended: move them to the gitignored `alpha-core/.env` (pattern already
  used) and load via `process.env`; leave no key literals in tracked sources.
- The mainnet deployer/owner must be a fresh **Safe / hardware key**, never an EOA
  key that has touched a repo or CI (see `phase-ladder-plan.md` §1).

## ✅ Clear
- **No tracked `.env`** (the active `alpha-core/.env` is correctly gitignored).
- No AWS keys / PEM private keys / SSH keys in tracked files.
- `gas-by-role.{md,csv}` 64-hex values are **blockscout tx hashes**, not keys
  (false positives).

## Durable gate added
- **`.gitleaks.toml` + a `secrets` CI job** (gitleaks, scans the working tree).
  Default rules catch API keys / JWTs / AWS / generic high-entropy; the 15 known
  Paseo testnet keys are allowlisted *by value* so any **new or real** secret —
  including a non-listed private key — fails. Noise paths (ABIs, artifacts,
  `*.json`, `archive/`, tx-hash docs) are excluded.
- Initially a **non-required** check; promote it to a required status check in
  branch protection once a clean run confirms no false positives.

## Remaining (operator / follow-on)
- [ ] **Rotate the Pinata credential** (🔴 above) — do this first. STILL OPEN
      (dashboard action; see 2026-06-16 addendum §3).
- [ ] Consider a **history scrub** (`git filter-repo`) for `TESTNET-KEYS.md`; at
      minimum, treat every key/credential ever committed as burned.
- [x] Move the scripts' hardcoded testnet keys to `.env` — done for the redeploy
      path (`setup-testnet.ts`, `deploy.ts` guardians) in the 2026-06-16 rotation.
      ~13 diagnostic/demo scripts still carry the OLD (now burned + defunded)
      literals; harmless, but should be migrated before open-source release
      (see addendum §4).
- [ ] Promote the `secrets` CI job to a required status check.

---

# Addendum — key rotation executed 2026-06-16

The 🟠 HIGH finding above (deployer/benchmark keys committed → burned) was
remediated by a full **fresh redeploy under a new keyset**, not an in-place
ownership transfer (Paseo testnet; valueless PAS; old keys git-burned). The old
deployer EOA (`0x94CC36…`, priv git-committed) was the root of both control
planes (router governor/adminGovernor + `DatumTimelock` owner per
`CONTROL-MATRIX-MEMO.md`); the redeploy reparents all 49 core contracts under a
fresh key.

### 1. New keyset
- New deployer/Alice = `0x26194fE2e00A837b2a3f4e92A09E835AbB3DCEE3`; new
  Bob/Charlie/Diana/…/Jack + 20 `TESTNET_ACCOUNTS` regenerated.
- Private keys live ONLY in gitignored `alpha-core/.env` and the gitignored
  scratch map `alpha-core/.key-rotation-2026-06-16.json` (old+new, for the
  sweep/audit). Neither is tracked; `.gitleaks.toml` allowlists only the OLD
  burned keys, so any new key in a tracked file fails CI.
- Pause guardians (`deploy.ts`) + relay signer (`relay-bot/.env`,
  `PUBLISHER_KEY` = new Diana) rotated to the new set.

### 2. PAS recovery
- Swept ~35,709 PAS from the 7 funded old accounts → new deployer
  (`scripts/sweep-old-keys.mjs`). Old accounts left with sub-reserve dust;
  abandoned.

### 3. Pinata — STILL THE OPEN ITEM (operator only)
The Pinata JWT/API key/secret (🔴 above) is the only **valuable** leaked
credential and CANNOT be rotated from the repo. Revoke + reissue in the Pinata
dashboard and update `PINATA_*` in `alpha-core/.env`.

### 4. Residual
- ~13 diagnostic/demo scripts (`benchmark-paseo.ts`, `check-testnet.ts`,
  `diag-*.ts`, `seed-*.mjs`, etc.) still embed the OLD burned literals. They are
  now defunded and not owners of the new contracts, so re-running them simply
  fails — no new exposure. Migrate to `.env` as a follow-up.
- New live addresses: `alpha-core/deployed-addresses.json` (deployedAt
  2026-06-17Z). Old deploy preserved at
  `deployed-addresses.pre-keyrotation-2026-06-16.json`.
- DATUM token plane (`deploy-token.ts`: mintAuthority/wrapper/vesting/feeShare)
  and the brand layer were NOT part of this core redeploy and remain under the
  old key — rotate separately if/when those planes go live.
