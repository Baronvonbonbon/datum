// Page taxonomy classification — matches pages to campaign categories.
// Multi-signal classifier: domain, title, meta description, meta keywords.
// Returns confidence scores per category (0.0 - 1.0).

export interface TaxonomyEntry {
  category: string;
  keywords: string[];
  domains: string[];
}

// MVP taxonomy — ~10 categories matching PoC spec
export const TAXONOMY: TaxonomyEntry[] = [
  {
    category: "crypto",
    keywords: ["bitcoin", "ethereum", "blockchain", "defi", "nft", "polkadot", "web3", "crypto", "wallet", "dao"],
    domains: ["coindesk.com", "cointelegraph.com", "decrypt.co", "theblock.co", "polkadot.network"],
  },
  {
    category: "finance",
    keywords: ["stock", "investing", "portfolio", "market", "trading", "equity", "fund", "etf", "savings"],
    domains: ["bloomberg.com", "ft.com", "wsj.com", "reuters.com", "finance.yahoo.com"],
  },
  {
    category: "technology",
    keywords: ["software", "developer", "programming", "open source", "linux", "ai", "machine learning", "cloud"],
    domains: ["techcrunch.com", "ycombinator.com", "github.com", "stackoverflow.com", "hacker-news.firebaseapp.com"],
  },
  {
    category: "gaming",
    keywords: ["game", "esports", "gaming", "play", "steam", "console", "multiplayer"],
    domains: ["steam.com", "ign.com", "kotaku.com", "polygon.com", "twitch.tv"],
  },
  {
    category: "news",
    keywords: ["breaking news", "headline", "politics", "election", "government", "economy"],
    domains: ["bbc.com", "cnn.com", "theguardian.com", "nytimes.com", "apnews.com"],
  },
  {
    category: "privacy",
    keywords: ["privacy", "vpn", "security", "encryption", "surveillance", "data protection"],
    domains: ["privacyguides.org", "eff.org", "torproject.org", "proton.me"],
  },
  {
    category: "open-source",
    keywords: ["open source", "free software", "linux", "gnu", "contributor", "pull request"],
    domains: ["github.com", "gitlab.com", "sourceforge.net", "debian.org"],
  },
  {
    category: "science",
    keywords: ["research", "study", "science", "physics", "biology", "chemistry", "paper", "academic"],
    domains: ["arxiv.org", "nature.com", "sciencedirect.com", "scholar.google.com"],
  },
  {
    category: "environment",
    keywords: ["climate", "sustainability", "renewable energy", "carbon", "green", "environment"],
    domains: ["greenpeace.org", "carbonbrief.org", "climatecentral.org"],
  },
  {
    category: "health",
    keywords: ["health", "fitness", "nutrition", "medical", "wellness", "exercise", "diet"],
    domains: ["webmd.com", "mayoclinic.org", "nih.gov", "healthline.com"],
  },
];

// Reverse map: taxonomy category name → on-chain categoryId
export const CATEGORY_ID_MAP: Record<string, number> = {
  crypto: 1,
  finance: 2,
  technology: 3,
  gaming: 4,
  news: 5,
  privacy: 6,
  "open-source": 7,
  science: 8,
  environment: 9,
  health: 10,
};

/** Confidence scores per category */
export type ClassificationResult = Record<string, number>;

/**
 * Classify the current page against the taxonomy using multiple signals.
 * Returns a map of category → confidence (0.0 - 1.0) for all matches above 0.3.
 */
export function classifyPageMulti(
  title: string,
  hostname: string,
  metaDescription?: string,
  metaKeywords?: string
): ClassificationResult {
  const titleLower = title.toLowerCase();
  const hostLower = hostname.toLowerCase();
  const descLower = (metaDescription ?? "").toLowerCase();
  const kwLower = (metaKeywords ?? "").toLowerCase();

  const result: ClassificationResult = {};

  for (const entry of TAXONOMY) {
    let confidence = 0;

    // Signal 1: Domain match (0.9 confidence) — suffix check for safety
    if (entry.domains.some((d) => hostLower === d || hostLower.endsWith("." + d))) {
      confidence = Math.max(confidence, 0.9);
    }

    // Signal 2: Title keyword match (0.6 per hit, capped at 0.8)
    let titleHits = 0;
    for (const kw of entry.keywords) {
      if (titleLower.includes(kw)) titleHits++;
    }
    if (titleHits > 0) {
      confidence = Math.max(confidence, Math.min(0.6 + (titleHits - 1) * 0.1, 0.8));
    }

    // Signal 3: Meta description keywords (0.4 per hit, capped at 0.6)
    if (descLower) {
      let descHits = 0;
      for (const kw of entry.keywords) {
        if (descLower.includes(kw)) descHits++;
      }
      if (descHits > 0) {
        confidence = Math.max(confidence, Math.min(0.4 + (descHits - 1) * 0.1, 0.6));
      }
    }

    // Signal 4: Meta keywords tag (0.5 per match)
    if (kwLower) {
      for (const kw of entry.keywords) {
        if (kwLower.includes(kw)) {
          confidence = Math.max(confidence, 0.5);
          break;
        }
      }
    }

    if (confidence >= 0.3) {
      result[entry.category] = Math.round(confidence * 100) / 100;
    }
  }

  return result;
}

/**
 * Classify the current page — backward-compatible single-category return.
 * Returns the highest-confidence category name, or null if no match.
 */
export function classifyPage(title: string, hostname: string): string | null {
  // In content script context, try to read meta tags
  let metaDescription: string | undefined;
  let metaKeywords: string | undefined;
  if (typeof document !== "undefined") {
    metaDescription =
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;
    metaKeywords =
      document.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? undefined;
  }

  const scores = classifyPageMulti(title, hostname, metaDescription, metaKeywords);
  const entries = Object.entries(scores);
  if (entries.length === 0) return null;

  // Return highest-confidence category
  entries.sort(([, a], [, b]) => b - a);
  return entries[0][0];
}
