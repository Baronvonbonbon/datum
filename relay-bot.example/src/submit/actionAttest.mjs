// Action attestation signer (type-2 / remote-action / CPA claims).
//
// DatumClaimValidator's type-2 path requires the pot's `actionVerifier` EOA to
// have signed the claim's computedHash (EIP-191 personal_sign). This module
// holds that key and exposes attest(): given the claim parameters, it reads the
// on-chain nonce + prevHash for the (user, campaign, actionType=2) chain,
// recomputes the canonical claim hash itself (never trusting a client-supplied
// hash), signs it, and returns { actionSig, firstNonce, prevHash } so the client
// can assemble a claim whose on-chain-derived hash matches the signature.
//
// Trust model: the relay attests that the game reported a legitimate action.
// A production deployment should join against a real action record before
// signing; this skeleton signs on request for the demo.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent } from "../logging/telemetry.mjs";

const ZERO_HASH = "0x" + "0".repeat(64);
const ACTION_TYPE = 2;

const SETTLEMENT_ABI = [
  "function lastNonce(address user, uint256 campaignId, uint8 actionType) view returns (uint256)",
  "function lastClaimHash(address user, uint256 campaignId, uint8 actionType) view returns (bytes32)",
];

export class ActionAttest {
  constructor({ provider, cfg, campaignPoll }) {
    this.provider = provider;
    this.cfg = cfg;
    this.campaignPoll = campaignPoll;
    this.enabled = !!cfg.actionVerifierKey;
    if (this.enabled) {
      // Sign with the actionVerifier key, but READ through pine.
      this.signer = new ethers.Wallet(cfg.actionVerifierKey);
      this.settlement = new ethers.Contract(cfg.addresses.settlement, SETTLEMENT_ABI, provider.reader);
      log.info("action-attest enabled", { verifier: this.signer.address });
    }
  }

  get verifierAddress() {
    return this.enabled ? this.signer.address : null;
  }

  /** Attest a type-2 claim. Returns { ok, actionSig, firstNonce, prevHash, verifier }. */
  async attest(body) {
    if (!this.enabled) return { ok: false, reason: "action-attest-disabled" };
    bumpCounter("actionAttestRequests");

    let campaignId, eventCount, rateWei, user, publisher;
    try {
      campaignId = BigInt(body.campaignId);
      eventCount = BigInt(body.eventCount);
      rateWei = BigInt(body.rateWei);
      user = ethers.getAddress(body.user);
      publisher = ethers.getAddress(body.publisher);
    } catch {
      bumpCounter("actionAttestErrors");
      return { ok: false, reason: "bad-params" };
    }
    if (eventCount <= 0n || rateWei <= 0n) return { ok: false, reason: "bad-amounts" };
    if (!this.campaignPoll.hasCampaign(campaignId)) return { ok: false, reason: "not-our-campaign" };

    // Read the on-chain position for the action-type chain.
    const last = BigInt(await this.settlement.lastNonce(user, campaignId, ACTION_TYPE));
    const prevHash = String(await this.settlement.lastClaimHash(user, campaignId, ACTION_TYPE));
    const firstNonce = last + 1n;

    // Canonical claim hash (DatumClaimValidator: 10 abi.encode fields).
    const computedHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
      [campaignId, publisher, user, eventCount, rateWei, ACTION_TYPE, ZERO_HASH, firstNonce, prevHash, ZERO_HASH],
    ));

    // EIP-191 personal_sign over the 32-byte hash (matches the contract's
    // "\x19Ethereum Signed Message:\n32" + computedHash recover).
    const sig = await this.signer.signMessage(ethers.getBytes(computedHash));
    const { r, s, yParity } = ethers.Signature.from(sig);
    const v = yParity + 27;
    const actionSig = [r, s, "0x" + v.toString(16).padStart(64, "0")];

    recordEvent("action-attested", { campaignId: campaignId.toString(), user });
    return {
      ok: true,
      actionSig,
      firstNonce: firstNonce.toString(),
      prevHash,
      verifier: this.signer.address,
    };
  }
}
