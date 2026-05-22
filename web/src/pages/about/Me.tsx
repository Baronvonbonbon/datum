import { AboutTemplate, DefList } from "./AboutTemplate";

export function AboutMe() {
  return (
    <AboutTemplate
      icon="👤"
      persona="Me"
      accent="var(--role-user, #a78bfa)"
      tagline={
        "The wallet-scoped view of your DATUM activity. Every page under /me " +
        "reads only the chain state tied to your connected wallet — claim " +
        "history, identity proofs, assurance tier, and any dust-recovery " +
        "credits the protocol owes you. Browse without a wallet for the " +
        "public Explorer; connect a wallet to populate the Me pages."
      }
      whatYouGet={[
        "A single dashboard for everything DATUM remembers about your wallet.",
        "Settlement history with per-claim breakdown — which campaign, which publisher, how much DOT, how much ERC-20 token.",
        "Identity controls: People Chain verification status, ZK proof generation, refresh flow.",
        "Assurance tier display — what features your current assurance level unlocks.",
        "Dust recovery for sub-existential-deposit balances that would otherwise be unreachable.",
      ]}
      primaryCta={{ label: "Open Me Dashboard", to: "/me" }}
      secondaryCta={{ label: "Browse public Explorer", to: "/explorer" }}
      contracts={[
        "settlement",
        "paymentVault",
        "tokenRewardVault",
        "peopleChainIdentity",
        "peopleChainBondedReporter",
        "publisherStake",
        "challengeBonds",
      ]}
      related={[
        { label: "Identity deep dive", to: "/about/identity" },
        { label: "Governance", to: "/about/governance" },
      ]}
      sections={[
        {
          heading: "The pages, in order",
          body: (
            <DefList items={[
              { term: "/me", def: "Dashboard. Connected wallet summary, recent claims, balances across DOT and any ERC-20 reward tokens credited to you." },
              { term: "/me/history", def: "Full settlement history. Every ClaimSettled event tied to your address, with the campaign, publisher, batch hash, and DOT split." },
              { term: "/me/identity", def: "People Chain identity status. Trigger a verification refresh (XCM-dispatched), view your current proof, and see which features your verification unlocks." },
              { term: "/me/assurance", def: "Assurance tier breakdown. DATUM's CB7 system gates higher-value features behind progressively stricter identity proofs — this page shows what your current tier permits and what the next tier requires." },
              { term: "/me/dust", def: "Dust recovery. Below the existential deposit, balances are otherwise unreachable. Datum's dust-recovery flow batches them into a withdrawable claim." },
            ]} />
          ),
        },
        {
          heading: "What gets stored on-chain — and what doesn't",
          lead: "DATUM minimizes what your wallet address ever touches on-chain. Some things, by necessity, are public.",
          body: (
            <>
              <p>
                Every <code>ClaimSettled</code> event includes your wallet
                address as the user being paid. That is the durable, public
                record of your participation — the chain has to know who to
                credit. The <em>contents</em> of what you saw are not
                recorded: only a claim hash and (optionally) a ZK proof that
                the impression count was valid.
              </p>
              <p>
                Your interest profile, browsing history, ad selection
                rationale, and ZK user secret all live exclusively in your
                browser extension. They never transit any DATUM server. The
                only network traffic from the extension is settlement
                transactions and (when enabled) the publisher attestation
                round-trip — both of which DATUM's design assumes are
                public-by-default.
              </p>
            </>
          ),
        },
        {
          heading: "Pull payments, always",
          body: (
            <p>
              Every reward DATUM owes you accumulates in a pull-payment vault
              and waits for you to withdraw it. Nothing is pushed to your
              address mid-session. This protects against two threats: it
              prevents on-chain dust accumulation from blocking withdrawals,
              and it eliminates a side-channel where someone could time their
              transaction to land in the same block as a known user. You
              withdraw on your own schedule, in your own batches.
            </p>
          ),
        },
      ]}
    />
  );
}
