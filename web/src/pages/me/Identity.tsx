// /me/identity — user-side People Chain identity floor + verification status.
//
// 2026-05-16: People Chain identity gate. Users can demand the identity check
// on every campaign they engage with (self-floor), and inspect / refresh the
// on-chain cached attestation that records their verified level.
//
// Levels mirror People Chain registrar judgments:
//   0 = None       — no identity on file (default)
//   1 = Reasonable — registrar reviewed but didn't field-verify
//   2 = KnownGood  — registrar performed off-chain verification

import { useEffect, useState } from "react";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";

const LEVELS: Array<{ value: number; label: string; description: string }> = [
  { value: 0, label: "Off (default)", description: "Engage with any campaign regardless of identity requirements. Maximum compatibility." },
  { value: 1, label: "Require Reasonable", description: "Only settle on campaigns where you hold at least a Reasonable People Chain judgment." },
  { value: 2, label: "Require KnownGood", description: "Only settle on campaigns where you hold a fully-verified KnownGood judgment. Strongest sybil resistance." },
];

const LEVEL_LABELS = ["None", "Reasonable", "KnownGood"];

export function IdentityPage() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();

  const [currentFloor, setCurrentFloor] = useState<number | null>(null);
  const [chosenFloor, setChosenFloor] = useState<number>(0);
  const [identity, setIdentity] = useState<{ level: number; expiryBlock: bigint; lastUpdatedBlock: bigint } | null>(null);
  const [blockNumber, setBlockNumber] = useState<bigint>(0n);
  const [refreshFee, setRefreshFee] = useState<bigint>(0n);
  const [inFlight, setInFlight] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const registryWired = !!contracts.peopleChainIdentity;
  // When the bridge is wired, refresh dispatches real XCM via the
  // IXcm precompile. When absent, fall back to the legacy event-only
  // requestIdentityRefresh() that off-chain bridges watch.
  const bridgeWired = !!contracts.peopleChainXcmBridge;

  useEffect(() => { load(); }, [address, registryWired]);

  // Watch the bridge's RefreshCallback event so the "verifying..." badge
  // clears when the People Chain response (or Diana stand-in) lands.
  useEffect(() => {
    if (!bridgeWired || !contracts.peopleChainXcmBridge || !address) return;
    const filter = contracts.peopleChainXcmBridge.filters.RefreshCallback(address);
    const handler = () => {
      setInFlight(false);
      load();
    };
    contracts.peopleChainXcmBridge.on(filter, handler);
    return () => {
      contracts.peopleChainXcmBridge?.off(filter, handler);
    };
  }, [bridgeWired, address, contracts.peopleChainXcmBridge]);

  async function load() {
    if (!address) { setLoading(false); return; }
    try {
      const lvl: bigint = await contracts.settlement.userMinIdentityLevel(address);
      setCurrentFloor(Number(lvl));
      setChosenFloor(Number(lvl));
      if (contracts.peopleChainIdentity) {
        const rec = await contracts.peopleChainIdentity.getIdentity(address);
        setIdentity({
          level: Number(rec.level),
          expiryBlock: BigInt(rec.expiryBlock),
          lastUpdatedBlock: BigInt(rec.lastUpdatedBlock),
        });
        const bn = await contracts.readProvider.getBlockNumber();
        setBlockNumber(BigInt(bn));
      }
      if (contracts.peopleChainXcmBridge) {
        const fee: bigint = await contracts.peopleChainXcmBridge.estimatedRefreshFee();
        setRefreshFee(BigInt(fee));
      }
    } catch (err) {
      push(`Failed to load identity state: ${humanizeError(err)}`, "error");
    }
    setLoading(false);
  }

  async function saveFloor() {
    if (!signer) { push("Connect your wallet first.", "error"); return; }
    if (chosenFloor === currentFloor) return;
    setSubmitting(true);
    try {
      const c = contracts.settlement.connect(signer);
      const tx = await c.setUserMinIdentityLevel(chosenFloor);
      await confirmTx(tx);
      push(`Identity floor set to ${LEVELS[chosenFloor].label}`, "ok");
      await load();
    } catch (err) {
      push(humanizeError(err), "error");
    }
    setSubmitting(false);
  }

  async function requestRefresh() {
    if (!signer || !contracts.peopleChainIdentity) return;
    setSubmitting(true);
    try {
      if (bridgeWired && contracts.peopleChainXcmBridge) {
        // Trustless path: dispatch XCM via the bridge. User pays the
        // fee in DOT/PAS (refreshFee from contract).
        const b = contracts.peopleChainXcmBridge.connect(signer);
        const tx = await b.requestRefresh(address, { value: refreshFee });
        await confirmTx(tx);
        setInFlight(true);
        push(`Refresh dispatched (${refreshFee.toString()} planck) — awaiting People Chain response.`, "ok");
      } else {
        // Legacy event-only path. Off-chain bridge watches the event and
        // posts the attestation. Free for the user.
        const c = contracts.peopleChainIdentity.connect(signer);
        const tx = await c.requestIdentityRefresh(address);
        await confirmTx(tx);
        push("Refresh requested — the off-chain bridge will re-query People Chain shortly.", "ok");
      }
    } catch (err) {
      push(humanizeError(err), "error");
    }
    setSubmitting(false);
  }

  async function forgetMe() {
    if (!signer || !contracts.peopleChainIdentity) return;
    if (!confirm("Purge your cached People Chain attestation? Settlement on identity-gated campaigns will reject until a writer re-attests.")) return;
    setSubmitting(true);
    try {
      const c = contracts.peopleChainIdentity.connect(signer);
      const tx = await c.forgetMe();
      await confirmTx(tx);
      push("Cached attestation purged.", "ok");
      await load();
    } catch (err) {
      push(humanizeError(err), "error");
    }
    setSubmitting(false);
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!address) return <div style={{ padding: 24 }}>Connect a wallet to manage your People Chain identity floor.</div>;

  const expired = identity && identity.expiryBlock > 0n && blockNumber >= identity.expiryBlock;
  const effectiveLevel = expired ? 0 : (identity?.level ?? 0);

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>People Chain Identity</h2>
      <p style={{ color: "var(--text-muted, #888)", fontSize: 14, lineHeight: 1.5 }}>
        Your DOT identity registered on the Polkadot People Chain. Campaigns may
        require a minimum verification level for settlement, and you can demand
        the gate yourself even when a campaign doesn't.
      </p>

      {/* Current cached attestation */}
      <div style={{
        marginTop: 24, padding: 16,
        border: "1px solid var(--border, #333)", borderRadius: 8,
        background: "var(--bg-muted, rgba(255,255,255,0.02))",
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Cached attestation</div>
        {!registryWired && (
          <div style={{ color: "var(--warn, #fb4)", fontSize: 13 }}>
            Identity cache contract not configured for this network — gate is unavailable.
          </div>
        )}
        {registryWired && (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>Current level: <strong>{LEVEL_LABELS[effectiveLevel]}</strong>{expired && <span style={{ color: "var(--warn, #fb4)" }}> (expired)</span>}</div>
            <div>Expiry block: <code>{identity?.expiryBlock?.toString() ?? "—"}</code> (current: <code>{blockNumber.toString()}</code>)</div>
            <div>Last updated block: <code>{identity?.lastUpdatedBlock?.toString() ?? "—"}</code></div>
            {inFlight && (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 6,
                background: "rgba(76, 207, 255, 0.08)", fontSize: 12 }}>
                Verifying… awaiting People Chain response (typically ~20s).
              </div>
            )}
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={requestRefresh}
                disabled={submitting || inFlight}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border, #333)", background: "transparent", cursor: "pointer" }}
              >
                {bridgeWired
                  ? `Request refresh (${refreshFee.toString()} planck)`
                  : "Request refresh"}
              </button>
              <button
                onClick={forgetMe}
                disabled={submitting || effectiveLevel === 0}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--err, #f55)", background: "transparent", color: "var(--err, #f55)", cursor: "pointer" }}
              >
                Forget me
              </button>
              {bridgeWired && (
                <span style={{ fontSize: 11, color: "var(--text-muted, #888)" }}>
                  Dispatches XCM to People Chain via the IXcm precompile.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <h3 style={{ marginTop: 32 }}>Your floor</h3>
      <p style={{ color: "var(--text-muted, #888)", fontSize: 14, lineHeight: 1.5 }}>
        The protocol enforces whichever floor is higher — yours or the campaign's.
      </p>

      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {LEVELS.map((l) => (
          <label key={l.value} style={{
            display: "flex", gap: 12, padding: 14,
            border: chosenFloor === l.value ? "2px solid var(--accent, #4cf)" : "1px solid var(--border, #333)",
            borderRadius: 8, cursor: "pointer",
            background: currentFloor === l.value ? "rgba(76, 207, 255, 0.05)" : undefined,
          }}>
            <input
              type="radio"
              checked={chosenFloor === l.value}
              onChange={() => setChosenFloor(l.value)}
              style={{ marginTop: 4 }}
            />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {l.label}
                {currentFloor === l.value && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ok, #4f4)" }}>(current)</span>}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted, #888)" }}>{l.description}</div>
            </div>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 24, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={saveFloor}
          disabled={submitting || chosenFloor === currentFloor}
          style={{
            padding: "10px 20px",
            background: chosenFloor === currentFloor ? "var(--bg-muted, #222)" : "var(--accent, #4cf)",
            color: chosenFloor === currentFloor ? "var(--text-muted, #888)" : "var(--bg, #000)",
            border: "none", borderRadius: 6,
            cursor: (submitting || chosenFloor === currentFloor) ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {submitting ? "Saving…" : chosenFloor === currentFloor ? "No change" : "Save floor"}
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
          Self-only — no admin can change this for you.
        </span>
      </div>
    </div>
  );
}
