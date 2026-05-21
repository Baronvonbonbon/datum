// Generate-mnemonic step.
//
// On mount we ask the offscreen wallet to generate a fresh BIP-39
// phrase via createWallet — but that call requires a password too.
// Solution: stash the entropy here, show the phrase, then advance to
// the password step which actually finalizes the vault. We do this
// by generating the phrase locally via ethers.Mnemonic.fromEntropy
// rather than calling background — keeps the password input out of
// this screen.

import { useState, useEffect, useMemo } from "react";
import { Mnemonic } from "ethers";
import { screen, heading, subText, button, card, mono, fieldLabel } from "./styles";

export function GenerateMnemonic({
  onContinue,
  onBack,
}: {
  /// Caller advances when the user confirms backup.
  onContinue: (phrase: string) => void;
  onBack: () => void;
}) {
  const [strength, setStrength] = useState<128 | 256>(128);
  const [confirmedBackup, setConfirmedBackup] = useState(false);
  const [reveal, setReveal] = useState(false);

  // Re-roll on strength change so a user toggling 12↔24 doesn't keep
  // the old entropy bytes.
  const phrase = useMemo(() => {
    const byteCount = strength / 8;
    const entropy = new Uint8Array(byteCount);
    crypto.getRandomValues(entropy);
    const hex =
      "0x" + Array.from(entropy, (b) => b.toString(16).padStart(2, "0")).join("");
    return Mnemonic.fromEntropy(hex).phrase;
  }, [strength]);

  const words = phrase.split(" ");

  return (
    <div style={screen}>
      <div style={heading}>Save your recovery phrase</div>
      <div style={subText}>
        These {words.length} words are the <strong>only</strong> way to
        recover your wallet. Write them down somewhere safe. Never share them.
      </div>

      <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
        <button
          style={{ ...button(strength === 128 ? "primary" : "secondary"), padding: "6px 10px", fontSize: 11 }}
          onClick={() => setStrength(128)}
        >
          12 words
        </button>
        <button
          style={{ ...button(strength === 256 ? "primary" : "secondary"), padding: "6px 10px", fontSize: 11 }}
          onClick={() => setStrength(256)}
        >
          24 words
        </button>
      </div>

      <div style={{ ...card, position: "relative" }}>
        {!reveal && (
          <div
            onClick={() => setReveal(true)}
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "var(--radius)",
              background: "rgba(0,0,0,0.85)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-strong)",
              fontSize: 12,
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            Click to reveal — make sure no one is watching
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 6,
            filter: reveal ? "none" : "blur(4px)",
          }}
        >
          {words.map((w, i) => (
            <div
              key={i}
              style={{
                ...mono,
                padding: "5px 7px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
            >
              <span style={{ color: "var(--text-muted)", marginRight: 4 }}>
                {i + 1}.
              </span>
              {w}
            </div>
          ))}
        </div>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 2,
          cursor: "pointer",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          checked={confirmedBackup}
          onChange={(e) => setConfirmedBackup(e.target.checked)}
        />
        I've written down or otherwise backed up these words.
      </label>

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <button style={{ ...button("secondary") }} onClick={onBack}>
          Back
        </button>
        <button
          style={{
            ...button("primary"),
            opacity: confirmedBackup ? 1 : 0.4,
            pointerEvents: confirmedBackup ? "auto" : "none",
          }}
          onClick={() => onContinue(phrase)}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
