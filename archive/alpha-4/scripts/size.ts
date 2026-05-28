// scripts/size.ts — print runtime + init bytecode sizes for every compiled contract.
// EIP-170 enforces a 24,576 B runtime cap on mainnet; pallet-revive on Paseo does not.
// Usage: npx hardhat run scripts/size.ts            (uses default config)
//        npx hardhat --config hardhat.config.mainnet.ts run scripts/size.ts
import { artifacts } from "hardhat";

const EIP170 = 24_576;

function hexBytes(hex: string): number {
  if (!hex || hex === "0x") return 0;
  return (hex.length - 2) / 2;
}

async function main() {
  const names = await artifacts.getAllFullyQualifiedNames();
  type Row = { name: string; runtime: number; init: number; over: number };
  const rows: Row[] = [];

  for (const fqName of names) {
    if (fqName.startsWith("@openzeppelin/")) continue;
    const art = await artifacts.readArtifact(fqName);
    const runtime = hexBytes(art.deployedBytecode);
    const init = hexBytes(art.bytecode);
    if (runtime === 0) continue; // interfaces / libraries with no deployable code
    rows.push({
      name: art.contractName,
      runtime,
      init,
      over: runtime - EIP170,
    });
  }

  rows.sort((a, b) => b.runtime - a.runtime);

  const wName = Math.max(8, ...rows.map((r) => r.name.length));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const padNum = (n: number, w: number) => " ".repeat(Math.max(0, w - String(n).length)) + String(n);

  console.log(pad("contract", wName), "  ", pad("runtime", 7), "  ", pad("init", 7), "  ", pad("over", 7));
  console.log("-".repeat(wName + 36));
  for (const r of rows) {
    const flag = r.over > 0 ? "  ⚠" : "";
    console.log(pad(r.name, wName), "  ", padNum(r.runtime, 7), "  ", padNum(r.init, 7), "  ", padNum(r.over, 7), flag);
  }

  const violations = rows.filter((r) => r.over > 0);
  console.log("");
  console.log(`EIP-170 limit: ${EIP170} B`);
  console.log(`Total contracts: ${rows.length}`);
  console.log(`Over limit:     ${violations.length}`);
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
