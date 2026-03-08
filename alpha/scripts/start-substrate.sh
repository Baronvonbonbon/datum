#!/usr/bin/env bash
# Start local pallet-revive substrate node + eth-rpc adapter via Docker.
# Exposes an eth_* RPC on http://127.0.0.1:8545
#
# Usage: ./scripts/start-substrate.sh
#   Stop: docker rm -f substrate eth-rpc

set -e

SUBSTRATE_IMAGE="paritypr/substrate:master-a209e590"
ETH_RPC_IMAGE="paritypr/eth-rpc:master-87a8fb03"
SUBSTRATE_PORT=9944
ETH_RPC_PORT=8545

echo "Starting substrate node..."
docker rm -f substrate 2>/dev/null || true
docker run -d --name substrate \
  -p ${SUBSTRATE_PORT}:9944 \
  ${SUBSTRATE_IMAGE} \
  --dev --rpc-external --rpc-cors=all \
  2>&1

echo "Waiting for substrate to be ready..."
for i in $(seq 1 20); do
  if curl -sf -H "Content-Type: application/json" \
    -d '{"id":1,"jsonrpc":"2.0","method":"system_version","params":[]}' \
    http://127.0.0.1:${SUBSTRATE_PORT} > /dev/null 2>&1; then
    echo "Substrate node ready."
    break
  fi
  sleep 1
done

echo "Starting eth-rpc adapter..."
docker rm -f eth-rpc 2>/dev/null || true
docker run -d --name eth-rpc \
  --network host \
  ${ETH_RPC_IMAGE} \
  --rpc-port ${ETH_RPC_PORT} \
  --node-rpc-url ws://127.0.0.1:${SUBSTRATE_PORT} \
  2>&1

echo "Waiting for eth-rpc adapter..."
for i in $(seq 1 20); do
  if curl -sf -H "Content-Type: application/json" \
    -d '{"id":1,"jsonrpc":"2.0","method":"eth_chainId","params":[]}' \
    http://127.0.0.1:${ETH_RPC_PORT} > /dev/null 2>&1; then
    echo "eth-rpc adapter ready on http://127.0.0.1:${ETH_RPC_PORT}"
    break
  fi
  sleep 1
done

echo "Done. Run: npx hardhat test --network substrate"
echo "Stop:  docker rm -f substrate eth-rpc"
