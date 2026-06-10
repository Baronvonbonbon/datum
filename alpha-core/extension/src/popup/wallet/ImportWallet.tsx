// Import-wallet screen.
//
// User pastes a BIP-39 phrase; we validate via the shared
// `validateMnemonic` helper (12 or 24 words, valid checksum, known
// word list). On success we bubble the normalized phrase up to the
// parent flow which advances to the password-set step.

import { useState } from "react";
import {
  validateMnemonic,
  normalizeMnemonic,
} from "../../background/wallet/mnemonic";
import {
  screen,
  heading,
  subText,
  button,
  input,
  errorText,
  fieldLabel,
} from "./styles";

export function ImportWallet({
  onContinue,
  onBack,
}: {
  onContinue: (phrase: string) => void;
  onBack: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    const cleaned = normalizeMnemonic(phrase);
    const wordCount = cleaned.split(" ").length;
    if (wordCount !== 12 && wordCount !== 24) {
      setErr(`Phrase must be 12 or 24 words. You entered ${wordCount}.`);
      return;
    }
    const valid = validateMnemonic(cleaned);
    if (!valid) {
      setErr(
        "Invalid recovery phrase. Check for typos — every word must come from the BIP-39 word list and the checksum must match."
      );
      return;
    }
    onContinue(valid);
  }

  return (
    <div style={screen}>
      <div style={heading}>Import existing wallet</div>
      <div style={subText}>
        Paste your 12 or 24-word recovery phrase. We validate it
        locally; nothing leaves your browser.
      </div>

      <div>
        <div style={fieldLabel}>Recovery phrase</div>
        <textarea
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          rows={4}
          style={{
            ...input,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            resize: "vertical",
          }}
          placeholder="word1 word2 word3 ..."
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        {err && <div style={errorText}>{err}</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <button style={button("secondary")} onClick={onBack}>
          Back
        </button>
        <button
          style={{
            ...button("primary"),
            opacity: phrase.trim() ? 1 : 0.4,
            pointerEvents: phrase.trim() ? "auto" : "none",
          }}
          onClick={submit}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
