# DATUM extension — release & store-submission guide

This is the operator runbook for cutting a production build of the DATUM browser
extension and submitting it to the Chrome Web Store / Edge Add-ons. It does **not**
submit anything automatically.

Current version: **0.3.0** (`manifest.json` + `package.json` are kept in sync).

---

## 1. Build the store artifact

```bash
cd alpha-5/extension
npm ci                 # clean install (first time / CI)
npm run type-check     # tsc --noEmit
npm test               # jest
npm run build:release  # production webpack build + zips dist/ → release/
```

`build:release` runs the production webpack build (`--mode production`) and then
`scripts/package-release.js`, which zips the **contents** of `dist/` (so
`manifest.json` is at the archive root, as the stores require) into:

```
release/datum-extension-v<version>.zip
```

Upload that zip to the store dashboard. `release/` is gitignored.

### Production build posture (already enforced by `webpack.config.ts`)
- `--mode production` → Terser minification, `process.env.NODE_ENV="production"`.
- `devtool: false` → **no source maps** shipped (the `*.map` exclusion in the
  packager is belt-and-braces).
- `output.clean: true` → `dist/` is wiped each build, so no stale assets leak in.

---

## 2. Permissions — store-review justification

The extension requests broad host access. This is **intentional and required by the
product model**; include the rationale below in the store listing's "privacy
practices" / permission-justification fields to smooth review.

| Permission | Why it's needed |
|---|---|
| `host_permissions: ["<all_urls>"]` | DATUM serves ads on **any** publisher site and exposes a `window.datum` wallet provider to **any** dapp. The publisher/dapp set is open and not knowable ahead of time, so access can't be narrowed to a fixed allowlist without breaking the core function. |
| `content_scripts` on `<all_urls>` | Four scripts at `document_start`/`document_idle`: `walletInjector` (MAIN world — attaches `window.datum`), `walletBridge` (ISOLATED — relays to the service worker), `provider` (EIP-1193 bridge), `content` (ad slot detection + impression recording). All run per-page for the same open-publisher reason. |
| `storage` | Local wallet (encrypted), settings, claim queue, campaign cache, interest profile. Nothing is sent off-device except signed claims/RPC. |
| `alarms` | Periodic campaign polling, claim auto-flush, wallet idle-lock. |
| `offscreen` | Runs the Pine light client (smoldot) + wallet crypto off the service-worker thread. |
| `windows` | Opens the signing-approval popup window for external-origin signature requests. |

**Content Security Policy** (already set, kept tight):
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `wasm-unsafe-eval` is
required for the snarkjs/Groth16 prover and the smoldot light client (both WASM);
no remote script sources are allowed.

> Note: the MAIN-world `window.datum` provider injection on all sites is the largest
> attack surface. If a future review pushes back, the fallback is to narrow the
> provider injection to an allowlist of known dapp domains while keeping the ad
> content scripts broad — see the "Narrow window.datum injection" option in the
> permission review. Not done for 0.3.0 (kept broad for generic-dapp support).

---

## 3. Versioning

Bump **both** `manifest.json` `version` and `package.json` `version` together (the
packager names the artifact from the manifest version). Chrome requires a strictly
increasing dotted-integer version on each upload.

---

## 4. Submit (manual — not automated here)

1. Chrome Web Store Developer Dashboard → the DATUM item → **Package** → upload
   `release/datum-extension-v<version>.zip`.
2. Re-confirm the permission justifications (section 2) in the privacy form.
3. Submit for review. (Edge Add-ons: same zip, Partner Center dashboard.)

The store handles signing (CRX). Do **not** self-sign a CRX for store submission;
upload the raw zip.
