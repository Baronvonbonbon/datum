// Ascend NFT gear mint submitter.
//
// Ascend (the roguelike) rewards players with tradeable on-chain relics. A relic
// is a standard ERC-721 on the AscendGear contract, so any marketplace can list
// and trade it. Minting is gasless: the player signs an EIP-712 `Mint(player,
// itemId,enchant,deadline)` on the AscendGear domain, and this relay — which holds
// the contract's minter role — verifies the signature, checks the requested gear is
// allowlisted (no consumables / arbitrary metadata), and submits AscendGear.mint
// (paying gas). Address comes from cfg.ascendGear or ASCEND_GEAR_ADDRESS.

import { ethers } from "ethers";
import { log } from "../logging/structured.mjs";
import { bumpCounter, recordEvent } from "../logging/telemetry.mjs";

const ABI = ["function mint(address to, string id, uint8 ench) returns (uint256)"];

// Only equippable gear may become a relic — weapons, armor, rings, wands.
const GEAR_IDS = new Set([
  "dagger", "sword", "mace", "vest", "cloak", "plate",
  "ring_res", "ring_regen", "ring_priv",
  "wand_bolt", "wand_banish", "wand_slow", "wand_dig",
]);

export class AscendMint {
  constructor({ provider, cfg }) {
    this.provider = provider;
    const addr = cfg.ascendGear || process.env.ASCEND_GEAR_ADDRESS;
    this.address = addr;
    this.enabled = !!addr && ethers.isAddress(addr);
    this.contract = this.enabled ? new ethers.Contract(addr, ABI, provider.wallet) : null;
  }

  /** Submit a player-authorized gasless relic mint. Returns { ok, txHash }. */
  async submit(body) {
    if (!this.enabled) return { ok: false, reason: "ascend-gear-unconfigured" };
    bumpCounter("ascendMintsReceived");
    const { player, itemId, enchant, deadline, sig } = body || {};
    if (!ethers.isAddress(player)) return { ok: false, reason: "invalid-player" };
    if (typeof itemId !== "string" || !GEAR_IDS.has(itemId)) return { ok: false, reason: "invalid-itemId" };
    if (!Number.isInteger(enchant) || enchant < 0 || enchant > 9) return { ok: false, reason: "invalid-enchant" };
    if (typeof sig !== "string" || sig.length < 130) return { ok: false, reason: "invalid-sig" };
    let dl;
    try { dl = BigInt(deadline); } catch { return { ok: false, reason: "invalid-deadline" }; }
    if (dl < BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: "expired" };

    // Authenticate: the signature must recover to `player` (no minting on others' behalf).
    const domain = { name: "AscendGear", version: "1", chainId: 420420417, verifyingContract: this.address };
    const types = { Mint: [
      { name: "player", type: "address" }, { name: "itemId", type: "string" },
      { name: "enchant", type: "uint8" }, { name: "deadline", type: "uint256" },
    ] };
    let recovered;
    try { recovered = ethers.verifyTypedData(domain, types, { player, itemId, enchant, deadline }, sig); }
    catch { return { ok: false, reason: "bad-signature" }; }
    if (recovered.toLowerCase() !== player.toLowerCase()) return { ok: false, reason: "bad-signature" };

    const tx = await this.contract.mint(player, itemId, enchant);
    await tx.wait(1);
    bumpCounter("ascendMintsSubmitted");
    recordEvent("ascend-mint", { player, itemId });
    log.info("ascend relic mint", { player: player.slice(0, 10), itemId, enchant, tx: tx.hash });
    return { ok: true, txHash: tx.hash };
  }
}
