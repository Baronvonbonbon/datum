# DATUM ‑ Decentralized Ad Targeting Utility Marketplace (MVP)

**Powered by Polkadot**

This repository contains a proof‑of‑concept implementation of the **Phase 1** DATUM design, written in [`ink!`](https://paritytech.github.io/ink/) for deployment on any PolkaVM / Contracts pallet.  
The MVP covers:

* **CampaignRegistry** – registers campaigns, escrows DOT, manages state‐machine (Pending → Active → Finished/Killed).
* **RewardVault** – holds deposits and pays out users, publishers, stakers, and treasury.
* **ImpressionLogger** – authorised endpoint (called by an off‑chain worker) to batch‑record daily impressions.

> **Scope trimmed for MVP**  
> *Single‑sig owner moderation* instead of DAO.  
> Fixed 50/40/5/5 reward split.  
> No KYB yet – assume trusted advertiser wallet.  
> Off‑chain aggregation mocked by a CLI script (TBA).

---

## 🛠  Quick start
```bash
# install Rust, wasm‑toolchain, cargo‑contract ≥ 3.1
rustup target add wasm32-unknown-unknown --toolchain stable
cargo install --locked cargo-contract

# build every contract
./scripts/build_all.sh

# run a local node (contracts‑pallet)
substrate-contracts-node --dev

# deploy via cargo‑contract
cd contracts/campaign_registry
cargo contract instantiate --suri //Alice --constructor new --args <reward_vault_addr>
