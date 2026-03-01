# Deployments

This directory tracks deployed contract addresses per network.

| File | Network |
|------|---------|
| `local.json` | Local substrate dev chain (Docker) |
| `westend.json` | Westend Asset Hub (when deployed) |
| `polkadot-hub.json` | Polkadot Hub mainnet (when deployed) |

## Format

```json
{
  "network": "<name>",
  "chainId": <number>,
  "deployedAt": "YYYY-MM-DD",
  "deployer": "0x...",
  "contracts": {
    "DatumPublishers": "0x...",
    "DatumCampaigns": "0x...",
    "DatumGovernanceVoting": "0x...",
    "DatumGovernanceRewards": "0x...",
    "DatumSettlement": "0x...",
    "DatumRelay": "0x..."
  },
  "notes": "..."
}
```

## Re-deploying

Each `npx hardhat run scripts/deploy.ts --network <net>` prints all addresses. Update the corresponding JSON file with the new addresses, then update the extension Settings accordingly.
