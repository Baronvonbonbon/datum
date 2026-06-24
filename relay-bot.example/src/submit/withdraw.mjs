// Gasless withdraw submitter.
//
// The user signs a WithdrawAuth (EIP-712 over the DatumPaymentVault domain); the
// relay submits DatumPaymentVault.withdrawUserBySig and pays the gas. The user
// keeps maxFee out of their balance to reimburse the relay (the client may set
// maxFee=0 to have the relay subsidise gas). Enables zero-PAS onboarding: a
// fresh wallet can cash out earned vault credit without ever holding gas.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent } from "../logging/telemetry.mjs";

const ABI = [
  "function withdrawUserBySig(address user, address recipient, uint256 maxFee, uint256 deadline, bytes sig)",
  "function userBalance(address) view returns (uint256)",
];

export class Withdraw {
  constructor({ provider, cfg }) {
    this.provider = provider;
    this.contract = new ethers.Contract(cfg.addresses.paymentVault, ABI, provider.wallet);
  }

  /** Submit a user-signed gasless withdrawal. Returns { ok, txHash, amount }. */
  async submit(body) {
    bumpCounter("withdrawalsReceived");
    const { user, recipient, maxFee, deadline, sig } = body || {};
    if (!ethers.isAddress(user)) return { ok: false, reason: "invalid-user" };
    if (recipient && recipient !== ethers.ZeroAddress && !ethers.isAddress(recipient)) return { ok: false, reason: "invalid-recipient" };
    if (typeof sig !== "string" || sig.length < 130) return { ok: false, reason: "invalid-sig" };

    const bal = await this.contract.userBalance(user).catch(() => 0n);
    if (BigInt(bal) === 0n) return { ok: false, reason: "nothing-to-withdraw" };

    const tx = await this.contract.withdrawUserBySig(
      user, recipient || ethers.ZeroAddress, maxFee ?? 0, deadline, sig,
    );
    await tx.wait(1);
    bumpCounter("withdrawalsSubmitted");
    recordEvent("withdraw", { user });
    log.info("gasless withdraw", { user: user.slice(0, 10), amount: bal.toString(), tx: tx.hash });
    return { ok: true, txHash: tx.hash, amount: bal.toString() };
  }
}
