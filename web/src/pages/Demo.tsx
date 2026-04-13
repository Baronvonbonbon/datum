import { useEffect, useRef, useState, useCallback } from "react";
import { ExtensionApplet } from "../components/ExtensionApplet";
import { runContentBridge, BridgeStatus, AuctionBid } from "../lib/contentBridge";
import { getRelaySignerAddress, getCampaignCount, repollCampaigns, getDebugInfo, setClaimBuilderMode, getInterestProfile, updateInterestProfile, DaemonDebugInfo } from "../lib/extensionDaemon";
import { BouncingText } from "../components/TransactionStatus";
import {
  _emit,
  installConsoleCapture,
  subscribeDaemonLog,
  clearDaemonLog,
  LogEntry,
} from "../lib/daemonLog";
import { setShimMessageLogger } from "../lib/chromeShim";

// Install console capture + message logger as early as possible (before daemon starts)
installConsoleCapture();
setShimMessageLogger((dir, type, detail) => {
  _emit(dir === "out" ? "msg-out" : "msg-in", `${dir === "out" ? "→" : "←"} ${type}${detail ? "  " + detail : ""}`);
});

const RELAY_URL = "https://relay.javcon.io";
const DEFAULT_PUBLISHER = "0xcA5668fB864Acab0aC7f4CFa73949174720b58D0";
const PUBLISHER_TAGS = "topic:crypto-web3,topic:defi,topic:computers-electronics,locale:en";


interface BrowseTopic {
  slug: string; label: string; iab: string; section: string; keywords: string;
}

const BROWSE_TOPICS: BrowseTopic[] = [
  // Crypto & Finance
  { slug: "crypto-web3",          label: "Crypto & Web3",          iab: "IAB13", section: "Cryptocurrency",         keywords: "bitcoin, ethereum, blockchain, web3, crypto, token, wallet" },
  { slug: "defi",                 label: "DeFi",                   iab: "IAB13", section: "Decentralised Finance",  keywords: "defi, yield farming, liquidity, amm, protocol, staking, swap" },
  { slug: "nft",                  label: "NFT & Digital Art",      iab: "IAB13", section: "NFT Marketplace",        keywords: "nft, digital art, opensea, mint, collection, generative art" },
  { slug: "polkadot",             label: "Polkadot",               iab: "IAB19", section: "Polkadot Ecosystem",     keywords: "polkadot, substrate, parachain, dot, kusama, relay chain" },
  { slug: "dao-governance",       label: "DAOs & Governance",      iab: "IAB13", section: "DAO Governance",         keywords: "dao, on-chain voting, proposal, treasury, governance token" },
  { slug: "finance",              label: "Personal Finance",       iab: "IAB13", section: "Personal Finance",       keywords: "investing, portfolio, ETF, savings, budgeting, interest rates" },
  { slug: "stock-market",         label: "Stocks & Trading",       iab: "IAB13", section: "Stock Market",           keywords: "stock, equity, trading, S&P 500, nasdaq, earnings, dividend" },
  { slug: "real-estate",          label: "Real Estate",            iab: "IAB21", section: "Real Estate",            keywords: "housing market, mortgage, property, home buying, rental, zillow" },
  // Technology
  { slug: "computers-electronics",label: "Computers & Hardware",   iab: "IAB19", section: "Technology",            keywords: "laptop, cpu, gpu, hardware, developer, open source, linux, api" },
  { slug: "ai-ml",                label: "AI & Machine Learning",  iab: "IAB19", section: "Artificial Intelligence",keywords: "AI, machine learning, LLM, neural network, model training, GPT" },
  { slug: "cybersecurity",        label: "Cybersecurity",          iab: "IAB19", section: "Cybersecurity",          keywords: "security, vulnerability, malware, threat, zero-day, pentesting" },
  { slug: "open-source",          label: "Open Source & Dev",      iab: "IAB19", section: "Open Source Software",   keywords: "github, open source, linux kernel, rust, go, typescript, devops" },
  { slug: "internet-telecom",     label: "Privacy & Internet",     iab: "IAB19", section: "Privacy & Security",    keywords: "vpn, encryption, privacy, data protection, tor, surveillance" },
  { slug: "cloud-saas",           label: "Cloud & SaaS",           iab: "IAB19", section: "Cloud Computing",        keywords: "AWS, cloud, saas, kubernetes, docker, microservices, serverless" },
  { slug: "mobile-apps",          label: "Mobile & Apps",          iab: "IAB19", section: "Mobile Apps",            keywords: "iOS, android, app store, react native, flutter, mobile dev" },
  { slug: "layer2-zk",            label: "ZK & Layer 2",           iab: "IAB19", section: "Layer 2 & ZK Proofs",   keywords: "rollup, zk proof, optimism, arbitrum, validity proof, zkEVM" },
  // Entertainment & Media
  { slug: "arts-entertainment",   label: "Arts & Entertainment",   iab: "IAB1",  section: "Entertainment",         keywords: "movie, film, tv show, streaming, celebrity, award, box office" },
  { slug: "music",                label: "Music",                  iab: "IAB1",  section: "Music",                  keywords: "album, artist, concert, playlist, lyrics, genre, music video" },
  { slug: "streaming-video",      label: "Streaming & Film",       iab: "IAB1",  section: "Streaming Video",        keywords: "netflix, hulu, disney+, series, episode, documentary, film review" },
  { slug: "anime-manga",          label: "Anime & Manga",          iab: "IAB1",  section: "Anime & Manga",          keywords: "anime, manga, crunchyroll, shonen, isekai, light novel, studio ghibli" },
  { slug: "gaming",               label: "Video Games",            iab: "IAB9",  section: "Gaming",                 keywords: "video games, steam, playstation, xbox, rpg, fps, indie game" },
  { slug: "esports",              label: "Esports",                iab: "IAB9",  section: "Esports & Streaming",    keywords: "esports, twitch, league of legends, tournament, pro player, streamer" },
  { slug: "books-literature",     label: "Books & Literature",     iab: "IAB9",  section: "Books & Reading",        keywords: "novel, author, fiction, nonfiction, kindle, audiobook, book review" },
  // News & Society
  { slug: "news",                 label: "World News",             iab: "IAB12", section: "World News",             keywords: "breaking news, headline, journalism, reporter, current events" },
  { slug: "politics",             label: "Politics & Policy",      iab: "IAB11", section: "Politics",               keywords: "election, congress, legislation, party, democracy, policy, vote" },
  { slug: "law-government",       label: "Law & Government",       iab: "IAB11", section: "Law & Regulation",       keywords: "law, regulation, court, attorney, compliance, patent, legal" },
  { slug: "people-society",       label: "Society & Culture",      iab: "IAB14", section: "Society & Culture",      keywords: "culture, diversity, equality, activism, social issues, community" },
  { slug: "online-communities",   label: "Forums & Communities",   iab: "IAB14", section: "Online Communities",     keywords: "reddit, forum, discord, community, thread, wiki, discussion" },
  // Health & Science
  { slug: "health",               label: "Health & Medicine",      iab: "IAB7",  section: "Health & Medicine",      keywords: "doctor, hospital, disease, treatment, symptoms, clinical, patient" },
  { slug: "mental-health",        label: "Mental Health",          iab: "IAB7",  section: "Mental Health",          keywords: "anxiety, depression, therapy, mindfulness, psychology, wellbeing" },
  { slug: "fitness",              label: "Fitness & Training",     iab: "IAB18", section: "Fitness",                keywords: "workout, gym, running, marathon, strength training, nutrition plan" },
  { slug: "science",              label: "Science & Research",     iab: "IAB15", section: "Science",                keywords: "research, physics, biology, chemistry, academic, peer review, study" },
  { slug: "climate-environment",  label: "Climate & Environment",  iab: "IAB15", section: "Climate & Environment",  keywords: "climate change, carbon, renewable energy, sustainability, green energy" },
  { slug: "space-astronomy",      label: "Space & Astronomy",      iab: "IAB15", section: "Space & Astronomy",      keywords: "nasa, rocket, exoplanet, telescope, mars, orbit, space exploration" },
  // Sports & Leisure
  { slug: "sports",               label: "Sports",                 iab: "IAB17", section: "Sports",                 keywords: "football, basketball, soccer, tennis, nba, nfl, premier league, olympics" },
  { slug: "outdoor-adventure",    label: "Outdoor & Adventure",    iab: "IAB9",  section: "Outdoor Activities",     keywords: "hiking, camping, climbing, backpacking, trail, national park, kayak" },
  { slug: "hobbies-leisure",      label: "Hobbies & DIY",          iab: "IAB9",  section: "Hobbies",                keywords: "diy, woodworking, craft, photography, model building, collecting" },
  { slug: "travel",               label: "Travel",                 iab: "IAB20", section: "Travel",                 keywords: "hotel, flight, vacation, tourism, destination, itinerary, airbnb" },
  { slug: "food-drink",           label: "Food & Drink",           iab: "IAB8",  section: "Food & Cooking",         keywords: "recipe, restaurant, cooking, chef, cuisine, wine, coffee, dining" },
  // Life & Home
  { slug: "beauty-style",         label: "Beauty & Style",         iab: "IAB18", section: "Beauty & Fashion",       keywords: "skincare, makeup, fashion, style, cosmetics, trend, beauty routine" },
  { slug: "home-garden",          label: "Home & Garden",          iab: "IAB10", section: "Home & Garden",          keywords: "interior design, furniture, renovation, garden, landscaping, decor" },
  { slug: "autos-vehicles",       label: "Cars & Vehicles",        iab: "IAB2",  section: "Automotive",             keywords: "car review, electric vehicle, EV, test drive, horsepower, dealership" },
  { slug: "pets-animals",         label: "Pets & Animals",         iab: "IAB16", section: "Pets & Animals",         keywords: "dog, cat, puppy, pet care, vet, wildlife, adoption, animal shelter" },
  // Business & Commerce
  { slug: "business-industrial",  label: "Business & Enterprise",  iab: "IAB3",  section: "Business",              keywords: "enterprise, corporate, supply chain, logistics, b2b, management" },
  { slug: "startups",             label: "Startups & VC",          iab: "IAB3",  section: "Startups & Venture",     keywords: "startup, venture capital, seed round, founder, pitch, Y Combinator" },
  { slug: "marketing-ads",        label: "Marketing & Ads",        iab: "IAB3",  section: "Marketing & Advertising",keywords: "SEO, content marketing, PPC, growth hacking, brand, campaign" },
  { slug: "jobs-education",       label: "Jobs & Education",       iab: "IAB5",  section: "Education & Careers",    keywords: "job, career, resume, salary, university, course, certification, mooc" },
  { slug: "shopping",             label: "Shopping & Deals",       iab: "IAB22", section: "Shopping",               keywords: "deals, sale, discount, coupon, product review, ecommerce, amazon" },
  { slug: "reference",            label: "Reference & Guides",     iab: "IAB15", section: "Reference",              keywords: "tutorial, how-to, guide, documentation, wiki, definition, explainer" },
];

interface RelayStatus { online: boolean; uptime?: number }
interface SdkStatus { ready: boolean; version?: string; publisher?: string; tags?: string[] }
interface HandshakeStatus { done: boolean; sig?: string }

export function Demo() {
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [sdk, setSdk] = useState<SdkStatus>({ ready: false });
  const [handshake, setHandshake] = useState<HandshakeStatus>({ done: false });
  const [publisherAddress, setPublisherAddress] = useState(DEFAULT_PUBLISHER);
  const [publisherInput, setPublisherInput] = useState(DEFAULT_PUBLISHER);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ step: "idle" });
  const [daemonReady, setDaemonReady] = useState(false);
  const sdkScriptRef = useRef<HTMLScriptElement | null>(null);
  const [relaySignerAddress, setRelaySignerAddress] = useState<string>("");
  const [sdkTagsInput, setSdkTagsInput] = useState(PUBLISHER_TAGS);
  const [campaignCount, setCampaignCount] = useState<number | null>(null);
  const [repolling, setRepolling] = useState(false);
  const [debugInfo, setDebugInfo] = useState<DaemonDebugInfo | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const [logAutoScroll, setLogAutoScroll] = useState(true);
  const [claimBuilderMode, setClaimBuilderModeState] = useState<"per-impression" | "aggregated">("aggregated");

  // Vickrey auction visualization state
  const [auctionBids, setAuctionBids] = useState<AuctionBid[]>([]);
  const [auctionKey, setAuctionKey] = useState(0);

  // Browse simulator state
  const [simVisitCounts, setSimVisitCounts] = useState<Record<string, number>>({});
  const [interestWeights, setInterestWeights] = useState<Record<string, number>>({});
  const [simulating, setSimulating] = useState(false);
  const [currentSimTopics, setCurrentSimTopics] = useState<string[]>([]);
  const [autoTourActive, setAutoTourActive] = useState(false);
  const autoTourRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load publisher SDK
  useEffect(() => {
    const existing = document.querySelector('script[data-datum-sdk]') as HTMLScriptElement | null;
    if (existing) { sdkScriptRef.current = existing; return; }
    const script = document.createElement("script");
    script.src = "/datum-sdk.js";
    script.setAttribute("data-datum-sdk", "1");
    script.setAttribute("data-publisher", publisherAddress);
    script.setAttribute("data-relay", RELAY_URL);
    script.setAttribute("data-tags", PUBLISHER_TAGS);
    document.body.appendChild(script);
    sdkScriptRef.current = script;
    return () => { script.remove(); sdkScriptRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SDK events
  useEffect(() => {
    const onReady = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setSdk({ ready: true, version: d.version, publisher: d.publisher, tags: d.tags });
    };
    const onResponse = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setHandshake({ done: true, sig: (d.signature || "").slice(0, 18) });
    };
    document.addEventListener("datum:sdk-ready", onReady);
    document.addEventListener("datum:response", onResponse);
    return () => {
      document.removeEventListener("datum:sdk-ready", onReady);
      document.removeEventListener("datum:response", onResponse);
    };
  }, []);

  // connectedAddress: derived from debug info polling (updated every 3s)
  const connectedAddress = debugInfo?.connectedAddress ?? null;

  // Auto-run the bridge once daemon is ready AND a wallet is connected.
  // Fires when connectedAddress first becomes non-null (wallet connect event).
  // Also retries every 8s if no campaigns found yet (poll still in progress).
  const prevConnectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!daemonReady || !connectedAddress) return;
    // Only fire when address first appears (avoid re-running on every 3s debug tick)
    if (prevConnectedRef.current === connectedAddress) return;
    prevConnectedRef.current = connectedAddress;

    let cancelled = false;
    const run = async () => {
      await runContentBridge(publisherAddress, setBridgeStatus).catch(console.error);
      if (cancelled) return;
      const cached = await getCampaignCount();
      setCampaignCount(cached);
      if (cached === 0 && !cancelled) {
        setTimeout(run, 8000);
      }
    };
    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonReady, connectedAddress]);

  // Set aggregated mode as default when daemon first becomes ready
  useEffect(() => {
    if (daemonReady) {
      setClaimBuilderMode("aggregated").catch(() => {});
      setClaimBuilderModeState("aggregated");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonReady]);

  // Poll debug info from storage every 3s while daemon is running
  useEffect(() => {
    if (!daemonReady) return;
    const tick = () => getDebugInfo().then((info) => {
      setDebugInfo(info);
      setClaimBuilderModeState(info.claimBuilderMode);
    }).catch(() => {});
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, [daemonReady]);

  // Subscribe to daemon activity log
  useEffect(() => {
    return subscribeDaemonLog((entries) => {
      setLogEntries(entries);
    });
  }, []);

  // Auto-scroll log box to bottom when new entries arrive (scroll within the box only)
  useEffect(() => {
    if (logAutoScroll && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logEntries, logAutoScroll]);

  // Relay heartbeat
  useEffect(() => {
    const check = () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      fetch(`${RELAY_URL}/health`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data) => { clearTimeout(t); setRelay(data?.ok ? { online: true, uptime: data.uptime } : { online: false }); })
        .catch(() => { clearTimeout(t); setRelay({ online: false }); });
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, []);

  // Remove previously injected simulation meta elements from DOM
  const clearSimMeta = useCallback(() => {
    document.querySelectorAll("[data-datum-sim]").forEach((el) => el.remove());
  }, []);

  // Simulate a page visit: inject metadata into DOM, update SDK tags, run bridge.
  // Accepts one topic (manual click) or an array (auto-tour multi-topic visit).
  const simulateVisit = useCallback(async (input: BrowseTopic | BrowseTopic[]) => {
    if (!daemonReady || simulating) return;
    const topics = Array.isArray(input) ? input : [input];
    setSimulating(true);
    setCurrentSimTopics(topics.map((t) => t.slug));

    clearSimMeta();

    // Merge sections and keywords across all topics for a realistic cross-topic page
    const mergedSection = topics.map((t) => t.section).join(", ");
    const mergedKeywords = topics.flatMap((t) => t.keywords.split(",").map((k) => k.trim())).join(", ");
    const primaryIab = [...new Set(topics.map((t) => t.iab))].join(",");

    // Inject Schema.org JSON-LD Article with merged content
    const ld = document.createElement("script");
    ld.type = "application/ld+json";
    ld.setAttribute("data-datum-sim", "1");
    ld.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
      "articleSection": topics.length === 1 ? topics[0].section : topics.map((t) => t.section),
      "keywords": mergedKeywords,
    });
    document.head.appendChild(ld);

    // Inject OG article:section (first topic)
    const ogSection = document.createElement("meta");
    ogSection.setAttribute("property", "article:section");
    ogSection.setAttribute("content", topics[0].section);
    ogSection.setAttribute("data-datum-sim", "1");
    document.head.appendChild(ogSection);

    // Inject OG article:tag — up to 3 keywords from each topic
    const tagKws = topics.flatMap((t) => t.keywords.split(",").map((k) => k.trim()).slice(0, 3));
    for (const kw of tagKws) {
      const ogTag = document.createElement("meta");
      ogTag.setAttribute("property", "article:tag");
      ogTag.setAttribute("content", kw);
      ogTag.setAttribute("data-datum-sim", "1");
      document.head.appendChild(ogTag);
    }

    // Inject IAB category meta (comma-separated if multiple)
    const iabMeta = document.createElement("meta");
    iabMeta.setAttribute("name", "iab-category");
    iabMeta.setAttribute("content", primaryIab);
    iabMeta.setAttribute("data-datum-sim", "1");
    document.head.appendChild(iabMeta);

    // Update SDK data-tags with all simulated topics
    if (sdkScriptRef.current) {
      sdkScriptRef.current.setAttribute("data-tags", topics.map((t) => `topic:${t.slug}`).join(",") + ",locale:en");
    }

    // Push all topic tags into interest profile
    const topicTags = topics.map((t) => `topic:${t.slug}`);
    await updateInterestProfile([...topicTags, "locale:en", "platform:desktop"]).catch(() => {});

    // Run full auction bridge (picks up injected meta via classifyPageToTags → extractors)
    if (connectedAddress) {
      await runContentBridge(publisherAddress, setBridgeStatus).catch(console.error);
    }

    // Read back the updated interest profile
    const profile = await getInterestProfile().catch(() => ({ weights: {}, visitCounts: {} }));
    setInterestWeights(profile.weights);

    setSimVisitCounts((prev) => {
      const next = { ...prev };
      for (const t of topics) next[t.slug] = (next[t.slug] ?? 0) + 1;
      return next;
    });
    setSimulating(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonReady, simulating, publisherAddress, connectedAddress, clearSimMeta]);

  // Pick 1-3 random topics, weighted: 55% single, 30% dual, 15% triple
  const pickRandomTopics = useCallback((): BrowseTopic[] => {
    const r = Math.random();
    const count = r < 0.55 ? 1 : r < 0.85 ? 2 : 3;
    const shuffled = [...BROWSE_TOPICS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }, []);

  // Auto-tour: randomly pick 1-3 topics per visit
  useEffect(() => {
    if (!autoTourActive) {
      if (autoTourRef.current) { clearInterval(autoTourRef.current); autoTourRef.current = null; }
      return;
    }
    const step = () => simulateVisit(pickRandomTopics());
    step(); // immediate first step
    autoTourRef.current = setInterval(step, 3500);
    return () => {
      if (autoTourRef.current) { clearInterval(autoTourRef.current); autoTourRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTourActive]);

  // Pick up new auction bids when bridge completes
  useEffect(() => {
    if (bridgeStatus.auctionBids && bridgeStatus.auctionBids.length > 0) {
      setAuctionBids(bridgeStatus.auctionBids);
      setAuctionKey((k) => k + 1);
    }
  }, [bridgeStatus.auctionBids]);

  const relayLabel = relay === null
    ? "Checking..."
    : relay.online
      ? `Online (uptime ${Math.floor((relay.uptime ?? 0) / 3600)}h ${Math.floor(((relay.uptime ?? 0) % 3600) / 60)}m)`
      : "Offline";

  return (
    <div className="nano-fade" style={{ maxWidth: 820 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "0.08em", marginBottom: 12 }}>
          DATUM
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, maxWidth: 560, lineHeight: 1.7 }}>
          Decentralized advertising protocol on Polkadot Hub.
          On-chain settlement, privacy-preserving engagement, no intermediaries.
        </p>
      </div>

      {/* ── How It Works ───────────────────────────────────────────────────── */}
      <Section label="How It Works">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: 4 }}>
          {[
            { n: "1", title: "Publish", desc: "Add the SDK tag to your site. Declare your content tags and publisher address. No ad server needed." },
            { n: "2", title: "Campaign", desc: "Advertisers deposit DOT into on-chain escrow, set a CPM bid and required tags. Governance votes to activate or reject." },
            { n: "3", title: "Engage", desc: "Users browse with the DATUM extension. Impressions tracked locally with engagement scoring. Data never leaves the browser." },
            { n: "4", title: "Settle", desc: "Claim hash chains submitted on-chain. Revenue splits automatically — publisher, user, protocol. All verifiable." },
          ].map((step) => (
            <div key={step.n} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 20 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-strong)", fontFamily: "var(--font-mono)", marginBottom: 6 }}>{step.n}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>{step.title}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{step.desc}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Interactive demo ───────────────────────────────────────────────── */}
      <Section label="Try It — No Install Required">
        <p style={p}>
          The panel below runs the full extension logic directly in your browser.
          Create a test wallet, browse the claim queue, adjust your ad filters,
          and watch campaigns load from Paseo testnet — all without installing anything.
        </p>

        {/* ── Row 1: Extension popup + Browse Simulator side-by-side ─────── */}
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap", marginTop: 16 }}>

          {/* Left — extension popup */}
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
              User View — Extension Popup
            </div>
            <ExtensionApplet onDaemonReady={() => {
              setDaemonReady(true);
              setRelaySignerAddress(getRelaySignerAddress());
              getCampaignCount().then(setCampaignCount);
            }} />
          </div>

          {/* Right — Browse Simulator */}
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
              Browse Simulator
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.6 }}>
              Simulate visiting different topic pages to build an interest profile.
              Each visit injects real Schema.org, Open Graph, and IAB metadata so the daemon
              classifies the page and re-runs the auction — showing how browsing history shifts
              campaign selection.
            </p>

            {!daemonReady && (
              <div style={{ fontSize: 12, color: "var(--warn)", marginBottom: 12, fontFamily: "var(--font-mono)" }}>
                Connect a wallet in the extension panel to start.
              </div>
            )}

            {/* Auto-Tour button — prominent, green */}
            <button
              onClick={() => setAutoTourActive((v) => !v)}
              disabled={!daemonReady}
              style={{
                display: "block",
                width: "100%",
                padding: "11px 20px",
                marginBottom: 10,
                borderRadius: 6,
                border: `2px solid ${daemonReady ? "var(--ok)" : "var(--border)"}`,
                background: autoTourActive ? "rgba(74,222,128,0.14)" : "transparent",
                color: daemonReady ? "var(--ok)" : "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "0.04em",
                cursor: daemonReady ? "pointer" : "not-allowed",
                transition: "background 0.2s",
                textAlign: "center",
              }}
            >
              {autoTourActive
                ? <BouncingText text="Stop Auto-Tour" />
                : "Start Auto-Tour"}
            </button>

            {/* Secondary controls */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <button
                onClick={() => simulateVisit(pickRandomTopics())}
                disabled={!daemonReady || simulating}
                style={{
                  background: "rgba(255,255,255,0.06)", border: "1px solid var(--border)",
                  borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)",
                  fontSize: 11, padding: "5px 12px",
                  cursor: daemonReady && !simulating ? "pointer" : "not-allowed",
                }}
              >
                Random Visit
              </button>
              {Object.keys(simVisitCounts).length > 0 && (
                <button
                  onClick={() => {
                    clearSimMeta();
                    setSimVisitCounts({});
                    setInterestWeights({});
                    setCurrentSimTopics([]);
                    setAutoTourActive(false);
                  }}
                  style={{
                    background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)",
                    borderRadius: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)",
                    fontSize: 11, padding: "5px 12px", cursor: "pointer",
                  }}
                >
                  Reset
                </button>
              )}
              {simulating && currentSimTopics.length > 0 && (
                <span style={{ fontSize: 11, color: "var(--warn)", fontFamily: "var(--font-mono)", alignSelf: "center" }}>
                  Simulating {currentSimTopics.join(" + ")}…
                </span>
              )}
            </div>

            {/* Topic grid */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
              {BROWSE_TOPICS.map((topic) => {
                const count = simVisitCounts[topic.slug] ?? 0;
                const weight = interestWeights[`topic:${topic.slug}`] ?? 0;
                const isActive = currentSimTopics.includes(topic.slug);
                return (
                  <button
                    key={topic.slug}
                    onClick={() => simulateVisit(topic)}
                    disabled={!daemonReady || simulating}
                    title={`IAB: ${topic.iab} · Section: ${topic.section}`}
                    style={{
                      background: isActive
                        ? "rgba(74,222,128,0.12)"
                        : count > 0
                          ? "rgba(255,255,255,0.07)"
                          : "rgba(255,255,255,0.03)",
                      border: `1px solid ${isActive ? "rgba(74,222,128,0.45)" : weight > 0.1 ? "rgba(255,255,255,0.2)" : "var(--border)"}`,
                      borderRadius: 4,
                      color: isActive ? "var(--ok)" : count > 0 ? "var(--text-strong)" : "var(--text-muted)",
                      fontFamily: "var(--font-mono)", fontSize: 11,
                      padding: "4px 9px",
                      cursor: daemonReady && !simulating ? "pointer" : "not-allowed",
                      display: "flex", alignItems: "center", gap: 5,
                      transition: "background 0.15s, border-color 0.15s",
                    }}
                  >
                    <span>{topic.label}</span>
                    {count > 0 && (
                      <span style={{
                        background: "rgba(255,255,255,0.12)", borderRadius: 3,
                        fontSize: 10, padding: "0 4px", color: "var(--text-muted)",
                        minWidth: 16, textAlign: "center",
                      }}>{count}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Interest profile bar chart */}
            {Object.keys(interestWeights).length > 0 && (() => {
              const topicWeights = Object.entries(interestWeights)
                .filter(([k]) => k.startsWith("topic:"))
                .sort(([, a], [, b]) => b - a)
                .slice(0, 12);
              const maxW = topicWeights[0]?.[1] ?? 1;
              return (
                <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 10, fontFamily: "var(--font-mono)" }}>
                    Interest Profile — Auction Weights
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {topicWeights.map(([tag, w]) => {
                      const label = tag.replace("topic:", "").replace(/-/g, " ");
                      const pct = Math.round((w / maxW) * 100);
                      return (
                        <div key={tag} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 130, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right", flexShrink: 0 }}>
                            {label}
                          </div>
                          <div style={{ flex: 1, height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: "rgba(74,222,128,0.55)", borderRadius: 4, transition: "width 0.3s" }} />
                          </div>
                          <div style={{ width: 36, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>
                            {w.toFixed(2)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginTop: 8 }}>
                    7-day exponential decay · campaigns matching higher-weight topics win more auctions
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* ── Row 2: Auction Visualization (full-width) ─────────────────── */}
        {auctionBids.length > 0 && (
          <div style={{
            marginTop: 24, borderRadius: 6, padding: "14px 16px",
            border: `1px solid ${
              bridgeStatus.mechanism === "solo" ? "rgba(147,197,253,0.25)"
              : bridgeStatus.mechanism === "floor" ? "rgba(251,146,60,0.25)"
              : "rgba(74,222,128,0.2)"
            }`,
            transition: "border-color 0.4s",
          }}>
            <div style={{
              fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14, fontFamily: "var(--font-mono)",
              color: bridgeStatus.mechanism === "solo" ? "rgba(147,197,253,0.9)"
                : bridgeStatus.mechanism === "floor" ? "rgba(251,146,60,0.9)"
                : "var(--ok)",
              transition: "color 0.4s",
            }}>
              {bridgeStatus.mechanism === "solo" ? "Solo Auction — Uncontested"
                : bridgeStatus.mechanism === "floor" ? "Second-Price Auction — Floor Price"
                : "Second-Price Vickrey Auction"}
            </div>
            <VickreyAuctionViz
              key={auctionKey}
              bids={auctionBids}
              mechanism={bridgeStatus.mechanism}
              clearingCpmPlanck={bridgeStatus.clearingCpmPlanck}
            />
          </div>
        )}

        {/* ── Row 3: Publisher View — SDK Config + Ad Slot ─────────────── */}
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 12, fontFamily: "var(--font-mono)" }}>
            Publisher View — Ad Slot
          </div>

          <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* SDK Config */}
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                  SDK Configuration
                </div>

                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>data-publisher</div>
                  <input
                    value={publisherInput}
                    onChange={(e) => setPublisherInput(e.target.value)}
                    style={inputStyle}
                    placeholder="0x..."
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>data-tags</div>
                  <input
                    value={sdkTagsInput}
                    onChange={(e) => setSdkTagsInput(e.target.value)}
                    style={inputStyle}
                    placeholder="topic:crypto-web3,topic:defi,locale:en"
                  />
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.4 }}>
                    Comma-separated tags. Campaigns match when the publisher has all required tags.
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => {
                      if (sdkScriptRef.current) {
                        sdkScriptRef.current.setAttribute("data-publisher", publisherInput);
                        sdkScriptRef.current.setAttribute("data-tags", sdkTagsInput);
                      }
                      setPublisherAddress(publisherInput);
                      runContentBridge(publisherInput, setBridgeStatus).catch(console.error);
                    }}
                    disabled={!daemonReady || !connectedAddress}
                    style={{
                      flex: 1,
                      background: (daemonReady && connectedAddress) ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                      border: "1px solid var(--border)", borderRadius: 4,
                      color: (daemonReady && connectedAddress) ? "var(--text)" : "var(--text-muted)",
                      fontFamily: "var(--font-mono)", fontSize: 11, padding: "6px 10px",
                      cursor: (daemonReady && connectedAddress) ? "pointer" : "not-allowed",
                    }}
                  >
                    {!daemonReady
                      ? "Loading campaigns from Paseo..."
                      : !connectedAddress
                        ? "Connect wallet to run auction"
                        : `Run Auction${campaignCount != null ? ` (${campaignCount} campaigns)` : ""}`}
                  </button>
                  {daemonReady && (
                    <button
                      onClick={async () => {
                        setRepolling(true);
                        try {
                          const n = await repollCampaigns();
                          setCampaignCount(n);
                        } finally {
                          setRepolling(false);
                        }
                      }}
                      disabled={repolling}
                      title="Clear poller cache and re-fetch all campaigns from chain"
                      style={{
                        background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)",
                        borderRadius: 4, color: repolling ? "var(--text-muted)" : "var(--text)",
                        fontFamily: "var(--font-mono)", fontSize: 11, padding: "6px 8px",
                        cursor: repolling ? "not-allowed" : "pointer", whiteSpace: "nowrap",
                      }}
                    >
                      {repolling ? "…" : "Repoll"}
                    </button>
                  )}
                </div>

                {/* Claim builder mode toggle */}
                {daemonReady && (
                  <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                      Claim Builder Mode
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {(["per-impression", "aggregated"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={async () => {
                            await setClaimBuilderMode(mode);
                            setClaimBuilderModeState(mode);
                          }}
                          style={{
                            flex: 1,
                            background: claimBuilderMode === mode ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
                            border: `1px solid ${claimBuilderMode === mode ? "rgba(255,255,255,0.3)" : "var(--border)"}`,
                            borderRadius: 4,
                            color: claimBuilderMode === mode ? "var(--text-strong)" : "var(--text-muted)",
                            fontFamily: "var(--font-mono)", fontSize: 11, padding: "5px 8px",
                            cursor: "pointer",
                          }}
                        >
                          {mode === "per-impression" ? "per-impression" : "aggregated"}
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
                      {claimBuilderMode === "per-impression"
                        ? "Each impression hashed immediately → 4 claims/tx × 1 impression = 4 impressions/tx."
                        : `Raw impressions queued until submit → up to 4 claims × 250 = 1000 impressions/tx.${debugInfo && debugInfo.rawQueueDepth > 0 ? ` (${debugInfo.rawQueueDepth} raw queued)` : ""}`}
                    </div>
                  </div>
                )}
              </div>

              {/* SDK status */}
              <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 14px", fontFamily: "var(--font-mono)", fontSize: 12, marginBottom: 12 }}>
                {[
                  ["Relay",      relayLabel, relay === null ? "var(--warn)" : relay.online ? "var(--ok)" : "var(--error)"],
                  ["SDK",        sdk.ready ? `Ready (v${sdk.version})` : "Loading…", sdk.ready ? "var(--ok)" : "var(--warn)"],
                  ["Publisher",  sdk.publisher ? sdk.publisher.slice(0, 10) + "…" : "—", "var(--text-muted)"],
                  ["Handshake",  handshake.done ? `Complete (${handshake.sig}…)` : "Pending", handshake.done ? "var(--ok)" : "var(--warn)"],
                ].map(([label, value, color]) => (
                  <div key={label} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                    <span style={{ color: "var(--text)", minWidth: 90 }}>{label}</span>
                    <span style={{ color }}>{value}</span>
                  </div>
                ))}
              </div>

              {relaySignerAddress && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 6, fontFamily: "var(--font-mono)" }}>
                    Relay Signer
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ok)", wordBreak: "break-all" }}>
                    {relaySignerAddress}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Diana (Publisher 1) — co-signs impression claims for on-chain settlement.
                  </div>
                </div>
              )}
            </div>

            {/* Ad slot + status */}
            <div style={{ flex: 1, minWidth: 220 }}>
              {/* Auction status */}
              {bridgeStatus.step !== "idle" && (
                <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 11, marginBottom: 12 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 6 }}>Auction Status</div>
                  {[
                    ["Step", stepLabel(bridgeStatus.step), stepColor(bridgeStatus.step)],
                    ...(bridgeStatus.totalCampaigns != null ? [["Campaigns", `${bridgeStatus.activeCampaigns} active / ${bridgeStatus.totalCampaigns} total`, "var(--text-muted)"]] : []),
                    ...(bridgeStatus.matchedPool != null ? [["Matched", `${bridgeStatus.matchedPool} in pool`, bridgeStatus.matchedPool > 0 ? "var(--ok)" : "var(--warn)"]] : []),
                    ...(bridgeStatus.campaignId ? [["Winner", `#${bridgeStatus.campaignId}`, "var(--ok)"]] : []),
                    ...(bridgeStatus.mechanism ? [["Mechanism", bridgeStatus.mechanism, "var(--text-muted)"]] : []),
                    ...(bridgeStatus.clearingCpmPlanck ? [["Clearing CPM", formatPlanck(bridgeStatus.clearingCpmPlanck), "var(--text-muted)"]] : []),
                    ...(bridgeStatus.participants != null ? [["Participants", String(bridgeStatus.participants), "var(--text-muted)"]] : []),
                    ...(bridgeStatus.error ? [["Error", bridgeStatus.error, "var(--error)"]] : []),
                    ...(bridgeStatus.step === "house-ad" && (bridgeStatus.totalCampaigns ?? 0) === 0
                      ? [["Hint", "No campaigns on Paseo — run setup-testnet.ts", "var(--warn)"]]
                      : []),
                  ].map(([label, value, color]) => (
                    <div key={label} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                      <span style={{ color: "var(--text)", minWidth: 90 }}>{label}</span>
                      <span style={{ color }}>{value}</span>
                    </div>
                  ))}
                  {debugInfo && (
                    <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 6 }}>
                      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 4 }}>Poller State</div>
                      {[
                        ["wallet", debugInfo.connectedAddress ? debugInfo.connectedAddress.slice(0, 10) + "…" : "not connected", debugInfo.connectedAddress ? "var(--ok)" : "var(--error)"],
                        ["fromBlock", debugInfo.pollLastBlock != null ? String(debugInfo.pollLastBlock) : "not set", debugInfo.pollLastBlock ? "var(--ok)" : "var(--error)"],
                        ["index", `${debugInfo.campaignIndexCount} entries`, debugInfo.campaignIndexCount > 0 ? "var(--ok)" : "var(--warn)"],
                        ["cache", `${debugInfo.activeCampaignsCount} campaigns`, debugInfo.activeCampaignsCount > 0 ? "var(--ok)" : "var(--warn)"],
                        ["claims", `${debugInfo.claimQueueCount} in queue${debugInfo.claimQueueAddresses.length > 0 ? ` (${debugInfo.claimQueueAddresses.map(a => a.slice(0,8)+"…").join(", ")})` : ""}`, debugInfo.claimQueueCount > 0 ? "var(--ok)" : "var(--text-muted)"],
                        ...(debugInfo.claimBuilderMode === "aggregated" ? [["raw queue", `${debugInfo.rawQueueDepth} impressions (aggregated mode)`, debugInfo.rawQueueDepth > 0 ? "var(--ok)" : "var(--text-muted)"]] : []),
                        ...(debugInfo.lastImpressionResult ? [["impression", debugInfo.lastImpressionResult.ok ? `ok campaign=${debugInfo.lastImpressionResult.campaignId}` : `fail: ${debugInfo.lastImpressionResult.reason}`, debugInfo.lastImpressionResult.ok ? "var(--ok)" : "var(--error)"]] : []),
                        ["relay key", debugInfo.relaySignerAddress ? debugInfo.relaySignerAddress.slice(0, 10) + "…" : "none", "var(--text-muted)"],
                        ...(debugInfo.sampleCampaign ? [["sample", `#${debugInfo.sampleCampaign.id} status=${debugInfo.sampleCampaign.status} pub=${debugInfo.sampleCampaign.publisher.slice(0, 8)}…`, "var(--text-muted)"]] : []),
                      ].map(([l, v, c]) => (
                        <div key={l} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                          <span style={{ color: "var(--text)", minWidth: 90 }}>{l}</span>
                          <span style={{ color: c, wordBreak: "break-all" }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div style={{
                border: "1px dashed rgba(255,255,255,0.12)", borderRadius: 8,
                padding: 20, marginBottom: 12, minHeight: 80,
              }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                  datum-ad-slot
                </div>
                <div id="datum-ad-slot" />
                {daemonReady && !connectedAddress && (
                  <div style={{ fontSize: 11, color: "var(--warn)", marginTop: 8, fontFamily: "var(--font-mono)" }}>
                    Connect a wallet in the extension panel to serve ads.
                  </div>
                )}
                {(!daemonReady || (daemonReady && connectedAddress && bridgeStatus.step === "idle")) && (
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.15)", marginTop: 8 }}>
                    {!daemonReady ? "Loading extension daemon…" : "Auction will run automatically once the wallet is connected."}
                  </div>
                )}
              </div>

              <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 8, fontFamily: "var(--font-mono)" }}>
                  What to try
                </div>
                {[
                  ["Set up wallet", "Generate or import a Paseo testnet key"],
                  ["Claims tab", "See pending impression claims and submit on-chain"],
                  ["Earnings tab", "Check your withdrawable balance"],
                  ["Filters tab", "Toggle ad topic categories and opt-out of campaigns"],
                  ["Settings tab", "Configure RPC endpoint and view interest profile"],
                ].map(([title, desc]) => (
                  <div key={title} style={{ padding: "4px 0", fontSize: 12 }}>
                    <span style={{ color: "var(--text-strong)" }}>{title}</span>
                    <span style={{ color: "var(--text-muted)" }}> — {desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Publisher Integration ──────────────────────────────────────────── */}
      <Section label="Publisher Integration">
        <p style={p}>Add the SDK to any page with two lines:</p>
        <pre style={pre}>{`<script src="https://your-cdn/datum-sdk.js"
  data-tags="topic:crypto-web3,topic:defi,locale:en"
  data-publisher="0xYOUR_PUBLISHER_ADDRESS"
  data-relay="https://your-relay.example.com"
  data-excluded-tags="topic:gambling,topic:adult"></script>
<div id="datum-ad-slot"></div>`}</pre>
        <p style={p}>
          <code style={code}>data-tags</code> declares which tags describe your site.{" "}
          <code style={code}>data-publisher</code> is your registered on-chain address.{" "}
          <code style={code}>data-relay</code> is your publisher relay endpoint.{" "}
          <code style={code}>data-excluded-tags</code> is an optional publisher-side tag blocklist.
        </p>
      </Section>

      {/* ── Daemon Activity Log ────────────────────────────────────────────── */}
      <Section label="Daemon Activity Log">
        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {logEntries.length} entries — console messages from the daemon and message bus traffic
          </span>
          <div style={{ flex: 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={logAutoScroll}
              onChange={(e) => setLogAutoScroll(e.target.checked)}
              style={{ accentColor: "var(--ok)" }}
            />
            auto-scroll
          </label>
          <button
            onClick={() => {
              const text = logEntries
                .map((e) => `${fmtTs(e.ts)} [${e.level}] ${e.text}`)
                .join("\n");
              navigator.clipboard.writeText(text).catch(() => {});
            }}
            style={logBtnStyle}
          >
            Copy
          </button>
          <button onClick={clearDaemonLog} style={logBtnStyle}>Clear</button>
        </div>
        <div
          ref={logBoxRef}
          onScroll={() => {
            const el = logBoxRef.current;
            if (!el) return;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setLogAutoScroll(atBottom);
          }}
          style={{
            height: 360,
            overflowY: "auto",
            background: "rgba(0,0,0,0.35)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.55,
          }}
        >
          {logEntries.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.2)", paddingTop: 4 }}>
              No activity yet. The log captures daemon console output and message bus traffic.
            </div>
          ) : (
            logEntries.map((e) => (
              <div key={e.id} style={{ display: "flex", gap: 8, padding: "1px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                <span style={{ color: "rgba(255,255,255,0.25)", flexShrink: 0, userSelect: "none" }}>
                  {fmtTs(e.ts)}
                </span>
                <span style={{ color: levelColor(e.level), flexShrink: 0, width: 52, userSelect: "none" }}>
                  [{e.level}]
                </span>
                <span style={{ color: levelTextColor(e.level), wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
                  {e.text}
                </span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </Section>

      {/* ── Resources ─────────────────────────────────────────────────────── */}
      <Section label="Resources">
        <ul style={{ listStyle: "none", padding: 0 }}>
          {[
            ["GitHub Repository", "https://github.com/Baronvonbonbon/datum"],
            ["Publisher Relay Template", "https://github.com/Baronvonbonbon/datum/tree/main/docs/relay-bot-template"],
            ["Paseo Explorer", "https://blockscout-testnet.polkadot.io/"],
            ['Testnet Faucet (select "Paseo")', "https://faucet.polkadot.io/"],
          ].map(([label, href]) => (
            <li key={href} style={{ padding: "3px 0", fontSize: 13 }}>
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)", textDecoration: "underline", textDecorationColor: "var(--border-hover)" }}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </Section>

    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nano-fade" style={{ marginBottom: 24 }}>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 14, fontFamily: "var(--font-mono)" }}>
          {label}
        </div>
        {children}
      </div>
    </div>
  );
}

function stepLabel(step: string): string {
  return ({
    idle: "Idle",
    detecting: "Detecting SDK...",
    matching: "Matching campaigns...",
    auction: "Running auction...",
    handshake: "Handshaking...",
    injected: "Ad injected",
    "house-ad": "House ad (no match)",
    "no-match": "No campaigns",
    error: "Error",
  } as Record<string, string>)[step] ?? step;
}

function stepColor(step: string): string {
  if (step === "injected") return "var(--ok)";
  if (step === "error") return "var(--error)";
  if (step === "house-ad" || step === "no-match") return "var(--warn)";
  return "var(--text-muted)";
}

function formatPlanck(planck: string): string {
  try {
    const dot = Number(BigInt(planck)) / 1e10;
    return `${dot.toFixed(4)} DOT`;
  } catch { return planck; }
}

function formatEffectiveBid(micro: string): string {
  try {
    // effectiveBid = bidCpm * weight * 1000 (micro-planck units)
    // DOT = micro / 1000 / 1e10 = micro / 1e13
    const dot = Number(BigInt(micro)) / 1e13;
    return `${dot.toFixed(4)}`;
  } catch { return "?"; }
}

const BID_CARD_H = 54;
const BID_CARD_GAP = 5;
const BID_CARD_STRIDE = BID_CARD_H + BID_CARD_GAP;
// Pile layout constants (result phase)
const PILE_WINNER_GAP = 10;  // gap between winner and 2nd price
const PILE_STACK_GAP = 8;    // gap between 2nd price and first loser card
const PILE_OFFSET = 7;       // vertical offset between stacked loser cards

function pileTop(rankIdx: number): number {
  if (rankIdx === 0) return 0;
  if (rankIdx === 1) return BID_CARD_H + PILE_WINNER_GAP;
  return BID_CARD_H + PILE_WINNER_GAP + BID_CARD_H + PILE_STACK_GAP + (rankIdx - 2) * PILE_OFFSET;
}

function pileContainerH(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return BID_CARD_H + 4;
  return pileTop(n - 1) + BID_CARD_H + 6;
}

type AuctionPhase = "scrambled" | "sorting" | "result";

function VickreyAuctionViz({ bids, mechanism, clearingCpmPlanck }: {
  bids: AuctionBid[];
  mechanism?: string;
  clearingCpmPlanck?: string;
}) {
  // rows[i] = display row for rank-i card during scramble/sort phases
  const [rows, setRows] = useState<number[]>(() =>
    bids.map((_, i) => i).sort(() => Math.random() - 0.5)
  );
  const [phase, setPhase] = useState<AuctionPhase>("scrambled");
  const [containerH, setContainerH] = useState(() => bids.length * BID_CARD_STRIDE);
  const [cycle, setCycle] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (bids.length === 0) return;

    // Reset scrambled
    setRows(bids.map((_, i) => i).sort(() => Math.random() - 0.5));
    setPhase("scrambled");
    setContainerH(bids.length * BID_CARD_STRIDE);

    // 800ms: sort into rank order
    timers.current.push(setTimeout(() => {
      setRows(bids.map((_, i) => i));
      setPhase("sorting");
    }, 800));

    // 2000ms: collapse losers into pile
    timers.current.push(setTimeout(() => {
      setPhase("result");
      setContainerH(pileContainerH(bids.length));
    }, 2000));

    // 5000ms: restart cycle
    timers.current.push(setTimeout(() => {
      setCycle(c => c + 1);
    }, 5000));

    return () => { timers.current.forEach(clearTimeout); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bids, cycle]);

  if (bids.length === 0) return null;

  const showDetail = phase === "result";

  return (
    <div style={{
      position: "relative",
      height: containerH,
      transition: "height 0.5s cubic-bezier(0.4,0,0.2,1)",
      overflow: "hidden",
    }}>
      {bids.map((bid, rankIdx) => {
        const isWinner = rankIdx === 0;
        const isSecond = rankIdx === 1;
        const isLoser = rankIdx >= 2;
        const pileDepth = Math.max(0, rankIdx - 2);  // 0 for 3rd, 1 for 4th, …

        // Position: scramble/sort use rows array * stride; result uses pile layout
        const top = phase === "result"
          ? pileTop(rankIdx)
          : (rows[rankIdx] ?? rankIdx) * BID_CARD_STRIDE;

        // Pile depth effects (only for loser cards in result phase)
        const pileOpacity = showDetail && isLoser ? Math.max(0.35, 1 - pileDepth * 0.09) : 1;
        const pileScale = showDetail && isLoser ? 1 - pileDepth * 0.012 : 1;
        // Slight alternating x-shift for card-shuffle feel
        const pileShiftX = showDetail && isLoser ? (pileDepth % 2 === 0 ? pileDepth * 0.8 : -pileDepth * 0.8) : 0;

        // Z-order: winner on top, deeper pile cards behind
        const zIndex = bids.length - rankIdx;

        const isSolo = mechanism === "solo";
        const isFloor = mechanism === "floor";

        // Winner colors vary by mechanism
        const winnerBorder = isSolo ? "rgba(147,197,253,0.50)" : "rgba(74,222,128,0.45)";
        const winnerBg     = isSolo ? "rgba(147,197,253,0.07)" : "rgba(74,222,128,0.06)";
        const winnerColor  = isSolo ? "rgba(147,197,253,0.95)" : "var(--ok)";
        // 2nd-price card: red treatment for floor (couldn't set price), amber for second-price
        const secondBorder = isFloor ? "rgba(239,68,68,0.35)"   : "rgba(251,191,36,0.40)";
        const secondBg     = isFloor ? "rgba(239,68,68,0.04)"   : "rgba(251,191,36,0.04)";
        const secondColor  = isFloor ? "rgba(239,68,68,0.85)"   : "var(--warn)";

        const borderColor = showDetail
          ? isWinner ? winnerBorder
          : isSecond ? secondBorder
          : "rgba(255,255,255,0.05)"
          : "rgba(255,255,255,0.06)";

        const bg = showDetail
          ? isWinner ? winnerBg
          : isSecond ? secondBg
          : "rgba(255,255,255,0.02)"
          : "rgba(255,255,255,0.03)";

        // Floor 2nd: visually sinks below winner in result phase
        const floorSinkY = showDetail && isFloor && isSecond ? 4 : 0;

        return (
          <div
            key={bid.id}
            style={{
              position: "absolute",
              left: 0, right: 0,
              top,
              height: BID_CARD_H,
              zIndex,
              border: `1px solid ${borderColor}`,
              borderRadius: 5,
              background: bg,
              boxShadow: showDetail && isWinner && isSolo
                ? "0 0 14px rgba(147,197,253,0.25), 0 0 4px rgba(147,197,253,0.15)"
                : showDetail && isLoser ? "0 2px 6px rgba(0,0,0,0.35)" : "none",
              padding: "6px 10px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              overflow: "hidden",
              transition: "top 0.5s cubic-bezier(0.4,0,0.2,1), opacity 0.4s ease, transform 0.5s cubic-bezier(0.4,0,0.2,1), background 0.35s, border-color 0.35s, box-shadow 0.35s",
              opacity: pileOpacity,
              transform: `translateX(${pileShiftX}px) scaleX(${pileScale}) translateY(${floorSinkY}px)`,
              transformOrigin: "center top",
            }}
          >
            {/* Rank number */}
            <div style={{
              width: 18, height: 18, borderRadius: 3, flexShrink: 0,
              background: showDetail && isWinner
                ? (isSolo ? "rgba(147,197,253,0.18)" : "rgba(74,222,128,0.18)")
                : showDetail && isSecond
                ? (isFloor ? "rgba(239,68,68,0.15)" : "rgba(251,191,36,0.15)")
                : "rgba(255,255,255,0.06)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10,
              color: showDetail && isWinner ? winnerColor
                : showDetail && isSecond ? secondColor
                : "var(--text-muted)",
              transition: "background 0.35s, color 0.35s",
            }}>
              {rankIdx + 1}
            </div>

            {/* Campaign ID + details */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "var(--text-strong)", fontSize: 11 }}>
                Campaign #{bid.id}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 1 }}>
                {formatPlanck(bid.bidCpmPlanck)}/1k · {bid.interestWeight.toFixed(2)}× weight
              </div>
            </div>

            {/* Effective bid + clearing price */}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{
                fontSize: 11,
                fontWeight: isWinner ? 600 : 400,
                color: showDetail && isWinner ? winnerColor
                  : showDetail && isSecond ? secondColor
                  : "var(--text-muted)",
                transition: "color 0.35s",
              }}>
                {formatEffectiveBid(bid.effectiveBidMicro)} eff
              </div>
              {showDetail && isWinner && (
                <div style={{ fontSize: 10, color: winnerColor, marginTop: 1, opacity: 0.85 }}>
                  {isSolo ? "uncontested · 70% of bid"
                    : isFloor ? `pays ${formatPlanck(clearingCpmPlanck ?? "0")} (floor)`
                    : clearingCpmPlanck ? `pays ${formatPlanck(clearingCpmPlanck)}` : null}
                </div>
              )}
              {showDetail && isSecond && (
                <div style={{ fontSize: 10, color: secondColor, marginTop: 1, opacity: 0.85 }}>
                  {isFloor ? "below floor" : "sets price"}
                </div>
              )}
            </div>

            {/* Status badge */}
            <div style={{
              flexShrink: 0, minWidth: 64, textAlign: "right",
              fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
              color: showDetail && isWinner ? winnerColor
                : showDetail && isSecond ? secondColor
                : "transparent",
              transition: "color 0.35s",
            }}>
              {isWinner
                ? (isSolo ? "SOLO WIN" : "WINNER")
                : isSecond
                ? (isFloor ? "BELOW FLOOR" : "2ND PRICE")
                : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-surface)", border: "1px solid var(--border)",
  borderRadius: 4, padding: "5px 8px", color: "var(--text)",
  fontFamily: "var(--font-mono)", fontSize: 11, outline: "none",
  boxSizing: "border-box",
};

const p: React.CSSProperties = { color: "var(--text)", fontSize: 14, marginBottom: 10, lineHeight: 1.7 };
const pre: React.CSSProperties = {
  background: "var(--bg-surface)", border: "1px solid var(--border)",
  borderRadius: 6, padding: 14, overflow: "auto",
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)",
  lineHeight: 1.6, margin: "10px 0", whiteSpace: "pre",
};
const code: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)",
  borderRadius: 3, padding: "1px 5px",
  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-strong)",
};

const logBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)", border: "1px solid var(--border)",
  borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)",
  fontSize: 11, padding: "4px 10px", cursor: "pointer",
};

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join(":") + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function levelColor(level: LogEntry["level"]): string {
  if (level === "error") return "var(--error)";
  if (level === "warn") return "var(--warn)";
  if (level === "msg-out") return "#7dd3fc"; // sky-300
  if (level === "msg-in") return "#86efac";  // green-300
  return "rgba(255,255,255,0.3)";
}

function levelTextColor(level: LogEntry["level"]): string {
  if (level === "error") return "#fca5a5";
  if (level === "warn") return "#fde68a";
  if (level === "msg-out") return "#e0f2fe";
  if (level === "msg-in") return "#dcfce7";
  return "var(--text)";
}
