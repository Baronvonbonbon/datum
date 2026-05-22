import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutPublisher() {
  return (
    <AboutTemplate
      icon="🌐"
      persona="Publisher"
      accent="var(--role-publisher, #34d399)"
      tagline={
        "Publishers are the surface DATUM advertises on. Register an " +
        "address, declare your tags, post a stake, drop the SDK on your " +
        "site, and the protocol routes matching campaigns to you. Every " +
        "settled impression pays you a configurable take-rate on the CPM, " +
        "credited to a pull-payment vault you can withdraw at any time."
      }
      whatYouGet={[
        "A configurable take rate (30–80%) negotiated at registration, locked per campaign at activation time.",
        "Per-publisher allowlist if you want to curate which advertisers can run on you, or open marketplace mode if you want maximum throughput.",
        "Reputation score that grows passively as settlements accept; unlocks access to higher-value campaigns over time.",
        "A bonded stake that scales with your impression volume — small for hobbyist sites, larger as you grow, slashable if fraud is upheld against you.",
        "SDK that's a single script tag and one div — no ad server, no tracking pixels, no cookie banners.",
      ]}
      primaryCta={{ label: "Register as Publisher", to: "/publisher/register" }}
      secondaryCta={{ label: "SDK setup", to: "/publisher/sdk" }}
      contracts={[
        "publishers",
        "publisherStake",
        "publisherReputation",
        "publisherGovernance",
        "tagSystem",
        "settlementRateLimiter",
        "campaignAllowlist",
        "settlement",
        "paymentVault",
        "relay",
      ]}
      related={[
        { label: "Advertiser deep dive", to: "/about/advertiser" },
        { label: "Protocol", to: "/about/protocol" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/publisher", def: "Dashboard. Stake status, current take rate, reputation score, recent settlements, withdrawable balance." },
              { term: "/publisher/register", def: "First-time setup. Configure take rate, declare tags, generate a relay signer address." },
              { term: "/publisher/stake", def: "Stake management. Stake is a bonding curve — required collateral scales with cumulative impressions. Top up or withdraw within limits." },
              { term: "/publisher/categories", def: "Tag declaration. Pick from the curated tag dictionary. Tags determine which open campaigns can match you." },
              { term: "/publisher/allowlist", def: "Per-campaign allow/deny — accept specific advertisers, block specific campaigns. Empty allowlist = open marketplace." },
              { term: "/publisher/rate", def: "Adjust take rate (within governance-set bounds). New rate applies to future activations only, not in-flight campaigns." },
              { term: "/publisher/earnings", def: "Withdraw accrued DOT from the PaymentVault. Pull payment — your schedule, your batches." },
              { term: "/publisher/sdk", def: "SDK installation. Copy the snippet, paste it into your site's HTML, you're done." },
              { term: "/publisher/profile", def: "Public profile metadata — display name, contact, URL. Optional but helpful for advertisers running open campaigns." },
            ]} />
          ),
        },
        {
          heading: "Three settlement paths",
          lead: "Publishers don't all submit settlement the same way. Pick the one that fits your operational posture.",
          body: (
            <>
              <p>
                <strong>Direct path.</strong> Your site runs the SDK and a
                small relay you operate. Users hand signed claim batches to
                your relay; your relay submits to Settlement with a publisher
                cosig. You pay the gas; the take-rate covers it for any
                reasonable batch size.
              </p>
              <p>
                <strong>Dual-sig path.</strong> Advertiser and publisher both
                cosign the batch directly to Settlement. Either side can
                refute by withholding their signature. Useful when you have
                a direct integration with an advertiser and want to skip the
                relay entirely.
              </p>
              <p>
                <strong>Bonded DatumRelay.</strong> A permissionless,
                third-party relay operator submits batches on the user's
                behalf. The operator posts a relayStake bond and earns a
                small per-settlement fee. Users get gas-free claims; you
                still earn your take rate. Misbehaviour is governed by
                RelayGovernance and slashable.
              </p>
            </>
          ),
        },
        {
          heading: "Reputation is a passive asset",
          body: (
            <p>
              Every settlement updates your PublisherReputation score, which
              records the ratio of accepted to rejected claims. The
              anomaly-detection threshold is set in basis points by
              governance. A clean publisher with a long history sees more
              high-value campaigns gravitate toward them; a publisher whose
              rejection rate exceeds the global rate by more than 2× is
              flagged. The score is on-chain and readable by anyone
              evaluating you as a partner.
            </p>
          ),
        },
      ]}
    />
  );
}
