import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  const net = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${net.chainId}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(bal)} PAS`);
}

main().catch((e) => { console.error(e); process.exit(1); });
