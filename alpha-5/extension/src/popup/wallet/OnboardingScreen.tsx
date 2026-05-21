// Entry screen for first-run.
//
// Two paths:
//   - "Create new wallet" → generates a fresh BIP-39 mnemonic
//   - "Import existing wallet" → user pastes a 12/24-word phrase
//
// Picked path bubbles up via the `onPick` callback; the parent
// OnboardingFlow advances state and renders the next screen.

import { BrandMark } from "../BrandMark";
import { screen, heading, subText, button } from "./styles";

export function OnboardingScreen({
  onPick,
}: {
  onPick: (mode: "generate" | "import") => void;
}) {
  return (
    <div style={screen}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--text-muted)" }}>
          <BrandMark size={20} />
        </span>
        <div style={{ ...heading, marginBottom: 0, fontSize: 17 }}>DATUM Wallet</div>
      </div>

      <div style={{ ...subText, marginTop: 4, marginBottom: 8 }}>
        A self-contained wallet for Polkadot Hub. Keys are encrypted
        with your password and stored only on this device.
      </div>

      <button
        style={button("primary")}
        onClick={() => onPick("generate")}
      >
        Create a new wallet
      </button>

      <button
        style={button("secondary")}
        onClick={() => onPick("import")}
      >
        Import an existing wallet
      </button>

      <div style={{ ...subText, marginTop: "auto", fontSize: 10 }}>
        Your seed phrase is the only way to recover this wallet. We
        never see it. Back it up before funding any address.
      </div>
    </div>
  );
}
