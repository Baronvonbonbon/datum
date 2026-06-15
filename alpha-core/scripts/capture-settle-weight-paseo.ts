/**
 * capture-settle-weight-paseo.ts
 * Fresh, correctly-SLIM-formatted settleClaims on live Paseo to capture the
 * real pallet-revive weight. Unlike benchmark-paseo.ts (stale flat claim →
 * every settle rejects), this builds the current nested-proof claim:
 *   Claim = { publisher, eventCount, rateWei, actionType, proof: ClaimProof[] }
 * Flow: create budgeted campaign (alice/advertiser, diana/publisher) →
 * adminActivateCampaign → disable PoW → self-settle as bob → verify lastNonce
 * advanced (proves the claim actually settled) → capture weight.
 *
 * Run: npx hardhat run scripts/capture-settle-weight-paseo.ts --network polkadotTestnet
 */
import { JsonRpcProvider, Wallet, Interface, ZeroHash, ZeroAddress, keccak256, AbiCoder } from "ethers";
import fs from "fs";
import path from "path";

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const A = (() => { const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")); return j.addresses || j; })();
const TX = { gasLimit: 500_000_000n as bigint };

const PROOF_T = "(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)";
const CLAIM_T = `(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,${PROOF_T}[] proof)`;

const settleIface = new Interface([
  `function settleClaims((address user,uint256 campaignId,${CLAIM_T}[] claims)[] batches) returns (uint256 settledCount,uint256 rejectedCount,uint256 totalPaid)`,
  "function lastNonce(address user,uint256 campaignId,uint8 actionType) view returns (uint256)",
  "function maxBatchSize() view returns (uint256)",
  "event ClaimRejected(uint256 indexed campaignId,address indexed user,uint256 nonce,uint8 reasonCode)",
]);
// reason-code → meaning (from DatumSettlementLogicB ClaimRejected emits)
const REASON: Record<number, string> = {
  16: "ZK proof empty/invalid", 18: "min-claim-interval (BM-10)", 20: "reputation canSettle=false",
  26: "ZK assurance required", 27: "below-CPM-floor / user-paused", 28: "user-blocks-advertiser",
  30: "identity/assurance gate", 11: "zero value",
};
const campIface = new Interface([
  "function createCampaign(address publisher,(uint8 actionType,uint256 budgetWei,uint256 dailyCapWei,uint256 rateWei,address actionVerifier)[] pots,bytes32[] requiredTags,bool requireZkProof,address rewardToken,uint256 rewardPerImpression,uint256 bondAmount) payable returns (uint256)",
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignForSettlement(uint256) view returns (uint8 status,address publisher,uint16 snapshotTakeRateBps)",
]);
const adminIface = new Interface(["function adminActivateCampaign(uint256 campaignId)"]);
const ledgerIface = new Interface(["function getRemainingBudget(uint256) view returns (uint256)"]);
const pubIface = new Interface(["function getPublisher(address) view returns (bool,uint16)", "function registerPublisher(uint16 takeRateBps)"]);
const powIface = new Interface(["function enforcePow() view returns (bool)", "function setEnforcePow(bool)", "function powTargetForUser(address user,uint256 eventCount) view returns (uint256)"]);

// 10-field claim-hash preimage, matching DatumClaimValidator (abi.encode, derived nonce/prevHash).
function claimHash(cid: bigint, pub: string, user: string, events: bigint, rate: bigint, nonce: bigint, prevHash: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
    [cid, pub, user, events, rate, 0, ZeroHash, nonce, prevHash, ZeroHash]));
}
function minePow(hash: string, target: bigint): string {
  const buf = new Uint8Array(64); buf.set(Buffer.from(hash.slice(2), "hex"), 0);
  const view = new DataView(buf.buffer);
  for (let n = 0n; n < 50_000_000n; n++) {
    view.setBigUint64(56, n);
    if (BigInt(keccak256(buf)) <= target) return "0x" + n.toString(16).padStart(64, "0");
  }
  throw new Error("PoW miner exhausted");
}
const mkProof = (powNonce: string) => [{ clickSessionHash: ZeroHash, stakeRootUsed: ZeroHash, nullifier: ZeroHash, powNonce, zkProof: new Array(8).fill(ZeroHash), actionSig: new Array(3).fill(ZeroHash) }];

const RATE = 10n ** 15n;    // 0.001 DOT = current live minimumCpmFloor (createCampaign reverts E27 below it)
const BUDGET = 10n ** 19n;  // 10 DOT budget AND dailyCap — big enough that 16 claims never hit the E26 daily cap
const EVENTS = 100n;

async function read(p: JsonRpcProvider, to: string, iface: Interface, m: string, args: any[]): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try { return iface.decodeFunctionResult(m, await p.call({ to, data: iface.encodeFunctionData(m, args) })); }
    catch (e: any) {
      const transient = /coalesce|1010|Invalid Transaction|timeout|503|502|ECONNRESET|fetch/i.test(String(e?.shortMessage ?? e?.message ?? e));
      if (!transient || attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
async function send(w: Wallet, p: JsonRpcProvider, to: string, iface: Interface, m: string, args: any[], value = 0n): Promise<string> {
  const data = iface.encodeFunctionData(m, args);
  // Retry transient Paseo gateway errors ("could not coalesce" / code 1010 Invalid Transaction).
  for (let attempt = 0; attempt < 4; attempt++) {
    const nonce = await p.getTransactionCount(w.address);
    try {
      const tx = await w.sendTransaction({ to, data, value, ...TX });
      for (let i = 0; i < 120; i++) { if (await p.getTransactionCount(w.address) > nonce) return tx.hash; await new Promise(r => setTimeout(r, 1000)); }
      throw new Error(`timeout: ${m}`);
    } catch (e: any) {
      const msg = String(e?.shortMessage ?? e?.message ?? e);
      const transient = /coalesce|1010|Invalid Transaction|timeout|503|502|ECONNRESET|fetch/i.test(msg);
      if (!transient || attempt === 3) throw e;
      console.log(`    retry ${m} (attempt ${attempt + 1}): ${msg.slice(0, 60)}`);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  throw new Error(`send failed: ${m}`);
}
const slimClaim = () => ({ publisher: "", eventCount: EVENTS, rateWei: RATE, actionType: 0, proof: [] as any[] });

async function main() {
  const p = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const alice = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, p);
  const diana = new Wallet(process.env.DIANA_PRIVATE_KEY!, p);
  const bob = new Wallet(process.env.BOB_PRIVATE_KEY!, p);
  console.log(`alice=${alice.address}\ndiana(publisher)=${diana.address}\nbob(user)=${bob.address}`);
  console.log(`balances: alice=${(await p.getBalance(alice.address))/10n**16n}/100 bob=${(await p.getBalance(bob.address))/10n**16n}/100 PAS`);

  // Ensure Diana is a registered publisher.
  const [reg] = await read(p, A.publishers, pubIface, "getPublisher", [diana.address]);
  console.log(`diana registered: ${reg}`);
  if (!reg) { console.log("registering diana..."); await send(diana, p, A.publishers, pubIface, "registerPublisher", [5000]); }

  // Publisher stake gate (settle reject reason 15): diana must be adequately staked.
  const stakeIface = new Interface([
    "function requiredStake(address) view returns (uint256)",
    "function isAdequatelyStaked(address) view returns (bool)",
    "function stake() payable",
  ]);
  const [adequate] = await read(p, A.publisherStake, stakeIface, "isAdequatelyStaked", [diana.address]);
  console.log(`diana adequately staked: ${adequate}`);
  if (!adequate) {
    const [req] = await read(p, A.publisherStake, stakeIface, "requiredStake", [diana.address]);
    const amt = BigInt(req) + 5n * 10n ** 18n; // required + 5 DOT headroom (covers bonding-curve growth across n=1+5+10 settles)
    await send(diana, p, A.publisherStake, stakeIface, "stake", [], amt);
    console.log(`diana staked ${amt} wei (required ${req})`);
  }

  // Disable PoW for the duration if we can (alice = deployer). Post-redeploy
  // ownership moves to the Timelock, so this may fail — then we mine a powNonce
  // per claim instead. `powEnforced` drives that fallback in measureSettle.
  let powWas = false;
  try { [powWas] = await read(p, A.powEngine, powIface, "enforcePow", []); } catch {}
  console.log(`enforcePow was: ${powWas}`);
  if (powWas) { try { await send(alice, p, A.powEngine, powIface, "setEnforcePow", [false]); console.log("PoW disabled"); } catch (e) { console.log("could not disable PoW (will mine powNonce):", String(e).slice(0, 80)); } }
  let powEnforced = false;
  try { [powEnforced] = await read(p, A.powEngine, powIface, "enforcePow", []); } catch {}
  console.log(`enforcePow now: ${powEnforced}${powEnforced ? " — mining powNonce per claim" : ""}`);

  // Each batch size gets its OWN fresh campaign so bob's per-(user,campaign)
  // lastSettlementBlock starts at 0 — otherwise the BM-10 min-claim-interval
  // cooldown (reason 18) rejects a second settle on the same campaign in-window.
  // Settler is the SEEDED account `bob` (has the identity/assurance state fresh
  // EOAs lack, so the settle doesn't fail-closed). 10 DOT budget+dailyCap >> any n.
  const pots = [{ actionType: 0, budgetWei: BUDGET, dailyCapWei: BUDGET, rateWei: RATE, actionVerifier: ZeroAddress }];
  async function measureSettle(n: number): Promise<{ gas: bigint; settled: boolean }> {
    await send(alice, p, A.campaigns, campIface, "createCampaign", [diana.address, pots, [], false, ZeroAddress, 0n, 0n], BUDGET);
    const cid = (await read(p, A.campaigns, campIface, "nextCampaignId", []))[0] - 1n;
    await send(alice, p, A.governanceRouter, adminIface, "adminActivateCampaign", [cid]);
    // Build the n-claim chain. If PoW is enforced (couldn't disable post-ownership-transfer),
    // mine a powNonce per claim against the derived hash (fresh campaign ⇒ nonce starts at 1).
    let powTarget = (1n << 256n) - 1n;
    if (powEnforced) { try { powTarget = (await read(p, A.powEngine, powIface, "powTargetForUser", [bob.address, EVENTS]))[0]; } catch {} }
    const claims: any[] = []; let prev = ZeroHash;
    for (let i = 1; i <= n; i++) {
      const h = claimHash(cid, diana.address, bob.address, EVENTS, RATE, BigInt(i), prev);
      const powNonce = powEnforced ? minePow(h, powTarget) : ZeroHash;
      claims.push({ publisher: diana.address, eventCount: EVENTS, rateWei: RATE, actionType: 0, proof: powEnforced ? mkProof(powNonce) : [] });
      prev = h;
    }
    const batch = [{ user: bob.address, campaignId: cid, claims }];
    let est = 0n;
    try { est = await p.estimateGas({ from: bob.address, to: A.settlement, data: settleIface.encodeFunctionData("settleClaims", [batch]) }); } catch {}
    const before = (await read(p, A.settlement, settleIface, "lastNonce", [bob.address, cid, 0]))[0];
    const h = await send(bob, p, A.settlement, settleIface, "settleClaims", [batch]);
    const after = (await read(p, A.settlement, settleIface, "lastNonce", [bob.address, cid, 0]))[0];
    const settled = after - before;
    let gas = 0n, reasons = "";
    try {
      const r = await p.getTransactionReceipt(h);
      if (r) {
        gas = r.gasUsed;
        const codes = new Set<number>();
        for (const log of r.logs) { try { const pl = settleIface.parseLog(log as any); if (pl?.name === "ClaimRejected") codes.add(Number(pl.args.reasonCode)); } catch {} }
        if (codes.size) reasons = `  rejectReason=[${[...codes].map(c => `${c}:${REASON[c] ?? "?"}`).join("; ")}]`;
      }
    } catch {}
    if (gas === 0n) gas = est; // fall back to estimate if receipt is null (Paseo bug)
    console.log(`  n=${String(n).padStart(2)}  settled=${settled}/${n}  weight(real)=${gas}  estimate=${est}  ${settled === BigInt(n) ? "✅" : "⚠️"}  tx=${h}${reasons}`);
    return { gas, settled: settled === BigInt(n) };
  }

  const out: Array<{ n: number; gas: bigint }> = [];
  try {
    console.log("\nReal settles by seeded account bob on the fresh campaign:");
    for (const n of [1, 5, 10]) {
      try { const { gas, settled } = await measureSettle(n); if (settled) out.push({ n, gas }); }
      catch (e) { console.log(`  n=${n} failed: ${String((e as any)?.shortMessage ?? (e as any)?.message ?? e).slice(0, 80)}`); }
    }
    if (out.length >= 2) {
      const a0 = out[0], aN = out[out.length - 1];
      const b = Number(aN.gas - a0.gas) / (aN.n - a0.n);
      const a = Number(a0.gas) - b * a0.n;
      console.log(`\nPaseo settle weight fit: weight(n) ≈ ${Math.round(a).toLocaleString()} + ${Math.round(b).toLocaleString()}·n`);
      console.log(`Per-claim marginal ≈ ${Math.round(b)} weight (${(b / 1e6).toFixed(6)} PAS); 1-claim = ${out[0].gas} weight (${(Number(out[0].gas) / 1e6).toFixed(6)} PAS).`);
    }
  } finally {
    if (powWas) { try { await send(alice, p, A.powEngine, powIface, "setEnforcePow", [true]); console.log("\nPoW re-enabled"); } catch {} }
  }
}
main().catch((e) => { console.error(String(e?.shortMessage ?? e?.message ?? e).slice(0, 400)); process.exit(1); });
