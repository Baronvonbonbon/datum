=== DATUM Publisher ===
Contributors: datumnetwork
Tags: advertising, web3, crypto, polkadot, dot, monetization, ads
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Earn DOT for verified ad impressions. Place DATUM ad slots via shortcode, block, or widget — no middlemen, no cookies.

== Description ==

**DATUM Publisher** embeds the [DATUM Publisher SDK](https://datum.network) on your WordPress site so you can earn DOT (Polkadot's native token) for every verified impression served to your visitors.

DATUM is a decentralised advertising protocol built on Polkadot Asset Hub. Advertisers lock DOT budgets on-chain and pay per verified impression. Publishers receive payment directly to their wallet — no intermediary takes a cut, no user tracking beyond on-device interest profiling.

**How it works**

1. Visitors install the DATUM browser extension.
2. The extension detects your DATUM ad slots and runs a real-time on-chain auction.
3. The winning campaign's creative is rendered in the slot.
4. The impression is settled on-chain; DOT lands in your publisher wallet.

**Features**

* Self-hosted SDK — no third-party script calls.
* Multi-slot support — place as many slots as you need; each runs an independent auction.
* Format-gated targeting — advertisers can target specific IAB slot sizes (leaderboard, medium-rectangle, etc.) using on-chain format tags.
* Three placement methods: shortcode, Gutenberg block, sidebar widget.
* Global settings with per-slot format selection.
* Publisher-side tag blacklist (excluded tags) to block unwanted ad categories.
* Zero cookies, zero third-party tracking.

**Supported ad formats (IAB standard)**

* Medium Rectangle — 300×250
* Leaderboard — 728×90
* Wide Skyscraper — 160×600
* Half Page — 300×600
* Mobile Banner — 320×50
* Square — 250×250
* Large Rectangle — 336×280

== Installation ==

1. Upload the `datum-publisher` folder to `/wp-content/plugins/`.
2. Activate the plugin in **Plugins → Installed Plugins**.
3. Go to **Settings → DATUM Publisher** and enter your publisher wallet address.
4. Place ad slots using the shortcode, block, or widget (see Usage below).

**Prerequisites**

* A wallet address registered on the DATUM Publishers contract on Polkadot Asset Hub.
* Visitors must have the [DATUM browser extension](https://datum.network) installed for ads to appear.

== Usage ==

= Shortcode =

Paste into any post, page, or text widget:

`[datum_slot format="medium-rectangle"]`
`[datum_slot format="leaderboard"]`

Available format values: `medium-rectangle`, `leaderboard`, `wide-skyscraper`, `half-page`, `mobile-banner`, `square`, `large-rectangle`.

Optional attribute: `class` — adds a custom CSS class to the slot element.

= Block Editor =

Search for **DATUM Ad Slot** in the block inserter (⊕). Select your format in the Inspector panel on the right. The block shows a live preview of the slot dimensions in the editor.

= Widget =

Go to **Appearance → Widgets**, find **DATUM Ad Slot**, and drag it into any widget area. Set an optional title and select the ad format.

== Frequently Asked Questions ==

= Do visitors need to do anything? =

Yes — visitors need the [DATUM browser extension](https://datum.network) installed. Without it, the slot element is present on the page but no ad is injected.

= Do I need to install any other software? =

No. The plugin self-hosts the DATUM SDK (`datum-sdk.js`). There are no external script dependencies loaded from third-party CDNs.

= How do I get a publisher wallet address? =

You need a wallet registered on the DATUM Publishers smart contract on Polkadot Asset Hub. Visit [datum.network](https://datum.network) for instructions.

= Can I place multiple slots per page? =

Yes. Each `[datum_slot]` shortcode, block, or widget renders an independent slot. The DATUM extension auctions each slot separately and prevents the same campaign from winning two slots on the same page.

= Can advertisers target specific slot formats? =

Yes. Advertisers add `format:leaderboard` (or any format tag) to their campaign's required tags. The extension automatically matches those campaigns only to the declared slot type.

= What tags should I add in the settings? =

Use `topic:*` tags to describe your content (e.g. `topic:defi,topic:crypto-web3`), `locale:*` for your primary language (e.g. `locale:en`), and `audience:*` for your readership. This helps advertisers find your inventory.

= How are excluded tags used? =

Any campaign that *requires* one of your excluded tags will be blocked from appearing on your site. Use this to block categories you don't want shown (e.g. `topic:gambling`).

== Screenshots ==

1. Settings page — enter your publisher address and content tags.
2. Block editor — drag-and-drop DATUM Ad Slot block with format preview.
3. Widget settings — choose format for sidebar placement.

== Changelog ==

= 1.0.0 =
* Initial release.
* Shortcode `[datum_slot]`, Gutenberg block, and sidebar widget.
* Global settings: publisher address, relay URL, page tags, excluded tags.
* Self-hosted datum-sdk.js v3.2.0 with multi-slot and format-tag support.

== Upgrade Notice ==

= 1.0.0 =
Initial release.
