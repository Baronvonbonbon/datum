import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutAdvertiser() {
  return (
    <AboutTemplate
      icon="📢"
      persona="Advertiser"
      accent="var(--role-advertiser, #f97316)"
      tagline={
        "Where you create, fund, and operate advertising campaigns on " +
        "DATUM. Every campaign starts as a budget locked in escrow, gets " +
        "reviewed by governance voters, and either activates or refunds. " +
        "Once live, settlement is on-chain and visible to anyone — no " +
        "agency reporting, no opaque attribution, no surprise invoices."
      }
      whatYouGet={[
        "Create campaigns with a clear escrow model — your budget sits in a vault until impressions are actually settled.",
        "Target by tag, not by user identity. Tags are open-vocabulary and curated; you describe the audience you want, publishers self-declare which tags they fit.",
        "Optional ZK enforcement: per-campaign flag that rejects claims without a valid cryptographic impression proof, filtering bot traffic at the contract level.",
        "ERC-20 token sidecar: pair your campaign with a project token for users on top of DOT settlement — useful for protocols seeding adoption.",
        "Bulletin Chain creative storage as a censorship-resistant alternative to IPFS for sensitive creative.",
      ]}
      primaryCta={{ label: "Create a Campaign", to: "/advertiser/create" }}
      secondaryCta={{ label: "Advertiser dashboard", to: "/advertiser" }}
      contracts={[
        "campaigns",
        "budgetLedger",
        "challengeBonds",
        "activationBonds",
        "lifecycle",
        "campaignAllowlist",
        "tokenRewardVault",
        "campaignCreative",
        "tagSystem",
        "governanceV2",
      ]}
      related={[
        { label: "Publisher deep dive", to: "/about/publisher" },
        { label: "Governance", to: "/about/governance" },
        { label: "Token plane", to: "/about/token" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/advertiser", def: "Dashboard. List of your campaigns, status badges, quick links into each." },
              { term: "/advertiser/create", def: "New-campaign wizard. Budget, daily cap, CPM bid, target publisher / open tag match, creative upload, optional ZK enforcement, optional ERC-20 reward sidecar." },
              { term: "/advertiser/campaign/:id", def: "Per-campaign view. Spend-to-date, remaining budget, daily-cap utilization, list of accepted/rejected claims, governance votes, refund or terminate controls." },
              { term: "/advertiser/campaign/:id/metadata", def: "Update creative metadata (text, CTA, landing URL, images, video) — pinned to IPFS or Bulletin Chain." },
              { term: "/advertiser/campaign/:id/bulletin", def: "Bulletin Chain creative manager. Pin / renew / migrate creative to the parachain-backed censorship-resistant storage path." },
              { term: "/advertiser/analytics", def: "Cross-campaign analytics: total spend, impressions delivered, top publishers, rejection rates, governance outcomes." },
            ]} />
          ),
        },
        {
          heading: "Escrow + the activation bond",
          lead: "Your money is never just \"with the protocol.\" It's in one of three well-defined places at all times.",
          body: (
            <>
              <p>
                When you create a campaign you place two deposits: the
                campaign <strong>budget</strong> (the spend pool) and a small
                refundable <strong>activation bond</strong> in
                ChallengeBonds. The budget moves into BudgetLedger and is
                drawn down only when Settlement accepts a claim batch. The
                activation bond comes back to you when the campaign ends
                cleanly; if a publisher-fraud track upholds against your
                campaign, a portion of the bond flows to challengers as a
                bonus.
              </p>
              <p>
                If governance terminates your campaign before activation,
                the budget is refunded immediately. If governance slashes
                your campaign mid-flight, a configurable share of the
                remaining budget flows to nay-voters per the conviction
                formula. The bond returns to you in all other cases.
              </p>
            </>
          ),
        },
        {
          heading: "Open vs. targeted campaigns",
          body: (
            <p>
              A campaign can either name a specific publisher (the
              publisher must accept via their allowlist) or leave the
              publisher slot open. Open campaigns match any publisher whose
              declared tags overlap with your required tag set. The tag
              vocabulary is curated by the TagCurator role under
              governance — see <code>/protocol/tag-curator</code>. Tags are
              durable identifiers, not free-form strings; this prevents
              tag-spam attacks where a publisher claims every tag.
            </p>
          ),
        },
        {
          heading: "Why ZK enforcement is optional",
          body: (
            <p>
              ZK proofs cost users gas to generate and add latency to claim
              submission. For low-value campaigns the rate limiter + claim
              chain + governance combination is enough. For high-value or
              click-fraud-sensitive campaigns you flip the per-campaign ZK
              flag and Settlement rejects any claim without a Groth16 proof
              of impression-count validity. The proof reveals nothing about
              the user — it's a range check over a Poseidon-bound nullifier.
            </p>
          ),
        },
      ]}
    />
  );
}
