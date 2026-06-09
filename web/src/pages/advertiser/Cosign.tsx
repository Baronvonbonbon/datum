// Advertiser EIP-712 cosign tool.
//
// The dual-sig settlement path (AssuranceLevel L2) requires the advertiser
// to countersign each ClaimBatch the publisher's relay aggregates. This page
// is the advertiser's side of that handshake: paste the publisher-signed
// batch, review the contents, produce the advertiserSig, then either copy
// the cosigned batch back to the publisher or submit `settleSignedClaims`
// directly.
//
// The EIP-712 envelope must exactly match the on-chain typehash (SLIM #2):
//   ClaimBatch(address user,uint256 campaignId,uint256 firstNonce,
//              bytes32 claimsHash,uint256 deadlineBlock,
//              address expectedRelaySigner,address expectedAdvertiserRelaySigner)
// and the domain must match the Settlement contract that the deployed
// build verifies signatures against (DatumSettlement / "1").
// claimsHash is the content hash of the slim claims:
//   keccak256( concat_i keccak256(abi.encode(slimClaim_i)) ).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { useContracts } from "../../hooks/useContracts";
import { useWallet } from "../../context/WalletContext";
import { useTx } from "../../hooks/useTx";
import { useToast } from "../../context/ToastContext";
import { humanizeError } from "@shared/errorCodes";
import { useSettings } from "../../context/SettingsContext";

// SLIM (#2): optional per-claim proof sidecar (mirrors IDatumSettlement.ClaimProof).
interface ClaimProof {
  clickSessionHash: string;
  stakeRootUsed: string;
  nullifier: string;
  powNonce: string;
  zkProof: string[];   // bytes32[8]
  actionSig: string[]; // bytes32[3]
}

// SLIM (#2): the on-chain slim Claim (mirrors IDatumSettlement.Claim).
interface Claim {
  publisher: string;
  eventCount: string;
  rateWei: string;
  actionType: string | number;
  proof: ClaimProof[]; // 0 entries = plain view claim
}

interface SignedClaimBatch {
  user: string;
  campaignId: string;
  firstNonce: string;  // SLIM (#2): replay anchor (nonce of claims[0])
  claims: Claim[];
  deadlineBlock: string;
  expectedRelaySigner: string;
  expectedAdvertiserRelaySigner: string;
  userSig: string;
  publisherSig: string;
  advertiserSig?: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EMPTY_SIG = "0x";

// ABI tuples for the content claimsHash — MUST match IDatumSettlement.sol.
const CLAIM_PROOF_TUPLE =
  "tuple(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)";
const SLIM_CLAIM_TUPLE =
  `tuple(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,${CLAIM_PROOF_TUPLE}[] proof)`;

const EIP712_TYPES = {
  ClaimBatch: [
    { name: "user", type: "address" },
    { name: "campaignId", type: "uint256" },
    { name: "firstNonce", type: "uint256" }, // SLIM (#2): replay anchor
    { name: "claimsHash", type: "bytes32" },
    { name: "deadlineBlock", type: "uint256" },
    { name: "expectedRelaySigner", type: "address" },
    { name: "expectedAdvertiserRelaySigner", type: "address" },
  ],
};

export function AdvertiserCosign() {
  const contracts = useContracts();
  const { signer, address } = useWallet();
  const { confirmTx } = useTx();
  const { push } = useToast();
  const { settings } = useSettings();

  const [jsonInput, setJsonInput] = useState("");
  const [parsed, setParsed] = useState<SignedClaimBatch | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [advertiserOnChain, setAdvertiserOnChain] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [verifyingContract, setVerifyingContract] = useState<string>(settings.contractAddresses.settlement);
  const [signing, setSigning] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const net = await contracts.readProvider.getNetwork();
        setChainId(Number(net.chainId));
      } catch {
        /* ignore */
      }
    })();
  }, [contracts]);

  function parse() {
    setParseErr(null);
    setParsed(null);
    setSignature(null);
    setAdvertiserOnChain(null);
    try {
      const obj = JSON.parse(jsonInput) as SignedClaimBatch;
      if (!obj || typeof obj !== "object") throw new Error("Not a JSON object");
      for (const f of [
        "user",
        "campaignId",
        "firstNonce",
        "claims",
        "deadlineBlock",
        "expectedRelaySigner",
        "expectedAdvertiserRelaySigner",
        "userSig",
        "publisherSig",
      ]) {
        if (!(f in obj)) throw new Error(`Missing field: ${f}`);
      }
      if (!Array.isArray(obj.claims) || obj.claims.length === 0) {
        throw new Error("claims must be a non-empty array");
      }
      if (!ethers.isAddress(obj.user)) throw new Error("user not a valid address");
      setParsed(obj);
      // Look up the advertiser-of-record for this campaign
      contracts.campaigns
        .getCampaignAdvertiser(BigInt(obj.campaignId))
        .then((a: string) => setAdvertiserOnChain(String(a).toLowerCase()))
        .catch(() => setAdvertiserOnChain(null));
    } catch (err: any) {
      setParseErr(err?.message ?? String(err));
    }
  }

  // SLIM (#2): claimsHash = keccak256( concat_i keccak256(abi.encode(slimClaim_i)) ),
  // matching DatumDualSigSettlement._hashClaims over the on-chain slim Claim tuple.
  const claimsHash = useMemo(() => {
    if (!parsed) return null;
    try {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const hashes = parsed.claims.map((c) => {
        const slim = {
          publisher: c.publisher,
          eventCount: BigInt(c.eventCount),
          rateWei: BigInt(c.rateWei),
          actionType: Number(c.actionType ?? 0),
          proof: (c.proof ?? []).map((p) => ({
            clickSessionHash: p.clickSessionHash,
            stakeRootUsed: p.stakeRootUsed,
            nullifier: p.nullifier,
            powNonce: p.powNonce,
            zkProof: p.zkProof,
            actionSig: p.actionSig,
          })),
        };
        return ethers.keccak256(coder.encode([SLIM_CLAIM_TUPLE], [slim]));
      });
      return ethers.keccak256("0x" + hashes.map((h) => h.slice(2)).join(""));
    } catch {
      return null;
    }
  }, [parsed]);

  const youAreAdvertiser =
    address && advertiserOnChain && address.toLowerCase() === advertiserOnChain;

  async function signCosig() {
    if (!signer || !parsed || !claimsHash || !chainId) return;
    if (!ethers.isAddress(verifyingContract)) {
      push("Verifying contract address invalid.", "error");
      return;
    }
    setSigning(true);
    try {
      const domain = {
        name: "DatumSettlement",
        version: "1",
        chainId,
        verifyingContract,
      };
      const message = {
        user: parsed.user,
        campaignId: BigInt(parsed.campaignId),
        firstNonce: BigInt(parsed.firstNonce),
        claimsHash,
        deadlineBlock: BigInt(parsed.deadlineBlock),
        expectedRelaySigner: parsed.expectedRelaySigner || ZERO_ADDRESS,
        expectedAdvertiserRelaySigner: parsed.expectedAdvertiserRelaySigner || ZERO_ADDRESS,
      };
      const sig = await (signer as any).signTypedData(domain, EIP712_TYPES, message);
      setSignature(sig);
    } catch (err) {
      push(humanizeError(err), "error");
    } finally {
      setSigning(false);
    }
  }

  async function submitDirect() {
    if (!signer || !parsed || !signature) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      // SLIM (#2): on-chain SignedClaimBatch with firstNonce + slim claims.
      const batch = {
        user: parsed.user,
        campaignId: BigInt(parsed.campaignId),
        firstNonce: BigInt(parsed.firstNonce),
        claims: parsed.claims.map((c) => ({
          publisher: c.publisher,
          eventCount: BigInt(c.eventCount),
          rateWei: BigInt(c.rateWei ?? "0"),
          actionType: Number(c.actionType ?? 0),
          proof: (c.proof ?? []).map((p) => ({
            clickSessionHash: p.clickSessionHash || ethers.ZeroHash,
            stakeRootUsed: p.stakeRootUsed || ethers.ZeroHash,
            nullifier: p.nullifier || ethers.ZeroHash,
            powNonce: p.powNonce || ethers.ZeroHash,
            zkProof: Array.isArray(p.zkProof) ? p.zkProof : new Array(8).fill(ethers.ZeroHash),
            actionSig: Array.isArray(p.actionSig) ? p.actionSig : [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
          })),
        })),
        deadlineBlock: BigInt(parsed.deadlineBlock),
        expectedRelaySigner: parsed.expectedRelaySigner || ZERO_ADDRESS,
        expectedAdvertiserRelaySigner: parsed.expectedAdvertiserRelaySigner || ZERO_ADDRESS,
        userSig: parsed.userSig || EMPTY_SIG,
        publisherSig: parsed.publisherSig,
        advertiserSig: signature,
      };
      const c = contracts.settlement.connect(signer) as typeof contracts.settlement;
      const tx = await c.settleSignedClaims([batch]);
      await confirmTx(tx);
      setSubmitMsg("settleSignedClaims submitted.");
    } catch (err) {
      push(humanizeError(err), "error");
      setSubmitMsg(humanizeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const fullBatchOut = useMemo(() => {
    if (!parsed || !signature) return null;
    return JSON.stringify({ ...parsed, advertiserSig: signature }, null, 2);
  }, [parsed, signature]);

  return (
    <div className="nano-fade" style={{ maxWidth: 820 }}>
      <Link to="/advertiser" style={{ color: "var(--text-muted)", fontSize: 13, textDecoration: "none" }}>← Advertiser Dashboard</Link>
      <h1 style={{ color: "var(--text-strong)", fontSize: 20, fontWeight: 700, margin: "12px 0 6px" }}>
        Cosign Claim Batch
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 18 }}>
        Counter-sign a publisher-signed batch under the EIP-712 ClaimBatch envelope. Required for
        any campaign with <strong>AssuranceLevel ≥ 2</strong> (dual-sig). Either copy the cosigned
        batch back to your publisher's relay, or submit <code>settleSignedClaims</code> on-chain directly.
      </p>

      <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>1. Paste publisher-signed batch</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
          Paste the JSON the publisher's relay sent you. Required fields: <code>user</code>, <code>campaignId</code>,
          <code> claims[]</code>, <code>deadlineBlock</code>, <code>expectedRelaySigner</code>,
          <code> expectedAdvertiserRelaySigner</code>, <code>userSig</code>, <code>publisherSig</code>.
        </div>
        <textarea
          value={jsonInput}
          onChange={(e) => setJsonInput(e.target.value)}
          placeholder='{"user":"0x...","campaignId":"1","claims":[...],"deadlineBlock":"...","expectedRelaySigner":"0x...","expectedAdvertiserRelaySigner":"0x...","userSig":"0x...","publisherSig":"0x..."}'
          rows={10}
          className="nano-input"
          style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 11 }}
        />
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button className="nano-btn nano-btn-accent" onClick={parse} disabled={!jsonInput.trim()}>
            Parse batch
          </button>
        </div>
        {parseErr && (
          <div style={{ color: "var(--error)", fontSize: 12, marginTop: 8 }}>{parseErr}</div>
        )}
      </section>

      {parsed && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>2. Review</div>
          <Row label="User" value={<code>{parsed.user}</code>} />
          <Row label="Campaign" value={parsed.campaignId} />
          <Row label="Claims" value={`${parsed.claims.length} claim(s)`} />
          <Row label="Deadline block" value={parsed.deadlineBlock} />
          <Row label="Expected publisher relay" value={<code>{parsed.expectedRelaySigner || ZERO_ADDRESS}</code>} />
          <Row label="Expected advertiser relay" value={<code>{parsed.expectedAdvertiserRelaySigner || ZERO_ADDRESS}</code>} />
          <Row label="claimsHash (computed)" value={<code style={{ wordBreak: "break-all" }}>{claimsHash ?? "—"}</code>} />
          <Row
            label="Advertiser-of-record"
            value={
              advertiserOnChain === null
                ? <span style={{ color: "var(--text-muted)" }}>loading…</span>
                : <code>{advertiserOnChain}</code>
            }
          />
          <Row
            label="You can cosign?"
            value={
              !address
                ? "Connect wallet"
                : youAreAdvertiser
                ? <span style={{ color: "var(--ok)" }}>Yes — your wallet is the advertiser-of-record</span>
                : <span style={{ color: "var(--error)" }}>No — connected wallet is not the campaign's advertiser</span>
            }
          />

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: 12 }}>EIP-712 domain (advanced)</summary>
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <Row label="name" value="DatumSettlement" />
              <Row label="version" value="1" />
              <Row label="chainId" value={chainId ?? "…"} />
              <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  verifyingContract — defaults to the Settlement address. If the deploy uses a separate
                  DualSig carve-out, set it to that address.
                </span>
                <input
                  className="nano-input"
                  value={verifyingContract}
                  onChange={(e) => setVerifyingContract(e.target.value)}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
                />
              </label>
            </div>
          </details>
        </section>
      )}

      {parsed && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>3. Cosign</div>
          {!signer && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Connect a wallet to sign.</div>}
          {signer && !youAreAdvertiser && (
            <div style={{ color: "var(--warn)", fontSize: 12, marginBottom: 8 }}>
              Warning: your connected wallet is not the advertiser-of-record for this campaign.
              Settlement will reject the cosignature.
            </div>
          )}
          {signer && (
            <button
              className="nano-btn nano-btn-accent"
              onClick={signCosig}
              disabled={signing || !claimsHash || !chainId}
              style={{ padding: "6px 14px", fontSize: 12 }}
            >
              {signing ? "Signing..." : "Produce advertiserSig"}
            </button>
          )}
          {signature && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 4 }}>advertiserSig</div>
              <code style={{ fontSize: 11, wordBreak: "break-all", color: "var(--ok)" }}>{signature}</code>
            </div>
          )}
        </section>
      )}

      {fullBatchOut && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>4a. Send cosigned batch back to publisher</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 8 }}>
            Copy this JSON and send it to your publisher's relay. They submit it via <code>settleSignedClaims</code>.
          </div>
          <textarea
            value={fullBatchOut}
            readOnly
            rows={12}
            className="nano-input"
            style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
          <button
            className="nano-btn"
            onClick={() => navigator.clipboard.writeText(fullBatchOut)}
            style={{ marginTop: 8, padding: "6px 14px", fontSize: 12 }}
          >
            Copy to clipboard
          </button>
        </section>
      )}

      {signature && parsed && (
        <section className="nano-card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ color: "var(--accent)", fontWeight: 600, fontSize: 13, marginBottom: 8 }}>4b. Or submit on-chain directly</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
            Calls <code>settleSignedClaims</code> on Settlement. The advertiser pays gas; settlement payouts
            go to user + publisher as usual.
          </div>
          <button
            className="nano-btn nano-btn-accent"
            onClick={submitDirect}
            disabled={submitting}
            style={{ padding: "6px 14px", fontSize: 12 }}
          >
            {submitting ? "Submitting..." : "Submit settleSignedClaims"}
          </button>
          {submitMsg && (
            <div style={{ color: submitMsg.startsWith("settleSignedClaims") ? "var(--ok)" : "var(--error)", fontSize: 12, marginTop: 8 }}>
              {submitMsg}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 13, alignItems: "baseline" }}>
      <span style={{ color: "var(--text-muted)", minWidth: 200 }}>{label}</span>
      <span style={{ color: "var(--text)", flex: 1, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
