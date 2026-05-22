import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutGovernance() {
  return (
    <AboutTemplate
      icon="⚖️"
      persona="Governance"
      accent="var(--role-voter, #fbbf24)"
      tagline={
        "DATUM governance is conviction-weighted, multi-track, and " +
        "designed so that the cost of approving a bad campaign exceeds " +
        "the reward of being right when one is good. Stake DOT with a " +
        "lockup multiplier on campaigns you've reviewed; earn from " +
        "slash pools when you're right; pay a slash when you're wrong."
      }
      whatYouGet={[
        "Conviction-weighted voting on campaign activation, with payouts from slash pools when nay-votes correctly terminate fraudulent campaigns.",
        "Bicameral parameter changes — Council can propose, but a veto window gives OpenGov time to block bad parameter changes.",
        "Separate tracks for publisher fraud, advertiser fraud, and protocol parameter changes — different evidence, different quorums.",
        "Activation bonds: every campaign creation deposits a small refundable bond; bond bonus flows to challengers if fraud is upheld.",
        "Public phase ladder showing exactly which contracts are still upgradable and which are locked.",
      ]}
      primaryCta={{ label: "Open Governance", to: "/governance" }}
      secondaryCta={{ label: "Phase ladder", to: "/governance/phase-ladder" }}
      contracts={[
        "governanceV2",
        "governanceRouter",
        "council",
        "timelock",
        "publisherGovernance",
        "advertiserGovernance",
        "parameterGovernance",
        "activationBonds",
        "challengeBonds",
        "blocklistCurator",
      ]}
      related={[
        { label: "Protocol", to: "/about/protocol" },
        { label: "Token plane", to: "/about/token" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/governance", def: "Dashboard. Pending campaigns awaiting activation, open votes, recent decisions." },
              { term: "/governance/activation-bonds", def: "View / claim refundable activation bonds for campaigns you created or challenged." },
              { term: "/governance/advertiser-fraud", def: "Open and vote on advertiser-fraud claims. Stake-weighted; upheld fraud slashes the advertiser stake." },
              { term: "/governance/publisher-fraud", def: "Same shape, publisher direction. Upheld fraud slashes the publisher stake; bond bonus flows to challenge-bond pool." },
              { term: "/governance/council", def: "Council membership, quorum, current proposals. Phase-1 fast-path governance for contracts not yet under OpenGov." },
              { term: "/governance/parameters", def: "Tunable protocol parameters — CPM floor, conviction weights, slash %, quorum thresholds, take-rate bounds." },
              { term: "/governance/phase-ladder", def: "Per-contract phase status — Phase 0 / 1 / 2 and lock state. The lock-once cypherpunk timeline lives here." },
              { term: "/governance/my-votes", def: "Wallet-scoped: your open votes, your lockups, your unlockable balance, your claim-the-slash pool credits." },
            ]} />
          ),
        },
        {
          heading: "Conviction voting in one paragraph",
          lead: "Higher conviction = more voting power, longer lockup, more slash exposure if you're wrong.",
          body: (
            <p>
              Conviction levels run 0–8 with weights{" "}
              <code>[1, 2, 3, 4, 6, 9, 14, 18, 21]</code> and lockups{" "}
              <code>[0, 1d, 3d, 7d, 21d, 90d, 180d, 270d, 365d]</code>.
              A vote of 1 DOT at conviction 8 counts as much as 21 DOT
              at conviction 0, but the DOT is locked for a full year and
              the slash exposure on a loss scales with the same weight.
              The system makes long-term stakeholders meaningfully more
              powerful than drive-by voters, without ever requiring you
              to give up custody.
            </p>
          ),
        },
        {
          heading: "Bicameral with a veto window",
          body: (
            <p>
              The Council can propose changes quickly. Every Council
              proposal includes a configurable veto window — OpenGov can
              block it before it executes. This is the practical
              compromise that keeps DATUM operational during the
              upgrade-heavy alpha/beta window without giving a small
              committee unilateral parameter-change power. Once a
              contract enters Phase 2 (OpenGov-direct), the veto window
              dissolves and OpenGov is the sole governor.
            </p>
          ),
        },
      ]}
    />
  );
}
