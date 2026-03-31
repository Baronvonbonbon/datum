import { useState } from "react";

interface Props {
  address: string;
  chars?: number; // chars to show on each side (default 6)
  mono?: boolean;
  explorerBase?: string; // e.g. "https://blockscout-testnet.polkadot.io" — click opens explorer
  style?: React.CSSProperties;
}

export function AddressDisplay({ address, chars = 6, mono = true, explorerBase, style }: Props) {
  const [copied, setCopied] = useState(false);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (explorerBase && /^0x[0-9a-fA-F]{40}$/.test(address)) {
      window.open(`${explorerBase}/address/${address}`, "_blank", "noopener,noreferrer");
    } else if (!explorerBase) {
      navigator.clipboard.writeText(address).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const truncated = `${address.slice(0, chars + 2)}…${address.slice(-4)}`;
  const title = explorerBase ? `${address} — click to open in explorer` : `${address} — click to copy`;

  return (
    <span
      onClick={handleClick}
      onContextMenu={handleCopy}
      title={title}
      style={{
        cursor: "pointer",
        fontFamily: mono ? "monospace" : undefined,
        color: copied ? "var(--ok)" : "var(--accent)",
        fontSize: "inherit",
        ...style,
      }}
    >
      {copied ? "Copied!" : truncated}
    </span>
  );
}
