export function Philosophy() {
  const SectionHeader = ({ children }: { children: React.ReactNode }) => (
    <div style={{
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: "0.12em",
      textTransform: "uppercase" as const,
      color: "var(--text-muted)",
      borderBottom: "1px solid var(--border)",
      paddingBottom: 8,
      marginBottom: 18,
    }}>
      {children}
    </div>
  );

  const P = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <p style={{ fontSize: 14, lineHeight: 1.75, color: "var(--text)", margin: 0, ...style }}>
      {children}
    </p>
  );

  return (
    <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 40 }}>

      <div className="nano-fade">
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
          Why I Built This
        </h1>
        <P style={{ color: "var(--text-muted)", fontSize: 13 }}>
          A manufacturing engineer's unsolicited opinion on the future of the internet.
        </P>
      </div>

      <div className="nano-fade">
        <SectionHeader>The Honest State of Web3</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <P>
            Let's be honest: a lot of web3 has been hype dressed up in whitepapers. NFTs of cartoon monkeys
            promised to reshape ownership. DeFi promised to democratize finance while mostly just creating new
            ways to get rugged. The underlying technology is genuinely remarkable — and it has mostly been used
            to make finance more complicated, not less.
          </P>
          <P>
            I'm not a cryptobro. I rather dislike finance. I'm an engineer from the manufacturing industry. I
            like solving concrete problems with capable tools, and I find it frustrating when a capable tool gets
            co-opted by the loudest voices in the room before anyone's figured out what it's actually good for.
          </P>
          <P>
            I think it would be a genuine shame if this technology's legacy is JPEGs and yield farming. There's
            a better use waiting.
          </P>
        </div>
      </div>

      <div className="nano-fade">
        <SectionHeader>Where the Inspiration Comes From</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <P>
            I look to my children for inspiration. They're young, curious, happy kids, and I want them to have
            a healthy relationship with technology. What I see instead is that they're already being shaped —
            their attention captured, their decisions nudged — by the very tools they need to learn to use.
            That's not the fault of any one company. It's structural. The business model demands it.
          </P>
          <P>
            The old saying goes: <em>if you're not paying for the product, you are the product.</em> That was
            always a bit cynical. Now it's just a description of how the internet works.
          </P>
          <P>
            The question I kept coming back to: is there a version of this that doesn't require exploiting
            people to function?
          </P>
        </div>
      </div>

      <div className="nano-fade">
        <SectionHeader>The Monetization Problem</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <P>
            Here's the inconvenient part of building a better internet: someone still has to pay for it. Content
            costs money to produce. Infrastructure costs money to run. Idealism doesn't cover hosting bills.
          </P>
          <P>
            So you need a monetization system. Targeted advertising is one that actually works — it's familiar,
            it's scalable, and advertisers have already budgeted for it. The problem isn't that advertising
            exists. The problem is the model that powers it: surveil users, build profiles without consent, sell
            attention without compensation, and optimize for engagement regardless of harm.
          </P>
          <P>
            Web3 changes that dynamic. With cryptographic attestations and on-chain settlement, you can build a
            system where:
          </P>
          <ul style={{ fontSize: 14, lineHeight: 1.75, color: "var(--text)", paddingLeft: 22, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>Users retain their privacy — their preferences stay on their device, not in a database.</li>
            <li>Advertisers know exactly where their campaigns are running, verified on-chain.</li>
            <li>Publishers control what their audience is exposed to, with no intermediary overriding that.</li>
            <li>Users are compensated for their attention — not with points, but with something actually useful.</li>
          </ul>
          <P>
            Exploitation isn't a necessary cost of doing business. It's just how the incumbent model was
            designed, before better tools existed.
          </P>
        </div>
      </div>

      <div className="nano-fade">
        <SectionHeader>Tokens as Raw Materials</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <P>
            My view on tokens is probably unpopular in some circles: a web3 token with genuine utility is a
            commodity. It's a raw material — used in the manufacture or processing of something that has higher
            value than the input. Steel isn't exciting. It's useful.
          </P>
          <P>
            If you're building a new digital service and you have a dedicated token, it makes sense to seed your
            users with a small amount when they engage with your platform. Not as a bribe, not as speculation
            fuel — as the literal material they need to participate. A user who earns tokens for real viewership
            work and then spends them on a service that requires those tokens is a user who has organically
            onboarded into your ecosystem.
          </P>
          <P>
            The migration path writes itself: build the ad platform → seed end users with tokens through passive
            engagement → promote the goods and services already available in web3 → make it easier for
            traditional products to migrate across. End users can cover their entire web3 migration through
            passive viewership, progressively learning and becoming stewards of their own intentional agency.
            No one needs to understand cryptography to earn their first PAS.
          </P>
        </div>
      </div>

      <div className="nano-fade">
        <SectionHeader>Why Polkadot</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <P>
            I've studied blockchain networks for over ten years. Most of them solve one problem and create two
            others. Polkadot struck me as the project that actually thought about the hard parts before shipping.
          </P>
          <P>
            It tackled scalability without sacrificing security, built a clear path to upgradeability without
            hard forks, and has remained consistently among the top two or three projects by GitHub commits and
            feature development — through bear markets, through the NFT mania, through all of it. That tells me
            it's being built as a long-term project by people who mean it.
          </P>
          <P>
            Practically: Polkadot Hub is low-cost to deploy on today, with a clearly defined runway to
            tens-of-thousands of TPS when the time comes. A project at this stage could run on almost any chain.
            But if it happens to grow, the upgrade path exists — and it doesn't require a painful token
            migration to get there.
          </P>
          <P>
            There's also the distribution angle. I like the idea of being as resilient as possible to single
            points of failure. Polkadot has prebuilt light clients — smoldot — that let a browser connect
            directly to the network without trusting an RPC provider. Skipping the middleware entirely is a
            meaningful step toward a system that doesn't depend on any company staying online and honest.
          </P>
        </div>
      </div>

      <div className="nano-fade">
        <SectionHeader>The Summary</SectionHeader>
        <div className="nano-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <P>
            I built this because I wanted a content monetization system that eliminates the need for
            surveillance, doesn't require trusting a platform with your attention data, and gives users a
            genuine reason to engage — or not — with the ads they're shown.
          </P>
          <P>
            Privacy, properly understood, is the right to selectively disclose information about yourself. Not
            the absence of information, but control over it. You should be able to prove you watched an ad
            without revealing who you are. You should be able to earn a reward without it being recorded in a
            database you don't control.
          </P>
          <P>
            I believe many legacy systems can be made more efficient, more transparent, and more fair with this
            technology. The targeted ad system is just one place to start — one that happens to sit at the
            intersection of every other problem: onboarding, compensation, privacy, trust, and distribution.
          </P>
          <P>
            It's early. The runway is long. But someone has to build the first thing.
          </P>
        </div>
      </div>

    </div>
  );
}
