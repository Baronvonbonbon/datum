import { useEffect, useRef, useState } from "react";
import { parseDOT, formatDOT } from "@shared/dot";

// Paseo testnet faucet. Same base URL used on the Demo page — the faucet UI
// asks the user to pick the "Paseo" network, so we nudge that in the copy.
const FAUCET_URL = "https://faucet.polkadot.io/";

// Below this, you can't pay for gas on anything interesting. parseDOT("1")
// == 10^10 planck == 1.000 PAS.
const MIN_PLANCK = parseDOT("1");

interface Props {
  /** Connected wallet address (checksummed 0x…). */
  address: string;
  /** Native balance in planck, or null while loading / on read failure. */
  balancePlanck: bigint | null;
  /** Currency symbol for the active network (e.g. "PAS"). */
  sym: string;
}

/**
 * A curt, cheeky nag that pops up on pages where you'll need gas — surfaced
 * only when the connected wallet is too broke to transact (< 1.000 PAS).
 * Links to the faucet, copies your address in one tap, dismissable, and
 * vanishes on its own the moment the balance clears the bar.
 */
export function LowBalanceNag({ address, balancePlanck, sym }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  // Track funded state across renders so we can auto-rearm the nag if the
  // wallet gets funded and then drained again within the same session.
  const wasFunded = useRef(false);

  const broke = balancePlanck !== null && balancePlanck < MIN_PLANCK;

  // Reset dismissal whenever the wallet changes or it crosses back under the
  // bar after having been funded — so a freshly-emptied wallet nags again.
  useEffect(() => {
    if (balancePlanck === null) return;
    if (balancePlanck >= MIN_PLANCK) {
      wasFunded.current = true;
      setDismissed(false);
    } else if (wasFunded.current) {
      // dropped back below the line after being funded — nag once more
      wasFunded.current = false;
      setDismissed(false);
    }
  }, [balancePlanck]);

  // New wallet, fresh nag.
  useEffect(() => {
    setDismissed(false);
    wasFunded.current = false;
  }, [address]);

  if (!broke || dismissed) return null;

  function copyAddress() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 64,
        right: 16,
        zIndex: 900,
        width: 280,
        maxWidth: "90vw",
        background: "var(--bg-surface)",
        border: "1px solid var(--warn)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        padding: "12px 14px",
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--text)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span style={{ fontWeight: 700, color: "var(--warn)", letterSpacing: "0.03em" }}>
          ⛽ Tank's empty
        </span>
        <button
          onClick={() => setDismissed(true)}
          title="Dismiss"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0, marginTop: -2 }}
        >
          ×
        </button>
      </div>

      <p style={{ margin: "6px 0 10px" }}>
        {balancePlanck !== null ? formatDOT(balancePlanck) : "0.000"} {sym} won't pay the gas.
        Top up before you try anything around here.
      </p>

      <div style={{ display: "flex", gap: 6 }}>
        <a
          href={FAUCET_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="nano-btn nano-btn-accent"
          style={{ flex: 1, justifyContent: "center", fontSize: 11, padding: "5px 8px", textDecoration: "none", whiteSpace: "nowrap" }}
          title='Opens the Polkadot faucet — pick "Paseo"'
        >
          Hit the faucet ↗
        </a>
        <button
          onClick={copyAddress}
          className="nano-btn"
          style={{ flex: 1, justifyContent: "center", fontSize: 11, padding: "5px 8px", whiteSpace: "nowrap" }}
          title={address}
        >
          {copied ? "Copied ✓" : "Copy address"}
        </button>
      </div>
    </div>
  );
}
