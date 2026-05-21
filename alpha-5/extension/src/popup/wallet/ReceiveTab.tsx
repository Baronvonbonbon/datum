// Receive tab — show the active account's address + a QR code.
//
// QR generated via `qrcode` package (CommonJS, ~30 KB compressed).
// We render to an SVG string so the result is crisp at any popup size
// without bringing canvas into the bundle.

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { WalletStatus } from "./walletClient";
import { heading, subText, card, mono, button } from "./styles";

export function ReceiveTab({ status }: { status: WalletStatus }) {
  const [qrSvg, setQrSvg] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!status.activeAddress) return;
    let cancelled = false;
    QRCode.toString(status.activeAddress, {
      type: "svg",
      margin: 1,
      color: { dark: "#ffffff", light: "#00000000" },
      width: 220,
    })
      .then((svg) => {
        if (!cancelled) setQrSvg(svg);
      })
      .catch((err) => {
        console.error("[wallet] QR render failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [status.activeAddress]);

  if (!status.activeAddress) {
    return (
      <div style={subText}>No active account. Add one on the Accounts tab.</div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(status.activeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API requires a user gesture in some contexts; if it
      // fails we just leave the visual state alone.
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}>
      <div style={{ ...heading, fontSize: 13 }}>Receive</div>
      <div style={subText}>
        Scan or copy this address to receive DOT and ERC-20 tokens on
        Polkadot Hub.
      </div>

      <div
        style={{
          ...card,
          display: "flex",
          justifyContent: "center",
          padding: 10,
        }}
      >
        {qrSvg ? (
          <div
            dangerouslySetInnerHTML={{ __html: qrSvg }}
            style={{ display: "block" }}
          />
        ) : (
          <div style={{ ...subText, padding: 60 }}>Rendering QR…</div>
        )}
      </div>

      <div style={{ ...card, ...mono, fontSize: 11, wordBreak: "break-all" }}>
        {status.activeAddress}
      </div>

      <button style={button("primary")} onClick={copy}>
        {copied ? "Copied!" : "Copy address"}
      </button>
    </div>
  );
}
