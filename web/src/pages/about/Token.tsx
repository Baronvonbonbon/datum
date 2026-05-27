import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutToken() {
  return (
    <AboutTemplate
      icon="🪙"
      persona="DATUM Token"
      accent="#f59e0b"
      tagline={
        "DATUM operates with DOT as the primary settlement currency, but " +
        "ships a parallel ERC-20 token plane — the protocol's own native " +
        "token — for protocol-aligned rewards, staking, and fee-sharing. " +
        "The token plane is fully upgradable during alpha/beta and " +
        "lock-once cypherpunk after OpenGov ratification — see the Phase " +
        "Ladder for the timeline. (For advertiser-funded per-campaign " +
        "ERC-20 rewards in any third-party token, see Sidecar Rewards.)"
      }
      whatYouGet={[
        "DATUM, the protocol's own ERC-20, minted alongside DOT settlement under a cap-controlled mint authority.",
        "A wrapper contract that mints DATUM with a commit-fund-claim flow that resists price-front-run on mint.",
        "Linear-vesting tooling for treasury and team allocations on the same plane.",
        "Fee-share contract that routes a configurable share of settlement fees to DATUM stakers.",
        "Mint coordinator that orchestrates per-batch DATUM emission alongside DOT settlement.",
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
      ]}
      related={[
        { label: "Sidecar Rewards (third-party ERC-20s)", to: "/about/rewards" },
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
      ]}
    />
  );
}
