# DATUM Publisher Relay — Reference Implementation

A reference implementation of a publisher relay endpoint that co-signs user claim batches and submits them on-chain via `DatumRelay.settleClaimsFor()`. The relay pays gas on behalf of users — publishers are reimbursed from the campaign budget's take-rate share.

Publishers need a publicly available relay endpoint, but how they choose to implement it is up to them. This template provides an automated Node.js service that queues and submits batches on a timer. Publishers are free to build their own relay using serverless functions, manual review dashboards, custom tooling, or any other approach — as long as the required HTTP endpoints are exposed.

## Prerequisites

- Node.js 18+
- A registered publisher address on-chain (via the DATUM extension Publisher tab)
- Funded wallet (PAS for gas on Paseo testnet)

## Quick Start

```bash
# Copy and configure
cp .env.example .env
# Edit .env — set your PUBLISHER_KEY and contract addresses

# Install dependencies
npm install

# Start
node relay-bot.mjs
```

## Configuration

All configuration is via environment variables or `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLISHER_KEY` | (required) | Publisher wallet private key (hex, 0x prefix) |
| `RPC_URL` | `https://eth-rpc-testnet.polkadot.io/` | Chain RPC endpoint |
| `PORT` | `3400` | HTTP server port |
| `POLL_INTERVAL_MS` | `300000` | Queue submission interval (5 min) |
| `RELAY_ADDRESS` | Paseo default | DatumRelay contract address |
| `SETTLEMENT_ADDRESS` | Paseo default | DatumSettlement contract address |
| `CAMPAIGNS_ADDRESS` | Paseo default | DatumCampaigns contract address |
| `PAUSE_REGISTRY_ADDRESS` | Paseo default | PauseRegistry contract address |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/.well-known/datum-attest` | Publisher co-signature (EIP-712 attestation) |
| POST | `/relay/submit` | Queue user-signed claim batches |
| POST | `/relay/flush` | Immediate submission (localhost only) |
| GET | `/relay/status` | Queue depth + stats |
| GET | `/health` | Heartbeat |

## Exposing to the Internet

The relay listens on `0.0.0.0:3400`. To accept remote claims, expose it via HTTPS:

### Cloudflare Quick Tunnel (simplest, no domain needed)

```bash
cloudflared tunnel --url http://127.0.0.1:3400
```

This gives you a temporary `*.trycloudflare.com` URL. The URL changes on restart.

### Cloudflare Named Tunnel (stable URL, requires domain)

```bash
cloudflared tunnel create my-relay
cloudflared tunnel route dns my-relay relay.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:3400 my-relay
```

### Connecting the Extension

The DATUM extension discovers relay URLs from the `data-relay` attribute on the publisher's SDK script tag. When a user visits a publisher page, the extension reads the relay URL and stores it for attestation requests. Post-alpha, publishers will register their relay domain on-chain.

## systemd Service (Linux)

Create `~/.config/systemd/user/datum-publisher-relay.service`:

```ini
[Unit]
Description=DATUM Publisher Relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/your/relay
ExecStart=/usr/bin/node relay-bot.mjs
Restart=on-failure
RestartSec=30
Environment=PUBLISHER_KEY=0xYOUR_KEY
Environment=RPC_URL=https://eth-rpc-testnet.polkadot.io/

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now datum-publisher-relay
loginctl enable-linger $USER  # keep running after logout
```

## Security

- **No user private keys:** Users sign claim batches locally (EIP-712). Only the signature is sent to the relay.
- **Signature verification:** Every submitted batch is verified against the claimed user address before queuing.
- **Rate limiting:** Per-IP sliding-window limits (10 attest/min, 5 submit/min, 30 status/min).
- **Input validation:** Address format, nonce range, batch size caps (max 100 claims per batch, 10 batches per request).
- **Body size limit:** 256 KB max request body.
- **Localhost-only flush:** The `/relay/flush` endpoint only accepts requests from 127.0.0.1.
- **No secrets in public endpoints:** `/relay/status` and `/health` expose only non-sensitive operational data.

## How It Works

1. User browses a publisher page with the DATUM SDK + extension
2. Extension tracks impressions locally, builds claim hash chain
3. When user signs a claim batch, extension requests publisher co-signature from `/.well-known/datum-attest`
4. Signed batch is submitted to `/relay/submit`
5. Relay verifies user signature, queues batch
6. Periodically (configurable), relay submits queued batches via `DatumRelay.settleClaimsFor()`
7. Settlement contract splits revenue: publisher (take rate), user (75%), protocol (25%)

## Queue Persistence

Pending batches are persisted to `pending-queue.json` so they survive restarts. Expired batches (past deadline block) are automatically pruned.
