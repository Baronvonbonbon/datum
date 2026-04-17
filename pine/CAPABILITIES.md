# Pine RPC — Capability Reference

Pine is a local smoldot light-client bridge that translates Ethereum JSON-RPC calls into
Substrate runtime API calls (`ReviveApi_*`, `chainHead_v1_*`) for Polkadot Asset Hub
(pallet-revive). This document compares Pine's implementation against the canonical
Ethereum JSON-RPC specification and documents every known limitation.

---

## Architecture summary

```
dApp / ethers.js
      │  eth_* JSON-RPC
      ▼
PineProvider (EIP-1193)
      │
      ├── MethodHandlers — per-method logic
      │       │
      │       ├── eth_call / eth_estimateGas → ReviveApi_call / ReviveApi_estimate_gas
      │       ├── eth_getBalance             → ReviveApi_balance
      │       ├── eth_getCode                → ReviveApi_get_code
      │       ├── eth_getStorageAt           → ReviveApi_get_storage
      │       ├── eth_getTransactionCount    → ReviveApi_nonce
      │       ├── eth_sendRawTransaction     → transaction_v1_broadcast (Revive.eth_transact extrinsic)
      │       ├── eth_blockNumber            → chainHead_v1_follow (in-memory latest)
      │       ├── eth_getBlockBy*            → chainHead_v1_storage + tracked block window
      │       ├── eth_getLogs                → LogIndexer (rolling in-memory window)
      │       └── eth_getTransactionReceipt  → ReceiptBuilder (TxPool + LogIndexer)
      │
      ├── LogIndexer — subscribes to finalized blocks, reads System.Events storage,
      │               parses Revive::ContractEmitted SCALE blobs into EthLog objects.
      │               Rolling window of last N blocks (default 10,000).
      │
      ├── ReceiptBuilder — builds receipts from TxPool + LogIndexer data.
      │
      ├── TxPool — in-memory map of transactions submitted through Pine this session.
      │
      └── ChainManager → SmoldotTransport → smoldot WASM light client
                         P2P proof fetching from Polkadot relay + parachain peers
```

**Key constraint:** smoldot is a *verifying light client*, not a full node. It has no local
storage index, no block archive, and no event database. Every state query fetches a Merkle
proof over P2P (~200 ms–1.5 s per call). This is the root cause of nearly all limitations
below.

---

## Method support matrix

### Fully supported

| Method | Implementation | Notes |
|--------|---------------|-------|
| `eth_blockNumber` | Latest finalized block number from chainHead subscription | |
| `eth_chainId` | Hardcoded per chain preset | `paseo-asset-hub` → `0x190e4241` |
| `net_version` | Same value as chainId, string form | |
| `web3_clientVersion` | Returns `"Pine/..."` | |
| `eth_getBalance` | `ReviveApi_balance(H160) → U256` | Returns wei (EVM-scaled). Cached 1 block (6 s). |
| `eth_getCode` | `ReviveApi_get_code(H160) → Option<Vec<u8>>` | Cached 5 min. |
| `eth_getStorageAt` | `ReviveApi_get_storage(H160, H256) → Option<Vec<u8>>` | Cached 1 block. |
| `eth_call` | `ReviveApi_call(origin, dest, value, input, None, None)` | See caveats below. |
| `eth_estimateGas` | `ReviveApi_estimate_gas(...)` | Returns gas with +20% margin. |
| `eth_gasPrice` | Hardcoded `0xe8d4a51000` (10¹² wei/gas) | Not dynamically queried. |
| `eth_getTransactionCount` | `ReviveApi_nonce(H160) → U256` | Cached 1 block. |
| `eth_sendRawTransaction` | Wraps raw tx in `Revive.eth_transact` extrinsic, broadcasts via `transaction_v1_broadcast` | |

### Partially supported

| Method | What works | What doesn't |
|--------|-----------|--------------|
| `eth_getBlockByNumber` | `"latest"`, `"finalized"`, `"safe"`, hex block numbers in the tracked window | Historical blocks outside the window return minimal stub (zero parentHash/stateRoot/timestamp). `"pending"` returns a fake empty block. `fullTransactions=true` always returns empty tx array. |
| `eth_getBlockByHash` | Blocks in the tracked window (up to `cache.maxBlocks`, default 1024) | Older blocks return a minimal stub with missing fields. |
| `eth_getBlockTransactionCountByNumber` | Returns count for tracked blocks | Returns `0x0` for historical blocks outside window. |
| `eth_getBlockTransactionCountByHash` | Same as above | |
| `eth_getLogs` | Logs from blocks seen since Pine connected (rolling window, default 10,000 blocks) | Any range that extends before Pine connected returns incomplete or empty results. Pallet index for `Revive::ContractEmitted` is discovered heuristically on the first emitted event — events in the very first block may be missed. The SCALE parser uses best-effort decoding without full runtime metadata; malformed or unknown event structures are skipped with a logged warning. |
| `eth_getTransactionByHash` | Txs submitted through Pine in the current session (TxPool) | Returns `null` for any tx submitted before Pine connected, submitted via another provider, or submitted before the TxPool was started. |
| `eth_getTransactionReceipt` | Same session scope as above. Fixes the Paseo eth-rpc proxy `null` bug by building receipts from System.Events. | Only available for TxPool-tracked txs. `contractAddress` is always `null` (CREATE address derivation not implemented). `cumulativeGasUsed` equals `gasUsed` (per-block accumulation not tracked). `logsBloom` is always 512 zero bytes. |

### Not implemented

Pine throws `{ code: 4200, message: "Unsupported method: ..." }` for any unrecognised method.

| Category | Methods |
|----------|---------|
| **Account/signing** | `eth_accounts`, `eth_sign`, `eth_signTransaction`, `eth_sendTransaction`, `personal_*` |
| **EIP-1559 fee market** | `eth_feeHistory`, `eth_maxPriorityFeePerGas` |
| **EIP-2930 access lists** | `eth_createAccessList` |
| **EIP-1186 Merkle proofs** | `eth_getProof` |
| **Filter subscriptions** | `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter` |
| **WebSocket push** | `eth_subscribe`, `eth_unsubscribe` |
| **Chain state** | `eth_syncing`, `eth_mining`, `eth_hashrate`, `eth_coinbase`, `eth_protocolVersion` |
| **Uncle/ommer queries** | `eth_getUncleCountByBlockHash`, `eth_getUncleCountByBlockNumber`, `eth_getUncleByBlockHashAndIndex`, `eth_getUncleByBlockNumberAndIndex` |
| **Debug / trace** | `debug_traceTransaction`, `debug_traceBlock`, `trace_*`, `txpool_*` |

---

## Per-method caveats

### `eth_call`

- **Block tag is always ignored.** All calls execute against the latest finalized state,
  regardless of the `blockTag` parameter. Historical call replay is not possible.
- **`to` is required.** Contract-deployment simulation (`to` omitted) throws `-32602`.
- **`from` defaults to zero address** if not specified.
- **SCALE response parsing is heuristic.** The `ContractResult` layout includes an optional
  `events` field whose presence varies by runtime version. Pine tries three skip offsets
  (`skip=1`, `skip=0`, `skip=2`) to locate the `Result` variant. If none matches, returns
  `"0x"` (safe but silent failure).
- **Revert data is decoded** and re-thrown as `{ code: 3, message: "execution reverted",
  data: "0x..." }`.

### `eth_estimateGas`

- Gas is computed from `ReviveApi_estimate_gas` → `gas_required.ref_time` converted with
  `weightToGas()`, then padded by **+20%**.
- `to` defaults to zero address if omitted (deployment estimation works, but CREATE address
  will be wrong in the receipt).
- Block tag is ignored (always latest finalized).

### `eth_getLogs`

This is the most constrained method. Key facts:

1. **Forward-only index.** LogIndexer only indexes blocks as they are finalized after
   Pine connects. Queries against ranges that include blocks from before Pine started will
   return incomplete results — not an error, just missing data.
2. **In-memory rolling window.** Default 10,000 blocks (~17 hours at 6 s/block). Logs
   older than the window are silently pruned.
3. **No `blockHash` filter support.** Only `fromBlock`/`toBlock`, `address`, and `topics`
   filters are applied. `blockHash` in the filter object is ignored.
4. **`transactionHash` is a zero hash.** Pine cannot derive the Ethereum tx hash from
   Substrate block data at indexing time. It is filled in as `0x000...0` for logs indexed
   from the rolling window; it is only non-zero if the log was also matched to a TxPool tx
   at receipt-build time.
5. **Heuristic pallet index discovery.** pallet-revive's pallet index in the runtime enum
   varies by runtime. Pine discovers it from the first `ContractEmitted` event it sees. If
   the very first block after connecting has events but no Revive events, future parsing
   may skip events from unrecognised pallets and require a heuristic scan.
6. **SCALE event parsing without metadata.** Parsing `System.Events` without the full
   runtime `Metadata_metadata` response means unknown event sizes are skipped heuristically
   (scanning up to 512 bytes for a zero topics-count byte followed by a valid phase byte).
   In practice this is reliable for Asset Hub workloads, but is not spec-correct.

### `eth_getTransactionByHash` / `eth_getTransactionReceipt`

Both are **session-scoped**:
- Return data only for txs added to the in-memory TxPool during the current Pine session.
- A tx submitted before Pine started, or by a different provider, returns `null`.
- TxPool entries expire after 10 minutes if not included in a finalized block.
- Inclusion detection works by keccak256-hashing every extrinsic in each finalized block
  body and comparing against pending hashes. This correctly handles out-of-order inclusion.

### `eth_getBlockByNumber` / `eth_getBlockByHash`

- The ChainManager tracks the most recent `cache.maxBlocks` (default 1024, ~1.7 hours)
  finalized blocks in memory.
- For older blocks, Pine fetches the block hash via `chainHead_v1_call` and the raw header
  via `chainHead_v1_storage`, but **cannot populate** `parentHash`, `stateRoot`,
  `extrinsicsRoot`, or `timestamp` — these are returned as zero bytes.
- `transactions` array is **always empty**, even when `fullTransactions=true`. Substrate
  blocks contain extrinsics, not Ethereum transactions; decoding all extrinsic types
  requires full metadata.
- EIP-1559 block fields (`baseFeePerGas`) are returned as `null`.
- `miner`, `difficulty`, `totalDifficulty`, `nonce`, `sha3Uncles`, `mixHash` are returned
  as zero values (meaningless in a PoA/NPoS network).

### `eth_gasPrice`

Hardcoded to `0xe8d4a51000` (10¹² wei/gas), matching the Paseo centralized eth-rpc proxy.
Not queried dynamically. If the chain adjusts its fee schedule, this value will be stale
until updated in code.

---

## Unsupported EIP-1193 event types

Pine emits:
- `"connect"` with `{ chainId }` after `connect()` resolves
- `"disconnect"` with `{ code, reason }` on fatal error or `disconnect()` call
- `"chainChanged"` with the hex chain ID on each new finalized block

Pine does **not** emit:
- `"accountsChanged"` — no wallet management
- `"message"` — no subscription push (no `eth_subscribe`)

---

## Performance characteristics

| Operation | Typical latency | Bottleneck |
|-----------|----------------|------------|
| Initial `connect()` | 10–60 s | smoldot WASM init + P2P peer discovery + first finalized block |
| `eth_call` (cache miss) | 300–1500 ms | P2P Merkle proof round-trip |
| `eth_call` (cache hit) | < 1 ms | In-memory map lookup |
| `eth_getBalance` | 300–1500 ms | Same as eth_call |
| `eth_blockNumber` | < 1 ms | In-memory latest block number |
| `eth_getLogs` | < 10 ms | In-memory index scan |
| `eth_sendRawTransaction` | 200–500 ms | `transaction_v1_broadcast` to first peer |
| Transaction inclusion | 6–12 s | Finality (1–2 blocks) |

**Concurrency:** smoldot processes one proof request at a time per subscription. Parallel
`eth_call` requests are queued internally. In practice ~10–20 concurrent requests can be
in-flight before latency degrades significantly. The Datum Campaigns poller uses batches
of 5 for this reason.

**No JSON-RPC batching.** Requests must be sent individually. Ethers v6 batching
(JsonRpcBatchProvider) is not supported — use the custom `PineEthersProvider` adapter
which dispatches each payload separately via `pine.request()`.

---

## Known Paseo-specific quirks handled

| Quirk | Handling |
|-------|---------|
| `eth_getTransactionReceipt` returns `null` for confirmed txs on Paseo eth-rpc proxy | Bypassed entirely — Pine builds receipts from System.Events via ReceiptBuilder |
| `ReviveApi_balance` returns wei (EVM-scaled), not planck | Passed through directly without denomination conversion |
| `value % 10^6 >= 500_000` rejected by pallet-revive (rounding bug) | Callers must round values to clean multiples of 10^6 planck; Pine does not rewrite values |
| `chainHead_v1_follow` subscription may stop unexpectedly | ChainManager re-follows up to 5 times with exponential backoff (1 s → 16 s) before emitting a fatal error |

---

## What Pine cannot do (fundamental limits)

These gaps are architectural — not implementation debt — and require either a full node or
the centralized eth-rpc proxy:

| Capability | Why impossible |
|-----------|---------------|
| Historical `eth_call` at arbitrary past block | smoldot does not retain historical state tries |
| Full historical `eth_getLogs` | No archive index; logs are only in-memory since connect |
| `eth_getProof` (Merkle proofs) | Could theoretically be built from `chainHead_v1_storage`, but not implemented |
| `eth_subscribe` / WebSocket push | smoldot exposes no WebSocket to the consumer |
| `eth_sendTransaction` (unsigned) | No private key access |
| Gas oracle / fee history | No historical block data |
| `debug_traceTransaction` | Requires EVM execution trace; not exposed by pallet-revive's runtime API |
| Resolving ENS / off-chain data | Outside scope |

---

## Supported chains

| Preset | Chain ID | Network |
|--------|----------|---------|
| `paseo-asset-hub` | 420420417 (`0x190e4241`) | Paseo testnet Asset Hub |
| `polkadot-asset-hub` | 420420416 (`0x190e4240`) | Polkadot mainnet Asset Hub |
| `kusama-asset-hub` | 420420418 (`0x190e4242`) | Kusama Asset Hub |
| `westend-asset-hub` | 420420419 (`0x190e4243`) | Westend testnet Asset Hub |
| `custom` | User-specified | Requires `relayChainSpec` + `parachainChainSpec` |
