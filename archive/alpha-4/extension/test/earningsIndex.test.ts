import "./chromeMock";
import { Contract, Interface } from "ethers";
import settlementAbi from "../src/shared/abis/DatumSettlement.json";
import {
  applyEvent,
  decodeClaimSettled,
  emptyIndex,
  topCampaigns,
  RECENT_BUFFER_SIZE,
} from "../src/shared/earningsIndex";

const iface = new Interface(settlementAbi.abi);

function fakeLog(opts: {
  campaignId: bigint;
  user: string;
  publisher: string;
  eventCount: bigint;
  ratePlanck: bigint;
  actionType: number;
  nonce: bigint;
  publisherPayment: bigint;
  userPayment: bigint;
  protocolFee: bigint;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}) {
  // ABI-encode the unindexed args; pack indexed ones as topics.
  const fragment = iface.getEvent("ClaimSettled");
  if (!fragment) throw new Error("ClaimSettled not in ABI");
  const indexed = fragment.inputs.filter((i) => i.indexed);
  const unindexed = fragment.inputs.filter((i) => !i.indexed);

  const argsByName: Record<string, any> = {
    campaignId: opts.campaignId,
    user: opts.user,
    publisher: opts.publisher,
    eventCount: opts.eventCount,
    ratePlanck: opts.ratePlanck,
    actionType: opts.actionType,
    nonce: opts.nonce,
    publisherPayment: opts.publisherPayment,
    userPayment: opts.userPayment,
    protocolFee: opts.protocolFee,
  };

  // Pack indexed args as topics. uint256 → padded hex; address → padded hex.
  const indexedTopics = indexed.map((i) => {
    const v = argsByName[i.name];
    if (i.type === "address") {
      return "0x" + (v as string).slice(2).toLowerCase().padStart(64, "0");
    }
    if (i.type.startsWith("uint")) {
      return "0x" + (v as bigint).toString(16).padStart(64, "0");
    }
    throw new Error(`unsupported indexed type ${i.type}`);
  });
  const topics = [fragment.topicHash, ...indexedTopics];

  const data = iface
    .getAbiCoder()
    .encode(unindexed.map((i) => i.type), unindexed.map((i) => argsByName[i.name]));

  return {
    topics,
    data,
    blockNumber: opts.blockNumber,
    transactionHash: opts.txHash,
    index: opts.logIndex,
  } as any;
}

const USER = "0x" + "aa".repeat(20);
const PUBLISHER = "0x" + "bb".repeat(20);
const PUBLISHER2 = "0x" + "cc".repeat(20);

describe("earningsIndex", () => {
  it("decodeClaimSettled parses topics + data correctly", () => {
    const log = fakeLog({
      campaignId: 42n,
      user: USER,
      publisher: PUBLISHER,
      eventCount: 1000n,
      ratePlanck: 100n,
      actionType: 0,
      nonce: 1n,
      publisherPayment: 50_000n,
      userPayment: 37_500n,
      protocolFee: 12_500n,
      blockNumber: 1000,
      txHash: "0x" + "11".repeat(32),
      logIndex: 0,
    });
    const decoded = decodeClaimSettled(log, iface);
    expect(decoded).not.toBeNull();
    expect(decoded!.campaignId).toBe(42n);
    expect(decoded!.userPayment).toBe(37_500n);
    expect(decoded!.actionType).toBe(0);
  });

  it("applyEvent dedupes on (txHash, logIndex)", () => {
    const idx = emptyIndex();
    const ev = {
      campaignId: 1n,
      user: USER,
      publisher: PUBLISHER,
      eventCount: 100n,
      ratePlanck: 10n,
      actionType: 0,
      nonce: 1n,
      publisherPayment: 0n,
      userPayment: 1000n,
      protocolFee: 0n,
      blockNumber: 100,
      txHash: "0xdead",
      logIndex: 0,
    };
    const r1 = applyEvent(idx, ev);
    expect(r1.applied).toBe(true);
    const r2 = applyEvent(idx, ev);
    expect(r2.applied).toBe(false);
    expect(idx.byCampaign["1"].claimCount).toBe(1);
  });

  it("applyEvent accumulates totals across multiple settles", () => {
    const idx = emptyIndex();
    for (let i = 0; i < 3; i++) {
      applyEvent(idx, {
        campaignId: 7n,
        user: USER,
        publisher: PUBLISHER,
        eventCount: 100n,
        ratePlanck: 10n,
        actionType: 0,
        nonce: BigInt(i + 1),
        publisherPayment: 0n,
        userPayment: 1_000n,
        protocolFee: 0n,
        blockNumber: 100 + i,
        txHash: "0x" + "ab".repeat(32) + i,
        logIndex: i,
      });
    }
    expect(idx.byCampaign["7"].claimCount).toBe(3);
    expect(idx.byCampaign["7"].totalUserPlanck).toBe("3000");
    expect(idx.byCampaign["7"].totalEvents).toBe("300");
    expect(idx.byCampaign["7"].lastBlock).toBe(102);
    expect(idx.recent.length).toBe(3);
  });

  it("recent ring buffer caps at RECENT_BUFFER_SIZE", () => {
    const idx = emptyIndex();
    const total = RECENT_BUFFER_SIZE + 5;
    for (let i = 0; i < total; i++) {
      applyEvent(idx, {
        campaignId: BigInt(i),
        user: USER,
        publisher: PUBLISHER,
        eventCount: 1n,
        ratePlanck: 1n,
        actionType: 0,
        nonce: 1n,
        publisherPayment: 0n,
        userPayment: 1n,
        protocolFee: 0n,
        blockNumber: i,
        txHash: "0x" + i.toString(16).padStart(64, "0"),
        logIndex: 0,
      });
    }
    expect(idx.recent.length).toBe(RECENT_BUFFER_SIZE);
    // Newest at index 0 (unshift)
    expect(idx.recent[0].campaignId).toBe(String(total - 1));
  });

  it("zero-payment claims update totals but skip the recent ring", () => {
    const idx = emptyIndex();
    applyEvent(idx, {
      campaignId: 9n,
      user: USER,
      publisher: PUBLISHER,
      eventCount: 100n,
      ratePlanck: 0n,
      actionType: 0,
      nonce: 1n,
      publisherPayment: 0n,
      userPayment: 0n, // zero
      protocolFee: 0n,
      blockNumber: 1,
      txHash: "0x" + "00".repeat(32),
      logIndex: 0,
    });
    expect(idx.byCampaign["9"].claimCount).toBe(1);
    expect(idx.recent.length).toBe(0);
  });

  it("topCampaigns sorts by totalUserPlanck descending by default", () => {
    const idx = emptyIndex();
    const campaigns: Array<[bigint, bigint]> = [
      [1n, 100n],
      [2n, 500n],
      [3n, 300n],
    ];
    let logCounter = 0;
    for (const [cid, payment] of campaigns) {
      applyEvent(idx, {
        campaignId: cid,
        user: USER,
        publisher: PUBLISHER,
        eventCount: 1n,
        ratePlanck: payment,
        actionType: 0,
        nonce: 1n,
        publisherPayment: 0n,
        userPayment: payment,
        protocolFee: 0n,
        blockNumber: 1,
        txHash: "0x" + (logCounter++).toString(16).padStart(64, "0"),
        logIndex: 0,
      });
    }
    const top = topCampaigns(idx);
    expect(top.map((t) => t.campaignId)).toEqual(["2", "3", "1"]);
  });

  it("topCampaigns supports alternate sort keys", () => {
    const idx = emptyIndex();
    // c1 = 1 claim, 1000 events, latest block 100
    applyEvent(idx, {
      campaignId: 1n, user: USER, publisher: PUBLISHER,
      eventCount: 1000n, ratePlanck: 1n, actionType: 0, nonce: 1n,
      publisherPayment: 0n, userPayment: 1n, protocolFee: 0n,
      blockNumber: 100, txHash: "0x" + "01".repeat(32), logIndex: 0,
    });
    // c2 = 5 claims, 50 events each = 250 events, latest block 200
    for (let i = 0; i < 5; i++) {
      applyEvent(idx, {
        campaignId: 2n, user: USER, publisher: PUBLISHER,
        eventCount: 50n, ratePlanck: 1n, actionType: 0, nonce: BigInt(i + 1),
        publisherPayment: 0n, userPayment: 1n, protocolFee: 0n,
        blockNumber: 200 + i, txHash: "0x" + (i + 100).toString(16).padStart(64, "0"), logIndex: 0,
      });
    }
    // c2 has 5 claims (1000) → claimCount = 5 vs c1 = 1
    expect(topCampaigns(idx, "claimCount").map((t) => t.campaignId)).toEqual(["2", "1"]);
    // c1 has 1000 events vs c2 = 250 → c1 wins on totalEvents
    expect(topCampaigns(idx, "totalEvents").map((t) => t.campaignId)).toEqual(["1", "2"]);
    // c2's last block (204) > c1's (100) → c2 wins on lastBlock
    expect(topCampaigns(idx, "lastBlock").map((t) => t.campaignId)).toEqual(["2", "1"]);
  });
});
