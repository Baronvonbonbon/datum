import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumPaymentVault } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners } from "./helpers/mine";

// Gasless (EIP-712 signature-authorized) user withdrawal — withdrawUserBySig.
// The user signs a WithdrawAuth off-chain; a separate "submitter" (relay /
// off-chain worker) broadcasts it, pays gas, and is reimbursed up to maxFee.
describe("DatumPaymentVault — withdrawUserBySig (gasless)", function () {
  let vault: DatumPaymentVault;
  let vaultAddr: string;
  let owner: HardhatEthersSigner;
  let settlementMock: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let submitter: HardhatEthersSigner; // the off-chain worker / relay
  let recipient: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TYPES = {
    WithdrawAuth: [
      { name: "user", type: "address" },
      { name: "recipient", type: "address" },
      { name: "maxFee", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  async function domain() {
    const { chainId } = await ethers.provider.getNetwork();
    return { name: "DatumPaymentVault", version: "1", chainId, verifyingContract: vaultAddr };
  }

  // Build a signed WithdrawAuth for `signer` (defaults to the canonical user).
  async function sign(
    signer: HardhatEthersSigner,
    { userAddr, recipientAddr, maxFee, nonce, deadline }: any,
  ) {
    return signer.signTypedData(await domain(), TYPES, {
      user: userAddr,
      recipient: recipientAddr,
      maxFee,
      nonce,
      deadline,
    });
  }

  const future = async () => (await ethers.provider.getBlockNumber()) + 1000;

  beforeEach(async function () {
    await fundSigners();
    [owner, settlementMock, user, submitter, recipient, other] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("DatumPaymentVault")).deploy();
    vaultAddr = await vault.getAddress();
    await vault.setSettlement(settlementMock.address);
    // Back the vault with DOT (simulates BudgetLedger.deductAndTransfer).
    await owner.sendTransaction({ to: vaultAddr, value: parseDOT("100") });
  });

  async function creditUser(amount: bigint) {
    await vault.connect(settlementMock).creditSettlement(other.address, 0n, user.address, amount, 0n);
  }

  it("happy path: submitter pays gas, user gets net, submitter gets the fee", async function () {
    const amount = parseDOT("1");
    const maxFee = parseDOT("0.01");
    await creditUser(amount);

    const deadline = await future();
    const sig = await sign(user, {
      userAddr: user.address, recipientAddr: ethers.ZeroAddress, maxFee, nonce: 0n, deadline,
    });

    const userBefore = await ethers.provider.getBalance(user.address);

    await expect(vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, deadline, sig))
      .to.emit(vault, "UserWithdrawalBySig")
      .withArgs(user.address, user.address, submitter.address, amount - maxFee, maxFee);

    // user (no tx sent) receives exactly the net; balance slot cleared; nonce bumped
    expect(await ethers.provider.getBalance(user.address)).to.equal(userBefore + (amount - maxFee));
    expect(await vault.userBalance(user.address)).to.equal(0n);
    expect(await vault.withdrawNonce(user.address)).to.equal(1n);
  });

  it("routes the net to a distinct recipient when signed", async function () {
    const amount = parseDOT("2");
    const maxFee = parseDOT("0.02");
    await creditUser(amount);
    const deadline = await future();
    const sig = await sign(user, { userAddr: user.address, recipientAddr: recipient.address, maxFee, nonce: 0n, deadline });

    const recBefore = await ethers.provider.getBalance(recipient.address);
    await vault.connect(submitter).withdrawUserBySig(user.address, recipient.address, maxFee, deadline, sig);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(recBefore + (amount - maxFee));
  });

  it("caps the fee at the balance (maxFee > balance ⇒ fee = balance, net = 0)", async function () {
    const amount = parseDOT("0.001");
    const maxFee = parseDOT("5"); // absurdly high
    await creditUser(amount);
    const deadline = await future();
    const sig = await sign(user, { userAddr: user.address, recipientAddr: ethers.ZeroAddress, maxFee, nonce: 0n, deadline });

    await expect(vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, deadline, sig))
      .to.emit(vault, "UserWithdrawalBySig")
      .withArgs(user.address, user.address, submitter.address, 0n, amount);
    expect(await vault.userBalance(user.address)).to.equal(0n);
  });

  it("rejects replay (nonce is consumed)", async function () {
    const amount = parseDOT("1");
    const maxFee = parseDOT("0.01");
    await creditUser(amount);
    const deadline = await future();
    const sig = await sign(user, { userAddr: user.address, recipientAddr: ethers.ZeroAddress, maxFee, nonce: 0n, deadline });

    await vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, deadline, sig);
    // same signature again → nonce now 1, recovered signer no longer matches → E82
    await expect(
      vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, deadline, sig),
    ).to.be.revertedWith("E82");
  });

  it("rejects an expired authorization (E81)", async function () {
    const amount = parseDOT("1");
    const maxFee = parseDOT("0.01");
    await creditUser(amount);
    const past = (await ethers.provider.getBlockNumber()) - 1;
    const sig = await sign(user, { userAddr: user.address, recipientAddr: ethers.ZeroAddress, maxFee, nonce: 0n, deadline: past });
    await expect(
      vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, past, sig),
    ).to.be.revertedWith("E81");
  });

  it("rejects a signature from someone other than `user` (E82)", async function () {
    const amount = parseDOT("1");
    const maxFee = parseDOT("0.01");
    await creditUser(amount);
    const deadline = await future();
    // `other` signs an auth claiming to be `user`
    const sig = await sign(other, { userAddr: user.address, recipientAddr: ethers.ZeroAddress, maxFee, nonce: 0n, deadline });
    await expect(
      vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, deadline, sig),
    ).to.be.revertedWith("E82");
  });

  it("rejects when the user has no balance (E03)", async function () {
    const maxFee = parseDOT("0.01");
    const deadline = await future();
    const sig = await sign(user, { userAddr: user.address, recipientAddr: ethers.ZeroAddress, maxFee, nonce: 0n, deadline });
    await expect(
      vault.connect(submitter).withdrawUserBySig(user.address, ethers.ZeroAddress, maxFee, deadline, sig),
    ).to.be.revertedWith("E03");
  });
});
