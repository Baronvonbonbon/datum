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
- [ ] **Rotate the Pinata credential** (🔴 above) — do this first.
- [ ] Consider a **history scrub** (`git filter-repo`) for `TESTNET-KEYS.md`; at
      minimum, treat every key/credential ever committed as burned.
- [ ] Move the ~10 scripts' hardcoded testnet keys to `.env` before any
      open-source release or mainnet work.
- [ ] Promote the `secrets` CI job to a required status check.
