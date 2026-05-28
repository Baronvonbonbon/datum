// Tests for claimBuilder.ts — verifies claim hashing, nonce sequencing,
// chain state persistence, and queue management.

import "./chromeMock";
import { resetStore, seedStore, getStore } from "./chromeMock";
import { claimBuilder } from "../src/background/claimBuilder";

const CAMPAIGN_ID = "42";
const USER = "0x94CC36412EE0c099BfE7D61a35092e40342F62D7";
const PUBLISHER = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
const BID_CPM = "5000000000"; // 0.5 DOT

function makeMsg(overrides = {}) {
  return {
    campaignId: CAMPAIGN_ID,
    url: "https://example.com",
    category: "tech",
    publisherAddress: PUBLISHER,
    ...overrides,
  };
}

beforeEach(() => {
  resetStore();
  seedStore({
    connectedAddress: USER,
    activeCampaigns: [{ id: CAMPAIGN_ID, viewBid: BID_CPM }],
  });
});

describe("claimBuilder.onImpression", () => {
  test("creates a claim and appends it to the queue", async () => {
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    const queue = store.claimQueue ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0].campaignId).toBe(CAMPAIGN_ID);
    expect(queue[0].userAddress).toBe(USER);
    expect(queue[0].publisher).toBe(PUBLISHER);
    expect(queue[0].nonce).toBe("1");
  });

  test("uses blake2 hash — 0x-prefixed 32-byte hex", async () => {
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    const claim = store.claimQueue[0];
    expect(claim.claimHash.startsWith("0x")).toBe(true);
    expect(claim.claimHash.length).toBe(66);
  });

  test("increments nonce for subsequent impressions", async () => {
    await claimBuilder.onImpression(makeMsg());
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    const queue = store.claimQueue ?? [];
    expect(queue).toHaveLength(2);
    expect(queue[0].nonce).toBe("1");
    expect(queue[1].nonce).toBe("2");
  });

  test("second claim's previousClaimHash equals first claim's claimHash", async () => {
    await claimBuilder.onImpression(makeMsg());
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    const queue = store.claimQueue;
    expect(queue[1].previousClaimHash).toBe(queue[0].claimHash);
  });

  test("uses clearingCpmPlanck from message if provided", async () => {
    await claimBuilder.onImpression(makeMsg({ clearingCpmPlanck: "3000000000" }));
    const store = getStore();
    expect(store.claimQueue[0].ratePlanck).toBe("3000000000");
  });

  test("falls back to viewBid if clearingCpmPlanck not provided", async () => {
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    expect(store.claimQueue[0].ratePlanck).toBe(BID_CPM);
  });

  test("drops impression if no connectedAddress", async () => {
    resetStore();
    seedStore({
      activeCampaigns: [{ id: CAMPAIGN_ID, viewBid: BID_CPM }],
    });
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    expect((store.claimQueue ?? []).length).toBe(0);
  });

  test("drops impression if campaign not in activeCampaigns", async () => {
    resetStore();
    seedStore({ connectedAddress: USER, activeCampaigns: [] });
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    expect((store.claimQueue ?? []).length).toBe(0);
  });
});

describe("claimBuilder.syncFromChain", () => {
  test("updates chain state and clears queue for that campaign", async () => {
    await claimBuilder.onImpression(makeMsg());
    const onChainHash = "0xdeadbeef" + "0".repeat(56);
    await claimBuilder.syncFromChain(USER, CAMPAIGN_ID, 5, onChainHash);

    const store = getStore();
    // Chain state is keyed by actionType (0 for view claims)
    const stateKey = `chainState:${USER}:${CAMPAIGN_ID}:0`;
    expect(store[stateKey].lastNonce).toBe(5);
    expect(store[stateKey].lastClaimHash).toBe(onChainHash);
    // Queue should be cleared for this campaign
    const queue: any[] = store.claimQueue ?? [];
    const remaining = queue.filter((c: any) => c.campaignId === CAMPAIGN_ID && c.userAddress === USER);
    expect(remaining).toHaveLength(0);
  });

  test("next claim after sync uses onChainNonce + 1", async () => {
    const onChainHash = "0xdeadbeef" + "0".repeat(56);
    await claimBuilder.syncFromChain(USER, CAMPAIGN_ID, 3, onChainHash);
    await claimBuilder.onImpression(makeMsg());
    const store = getStore();
    expect(store.claimQueue[0].nonce).toBe("4");
    expect(store.claimQueue[0].previousClaimHash).toBe(onChainHash);
  });
});
