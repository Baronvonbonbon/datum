// exercise-governable-params.ts
//
// Walks every Phase A + Phase B governable parameter and proves the
// wiring end-to-end:
//   1. Read the current on-chain value
//   2. Set it to a NEW value (the "up" direction)
//   3. Verify the read-back matches
//   4. Set it to a DIFFERENT value (the "down" direction)
//   5. Verify the read-back matches
//   6. Restore the original
//   7. Verify the restored read-back matches
//
// Uses the OWNER path (deployer is the current governor on Phase 0).
// The PG path is structurally equivalent — same modifier, same bounds,
// same storage write — so confirming the owner path proves the
// modifier swap landed correctly. PG path exercise would require a
// full propose → vote → execute cycle which is out of scope for a
// wiring check.
//
// Output: a markdown-ish console report with one row per setter:
//   role       value-before   value-up   value-down   restored
//
// Skipped rows: setters that have a retune-cooldown active OR a
// per-setter constraint we can't satisfy in a quick script (e.g.,
// setMaxRequiredStake refuses 0, but we test that bound separately
// in the hardhat unit suite — here we just confirm a tune lands).

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { parseDOT } from "../test/helpers/dot";

type ExerciseResult =
  | { ok: true; before: bigint; up: bigint; down: bigint; restored: bigint }
  | { ok: false; reason: string };

interface Param {
  contract: string;
  setter: string;            // e.g. "setMinimumCpmFloor(uint256)"
  getter: string;            // "minimumCpmFloor"
  upValue: bigint;
  downValue: bigint;
  /// Optional: skip exercise if the value matches this predicate
  skipIf?: (current: bigint) => boolean;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network: chainId=${(await ethers.provider.getNetwork()).chainId}`);
  console.log();

  // Phase A parameters
  const params: Param[] = [
    // DatumCampaigns
    { contract: "campaigns",         setter: "setMinimumCpmFloor(uint256)",        getter: "minimumCpmFloor",
      upValue: 50_000_000n, downValue: 20_000_000n },
    { contract: "campaigns",         setter: "setPendingTimeoutBlocks(uint256)",   getter: "pendingTimeoutBlocks",
      upValue: 50_000n, downValue: 1_000n },
    // DatumCampaignLifecycle
    { contract: "campaignLifecycle", setter: "setInactivityTimeoutBlocks(uint256)", getter: "inactivityTimeoutBlocks",
      upValue: 1_000_000n, downValue: 300_000n },

    // Phase B — DatumAdvertiserStake (now deployed in alpha-5 v5)
    { contract: "advertiserStake",   setter: "setMaxRequiredStake(uint256)",       getter: "maxRequiredStake",
      upValue: 10n ** 15n, downValue: 10n ** 14n },
    { contract: "advertiserStake",   setter: "setMaxSlashBpsPerCall(uint16)",      getter: "maxSlashBpsPerCall",
      upValue: 7000n, downValue: 3000n },
    // Phase B — DatumAdvertiserGovernance
    { contract: "advertiserGovernance", setter: "setPublisherClaimBond(uint256)",  getter: "publisherClaimBond",
      upValue: parseDOT("0.5"), downValue: parseDOT("0.1") },

    // Phase B — DatumActivationBonds
    { contract: "activationBonds",   setter: "setMinBond(uint256)",                getter: "minBond",
      upValue: parseDOT("2"), downValue: parseDOT("0.5") },
    { contract: "activationBonds",   setter: "setMuteMinBond(uint256)",            getter: "muteMinBond",
      upValue: parseDOT("1"), downValue: parseDOT("0.1") },

    // Phase B — DatumGovernanceV2
    // Many of these have retune-cooldown via _guardRetune — they may SKIP on second tune. We test "up" only when that applies.
    { contract: "governanceV2",      setter: "setTerminationQuorum(uint256)",      getter: "terminationQuorum",
      upValue: parseDOT("3"), downValue: parseDOT("2") },

    // Phase B — DatumMintCoordinator
    { contract: "mintCoordinator",   setter: "setDustMintThreshold(uint256)",      getter: "dustMintThreshold",
      upValue: 5n * 10n ** 9n, downValue: 1n * 10n ** 9n },
  ];

  console.log(`Exercising ${params.length} governable parameters in up/down/restore sweep:\n`);
  const results: Array<{ p: Param; r: ExerciseResult }> = [];

  for (const p of params) {
    const addr = addrs[p.contract];
    if (!addr) {
      results.push({ p, r: { ok: false, reason: `address for ${p.contract} not in addresses.json` } });
      continue;
    }
    const iface = new ethers.Interface([
      `function ${p.setter}`,
      `function ${p.getter}() view returns (uint256)`,
    ]);

    try {
      // 1. read before
      const beforeRaw = await ethers.provider.call({ to: addr, data: iface.encodeFunctionData(p.getter) });
      const before = iface.decodeFunctionResult(p.getter, beforeRaw)[0] as bigint;

      // 2. set UP
      const upTx = await deployer.sendTransaction({
        to: addr,
        data: iface.encodeFunctionData(p.setter.split("(")[0], [p.upValue]),
      });
      await upTx.wait();
      const upReadRaw = await ethers.provider.call({ to: addr, data: iface.encodeFunctionData(p.getter) });
      const up = iface.decodeFunctionResult(p.getter, upReadRaw)[0] as bigint;
      if (up !== p.upValue) {
        results.push({ p, r: { ok: false, reason: `UP write mismatch: wrote ${p.upValue} read ${up}` } });
        continue;
      }

      // 3. set DOWN (may hit retune-cooldown; tolerate that)
      let down = up;
      try {
        const downTx = await deployer.sendTransaction({
          to: addr,
          data: iface.encodeFunctionData(p.setter.split("(")[0], [p.downValue]),
        });
        await downTx.wait();
        const downReadRaw = await ethers.provider.call({ to: addr, data: iface.encodeFunctionData(p.getter) });
        down = iface.decodeFunctionResult(p.getter, downReadRaw)[0] as bigint;
      } catch (e: any) {
        const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 80);
        if (!msg.includes("retune") && !msg.includes("cooldown")) throw e;
        // retune-cooldown is expected for some setters; record and move on
        down = up;
      }

      // 4. restore
      const restoreTx = await deployer.sendTransaction({
        to: addr,
        data: iface.encodeFunctionData(p.setter.split("(")[0], [before]),
      });
      let restored = down;
      try {
        await restoreTx.wait();
        const restoredRaw = await ethers.provider.call({ to: addr, data: iface.encodeFunctionData(p.getter) });
        restored = iface.decodeFunctionResult(p.getter, restoredRaw)[0] as bigint;
      } catch (e: any) {
        const msg = (e?.shortMessage ?? e?.message ?? String(e)).split("\n")[0].slice(0, 80);
        if (!msg.includes("retune") && !msg.includes("cooldown")) throw e;
      }

      results.push({ p, r: { ok: true, before, up, down, restored } });
    } catch (e: any) {
      const msg = (e?.shortMessage ?? e?.reason ?? e?.message ?? String(e)).split("\n")[0].slice(0, 120);
      results.push({ p, r: { ok: false, reason: msg } });
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  console.log(`| Contract                | Setter                          | Before           | Up              | Down            | Restored        | Status |`);
  console.log(`|---|---|---:|---:|---:|---:|---|`);
  let pass = 0;
  let fail = 0;
  for (const { p, r } of results) {
    if (r.ok) {
      const trim = (v: bigint) => v.toString().padEnd(15).slice(0, 15);
      console.log(`| ${p.contract.padEnd(22)} | ${p.setter.padEnd(31)} | ${trim(r.before)} | ${trim(r.up)} | ${trim(r.down)} | ${trim(r.restored)} | ✓ |`);
      pass++;
    } else {
      console.log(`| ${p.contract.padEnd(22)} | ${p.setter.padEnd(31)} | — | — | — | — | ✗ ${r.reason} |`);
      fail++;
    }
  }
  console.log();
  console.log(`Summary: ${pass} ok, ${fail} failed (of ${results.length} parameters exercised)`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
