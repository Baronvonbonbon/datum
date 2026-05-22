import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutProtocol() {
  return (
    <AboutTemplate
      icon="🛠"
      persona="Protocol"
      accent="#60a5fa"
      tagline={
        "The protocol section is where you can see DATUM's internals. " +
        "Every upgradable contract, every governance parameter, every " +
        "pause category, every curated tag — visible, addressable, and " +
        "(for the privileged roles) controllable. This is the dashboard " +
        "you'd use to operate a node, audit the system, or propose a " +
        "change."
      }
      whatYouGet={[
        "Live, addressable view of every contract in the DATUM deployment — name, address, current version, last upgrade.",
        "Per-category pause registry — pause settlement without halting governance, or vice versa.",
        "Parameter governance: every tunable in the system (CPM floor, conviction weights, take-rate bounds, slash %, grace periods) is here.",
        "Tag curator: the open-vocabulary tag dictionary that publishers self-declare into.",
        "Blocklist + Sybil-defense controls, behind appropriate role checks.",
      ]}
      primaryCta={{ label: "Open Protocol Dashboard", to: "/protocol" }}
      secondaryCta={{ label: "Upgrade ladder", to: "/protocol/upgrades" }}
      contracts={[
        "governanceRouter",
        "council",
        "timelock",
        "parameterGovernance",
        "pauseRegistry",
        "tagSystem",
        "blocklistCurator",
        "powEngine",
        "publisherStake",
        "challengeBonds",
        "publisherReputation",
        "settlementRateLimiter",
        "nullifierRegistry",
      ]}
      related={[
        { label: "Governance", to: "/about/governance" },
        { label: "Token plane", to: "/about/token" },
        { label: "Identity", to: "/about/identity" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/protocol", def: "Dashboard. All ~36 contracts, current address resolved via DatumGovernanceRouter, status badges, link to per-contract pages." },
              { term: "/protocol/upgrades", def: "Upgrade ladder. Pending router upgrades, queued timelock operations, live phase of each contract, lock state." },
              { term: "/protocol/tag-curator", def: "Curated tag dictionary. Add / remove / merge tags via governance proposal." },
              { term: "/protocol/pause-registry", def: "Pause categories — emergency stop with granular scope (settlement, governance, advertiser-create, etc.)." },
              { term: "/protocol/parameter-governance", def: "Bicameral parameter changes — Council proposes, OpenGov has a veto window before execution." },
              { term: "/protocol/sybil-defense", def: "PowEngine on/off toggle and difficulty. Affects whether ClaimValidator requires PoW solutions." },
              { term: "/protocol/publisher-stake", def: "Bonding-curve parameters. Base + per-impression multiplier; sets the required-stake formula." },
              { term: "/protocol/challenge-bonds", def: "Bond sizing for advertiser challenge / activation bonds. Slash-bonus basis points." },
              { term: "/protocol/blocklist", def: "Council-delegated blocklist curator. Fast removal of egregious campaigns; subject to OpenGov override." },
              { term: "/protocol/protocol-fees", def: "Protocol fee schedule and recipient routing." },
              { term: "/protocol/timelock", def: "Timelock queue inspector. Pending operations, ETAs, cancel/execute controls." },
              { term: "/protocol/mint-authority", def: "DATUM token mint cap, recipient, and lock state." },
            ]} />
          ),
        },
        {
          heading: "The upgrade ladder",
          lead: "Every contract in DATUM is upgradable today — locked tomorrow. Two phases, one ratchet.",
          body: (
            <>
              <p>
                The DatumGovernanceRouter is the stable address every
                contract calls home to. It's owned by the Timelock. Through
                a governance-approved upgrade you can rotate the
                implementation behind any logical contract name without
                forcing every caller to re-bind.
              </p>
              <p>
                <strong>Phase 0 (Admin).</strong> Deployer is the
                governor; upgrades are instant. Used during initial
                bring-up.{" "}
                <strong>Phase 1 (Council).</strong> Council N-of-M votes
                gate upgrades — fast enough to ship fixes during beta.{" "}
                <strong>Phase 2 (OpenGov).</strong> Conviction-voted
                OpenGov referenda gate upgrades through a 48h Timelock.
              </p>
              <p>
                The phase you're on for each contract is visible at{" "}
                <code>/governance/phase-ladder</code>. Once a contract
                fires its <code>lock*()</code> function via OpenGov, that
                contract is permanently frozen — no upgrade path remains.
                Lock decisions ratify the design choices one contract at
                a time.
              </p>
            </>
          ),
        },
        {
          heading: "Pause is not a drain switch",
          body: (
            <p>
              The PauseRegistry has category granularity: an emergency
              can halt new settlement without halting governance, or
              freeze advertiser-create without affecting publisher
              withdrawals. Critically, pause cannot drain escrow — the
              budget vaults remain inviolate while paused. The pause is a
              circuit breaker against new state changes, not a treasury
              instrument.
            </p>
          ),
        },
      ]}
    />
  );
}
