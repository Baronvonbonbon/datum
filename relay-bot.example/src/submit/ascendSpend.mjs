// Ascend shop spend submitter.
//
// Ascend (the roguelike) lets players spend their on-chain purse at in-dungeon
// shops without paying gas: the player signs an EIP-712 `Spend(user,amount,
// nonce,deadline)` on the AscendBank domain, and this relay submits
// AscendBank.spendBySig (paying gas). Spent PAS stays in the bank as shop
// revenue. Address comes from cfg.ascendBank or ASCEND_BANK_ADDRESS.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent } from "../logging/telemetry.mjs";

const ABI = [
  "function spendBySig(address user, uint256 amount, uint256 deadline, bytes sig)",
  "function balanceOf(address) view returns (uint256)",
];

export class AscendSpend {
  constructor({ provider, cfg }) {
    this.provider = provider;
    const addr = cfg.ascendBank || process.env.ASCEND_BANK_ADDRESS;
    this.enabled = !!addr && ethers.isAddress(addr);
    this.contract = this.enabled ? new ethers.Contract(addr, ABI, provider.wallet) : null;
  }

  /** Submit a player-signed gasless shop spend. Returns { ok, txHash }. */
  async submit(body) {
    if (!this.enabled) return { ok: false, reason: "ascend-bank-unconfigured" };
    bumpCounter("ascendSpendsReceived");
    const { user, amount, deadline, sig } = body || {};
    if (!ethers.isAddress(user)) return { ok: false, reason: "invalid-user" };
    if (typeof sig !== "string" || sig.length < 130) return { ok: false, reason: "invalid-sig" };
    let amt;
    try { amt = BigInt(amount); } catch { return { ok: false, reason: "invalid-amount" }; }

    const bal = await this.contract.balanceOf(user).catch(() => 0n);
    if (BigInt(bal) < amt) return { ok: false, reason: "insufficient-purse" };

    const tx = await this.contract.spendBySig(user, amt, deadline, sig);
    await tx.wait(1);
    bumpCounter("ascendSpendsSubmitted");
    recordEvent("ascend-spend", { user });
    log.info("ascend shop spend", { user: user.slice(0, 10), amount: amt.toString(), tx: tx.hash });
    return { ok: true, txHash: tx.hash };
  }
}
