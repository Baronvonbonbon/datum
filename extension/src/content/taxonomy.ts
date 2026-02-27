// Page taxonomy classification — matches pages to campaign categories.
// MVP: hardcoded categories with keyword/domain matching.

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
    domains: ["bloomberg.com", "ft.com", "wsj.com", "reuters.com", "yahoo.com/finance"],
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

/**
 * Classify the current page against the taxonomy.
 * Returns the matched category name, or null if no match.
 */
export function classifyPage(title: string, hostname: string): string | null {
  const titleLower = title.toLowerCase();
  const hostLower = hostname.toLowerCase();

  for (const entry of TAXONOMY) {
    // Domain match (highest confidence)
    if (entry.domains.some((d) => hostLower.includes(d))) {
      return entry.category;
    }
    // Keyword match in page title
    if (entry.keywords.some((kw) => titleLower.includes(kw))) {
      return entry.category;
    }
  }
  return null;
}
