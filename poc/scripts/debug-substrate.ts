import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer address:", signer.address);
  const feeData = await ethers.provider.getFeeData();
  console.log("Fee data:", {
    gasPrice: feeData.gasPrice?.toString(),
    maxFeePerGas: feeData.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
  });
  const block = await ethers.provider.getBlock("latest");
  console.log("Block gas limit:", block?.gasLimit?.toString());
  const balance = await ethers.provider.getBalance(signer.address);
  console.log("Balance:", balance.toString());
}

main().catch(console.error);
