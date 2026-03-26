/**
 * Minimal substrate debug script — deploy MockCampaigns and call registerPublisher.
 * Run from poc/ with: npx hardhat run scripts/debug-substrate.ts --network substrate
 */
import { ethers } from "hardhat";

async function main() {
  const [deployer, publisher] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "chainId:", network.chainId);
  console.log("Deployer:", deployer.address);
  console.log("Publisher:", publisher.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "DOT");

  const feeData = await ethers.provider.getFeeData();
  console.log("Fee data:", {
    gasPrice: feeData.gasPrice?.toString(),
    maxFeePerGas: feeData.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
  });

  // Step 1: Deploy MockCampaigns
  console.log("\n--- Deploying MockCampaigns ---");
  const MockFactory = await ethers.getContractFactory("MockCampaigns");
  const mock = await MockFactory.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log("MockCampaigns deployed at:", mockAddr);

  // Step 2: Call registerPublisher
  console.log("\n--- Calling MockCampaigns.registerPublisher(5000) ---");
  try {
    const gasEstimate = await mock.connect(publisher).registerPublisher.estimateGas(5000);
    console.log("Gas estimate:", gasEstimate.toString());

    // Note: pallet-revive rejects gasLimit > per-tx cap; use estimate directly (no *2)
    const tx = await mock.connect(publisher).registerPublisher(5000, {
      gasLimit: gasEstimate,
    });
    console.log("TX hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Receipt status:", receipt?.status);
    console.log("Gas used:", receipt?.gasUsed.toString());
    console.log("SUCCESS");
  } catch (err: any) {
    console.error("FAILED:", err.message);
    if (err.data) console.error("Error data:", err.data);
    if (err.transaction) console.error("TX:", JSON.stringify(err.transaction, null, 2));
  }

  // Step 3: Deploy DatumPublishers and try registerPublisher
  console.log("\n--- Deploying DatumPublishers ---");
  try {
    const PubFactory = await ethers.getContractFactory("DatumPublishers");
    const pub = await PubFactory.deploy(50n);
    await pub.waitForDeployment();
    console.log("DatumPublishers deployed at:", await pub.getAddress());

    console.log("\n--- Calling DatumPublishers.registerPublisher(5000) ---");
    const gasEst = await pub.connect(publisher).registerPublisher.estimateGas(5000);
    console.log("Gas estimate:", gasEst.toString());

    const tx2 = await pub.connect(publisher).registerPublisher(5000, {
      gasLimit: gasEst,
    });
    console.log("TX hash:", tx2.hash);
    const receipt2 = await tx2.wait();
    console.log("Receipt status:", receipt2?.status);
    console.log("Gas used:", receipt2?.gasUsed.toString());
    console.log("SUCCESS");
  } catch (err: any) {
    console.error("FAILED:", err.message);
    if (err.data) console.error("Error data:", err.data);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
