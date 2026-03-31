// Human-readable error messages for DATUM on-chain error codes.
// Contract error strings are 2-3 chars (E00-E58, P) to minimize PVM bytecode.

const ERROR_CODES: Record<string, string> = {
  // General
  E00: "Invalid address (zero address).",
  E01: "Campaign or entity not found.",
  E02: "Transfer failed.",
  E03: "Nothing to withdraw (zero balance).",

  // Campaigns — creation
  E11: "Campaign value must be greater than zero.",
  E12: "Daily cap must be > 0 and ≤ total budget.",
  E13: "Not authorized (only advertiser or settlement).",
  E14: "Campaign must be Active or Paused.",
  E15: "Campaign is not active.",
  E16: "Insufficient remaining budget.",
  E17: "Publisher not registered.",
  E18: "Not the contract owner.",
  E19: "Only the governance contract can do this.",

  // Campaigns — lifecycle
  E20: "Campaign is not in Pending status.",
  E21: "Only the advertiser can do this.",
  E22: "Campaign must be Active to pause.",
  E23: "Campaign must be Paused to resume.",
  E24: "Pending timeout not reached (~7 days). Vote active via Govern tab or wait for timeout.",
  E25: "Only the settlement contract can deduct budget.",
  E26: "Daily cap exceeded.",
  E27: "Bid is below the minimum CPM floor.",

  // Settlement
  E28: "Batch too large (max 5 claims per batch).",
  E29: "Claim deadline has expired. Re-sign the claims.",
  E30: "Invalid user signature length.",
  E31: "Invalid user signature.",
  E32: "Not authorized to settle (must be user or relay).",
  E33: "Invalid publisher signature length.",
  E34: "Invalid publisher signature.",

  // Timelock
  E35: "No pending proposal to cancel.",
  E36: "No pending proposal to execute.",
  E37: "Timelock delay not elapsed (48h required).",

  // Governance V2
  E40: "Invalid conviction (must be 0–6).",
  E41: "Stake must be greater than zero.",
  E42: "Already voted on this campaign. Withdraw first to change your vote.",
  E43: "Campaign must be Pending or Active to vote.",
  E44: "No vote found for this campaign.",
  E45: "Vote lockup period has not expired yet.",
  E46: "Quorum not met.",
  E47: "Aye majority required (> 50%). If nay has majority, the campaign will remain Pending until the pending timeout expires (~7 days from creation), then anyone can call Expire.",
  E48: "Nay majority required (≥ 50%) with sufficient termination quorum.",
  E49: "Campaign already resolved.",
  E50: "Campaign in unexpected status for evaluation.",
  E51: "Cannot evaluate with zero total votes.",

  // Termination protection (anti-grief) / Governance Slash
  E52: "Termination quorum not met (nay stake too low), or slash already finalized.",
  E53: "Termination grace period not elapsed (~24h from first nay vote), or campaign not yet resolved for slash.",
  E54: "Slash must be finalized before claiming reward.",
  E55: "Slash reward already claimed.",
  E56: "Not on the winning side.",

  // System
  E57: "Transaction conflict (reentrancy). Try again.",
  E58: "Amount below existential deposit (dust).",
  P: "System is globally paused.",
};

/**
 * Convert a raw ethers error into a human-readable message.
 * Matches error codes like "E24", "E42", "P" in the revert reason.
 */
export function humanizeError(err: unknown): string {
  const s = String(err);

  // Match quoted error codes in ethers revert data
  for (const [code, msg] of Object.entries(ERROR_CODES)) {
    if (s.includes(`"${code}"`)) return `${code}: ${msg}`;
  }

  // Fallback: extract reason from ethers error
  if (s.includes("execution reverted")) {
    const match = s.match(/reason="([^"]+)"/);
    if (match) return `Transaction reverted: ${match[1]}`;
  }

  // Shorten common ethers noise
  if (s.includes("user rejected") || s.includes("ACTION_REJECTED")) {
    return "Transaction cancelled by user.";
  }

  if (s.includes("insufficient funds")) {
    return "Insufficient funds for this transaction.";
  }

  // Strip RPC URLs and internal details from error messages
  const sanitized = s
    .replace(/https?:\/\/[^\s"')]+/g, "[RPC]")
    .replace(/at\s+\S+\s+\(.*?\)/g, "")
    .replace(/\{[^}]{200,}\}/g, "[details omitted]");
  return sanitized.length > 300 ? sanitized.slice(0, 300) + "…" : sanitized;
}
