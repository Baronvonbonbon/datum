import "./chromeMock";
import { auctionForPage, CampaignCandidate, AuctionResult } from "../src/background/auction";
import { UserInterestProfile } from "../src/background/interestProfile";
import { tagHash } from "../src/shared/tagDictionary";

function candidate(id: string, bidCpmPlanck: string, categoryId = 0): CampaignCandidate {
  return { id, bidCpmPlanck, categoryId, publisher: "0x" + "11".repeat(20) };
}

const flatProfile: UserInterestProfile = {
  visits: [],
  weights: {},
  visitCounts: {},
};

const cryptoProfile: UserInterestProfile = {
  visits: [],
  weights: { "topic:crypto-web3": 1.0, "topic:finance": 0.5 },
  visitCounts: {},
};

describe("auctionForPage", () => {
  test("empty candidates returns null", () => {
    expect(auctionForPage([], {}, flatProfile)).toBeNull();
  });

  test("solo campaign: 70% of bid", () => {
    const result = auctionForPage(
      [candidate("1", "1000000000")],
      {},
      flatProfile,
    )!;
    expect(result.mechanism).toBe("solo");
    expect(result.winner.id).toBe("1");
    expect(result.clearingCpmPlanck).toBe(700000000n); // 70%
    expect(result.participants).toBe(1);
  });

  test("solo campaign minimum clearing is 1", () => {
    const result = auctionForPage(
      [candidate("1", "1")], // 1 planck CPM — 70% rounds to 0
      {},
      flatProfile,
    )!;
    expect(result.clearingCpmPlanck).toBe(1n);
  });

  test("two campaigns: second-price — higher bid wins", () => {
    const result = auctionForPage(
      [candidate("high", "2000000000"), candidate("low", "1000000000")],
      {},
      flatProfile,
    )!;
    expect(result.winner.id).toBe("high");
    expect(result.participants).toBe(2);
  });

  test("two campaigns: clearing CPM clamped to floor (30%)", () => {
    // high=1000, low=1. With flat profile (interest=0.1 default):
    // effectiveBid_high = 1000*100 = 100000, effectiveBid_low = 1*100 = 100
    // clearingRaw = 100 / 100 = 1. Floor = 1000 * 30% = 300.
    // clearingCpm = floor = 300
    const result = auctionForPage(
      [candidate("high", "1000"), candidate("low", "1")],
      {},
      flatProfile,
    )!;
    expect(result.mechanism).toBe("floor");
    expect(result.clearingCpmPlanck).toBe(300n); // 30% of 1000
  });

  test("interest profile affects effective bid and winner", () => {
    // Campaign A: topic:crypto-web3, bid=100
    // Campaign B: topic:finance, bid=150
    // With cryptoProfile: crypto weight=1.0, finance weight=0.5
    // effectiveA = 100 * 1000 = 100000
    // effectiveB = 150 * 500 = 75000
    // Winner = A (despite lower raw bid)
    const candA: CampaignCandidate = {
      ...candidate("A", "100", 26),
      requiredTags: [tagHash("topic:crypto-web3")],
    };
    const candB: CampaignCandidate = {
      ...candidate("B", "150", 7),
      requiredTags: [tagHash("topic:finance")],
    };
    const result = auctionForPage([candA, candB], {}, cryptoProfile)!;
    expect(result.winner.id).toBe("A");
  });

  test("three campaigns: winner uses second-price", () => {
    const result = auctionForPage(
      [
        candidate("top", "3000000000"),
        candidate("mid", "2000000000"),
        candidate("low", "1000000000"),
      ],
      {},
      flatProfile,
    )!;
    expect(result.winner.id).toBe("top");
    expect(result.participants).toBe(3);
    expect(result.mechanism).toBe("second-price");
  });
});
