// build-testpages.mjs — generate the interlinked static test-publisher sites under
// web/public/testpages/ from manifest.json. Each publisher gets a themed, normal-
// looking multi-page site that embeds the real DATUM SDK with that publisher's
// address + multiple IAB ad slots, plus an unmistakable TEST banner. Re-run any
// time the manifest changes; it overwrites the output tree.
//
//   node build-testpages.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, "..", "..", "..");           // datum/
const OUT = resolve(ROOT, "web", "public", "testpages");
const manifest = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf8"));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SDK = "/testpages/assets/datum-sdk.js";

// ── Per-site editorial content (themed, believable filler) ───────────────────
const P = {
  chainsignal: {
    articles: [
      { t: "Coretime goes live: what agile blockspace means for builders", d: "Polkadot's shift to coretime changes how parachains pay for security — and who can ship.", b: ["The move from fixed parachain slots to purchasable coretime is the biggest change to Polkadot's economic model since launch. Teams can now buy blockspace on demand instead of locking DOT in two-year auctions.", "For small teams the practical upshot is simple: a prototype can rent a core for a day, prove product-market fit, and scale commitments later. The auction cliff is gone.", "Watch the secondary market. As coretime becomes tradable, brokers and resellers will emerge, and the price signal will tell us which use cases actually demand guaranteed blockspace."] },
      { t: "Stablecoin flows on Asset Hub hit a quarterly record", d: "On-chain settlement volume keeps climbing as issuers favour native assets over bridges.", b: ["Native stablecoins on Asset Hub settled more value last quarter than in the previous three combined, according to on-chain data. The trend tracks a broader move away from bridged representations.", "Lower fees and shared security are the obvious draws, but the quieter story is composability: assets that live natively are easier to route through XCM without wrapping."] },
      { t: "JAM, explained for the perpetually busy", d: "A five-minute mental model for the Join-Accumulate Machine.", b: ["JAM reframes the relay chain as a general computation layer rather than a pure coordinator. Think of it as a global rollup host with in-protocol scheduling.", "You don't need the formal spec to follow the implications: more general execution, fewer bespoke parachain runtimes, and a path to far higher throughput."] },
    ],
  },
  devforge: {
    articles: [
      { t: "Ship a container to 30 edges with one command", d: "A field guide to zero-config edge deploys that don't wake you up at 3am.", b: ["Edge platforms have quietly gotten good. The workflow that used to need a YAML thesis is now a single push, and the rollback is just as fast.", "The trick is treating the edge like a CDN for compute: immutable artifacts, content-addressed builds, and health checks that fail closed.", "We benchmarked cold starts across three providers; the spread was smaller than the variance inside any one region. Pick on ergonomics, not microbenchmarks."] },
      { t: "Profiling async Rust without tears", d: "Flamegraphs, tokio-console, and the two bugs everyone hits.", b: ["Most async performance problems are not CPU problems — they're scheduling problems. A task that looks idle is often starved behind a blocking call hiding in a library.", "tokio-console makes the invisible visible: you can watch tasks pile up and find the await that never yields."] },
      { t: "The quiet case for boring deploys", d: "Why the most reliable teams ship the least exciting pipelines.", b: ["Boring is a feature. A deploy you can describe in one sentence is a deploy you can debug at 3am.", "Every clever step in a pipeline is a step someone has to understand under pressure later. Optimise for the tired engineer."] },
    ],
  },
  saltandember: {
    articles: [
      { t: "Weeknight miso-butter udon", d: "Fifteen minutes, one pan, and a pantry you probably already have.", b: ["This is the dish to learn when you want something that tastes slow on a night that is anything but. Miso and butter do almost all the work.", "Start the water before anything else. Thick udon cooks fast, and the sauce comes together in the time it takes to boil.", "Finish with a runny egg and a fistful of scallions. The yolk is the sauce's better half."] },
      { t: "The only focaccia recipe you need", d: "High hydration, long cold rise, dimples like a kiddie pool.", b: ["Good focaccia is mostly patience and olive oil. The dough wants time in the fridge, not effort on the counter.", "Don't be shy with the salt flakes or the oil pooling in the dimples — that's the crust you're paying for."] },
      { t: "Cast iron, demystified", d: "Seasoning, scrubbing, and the myths worth ignoring.", b: ["You can use soap. You can cook tomatoes. A well-seasoned pan is tougher than the internet thinks.", "Dry it on the heat, wipe a thin film of oil, and it will outlive most of your other cookware."] },
    ],
  },
  pixelpit: {
    articles: [
      { t: "Hands-on: 'Hollow Tide' is the co-op surprise of the season", d: "A hand-drawn roguelite with the best drowning animation we've ever cheered for.", b: ["Hollow Tide understands the one thing many co-op games miss: failure should be funny. Every wipe ends in a story you retell.", "The art is the hook — ink-wash backgrounds that shift as the tide rises — but the build variety is what keeps the runs going.", "Four-player chaos is the intended way to play, though a solo run has a melancholy all its own."] },
      { t: "The best co-op roguelites you missed this year", d: "Six small games that punch far above their player counts.", b: ["The genre is having a moment, and the indies are leading it. These six share a love of short runs and long friendships.", "If you only try one, make it the deck-builder — it's the rare game that's better with a backseat driver."] },
      { t: "How a 48-hour game jam actually ships", d: "Scope, sleep, and the brutal art of cutting features.", b: ["The winning jam teams aren't the most talented — they're the most ruthless about scope. One mechanic, polished, beats five half-done.", "Build the loop first. If it isn't fun grey-boxed, art won't save it."] },
    ],
  },
  finfold: {
    articles: [
      { t: "Rates, unpacked: what the curve is quietly saying", d: "A plain-English read on an inverted yield curve that refuses to behave.", b: ["The curve has been a reliable recession bell for decades, which is exactly why this cycle has economists hedging. The signal is loud; the timing is not.", "Strip out the noise and the message is about expectations: markets think short rates come down, eventually. The fight is over 'when'.", "For ordinary savers the takeaway is unglamorous — ladder your maturities and stop trying to time the top."] },
      { t: "A calm person's guide to volatility", d: "Why the scariest charts are often the least useful.", b: ["Volatility is not risk; it's the price of admission for returns. Confusing the two is how good plans die in bad weeks.", "The antidote is boring: an allocation you can hold through a 20% drawdown without checking your phone at dinner."] },
      { t: "Tokenized treasuries go mainstream", d: "On-chain money-market funds cross a threshold that matters.", b: ["When the plumbing of traditional finance starts settling on public chains, the interesting question isn't 'if' but 'who custodies'.", "Yield-bearing on-chain cash is a genuine product, not a meme. The regulatory edges are still sharp — tread accordingly."] },
    ],
  },
  wanderlux: {
    articles: [
      { t: "Lisbon on a long weekend", d: "Three days, a tram pass, and zero regrets about the pastéis.", b: ["Lisbon rewards the unhurried. Build the trip around hills and viewpoints and let the rest fall into place between coffees.", "Take the 28 tram early before the crowds, then walk down through Alfama with no particular plan.", "Budget one afternoon for Belém and the custard tarts. Everyone says it; everyone is right."] },
      { t: "Carry-on only: the 7-day kit", d: "What actually earns its place in the bag, and what to leave home.", b: ["The secret to one bag isn't tiny gadgets — it's a tight color palette and merino. Everything goes with everything; nothing smells.", "Pack for laundry, not for days. A sink and an evening solve most overpacking."] },
      { t: "Night trains are back", d: "Europe's sleeper revival, route by route.", b: ["The sleeper is the rare travel upgrade that gives you time instead of taking it. Board after dinner, wake up somewhere new.", "Book the cabin, not the seat. The math on a hotel-plus-flight rarely beats it once you count the morning."] },
    ],
  },
};

// ── HTML building blocks ─────────────────────────────────────────────────────
function adSlot(format, note) {
  return (
    `<figure class="ad" data-fmt="${format}">` +
    `<figcaption class="ad-cap">Advertisement · <span class="ad-fmt">${format}</span></figcaption>` +
    `<div data-datum-slot="${format}"></div>` +
    `</figure>`
  );
}

function shell(site, pub, { title, active, body }) {
  const nav = [
    { slug: "index", label: "Home" },
    { slug: "article", label: site.id === "saltandember" ? "Recipe" : site.id === "pixelpit" ? "Reviews" : site.id === "wanderlux" ? "Guides" : "Latest" },
    { slug: "about", label: "About" },
  ];
  const navHtml = nav
    .map((n) => `<a href="${n.slug}.html"${n.slug === active ? ' class="active"' : ""}>${n.label}</a>`)
    .join("");
  const others = manifest.publishers
    .filter((q) => q.site.id !== site.id)
    .map((q) => `<a href="../${q.site.id}/index.html">${esc(q.site.name)}</a>`)
    .join("");
  const tags = pub.tags.join(",");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(site.name)}</title>
<link rel="stylesheet" href="/testpages/assets/testnet.css">
<style>:root{--accent:${site.accent};--bg:${site.bg};--fg:${site.fg}}</style>
</head><body data-site="${site.id}">
<div class="testbar">⚠ DATUM TEST PAGE — synthetic publisher <code>${esc(site.name)}</code> for end-to-end ad testing · <strong>not a real website</strong> · <a href="/testpages/index.html">test network ↑</a> · <a href="/">datum app →</a></div>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="index.html"><span class="dot"></span>${esc(site.name)}</a>
    <nav>${navHtml}</nav>
  </div>
  <div class="wrap tagline">${esc(site.tagline)}</div>
</header>
<main class="wrap layout">${body}</main>
<footer class="site-foot"><div class="wrap">
  <div class="foot-pub"><strong>${esc(site.name)}</strong> · DATUM publisher <code>${pub.address}</code> · take rate ${(pub.takeRateBps / 100).toFixed(0)}%</div>
  <div class="foot-net">More test sites: ${others}</div>
  <div class="foot-note">Ad slots on this page are filled by the DATUM browser extension running a live on-chain auction. With no extension installed you'll see the SDK's house-ad fallback. This is a test fixture — see <a href="/testpages/index.html">the test network overview</a>.</div>
</div></footer>
<script src="${SDK}" data-publisher="${pub.address}" data-relay="${manifest.relayUrl}" data-relay-mode="${manifest.relayMode}" data-tags="${esc(tags)}"></script>
</body></html>`;
}

function articleCard(site, a, i) {
  return `<a class="card" href="article.html#a${i}"><h3>${esc(a.t)}</h3><p>${esc(a.d)}</p><span class="more">Read →</span></a>`;
}

// ── Per-page bodies ──────────────────────────────────────────────────────────
function homeBody(site) {
  const arts = P[site.id].articles;
  return (
    `<div class="content">` +
    adSlot("leaderboard") +
    `<h1 class="lede">${esc(site.tagline)}</h1>` +
    `<section class="feed">` +
    articleCard(site, arts[0], 0) +
    adSlot("medium-rectangle") +
    articleCard(site, arts[1], 1) +
    articleCard(site, arts[2], 2) +
    `</section></div>` +
    `<aside class="rail">` +
    `<div class="rail-box"><h4>Trending</h4><ol>${arts.map((a, i) => `<li><a href="article.html#a${i}">${esc(a.t)}</a></li>`).join("")}</ol></div>` +
    adSlot("wide-skyscraper") +
    `</aside>`
  );
}

function articleBody(site) {
  const arts = P[site.id].articles;
  const a = arts[0];
  const paras = a.b.map((p, i) => (i === 1 ? adSlot("large-rectangle") + `<p>${esc(p)}</p>` : `<p>${esc(p)}</p>`)).join("");
  return (
    `<article class="content">` +
    adSlot("leaderboard") +
    `<h1 id="a0">${esc(a.t)}</h1><p class="dek">${esc(a.d)}</p>` +
    paras +
    `<h2>Related</h2><div class="related">${arts.slice(1).map((x, i) => articleCard(site, x, i + 1)).join("")}</div>` +
    adSlot("mobile-banner") +
    `</article>` +
    `<aside class="rail"><div class="rail-box"><h4>From ${esc(site.name)}</h4><p>${esc(site.tagline)}</p></div>` +
    adSlot("half-page") +
    `</aside>`
  );
}

function aboutBody(site, pub) {
  return (
    `<article class="content">` +
    `<h1>About ${esc(site.name)}</h1>` +
    `<p class="dek">${esc(site.kind)} · a DATUM test publisher.</p>` +
    `<p>${esc(site.name)} is a synthetic publisher used to exercise the DATUM ad exchange end-to-end on Paseo: SDK embed → on-chain auction → creative injection → claim → settlement. It is intentionally fictional.</p>` +
    `<p>This site is registered on-chain as publisher <code>${pub.address}</code> with a ${(pub.takeRateBps / 100).toFixed(0)}% take rate, targeting tags <code>${esc(pub.tags.join(", "))}</code>.</p>` +
    adSlot("square") +
    `<p>Every ad you see here is a real campaign creative pinned to IPFS and selected by a second-price auction in the DATUM browser extension. No browsing data leaves your device.</p>` +
    `</article>` +
    `<aside class="rail">${adSlot("medium-rectangle")}</aside>`
  );
}

// ── Landing page ─────────────────────────────────────────────────────────────
function landing() {
  const cards = manifest.publishers
    .map(
      (p) =>
        `<a class="netcard" href="${p.site.id}/index.html" style="--c:${p.site.accent}"><span class="nc-kind">${esc(p.site.kind)}</span><h3>${esc(p.site.name)}</h3><p>${esc(p.site.tagline)}</p><code>${p.address.slice(0, 10)}…</code></a>`,
    )
    .join("");
  const brands = manifest.brands.map((b) => `<li><strong>${esc(b.name)}</strong> — ${esc(b.tagline)}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DATUM Test Network</title><link rel="stylesheet" href="/testpages/assets/testnet.css"></head>
<body class="landing">
<div class="testbar">⚠ DATUM TEST NETWORK — synthetic publishers &amp; ads for end-to-end testing · <a href="/">datum app →</a></div>
<header class="hero"><div class="wrap">
<h1>DATUM Test Network</h1>
<p class="sub">A set of fictional publisher sites wired to the live Paseo deployment. Install the DATUM extension, open any site, and watch real campaigns settle on-chain. These pages exist only to exercise the SDK, the auction, and the settlement flow — they are not real publications.</p>
</div></header>
<main class="wrap">
<h2>Publisher sites (${manifest.publishers.length})</h2>
<div class="netgrid">${cards}</div>
<h2>Advertiser brands in rotation</h2>
<ul class="brandlist">${brands}</ul>
<h2>How to run the manual e2e test</h2>
<ol class="howto">
<li>Make sure the local IPFS node is serving creatives (<code>${esc(manifest.gateway)}</code>) and, to settle, the lab relay is running (<code>${esc(manifest.relayUrl)}</code>).</li>
<li>Build + load the DATUM extension (<code>alpha-5/extension</code>) pointed at the alpha-5 v5 addresses.</li>
<li>Open any site above. The SDK declares its ad slots; the extension classifies the page, runs a second-price auction over the active campaigns, fetches the winning creative from IPFS, and injects it at the exact IAB size.</li>
<li>Claims auto-submit to the relay, which co-signs and settles on-chain. Watch the indexer (<code>datum-labs/indexer</code>) for <code>ClaimSettled</code>.</li>
</ol>
<p class="foot-note">Full details, addresses, and the campaign↔creative map: <code>alpha-5/scripts/demo-network/README.md</code>.</p>
</main>
</body></html>`;
}

// ── Emit ─────────────────────────────────────────────────────────────────────
mkdirSync(resolve(OUT, "assets"), { recursive: true });
copyFileSync(resolve(ROOT, "sdk", "datum-sdk.js"), resolve(OUT, "assets", "datum-sdk.js"));
writeFileSync(resolve(OUT, "assets", "testnet.css"), CSS());
writeFileSync(resolve(OUT, "index.html"), landing());

for (const pub of manifest.publishers) {
  const site = pub.site;
  const d = resolve(OUT, site.id);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, "index.html"), shell(site, pub, { title: site.name, active: "index", body: homeBody(site) }));
  writeFileSync(resolve(d, "article.html"), shell(site, pub, { title: P[site.id].articles[0].t, active: "article", body: articleBody(site) }));
  writeFileSync(resolve(d, "about.html"), shell(site, pub, { title: "About", active: "about", body: aboutBody(site, pub) }));
  console.log(`  ${site.id}: index.html article.html about.html`);
}
console.log(`\n✓ Built ${manifest.publishers.length} test sites (3 pages each) + landing → web/public/testpages/`);

function CSS() {
  return `:root{--accent:#5b8cff;--bg:#0b1020;--fg:#e9eeff;--muted:rgba(255,255,255,.6);--card:rgba(255,255,255,.04);--line:rgba(255,255,255,.1)}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.testbar{background:repeating-linear-gradient(45deg,#3a2a00,#3a2a00 12px,#332500 12px,#332500 24px);color:#ffd479;font-size:13px;padding:7px 14px;text-align:center;border-bottom:1px solid #5a4400;position:sticky;top:0;z-index:50}
.testbar code{background:rgba(255,212,121,.15);padding:1px 5px;border-radius:4px}.testbar a{color:#ffe6a8}
.site-head{border-bottom:1px solid var(--line);padding:18px 0 12px;background:linear-gradient(180deg,rgba(255,255,255,.03),transparent)}
.site-head .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font-weight:800;font-size:22px;color:var(--fg);display:flex;align-items:center;gap:9px}
.brand .dot{width:14px;height:14px;border-radius:4px;background:var(--accent)}
.site-head nav a{color:var(--muted);margin-left:18px;font-weight:600;font-size:14px}
.site-head nav a.active,.site-head nav a:hover{color:var(--fg)}
.tagline{color:var(--muted);font-size:14px;padding-top:6px}
.layout{display:grid;grid-template-columns:1fr 320px;gap:32px;padding:28px 20px 48px}
.content{min-width:0}.lede{font-size:26px;font-weight:800;margin:18px 0}
.feed{display:flex;flex-direction:column;gap:18px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h3{margin:0 0 6px;font-size:19px;color:var(--fg)}.card p{margin:0;color:var(--muted)}.card .more{color:var(--accent);font-weight:600;font-size:14px}
.related{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:10px 0 22px}
h1{font-size:30px;line-height:1.2;margin:14px 0 8px}.dek{color:var(--muted);font-size:18px;margin:0 0 18px}
.content p{margin:0 0 16px}.content h2{margin:26px 0 10px}
.rail{display:flex;flex-direction:column;gap:20px}
.rail-box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.rail-box h4{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.rail-box ol{margin:0;padding-left:18px}.rail-box li{margin:6px 0}
.rail-box a{color:var(--fg)}
figure.ad{margin:18px 0;display:flex;flex-direction:column;align-items:center;gap:5px}
figure.ad .ad-cap{font-size:10px;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);opacity:.7}
figure.ad .ad-fmt{opacity:.6}
figure.ad>div[data-datum-slot]{outline:1px dashed var(--line);outline-offset:4px;border-radius:6px;min-height:24px;display:flex;align-items:center;justify-content:center}
.site-foot{border-top:1px solid var(--line);padding:24px 0;color:var(--muted);font-size:13px;margin-top:24px}
.site-foot code{background:var(--card);padding:1px 6px;border-radius:5px;font-size:12px}
.foot-pub{margin-bottom:8px}.foot-net a{margin-right:14px}.foot-note{margin-top:12px;opacity:.8;max-width:760px}
/* landing */
.landing{background:#0a0e1a}
.hero{padding:48px 0 28px;border-bottom:1px solid var(--line)}
.hero h1{font-size:40px;margin:0 0 12px}.hero .sub{color:var(--muted);font-size:18px;max-width:780px}
.netgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;margin:14px 0 34px}
.netcard{display:block;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:14px;padding:18px}
.netcard .nc-kind{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--c);font-weight:700}
.netcard h3{margin:6px 0 6px;color:#fff;font-size:20px}.netcard p{margin:0 0 10px;color:var(--muted)}
.netcard code{font-size:12px;color:var(--muted)}
.brandlist{columns:2;gap:24px;color:var(--muted)}.brandlist strong{color:var(--fg)}
.howto{color:var(--muted);max-width:820px}.howto code{background:var(--card);padding:1px 6px;border-radius:5px;color:var(--fg);font-size:13px}
h2{font-size:22px;margin:28px 0 12px}
@media(max-width:820px){.layout{grid-template-columns:1fr}.related{grid-template-columns:1fr}.brandlist{columns:1}}`;
}
