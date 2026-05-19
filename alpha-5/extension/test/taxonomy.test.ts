import "./chromeMock";
import { classifyPageMulti, CATEGORY_ID_MAP } from "../src/content/taxonomy";

describe("classifyPageMulti", () => {
  test("domain match gives high confidence", () => {
    const result = classifyPageMulti("Some Page", "github.com");
    expect(result["computers-electronics"]).toBeGreaterThanOrEqual(0.9);
  });

  test("subdomain match works", () => {
    const result = classifyPageMulti("A Post", "sub.github.com");
    expect(result["computers-electronics"]).toBeGreaterThanOrEqual(0.9);
  });

  test("keyword match in title", () => {
    const result = classifyPageMulti("Bitcoin Price Surges Today", "randomsite.com");
    expect(result["crypto-web3"]).toBeGreaterThanOrEqual(0.6);
  });

  test("multiple keyword hits increase confidence", () => {
    const single = classifyPageMulti("bitcoin news", "randomsite.com");
    const multi = classifyPageMulti("bitcoin ethereum defi blockchain", "randomsite.com");
    expect(multi["crypto-web3"]).toBeGreaterThan(single["crypto-web3"]!);
  });

  test("meta description adds signal", () => {
    const result = classifyPageMulti("Untitled Page", "randomsite.com", "Learn about yoga and fitness workouts");
    expect(result["beauty-fitness"]).toBeDefined();
  });

  test("meta keywords add signal", () => {
    const result = classifyPageMulti("My Blog", "randomsite.com", undefined, "cooking, recipe, food");
    expect(result["food-drink"]).toBeDefined();
  });

  test("no match returns empty", () => {
    const result = classifyPageMulti("xyzzy foobar baz", "unknowndomain12345.tld");
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("low confidence below 0.3 filtered out", () => {
    const result = classifyPageMulti("xyzzy", "randomsite.com", "just one mention of stock");
    // Even with one keyword hit in description (0.4), it should show
    // but with very tangential content it may not reach 0.3
    for (const score of Object.values(result)) {
      expect(score).toBeGreaterThanOrEqual(0.3);
    }
  });

  test("multiple categories can match", () => {
    const result = classifyPageMulti(
      "Bitcoin Investment Portfolio Trading",
      "randomsite.com"
    );
    // Should match both crypto-web3 and finance
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(2);
  });
});

describe("CATEGORY_ID_MAP", () => {
  test("all 26 main categories mapped", () => {
    const mainCategories = [
      "arts-entertainment", "autos-vehicles", "beauty-fitness", "books-literature",
      "business-industrial", "computers-electronics", "finance", "food-drink",
      "games", "health", "hobbies-leisure", "home-garden", "internet-telecom",
      "jobs-education", "law-government", "news", "online-communities",
      "people-society", "pets-animals", "real-estate", "reference",
      "science", "shopping", "sports", "travel", "crypto-web3",
    ];
    for (const cat of mainCategories) {
      expect(CATEGORY_ID_MAP[cat]).toBeDefined();
      expect(CATEGORY_ID_MAP[cat]).toBeGreaterThanOrEqual(1);
      expect(CATEGORY_ID_MAP[cat]).toBeLessThanOrEqual(26);
    }
  });

  test("legacy aliases exist", () => {
    expect(CATEGORY_ID_MAP["crypto"]).toBe(26);
    expect(CATEGORY_ID_MAP["technology"]).toBe(6);
    expect(CATEGORY_ID_MAP["gaming"]).toBe(9);
  });

  test("IDs are unique among main categories", () => {
    const mainIds = new Set<number>();
    for (let i = 1; i <= 26; i++) {
      const cat = Object.entries(CATEGORY_ID_MAP).find(([, id]) => id === i);
      expect(cat).toBeDefined();
      mainIds.add(i);
    }
    expect(mainIds.size).toBe(26);
  });
});
