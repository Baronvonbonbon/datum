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

  test("solo campaign: pays its own CPM (rounded clean)", () => {
    const result = auctionForPage(
      [candidate("1", "1000000000")],
      {},
      flatProfile,
    )!;
    expect(result.mechanism).toBe("cpm");
    expect(result.winner.id).toBe("1");
    expect(result.clearingCpmPlanck).toBe(1000000000n); // below the 2e9 grid → unchanged
    expect(result.participants).toBe(1);
    expect(result.bidEfficiency).toBeCloseTo(1);
  });

  test("tiny CPM below the rounding grid is left unchanged", () => {
    const result = auctionForPage(
      [candidate("1", "1")], // 1 planck CPM — below the 2e9 grid, can't round down
      {},
      flatProfile,
    )!;
    expect(result.clearingCpmPlanck).toBe(1n);
  });

  test("dirty CPM rounds DOWN to a denomination-clean multiple of 2e9", () => {
    // 3161144617 (the kind of arbitrary CPM that hit Paseo's %1e6 payout revert)
    // floors to the 2e9 grid → 2000000000, which keeps the settlement payout clean.
    const result = auctionForPage([candidate("1", "3161144617")], {}, flatProfile)!;
    expect(result.clearingCpmPlanck).toBe(2000000000n);
    expect(result.clearingCpmPlanck % 2000000000n).toBe(0n);
  });

  test("two campaigns: higher effective bid wins", () => {
    const result = auctionForPage(
      [candidate("high", "2000000000"), candidate("low", "1000000000")],
      {},
      flatProfile,
    )!;
    expect(result.winner.id).toBe("high");
    expect(result.participants).toBe(2);
  });

  test("two campaigns: winner pays its own CPM (no second-price clamp)", () => {
    // high=1000, low=1. Winner = high (higher effective bid); it pays its OWN CPM
    // (1000), below the 2e9 grid so unchanged. No floor/second-price clamp anymore.
    const result = auctionForPage(
      [candidate("high", "1000"), candidate("low", "1")],
      {},
      flatProfile,
    )!;
    expect(result.mechanism).toBe("cpm");
    expect(result.winner.id).toBe("high");
    expect(result.clearingCpmPlanck).toBe(1000n);
    expect(result.bidEfficiency).toBeCloseTo(1);
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

  test("three campaigns: highest effective bid wins, pays own CPM (rounded)", () => {
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
    expect(result.mechanism).toBe("cpm");
    expect(result.clearingCpmPlanck).toBe(2000000000n); // 3e9 floored to the 2e9 grid
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
      // Winner pays its own CPM (3e9), floored to the 2e9 denomination grid → 2e9.
      expect(result.mechanism).toBe("cpm");
      expect(result.clearingCpmPlanck).toBe(2000000000n);
    });
  });
});
