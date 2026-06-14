# Live-settlement E2E harness (Playwright)

Proves a **real browser impression settles on-chain** against the live Paseo
deploy — the A2 "real user earns" proof, automated.

It drives the web app's `/demo` page, where the in-page **daemon** runs the
*real* extension background code (`routeMessage` + `claimBuilder` + `claimCore` —
the same SLIM claim construction the extension uses), records an impression for a
Diana-published campaign, and settles it via `DatumSettlement.settleClaims`.
Ground truth = the daemon's `claimStatus` reaching `phase: "settled"` +
`settledCount > 0` (written after the on-chain tx confirms).

Why `/demo` and not the MV3 extension in headless Chrome: the daemon is an in-page
replica that imports the extension's background modules verbatim, so this
exercises the real claim path in a real browser without the headless-extension /
encrypted-wallet friction. The relay dual-sig path is separately proven (the
`inject` test + `EXTENSION-SLIM-AUDIT.md`).

## Run

```bash
cd web/e2e
npm install                 # @playwright/test only — uses system Chrome (channel), no browser download
npm test                    # starts `vite dev` on :5174, drives /demo, asserts on-chain settlement
# or against an already-running server:
DEMO_BASE_URL=http://127.0.0.1:5173 npm test
```

Requires a system Chrome/Chromium (`channel: "chrome"`) and a **Diana-published
active campaign** on-chain (e.g. campaign created with `publisher = diana` so
`relaySigner(diana) == diana` — the demo settles those gaslessly via Diana). The
harness logs the campaign cache and picks the first Diana-published active one.

## What it asserts
1. The in-page daemon boots (chrome shim installed) and polls live campaigns.
2. An `IMPRESSION_RECORDED` for a Diana campaign builds a real SLIM claim.
3. `DAEMON_SUBMIT_CLAIMS` settles it on-chain (`settleClaims`), and `claimStatus`
   reaches `settled` with `settledCount > 0` — verified against on-chain nonce.
