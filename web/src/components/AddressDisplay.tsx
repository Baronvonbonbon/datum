import { useState } from "react";

interface Props {
  address: string;
  chars?: number; // chars to show on each side (default 6)
  mono?: boolean;
  style?: React.CSSProperties;
}

export function AddressDisplay({ address, chars = 6, mono = true, style }: Props) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const truncated = `${address.slice(0, chars + 2)}…${address.slice(-4)}`;

  return (
    <span
      onClick={handleCopy}
      title={`${address} — click to copy`}
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
