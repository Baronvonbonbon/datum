import "./chromeMock";
import { isCampaignAllowed } from "../src/background/userPreferences";
import { UserPreferences, CATEGORY_NAMES } from "@shared/types";

function defaultPrefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    blockedCampaigns: [],
    silencedCategories: [],
    maxAdsPerHour: 12,
    maxAdsPerCampaignPerHour: 3,
    minBidCpm: "0",
    ...overrides,
  };
}

describe("isCampaignAllowed", () => {
  test("allows campaign with default preferences", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 26, bidCpmPlanck: "1000000000" },
        defaultPrefs(),
        CATEGORY_NAMES,
      )
    ).toBe(true);
  });

  test("blocks campaign by ID", () => {
    expect(
      isCampaignAllowed(
        { id: "42", categoryId: 0, bidCpmPlanck: "1000" },
        defaultPrefs({ blockedCampaigns: ["42"] }),
        CATEGORY_NAMES,
      )
    ).toBe(false);
  });

  test("blocks campaign by silenced category", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 9, bidCpmPlanck: "1000" }, // 9 = Games
        defaultPrefs({ silencedCategories: ["Games"] }),
        CATEGORY_NAMES,
      )
    ).toBe(false);
  });

  test("allows campaign in non-silenced category", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 26, bidCpmPlanck: "1000" }, // 26 = Crypto & Web3
        defaultPrefs({ silencedCategories: ["Games"] }),
        CATEGORY_NAMES,
      )
    ).toBe(true);
  });

  test("blocks campaign below min bid CPM", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 0, bidCpmPlanck: "500" },
        defaultPrefs({ minBidCpm: "1000" }),
        CATEGORY_NAMES,
      )
    ).toBe(false);
  });

  test("allows campaign at or above min bid CPM", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 0, bidCpmPlanck: "1000" },
        defaultPrefs({ minBidCpm: "1000" }),
        CATEGORY_NAMES,
      )
    ).toBe(true);
  });

  test("minBidCpm of '0' allows any bid", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 0, bidCpmPlanck: "1" },
        defaultPrefs({ minBidCpm: "0" }),
        CATEGORY_NAMES,
      )
    ).toBe(true);
  });

  test("uncategorized campaign (0) is allowed even with silenced categories", () => {
    expect(
      isCampaignAllowed(
        { id: "1", categoryId: 0, bidCpmPlanck: "1000" },
        defaultPrefs({ silencedCategories: ["Games", "Finance"] }),
        CATEGORY_NAMES,
      )
    ).toBe(true);
  });

  test("campaign with missing fields still works", () => {
    expect(
      isCampaignAllowed({}, defaultPrefs(), CATEGORY_NAMES)
    ).toBe(true);
  });
});
