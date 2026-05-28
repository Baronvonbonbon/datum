import "./chromeMock";
import { auctionForPage, CampaignCandidate, AuctionResult } from "../src/background/auction";
import { UserInterestProfile } from "../src/background/interestProfile";
import { tagHash } from "../src/shared/tagDictionary";

function candidate(id: string, viewBid: string, categoryId = 0): CampaignCandidate {
  return { id, viewBid, categoryId, publisher: "0x" + "11".repeat(20) };
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

  test("solo campaign: 85% of bid", () => {
    const result = auctionForPage(
      [candidate("1", "1000000000")],
      {},
      flatProfile,
    )!;
    expect(result.mechanism).toBe("solo");
    expect(result.winner.id).toBe("1");
    expect(result.clearingCpmPlanck).toBe(850000000n); // 85%
    expect(result.participants).toBe(1);
    expect(result.bidEfficiency).toBeCloseTo(0.85);
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

  test("two campaigns: clearing CPM clamped to floor (65%)", () => {
    // high=1000, low=1. With flat profile (interest=0.1 default):
    // effectiveBid_high = 1000*100 = 100000, effectiveBid_low = 1*100 = 100
    // clearingRaw = 100 / 100 = 1. Floor = 1000 * 65% = 650.
    // clearingCpm = floor = 650
    const result = auctionForPage(
      [candidate("high", "1000"), candidate("low", "1")],
      {},
      flatProfile,
    )!;
    expect(result.mechanism).toBe("floor");
    expect(result.clearingCpmPlanck).toBe(650n); // 65% of 1000
    expect(result.bidEfficiency).toBeCloseTo(0.65);
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

  // AUC-IPFS: Campaigns sourced from IPFS metadata (via campaignPoller) carry
  // requiredTags derived from the IPFS JSON payload.  The auction must honour them.
  describe("AUC-IPFS: IPFS-sourced tag campaigns in auction", () => {
    // Simulate a campaign whose requiredTags were fetched from IPFS metadata
    // (the poller stores them in chrome.storage; content script reads and passes as candidates)
    test("AUC-IPFS-1: IPFS-sourced campaign with matching tags wins over tagless equal-bid campaign", () => {
      // Campaign A: discovered via IPFS metadata, has topic:crypto-web3 tag
      // Campaign B: plain on-chain campaign, no tags
      // Both bid the same. User has strong crypto interest — A should win on effective bid.
      const ipfsCampaign: CampaignCandidate = {
        id: "ipfs-campaign",
        viewBid: "1000000000",
        categoryId: 0,
        publisher: "0x" + "aa".repeat(20),
        requiredTags: [tagHash("topic:crypto-web3")], // from IPFS JSON metadata
      };
      const plainCampaign: CampaignCandidate = {
        id: "plain-campaign",
        viewBid: "1000000000",
        categoryId: 0,
        publisher: "0x" + "bb".repeat(20),
        // no requiredTags — falls back to page tags
      };

      // Page has no crypto tags — tagless campaign gets low fallback weight
      const result = auctionForPage(
        [ipfsCampaign, plainCampaign],
        {},
        cryptoProfile,
        ["topic:defi"], // page topic — doesn't match plain campaign well
      )!;

      expect(result).not.toBeNull();
      expect(result.winner.id).toBe("ipfs-campaign");
    });

    test("AUC-IPFS-2: IPFS campaign with non-matching tags loses to untagged higher-interest campaign", () => {
      // Campaign A: IPFS-sourced, requires topic:gaming (user has no gaming interest)
      // Campaign B: plain, no required tags (gets page-based interest weight)
      const gamingCampaign: CampaignCandidate = {
        id: "gaming",
        viewBid: "2000000000", // higher bid
        categoryId: 0,
        publisher: "0x" + "aa".repeat(20),
        requiredTags: [tagHash("topic:gaming")],
      };
      const cryptoCampaign: CampaignCandidate = {
        id: "crypto",
        viewBid: "1000000000",
        categoryId: 0,
        publisher: "0x" + "bb".repeat(20),
        requiredTags: [tagHash("topic:crypto-web3")],
      };

      // User has 1.0 crypto weight, zero gaming weight
      const result = auctionForPage(
        [gamingCampaign, cryptoCampaign],
        {},
        cryptoProfile,
        ["topic:crypto-web3"],
      )!;

      // effectiveBid_gaming  = 2000000000 * 0 (weight 0 → excluded or near-zero)
      // effectiveBid_crypto  = 1000000000 * 1.0 * 1000 = 1e12
      // Crypto wins despite lower raw bid
      expect(result.winner.id).toBe("crypto");
    });

    test("AUC-IPFS-3: IPFS campaign competes with ERC-20 sidecar campaign — auction is bid-agnostic to token type", () => {
      // The auction doesn't know about ERC-20 sidecars — it only sees CPM bids.
      // A campaign with an ERC-20 sidecar (higher DOT CPM as it offers extra incentive)
      // should win on effective bid alone.
      const ercCampaign: CampaignCandidate = {
        id: "erc20-sidecar",
        viewBid: "3000000000", // premium DOT CPM to attract publisher
        categoryId: 0,
        publisher: "0x" + "cc".repeat(20),
        requiredTags: [tagHash("topic:crypto-web3")],
        // In production this candidate would also carry rewardToken + rewardPerImpression
        // from the poller, but the auction only uses viewBid for ordering.
      };
      const ipfsCampaign: CampaignCandidate = {
        id: "ipfs-only",
        viewBid: "1000000000",
        categoryId: 0,
        publisher: "0x" + "dd".repeat(20),
        requiredTags: [tagHash("topic:crypto-web3")],
      };

      const result = auctionForPage(
        [ercCampaign, ipfsCampaign],
        {},
        cryptoProfile,
        ["topic:crypto-web3"],
      )!;

      expect(result.winner.id).toBe("erc20-sidecar");
      // Clearing CPM = second effective bid / winner interest weight (clamped to floor)
      // Both have weight 1.0 (crypto match). Clearing = 1000000000 * 1.0 / 1.0 = 1000000000.
      // Floor = 3000000000 * 65% = 1950000000. Clearing < floor → floor mechanism.
      expect(result.mechanism).toBe("floor");
      expect(result.clearingCpmPlanck).toBe(1950000000n);
    });
  });
});
