// ContractsTouched — small footer surfaced on every action page that
// lists the contracts the page reads from or writes to, with
// Blockscout deep links and hover tooltips explaining each contract's
// role. Makes the on-chain surface area transparent without requiring
// the user to dig through /protocol pages.

import { useSettings } from "../context/SettingsContext";
import { getExplorerUrl } from "@shared/networks";
import { CONTRACT_CATALOG, type ContractKey } from "@shared/contractCatalog";

export function ContractsTouched({
  contracts,
  note,
}: {
  contracts: ContractKey[];
  /// Optional one-line clarifier above the list (e.g. "Reads + writes:").
  note?: string;
}) {
  const { settings } = useSettings();
  const explorerBase = getExplorerUrl(settings.network);
  const items = contracts
    .map((key) => {
      const entry = CONTRACT_CATALOG[key];
      const addr = settings.contractAddresses[key];
      if (!entry || !addr) return null;
      return { key, name: entry.name, blurb: entry.blurb, addr };
    })
    .filter((x): x is { key: ContractKey; name: string; blurb: string; addr: string } => x !== null);

  if (items.length === 0) return null;

  return (
    <div
      className="nano-fade"
      style={{
        marginTop: 36,
        padding: "14px 16px",
        borderTop: "1px solid var(--border)",
        background: "transparent",
        fontSize: 11,
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono, ui-monospace)",
        lineHeight: 1.7,
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>
        {note ?? "Contracts touched on this page"}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
        {items.map((it) => (
          <ContractChip key={it.key} name={it.name} blurb={it.blurb} addr={it.addr} explorerBase={explorerBase} />
        ))}
      </div>
    </div>
  );
}

function ContractChip({
  name,
  blurb,
  addr,
  explorerBase,
}: {
  name: string;
  blurb: string;
  addr: string;
  explorerBase: string;
}) {
  const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const tooltip = `${name} — ${blurb}\n\n${addr}`;
  const href = explorerBase ? `${explorerBase}/address/${addr}` : undefined;
  const content = (
    <>
      <span style={{ color: "var(--text)", fontWeight: 600 }}>{name}</span>
      <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>{short}</span>
    </>
  );
  if (!href) {
    return (
      <span title={tooltip} style={{ cursor: "help" }}>
        {content}
      </span>
    );
  }
  return (
    <a
      href={href}
      title={tooltip}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: "none", cursor: "help" }}
    >
      {content}
    </a>
  );
}
