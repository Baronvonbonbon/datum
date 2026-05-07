import "./chromeMock";
import { isCampaignAllowed } from "../src/background/userPreferences";
import { UserPreferences } from "@shared/types";
import { tagHash } from "../src/shared/tagDictionary";

function defaultPrefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    blockedCampaigns: [],
    silencedCategories: [],
    blockedTags: [],
    maxAdsPerHour: 12,
    minBidCpm: "0",
    filterMode: "all",
    allowedTopics: [],
    sweepAddress: "",
    sweepThresholdPlanck: "0",
    ...overrides,
  };
}

const cryptoHash = tagHash("topic:crypto-web3");
const gamesHash  = tagHash("topic:gaming");

describe("isCampaignAllowed", () => {
  test("allows campaign with default preferences", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000000000", requiredTags: [cryptoHash] },
        defaultPrefs(),
      )
    ).toBe(true);
  });

  test("blocks campaign by ID", () => {
    expect(
      isCampaignAllowed(
        { id: "42", viewBid: "1000" },
        defaultPrefs({ blockedCampaigns: ["42"] }),
      )
    ).toBe(false);
  });

  test("blocks campaign by blocked tag", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000", requiredTags: [gamesHash] },
        defaultPrefs({ blockedTags: ["topic:gaming"] }),
      )
    ).toBe(false);
  });

  test("allows campaign whose tags are not blocked", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000", requiredTags: [cryptoHash] },
        defaultPrefs({ blockedTags: ["topic:gaming"] }),
      )
    ).toBe(true);
  });

  test("blocks campaign below min bid CPM", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "500" },
        defaultPrefs({ minBidCpm: "1000" }),
      )
    ).toBe(false);
  });

  test("allows campaign at or above min bid CPM", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000" },
        defaultPrefs({ minBidCpm: "1000" }),
      )
    ).toBe(true);
  });

  test("minBidCpm of '0' allows any bid", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1" },
        defaultPrefs({ minBidCpm: "0" }),
      )
    ).toBe(true);
  });

  test("open campaign (no requiredTags) is allowed even with blocked tags", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000" },
        defaultPrefs({ blockedTags: ["topic:gaming", "topic:finance"] }),
      )
    ).toBe(true);
  });

  test("filterMode=selected blocks campaign without allowed topic", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000", requiredTags: [gamesHash] },
        defaultPrefs({ filterMode: "selected", allowedTopics: ["topic:crypto-web3"] }),
      )
    ).toBe(false);
  });

  test("filterMode=selected allows campaign with matching topic", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000", requiredTags: [cryptoHash] },
        defaultPrefs({ filterMode: "selected", allowedTopics: ["topic:crypto-web3"] }),
      )
    ).toBe(true);
  });

  test("filterMode=selected: open campaign (no requiredTags) always passes", () => {
    expect(
      isCampaignAllowed(
        { id: "1", viewBid: "1000" },
        defaultPrefs({ filterMode: "selected", allowedTopics: ["topic:crypto-web3"] }),
      )
    ).toBe(true);
  });

  test("campaign with missing fields still works", () => {
    expect(
      isCampaignAllowed({}, defaultPrefs())
    ).toBe(true);
  });
});
