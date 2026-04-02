// Page taxonomy classification — matches pages to campaign categories.
// Multi-signal classifier: domain, title, meta description, meta keywords.
// Returns confidence scores per category (0.0 - 1.0).
// 26 top-level categories for ad classification.

export interface TaxonomyEntry {
  category: string;       // lowercase slug matching CATEGORY_ID_MAP key
  keywords: string[];
  domains: string[];
}

// Expanded taxonomy — 26 top-level categories + key subcategories
export const TAXONOMY: TaxonomyEntry[] = [
  // 1: Arts & Entertainment
  {
    category: "arts-entertainment",
    keywords: ["art", "entertainment", "celebrity", "movie", "film", "music", "theater", "concert", "album", "artist", "gallery", "exhibition", "performing arts", "comedy", "drama", "animation", "comics", "manga", "anime", "streaming", "tv show", "series", "festival"],
    domains: ["imdb.com", "rottentomatoes.com", "variety.com", "hollywoodreporter.com", "pitchfork.com", "rollingstone.com", "billboard.com", "deviantart.com", "artstation.com", "behance.net", "netflix.com", "hulu.com", "disneyplus.com", "spotify.com", "soundcloud.com", "bandcamp.com", "crunchyroll.com", "myanimelist.net"],
  },
  // 2: Autos & Vehicles
  {
    category: "autos-vehicles",
    keywords: ["car", "vehicle", "automotive", "motorcycle", "truck", "suv", "sedan", "electric vehicle", "ev", "hybrid", "auto parts", "car review", "test drive", "horsepower", "mpg", "dealership"],
    domains: ["caranddriver.com", "motortrend.com", "edmunds.com", "kbb.com", "autotrader.com", "jalopnik.com", "autoblog.com", "topgear.com"],
  },
  // 3: Beauty & Fitness
  {
    category: "beauty-fitness",
    keywords: ["beauty", "skincare", "makeup", "cosmetics", "fitness", "workout", "gym", "yoga", "pilates", "fashion", "style", "haircare", "grooming", "wellness", "bodybuilding", "exercise", "running", "marathon"],
    domains: ["allure.com", "sephora.com", "ulta.com", "vogue.com", "elle.com", "bodybuilding.com", "myfitnesspal.com", "nike.com", "lululemon.com", "menshealth.com", "womenshealthmag.com"],
  },
  // 4: Books & Literature
  {
    category: "books-literature",
    keywords: ["book", "novel", "author", "literature", "reading", "fiction", "nonfiction", "e-book", "kindle", "audiobook", "publisher", "literary", "bestseller", "book review", "poetry", "memoir"],
    domains: ["goodreads.com", "bookdepository.com", "amazon.com/books", "penguinrandomhouse.com", "harpercollins.com", "barnesandnoble.com", "librarything.com"],
  },
  // 5: Business & Industrial
  {
    category: "business-industrial",
    keywords: ["business", "enterprise", "corporate", "startup", "entrepreneur", "marketing", "advertising", "supply chain", "logistics", "manufacturing", "b2b", "management", "consulting", "industry", "commerce", "warehouse"],
    domains: ["hbr.org", "forbes.com", "inc.com", "entrepreneur.com", "fastcompany.com", "businessinsider.com", "mckinsey.com", "deloitte.com"],
  },
  // 6: Computers & Electronics
  {
    category: "computers-electronics",
    keywords: ["computer", "laptop", "desktop", "hardware", "software", "programming", "developer", "code", "open source", "linux", "ai", "machine learning", "cloud", "server", "cpu", "gpu", "smartphone", "tablet", "gadget", "tech", "electronics", "semiconductor", "api", "devops", "database"],
    domains: ["techcrunch.com", "arstechnica.com", "theverge.com", "wired.com", "github.com", "stackoverflow.com", "hackerNews.ycombinator.com", "tomshardware.com", "anandtech.com", "pcmag.com", "engadget.com", "dev.to", "medium.com", "towardsdatascience.com"],
  },
  // 7: Finance
  {
    category: "finance",
    keywords: ["stock", "investing", "portfolio", "market", "trading", "equity", "fund", "etf", "savings", "banking", "insurance", "mortgage", "credit", "loan", "interest rate", "financial", "forex", "bonds", "retirement", "401k", "ira", "fintech"],
    domains: ["bloomberg.com", "ft.com", "wsj.com", "reuters.com", "finance.yahoo.com", "marketwatch.com", "cnbc.com", "investopedia.com", "nerdwallet.com", "bankrate.com", "seekingalpha.com", "morningstar.com"],
  },
  // 8: Food & Drink
  {
    category: "food-drink",
    keywords: ["food", "recipe", "cooking", "restaurant", "cuisine", "chef", "baking", "meal", "ingredient", "wine", "beer", "cocktail", "coffee", "tea", "dining", "vegan", "vegetarian", "nutrition"],
    domains: ["allrecipes.com", "foodnetwork.com", "bonappetit.com", "epicurious.com", "seriouseats.com", "yelp.com", "eater.com", "food52.com", "delish.com"],
  },
  // 9: Games
  {
    category: "games",
    keywords: ["game", "gaming", "esports", "play", "steam", "console", "multiplayer", "rpg", "fps", "mmorpg", "board game", "card game", "indie game", "gameplay", "twitch", "streamer", "playstation", "xbox", "nintendo", "pc gaming"],
    domains: ["steampowered.com", "ign.com", "kotaku.com", "polygon.com", "twitch.tv", "gamespot.com", "pcgamer.com", "eurogamer.net", "rockpapershotgun.com", "boardgamegeek.com", "epicgames.com"],
  },
  // 10: Health
  {
    category: "health",
    keywords: ["health", "medical", "doctor", "hospital", "disease", "symptoms", "treatment", "medication", "mental health", "therapy", "psychology", "wellness", "diet", "nutrition", "vaccine", "clinical", "patient", "diagnosis", "pharmacy"],
    domains: ["webmd.com", "mayoclinic.org", "nih.gov", "healthline.com", "medlineplus.gov", "clevelandclinic.org", "who.int", "cdc.gov", "psychologytoday.com"],
  },
  // 11: Hobbies & Leisure
  {
    category: "hobbies-leisure",
    keywords: ["hobby", "craft", "diy", "woodworking", "knitting", "sewing", "model", "collecting", "photography", "painting", "outdoor", "camping", "hiking", "fishing", "hunting", "birdwatching", "gardening", "puzzle"],
    domains: ["instructables.com", "makezine.com", "craftsy.com", "alltrails.com", "rei.com", "flickr.com", "500px.com", "dpreview.com"],
  },
  // 12: Home & Garden
  {
    category: "home-garden",
    keywords: ["home", "house", "apartment", "furniture", "decor", "interior design", "renovation", "garden", "landscaping", "plumbing", "electrical", "kitchen", "bathroom", "diy home", "real estate", "property"],
    domains: ["houzz.com", "hgtv.com", "architecturaldigest.com", "bhg.com", "lowes.com", "homedepot.com", "ikea.com", "wayfair.com"],
  },
  // 13: Internet & Telecom
  {
    category: "internet-telecom",
    keywords: ["internet", "broadband", "wifi", "5g", "telecom", "isp", "vpn", "privacy", "security", "encryption", "web hosting", "domain", "cloud computing", "saas", "email", "messaging", "data protection", "cybersecurity", "firewall"],
    domains: ["cloudflare.com", "aws.amazon.com", "digitalocean.com", "privacyguides.org", "eff.org", "torproject.org", "proton.me", "letsencrypt.org", "speedtest.net"],
  },
  // 14: Jobs & Education
  {
    category: "jobs-education",
    keywords: ["job", "career", "hiring", "resume", "interview", "salary", "education", "university", "college", "school", "course", "tutorial", "learning", "degree", "certification", "scholarship", "training", "mooc", "online course"],
    domains: ["linkedin.com", "indeed.com", "glassdoor.com", "coursera.org", "udemy.com", "edx.org", "khanacademy.org", "mit.edu", "stanford.edu", "harvard.edu"],
  },
  // 15: Law & Government
  {
    category: "law-government",
    keywords: ["law", "legal", "court", "attorney", "lawyer", "government", "regulation", "policy", "legislation", "congress", "parliament", "military", "defense", "patent", "trademark", "compliance"],
    domains: ["supremecourt.gov", "congress.gov", "govtrack.us", "law.cornell.edu", "findlaw.com", "justia.com", "whitehouse.gov"],
  },
  // 16: News
  {
    category: "news",
    keywords: ["breaking news", "headline", "politics", "election", "world news", "local news", "journalism", "reporter", "editorial", "opinion", "current events", "investigation"],
    domains: ["bbc.com", "cnn.com", "theguardian.com", "nytimes.com", "apnews.com", "washingtonpost.com", "reuters.com", "aljazeera.com", "npr.org", "politico.com", "thehill.com"],
  },
  // 17: Online Communities
  {
    category: "online-communities",
    keywords: ["forum", "community", "social media", "blog", "discussion", "reddit", "thread", "post", "comment", "subreddit", "discord", "chat", "wiki", "fandom"],
    domains: ["reddit.com", "quora.com", "stackexchange.com", "discord.com", "fandom.com", "wikipedia.org", "medium.com", "substack.com", "tumblr.com"],
  },
  // 18: People & Society
  {
    category: "people-society",
    keywords: ["family", "relationship", "parenting", "children", "marriage", "divorce", "religion", "spirituality", "church", "charity", "nonprofit", "volunteer", "social issues", "equality", "diversity", "inclusion", "activism"],
    domains: ["parents.com", "babycenter.com", "care.com", "gofundme.com", "change.org", "redcross.org", "unicef.org"],
  },
  // 19: Pets & Animals
  {
    category: "pets-animals",
    keywords: ["pet", "dog", "cat", "puppy", "kitten", "animal", "veterinary", "vet", "breed", "adoption", "shelter", "wildlife", "aquarium", "bird", "reptile", "fish tank"],
    domains: ["akc.org", "petfinder.com", "chewy.com", "petsmart.com", "nationalgeographic.com/animals", "wwf.org"],
  },
  // 20: Real Estate
  {
    category: "real-estate",
    keywords: ["real estate", "property", "house for sale", "apartment for rent", "mortgage", "realtor", "listing", "condo", "commercial property", "land", "foreclosure", "housing market"],
    domains: ["zillow.com", "realtor.com", "redfin.com", "trulia.com", "apartments.com", "rightmove.co.uk"],
  },
  // 21: Reference
  {
    category: "reference",
    keywords: ["dictionary", "encyclopedia", "thesaurus", "reference", "definition", "translation", "how to", "tutorial", "guide", "manual", "documentation"],
    domains: ["wikipedia.org", "britannica.com", "merriam-webster.com", "dictionary.com", "wikihow.com"],
  },
  // 22: Science
  {
    category: "science",
    keywords: ["science", "research", "study", "physics", "biology", "chemistry", "paper", "academic", "journal", "peer review", "experiment", "theory", "mathematics", "astronomy", "geology", "ecology", "climate", "environment", "sustainability", "renewable energy", "carbon", "green energy"],
    domains: ["arxiv.org", "nature.com", "sciencedirect.com", "pnas.org", "science.org", "nasa.gov", "esa.int", "greenpeace.org", "carbonbrief.org", "climatecentral.org"],
  },
  // 23: Shopping
  {
    category: "shopping",
    keywords: ["shop", "buy", "sale", "discount", "coupon", "deal", "price", "product", "review", "ecommerce", "retail", "store", "marketplace", "shipping", "gift"],
    domains: ["amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com", "aliexpress.com", "shopify.com", "bestbuy.com"],
  },
  // 24: Sports
  {
    category: "sports",
    keywords: ["sport", "football", "basketball", "soccer", "baseball", "tennis", "golf", "cricket", "rugby", "hockey", "olympics", "athlete", "championship", "league", "tournament", "score", "team", "coach", "nba", "nfl", "mlb", "premier league", "mma", "boxing", "swimming", "surfing"],
    domains: ["espn.com", "sports.yahoo.com", "bleacherreport.com", "bbc.com/sport", "skysports.com", "nba.com", "nfl.com", "mlb.com", "uefa.com", "olympics.com"],
  },
  // 25: Travel
  {
    category: "travel",
    keywords: ["travel", "flight", "hotel", "vacation", "tourism", "destination", "booking", "trip", "airline", "cruise", "backpacking", "resort", "passport", "visa", "itinerary", "airbnb"],
    domains: ["tripadvisor.com", "booking.com", "expedia.com", "airbnb.com", "skyscanner.com", "kayak.com", "lonelyplanet.com", "hotels.com"],
  },
  // 26: Crypto & Web3
  {
    category: "crypto-web3",
    keywords: ["bitcoin", "ethereum", "blockchain", "defi", "nft", "polkadot", "web3", "crypto", "cryptocurrency", "wallet", "dao", "token", "smart contract", "dapp", "staking", "yield", "airdrop", "substrate", "parachain", "bridge", "layer 2", "rollup", "zk proof", "solidity"],
    domains: ["coindesk.com", "cointelegraph.com", "decrypt.co", "theblock.co", "polkadot.network", "ethereum.org", "defillama.com", "coingecko.com", "coinmarketcap.com", "dune.com", "subscan.io", "polkadot.js.org"],
  },
];

/** Map taxonomy slug → tag string (replaces CATEGORY_ID_MAP for new flow) */
export const SLUG_TO_TAG: Record<string, string> = {
  "arts-entertainment": "topic:arts-entertainment",
  "autos-vehicles": "topic:autos-vehicles",
  "beauty-fitness": "topic:beauty-fitness",
  "books-literature": "topic:books-literature",
  "business-industrial": "topic:business-industrial",
  "computers-electronics": "topic:computers-electronics",
  "finance": "topic:finance",
  "food-drink": "topic:food-drink",
  "games": "topic:gaming",
  "health": "topic:health",
  "hobbies-leisure": "topic:hobbies-leisure",
  "home-garden": "topic:home-garden",
  "internet-telecom": "topic:internet-telecom",
  "jobs-education": "topic:jobs-education",
  "law-government": "topic:law-government",
  "news": "topic:news",
  "online-communities": "topic:online-communities",
  "people-society": "topic:people-society",
  "pets-animals": "topic:pets-animals",
  "real-estate": "topic:real-estate",
  "reference": "topic:reference",
  "science": "topic:science",
  "shopping": "topic:shopping",
  "sports": "topic:sports",
  "travel": "topic:travel",
  "crypto-web3": "topic:crypto-web3",
};

/**
 * Classify the current page into tag strings — multi-category.
 * Returns an array of tag strings for all categories above confidence threshold 0.3.
 * E.g., ["topic:crypto-web3", "topic:defi"]
 */
export function classifyPageToTags(
  title: string,
  hostname: string,
  metaDescription?: string,
  metaKeywords?: string,
): string[] {
  const scores = classifyPageMulti(title, hostname, metaDescription, metaKeywords);
  const tags: string[] = [];
  for (const [slug, confidence] of Object.entries(scores)) {
    if (confidence >= 0.3) {
      const tag = SLUG_TO_TAG[slug];
      if (tag) tags.push(tag);
    }
  }
  return tags;
}

/** @deprecated Use classifyPageToTags. Reverse map: taxonomy category slug → on-chain categoryId */
export const CATEGORY_ID_MAP: Record<string, number> = {
  "arts-entertainment": 1,
  "autos-vehicles": 2,
  "beauty-fitness": 3,
  "books-literature": 4,
  "business-industrial": 5,
  "computers-electronics": 6,
  "finance": 7,
  "food-drink": 8,
  "games": 9,
  "health": 10,
  "hobbies-leisure": 11,
  "home-garden": 12,
  "internet-telecom": 13,
  "jobs-education": 14,
  "law-government": 15,
  "news": 16,
  "online-communities": 17,
  "people-society": 18,
  "pets-animals": 19,
  "real-estate": 20,
  "reference": 21,
  "science": 22,
  "shopping": 23,
  "sports": 24,
  "travel": 25,
  "crypto-web3": 26,
  // Legacy aliases for backward compatibility with existing interest profiles
  "crypto": 26,
  "technology": 6,
  "gaming": 9,
  "privacy": 13,
  "open-source": 6,
  "environment": 22,
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
 * Returns the highest-confidence category slug, or null if no match.
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
