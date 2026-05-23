import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const a = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));

  const targets = [
    { name: "DatumActivationBonds",  key: "activationBonds",   versionExpected: 2n },
    { name: "DatumGovernanceV2",     key: "governanceV2",      versionExpected: 2n },
    { name: "DatumMintCoordinator",  key: "mintCoordinator",   versionExpected: 2n },
    { name: "DatumCampaigns",        key: "campaigns",         versionExpected: 2n },
    { name: "DatumCampaignLifecycle",key: "campaignLifecycle", versionExpected: 2n },
  ];

  for (const t of targets) {
    const iface = new ethers.Interface([
      "function version() pure returns (uint256)",
      "function parameterGovernance() view returns (address)",
    ]);
    const verData = iface.encodeFunctionData("version");
    const pgData  = iface.encodeFunctionData("parameterGovernance");
    const verRaw  = await ethers.provider.call({ to: a[t.key], data: verData });
    const pgRaw   = await ethers.provider.call({ to: a[t.key], data: pgData });
    const ver = iface.decodeFunctionResult("version", verRaw)[0] as bigint;
    const pg  = iface.decodeFunctionResult("parameterGovernance", pgRaw)[0] as string;
    const okVer = ver === t.versionExpected;
    const okPg  = pg.toLowerCase() === a.parameterGovernance.toLowerCase();
    console.log(`${t.name.padEnd(28)} @ ${a[t.key]}`);
    console.log(`  version()                   = ${ver}  ${okVer ? "✓" : "✗ expected " + t.versionExpected}`);
    console.log(`  parameterGovernance()       = ${pg}  ${okPg ? "✓" : "✗ expected " + a.parameterGovernance}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
