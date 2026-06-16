# DATUM Publisher — copy-paste ad-slot snippets

Drop one of these into your page's HTML. Replace `0xYOUR_ADDRESS` with your
registered DATUM publisher address and set `data-tags` to describe your content
(comma-separated `dimension:value`, e.g. `topic:crypto-web3,locale:en`).

The SDK is a single self-hosted script — no build step, no external ad server.
A real ad from a visitor's DATUM extension always fills the slot; the **display
mode** below only controls how an *unfilled* slot looks when no extension is
present.

> Script URL: `https://datum.javcon.io/datum-sdk.js` (self-host a copy if you prefer).

---

## Display modes

| Mode | Unfilled slot looks like | Use when |
|------|--------------------------|----------|
| `full` (default) | DATUM house-ad banner sized to the format | you want the slot to always show something |
| `minimal` | a slim labelled placeholder frame | you want a subtle cue, no house ad |
| `silent` | nothing — the slot collapses | you want zero visual footprint unless a real ad is served |

Set the default for the whole page with `data-mode` on the `<script>` tag.
Override any single slot with `data-datum-mode` on that slot's `<div>`.

---

## 1. Full (default house-ad banner)

```html
<script src="https://datum.javcon.io/datum-sdk.js"
        data-publisher="0xYOUR_ADDRESS"
        data-tags="topic:crypto-web3,locale:en"
        data-mode="full"></script>

<div data-datum-slot="leaderboard"></div>
<div data-datum-slot="medium-rectangle"></div>
```

## 2. Minimal (slim placeholder cue)

```html
<script src="https://datum.javcon.io/datum-sdk.js"
        data-publisher="0xYOUR_ADDRESS"
        data-tags="topic:crypto-web3,locale:en"
        data-mode="minimal"></script>

<div data-datum-slot="leaderboard"></div>
<div data-datum-slot="medium-rectangle"></div>
```

## 3. Silent (collapse — no footprint)

```html
<script src="https://datum.javcon.io/datum-sdk.js"
        data-publisher="0xYOUR_ADDRESS"
        data-tags="topic:crypto-web3,locale:en"
        data-mode="silent"></script>

<div data-datum-slot="leaderboard"></div>
<div data-datum-slot="medium-rectangle"></div>
```

## Mixed — per-slot override

Page default is `minimal`; the leaderboard stays silent, the in-article unit
shows the full banner:

```html
<script src="https://datum.javcon.io/datum-sdk.js"
        data-publisher="0xYOUR_ADDRESS"
        data-tags="topic:finance,locale:en"
        data-mode="minimal"></script>

<div data-datum-slot="leaderboard" data-datum-mode="silent"></div>
<div data-datum-slot="medium-rectangle" data-datum-mode="full"></div>
```

---

## Slot formats (`data-datum-slot`)

`leaderboard` (728×90) · `medium-rectangle` (300×250) · `wide-skyscraper`
(160×600) · `half-page` (300×600) · `mobile-banner` (320×50) · `square`
(250×250) · `large-rectangle` (336×280). Defaults to `medium-rectangle`.

## Other options (optional)

- `data-excluded-tags="topic:gambling,topic:adult"` — campaigns requiring these
  tags are never shown on your page.
- `data-relay="https://relay.example.com"` — your publisher relay endpoint
  (leave off to use the default DATUM relay).
- `data-relay-mode="publisher|dualsig|datumrelay"` — settlement architecture
  hint (default `publisher`).

---

## WordPress

Use the **DATUM Publisher** plugin instead of pasting HTML:

- **Settings → Display → Ad Slot Display Mode** sets the site-wide default.
- Per slot: shortcode `[datum_slot format="leaderboard" mode="silent"]`, or the
  **Display Mode** dropdown on the DATUM Ad Slot block / widget.
