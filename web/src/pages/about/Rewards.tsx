import { AboutTemplate } from "./AboutTemplate";

export function AboutRewards() {
  return (
    <AboutTemplate
      icon="🎁"
      persona="Sidecar Rewards"
      accent="#10b981"
      tagline={
        "Optional, advertiser-funded ERC-20 rewards that ride alongside DOT " +
        "settlement on any campaign. Distinct from the DATUM token plane — " +
        "the sidecar is an open lane for *any* third-party ERC-20 to be " +
        "credited per impression. Brands seed their own token budget; users " +
        "withdraw via pull-payment. The protocol stays unopinionated about " +
        "which token gets distributed."
      }
      whatYouGet={[
        "A clean way to layer your project's own ERC-20 on top of DOT settlement — adoption-seeding, point systems, loyalty tokens.",
        "A pull-payment vault that holds the budget and pays users only when they call withdraw, so no balance dust is left on the protocol.",
        "Non-critical credit path: if the token budget runs out before DOT does, DOT settlement keeps working unaffected.",
        "Per-campaign configuration on Create Campaign — pick the token, pick the per-impression amount, fund the vault, done.",
      ]}
      primaryCta={{ label: "Withdraw earned tokens", to: "/me/history" }}
      secondaryCta={{ label: "Seed rewards on a new campaign", to: "/advertiser/create" }}
      contracts={["tokenRewardVault"]}
      related={[
        { label: "DATUM Token (the native plane)", to: "/about/token" },
        { label: "Advertiser deep dive", to: "/about/advertiser" },
        { label: "Me (where you withdraw)", to: "/about/me" },
      ]}
      sections={[
        {
          heading: "How it differs from the DATUM token plane",
          body: (
            <>
              <p>
                The DATUM token plane (<code>/about/token</code>) is the
                protocol's own native ERC-20 — minted under a single capped
                authority, governed end-to-end by Datum governance, and
                eventually lock-once after OpenGov. There is exactly one
                DATUM.
              </p>
              <p>
                Sidecar rewards are the opposite shape: any ERC-20 anyone has
                already deployed (USDT on Asset Hub, a brand's own loyalty
                token, anything that conforms to the standard) can be
                attached to a campaign. The protocol holds the budget in
                <code> DatumTokenRewardVault</code> and credits per-user
                balances on each settled batch. There can be thousands of
                tokens flowing through the same vault concurrently — one per
                campaign that opts in.
              </p>
            </>
          ),
        },
        {
          heading: "Mechanics",
          body: (
            <>
              <p>
                An advertiser sets two optional fields at campaign creation:
                <code> rewardToken</code> (the ERC-20 address) and
                <code> rewardPerImpression</code> (units credited per
                settled impression). The vault is pre-funded by the
                advertiser approving + depositing the token before the
                campaign goes Active.
              </p>
              <p>
                On each settled batch <code>DatumSettlement</code> calls
                <code> DatumTokenRewardVault.creditReward()</code> with the
                user, the token, and the amount. That call is
                <i> non-critical</i>: if it reverts (e.g. token budget
                exhausted) the DOT settlement still completes. Users see
                their accumulated balance per token under their account
                history and can pull anytime via <code>withdraw(token)</code>.
              </p>
              <p>
                On Paseo, the most common sidecar token is the USDT
                precompile at <code>0x0000…0001200000</code> — but any ERC-20
                works.
              </p>
            </>
          ),
        },
        {
          heading: "Who touches what",
          body: (
            <ul style={{ paddingLeft: 20, margin: 0, lineHeight: 1.7 }}>
              <li><b>Advertiser</b> — configures + funds at <code>/advertiser/create</code>.</li>
              <li><b>Settlement contract</b> — credits per batch (no user action).</li>
              <li><b>User</b> — sees accrued balances and withdraws at <code>/me/history</code>.</li>
              <li><b>Token plane</b> — completely uninvolved. Sidecar rewards never mint DATUM.</li>
            </ul>
          ),
        },
      ]}
    />
  );
}
