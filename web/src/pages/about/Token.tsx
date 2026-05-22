import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutToken() {
  return (
    <AboutTemplate
      icon="🪙"
      persona="DATUM Token"
      accent="#f59e0b"
      tagline={
        "DATUM operates with DOT as the primary settlement currency, but " +
        "ships a parallel ERC-20 token plane for protocol-aligned " +
        "rewards, staking, and fee-sharing. The token plane is fully " +
        "upgradable during alpha/beta and lock-once cypherpunk after " +
        "OpenGov ratification — see the Phase Ladder for the timeline."
      }
      whatYouGet={[
        "A path to earn the protocol's native token on top of DOT — useful for projects seeding adoption of their own ERC-20.",
        "A wrapper contract that mints DATUM under cap-controlled mint authority, with the commit-fund-claim flow protecting against price-front-run.",
        "Linear-vesting tooling for treasury and team allocations on the same plane.",
        "Fee-share contract that routes a configurable share of settlement fees to DATUM stakers.",
        "Mint coordinator that orchestrates per-batch token emission alongside DOT settlement.",
      ]}
      primaryCta={{ label: "Open Token Dashboard", to: "/token" }}
      secondaryCta={{ label: "Wrapper / mint flow", to: "/token/wrapper" }}
      contracts={[
        "wrapper",
        "mintAuthority",
        "mintCoordinator",
        "emissionEngine",
        "bootstrapPool",
        "vesting",
        "feeShare",
        "tokenRewardVault",
      ]}
      related={[
        { label: "Protocol deep dive", to: "/about/protocol" },
        { label: "Governance", to: "/about/governance" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/token", def: "Dashboard. Total supply, circulating supply, mint cap remaining, fee-share balance, current phase status." },
              { term: "/token/wrapper", def: "Wrapper contract — commit-fund-claim mint flow. Users commit to a mint, fund it, then claim after the timelock elapses. Resists front-running of price-sensitive mints." },
              { term: "/token/mint-coordinator", def: "Per-batch emission orchestration. Reads the EmissionEngine to compute how many DATUM accompany each settled batch." },
              { term: "/token/bootstrap", def: "Genesis liquidity pool — phased emissions that seed initial DATUM availability and bond it to DOT for AMM bootstrap." },
              { term: "/token/vesting", def: "Linear-vesting schedules. Team / treasury / partner allocations. Cliffs + linear release." },
              { term: "/token/fee-share", def: "Routes a configurable share of settlement protocol fees to DATUM stakers proportional to stake." },
            ]} />
          ),
        },
        {
          heading: "Lock-once cypherpunk",
          lead: "Every contract on the token plane is replaceable during alpha and beta. Each one locks once OpenGov is in charge.",
          body: (
            <>
              <p>
                During alpha + beta, every token-plane contract is
                upgradable via the DatumGovernanceRouter. Deployer
                upgrades in Phase 0 (Admin), Council vote in Phase 1,
                OpenGov + 48h Timelock in Phase 2. <code>lock*()</code>
                functions exist on each contract and revert{" "}
                <code>not-opengov</code> until Phase 2 — so the system
                stays malleable while still iterating, but no human can
                "just lock it" pre-OpenGov.
              </p>
              <p>
                Once OpenGov ratifies the design, governance fires{" "}
                <code>lock*()</code> per contract. After that, MintAuthority
                is permanently capped, Wrapper is permanently wired, and
                no upgrade path remains. Original code-is-law guarantees
                become OpenGov-choice commitments rather than deployer
                promises. See the <code>/governance/phase-ladder</code>{" "}
                page for live phase status.
              </p>
            </>
          ),
        },
        {
          heading: "Per-batch token rewards alongside DOT",
          body: (
            <p>
              An advertiser can seed an ERC-20 token budget into{" "}
              <code>TokenRewardVault</code> at campaign creation. Each
              settled batch credits a configurable amount of those tokens
              to each user in addition to their DOT share. If the token
              budget runs out before DOT does, DOT settlement continues
              unaffected — token credit is a non-critical path on the
              advertiser side and a pure bonus on the user side. Users
              withdraw via the same pull-payment pattern as DOT.
            </p>
          ),
        },
      ]}
    />
  );
}
