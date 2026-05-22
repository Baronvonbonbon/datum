import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutIdentity() {
  return (
    <AboutTemplate
      icon="🪪"
      persona="Identity"
      accent="#a78bfa"
      tagline={
        "DATUM uses Polkadot's People Chain for identity rather than " +
        "rolling its own. Verification happens off-chain; DATUM reads " +
        "a cached proof from People Chain via XCM and uses it to gate " +
        "higher-assurance features. Combined with ZK tooling, the system " +
        "gives advertisers humanity guarantees without users having to " +
        "expose who they are."
      }
      whatYouGet={[
        "People Chain identity bridge — refresh, cache, and verify your identity proof without leaving DATUM.",
        "Assurance tier system — features unlock progressively as your identity proof strengthens.",
        "ZK tooling — generate impression nullifiers and identity proofs entirely in-browser; no server sees your secret.",
        "Bonded fast-path reporter for low-latency identity refresh during peak settlement traffic.",
        "Identity is optional — most settlement paths work without it, but higher-value tiers gate behind it.",
      ]}
      primaryCta={{ label: "Open Identity Dashboard", to: "/identity" }}
      secondaryCta={{ label: "People Chain bridge", to: "/identity/people-chain" }}
      contracts={[
        "peopleChainIdentity",
        "peopleChainXcmBridge",
        "peopleChainBondedReporter",
        "identityVerifier",
        "nullifierRegistry",
      ]}
      related={[
        { label: "Me dashboard", to: "/about/me" },
        { label: "Protocol", to: "/about/protocol" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/identity", def: "Dashboard. Current verification status across all assurance tiers, time-to-stale countdown on the cached proof." },
              { term: "/identity/people-chain", def: "People Chain bridge. Trigger an XCM-dispatched verification refresh, see pending requests, view the bonded-reporter fast-path." },
              { term: "/identity/zk", def: "ZK tooling. Generate impression nullifiers, ZK identity proofs, witness commitments — all in-browser via the snarkjs runtime." },
              { term: "/me/identity", def: "Wallet-scoped identity view. Same status as /identity, scoped to your address. Lives under /me for personal-context tasks." },
              { term: "/me/assurance", def: "Tier breakdown. What you've unlocked, what the next tier requires, what features each tier permits." },
            ]} />
          ),
        },
        {
          heading: "Why People Chain, not a DATUM-native identity",
          lead: "DATUM ships ad infrastructure, not identity infrastructure.",
          body: (
            <p>
              Polkadot's People Chain already provides on-chain identity
              with KYC partners, judgement levels, and a public proof
              format. DATUM caches a reference to your People Chain
              identity via XCM and reads its judgement level when gating
              features. This avoids the trap of every protocol building
              its own identity layer, lets users keep one identity across
              the ecosystem, and means DATUM never custodies KYC data.
              The bonded-reporter pattern handles the latency mismatch
              between XCM refresh and real-time settlement traffic.
            </p>
          ),
        },
        {
          heading: "ZK is privacy, not anti-fraud",
          body: (
            <p>
              The ZK tooling is for users who want to <em>prove</em> they
              are a unique human without revealing <em>which</em> human.
              Identity verification anchors the strong claim ("a verified
              People Chain user did this"); ZK proofs anchor the
              privacy-preserving claim ("a verified human did this,
              without saying which one"). The combination is more useful
              than either alone: advertisers get bot-resistant
              attribution, users keep their browsing patterns invisible.
            </p>
          ),
        },
      ]}
    />
  );
}
