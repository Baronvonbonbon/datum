import { ethers } from "hardhat";

async function main() {
  // Patch micro-eth-signer to log the actual validation errors
  const mse = require("micro-eth-signer");
  const origTx = mse.Transaction;
  const origPrepare = origTx.prepare.bind(origTx);
  origTx.prepare = function(data: any, strict: any) {
    try {
      return origPrepare(data, strict);
    } catch (e: any) {
      if (e.errors) {
        console.error("TX field errors:", JSON.stringify(e.errors, null, 2));
        console.error("TX data:", JSON.stringify(data, (k, v) =>
          typeof v === 'bigint' ? v.toString() + 'n' : v, 2));
      }
      throw e;
    }
  };

  const [signer] = await ethers.getSigners();
  console.log("Deploying...");

  const CampaignsFactory = await ethers.getContractFactory("DatumCampaigns");
  await CampaignsFactory.deploy(0n, 50n, 20n);
}

main().catch(console.error);
