// DatumCouncil treasury grants (§2.7 D) — propose/execute with caps.
//
// Verifies:
//   - proposeGrant rejects above per-proposal cap
//   - executeGrant only callable by council via passed proposal
//   - Monthly cumulative cap enforced
//   - Caps tunable within bounds via council self-vote
//   - Token-based payout (WDATUM transfer)

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumCouncil,
  DatumWrapper,
  DatumMintAuthority,
  AssetHubPrecompileMock,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { mineBlocks } from "../helpers/mine";

const ASSET_ID = 31337n;
const DECIMALS = 10n;
const UNIT = 10n ** DECIMALS;

describe("DatumCouncil treasury grants", function () {
  let council: DatumCouncil;
  let wrapper: DatumWrapper;
  let precompile: AssetHubPrecompileMock;
  let authority: DatumMintAuthority;

  let deployer: HardhatEthersSigner;
  let member1: HardhatEthersSigner;
  let member2: HardhatEthersSigner;
  let member3: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;

  const VOTING_PERIOD = 100n;       // blocks
  const EXEC_DELAY    = 10n;
  const VETO_WINDOW   = 200n;
  const MAX_EXEC_WINDOW = 100n;
  const THRESHOLD = 2n;             // 2-of-3

  before(async function () {
    [deployer, member1, member2, member3, guardian, recipient] = await ethers.getSigners();

    // Token stack — needed to provide WDATUM as the grant treasury source
    const PrecompileF = await ethers.getContractFactory("AssetHubPrecompileMock");
    precompile = await PrecompileF.deploy();

    const AuthorityF = await ethers.getContractFactory("DatumMintAuthority");
    authority = await AuthorityF.deploy(await precompile.getAddress(), ASSET_ID);
    await precompile.registerAsset(
      ASSET_ID, await authority.getAddress(),
      "DATUM", "DATUM", Number(DECIMALS),
    );

    const WrapperF = await ethers.getContractFactory("DatumWrapper");
    wrapper = await WrapperF.deploy(
      await authority.getAddress(), await precompile.getAddress(), ASSET_ID, true,
    );
    await authority.setWrapper(await wrapper.getAddress());
    await authority.setSettlement(deployer.address);

    // Council with 3 initial members, 2-of-3 threshold
    const CouncilF = await ethers.getContractFactory("DatumCouncil");
    council = await CouncilF.deploy(
      [member1.address, member2.address, member3.address],
      THRESHOLD,
      guardian.address,
      VOTING_PERIOD,
      EXEC_DELAY,
      VETO_WINDOW,
      MAX_EXEC_WINDOW,
    );

    // Seed treasury: mint 1M WDATUM to the council itself
    await authority.mintForSettlement(
      await council.getAddress(), 1_000_000n * UNIT,
      ethers.ZeroAddress, 0n,
      ethers.ZeroAddress, 0n,
    );

    // Wire grant token via council self-vote
    {
      const calldata = council.interface.encodeFunctionData("setGrantToken", [await wrapper.getAddress()]);
      await council.connect(member1).propose(
        [await council.getAddress()], [0n], [calldata], "set grant token",
      );
      const id = (await council.nextProposalId()) - 1n;
      await council.connect(member1).vote(id);
      await council.connect(member2).vote(id);
      await mineBlocks(Number(EXEC_DELAY) + 1);
      await council.execute(id);
    }
  });

  describe("Grant proposal flow", function () {
    it("Default per-proposal cap is 50k WDATUM, monthly is 200k", async function () {
      expect(await council.grantPerProposalMax()).to.equal(50_000n * UNIT);
      expect(await council.grantMonthlyMax()).to.equal(200_000n * UNIT);
      expect(await council.grantMonthlyUsed()).to.equal(0);
    });

    it("Member can propose a grant within the per-proposal cap", async function () {
      const amount = 30_000n * UNIT;
      const tx = await council.connect(member1).proposeGrant(
        recipient.address, amount, "audit firm payment",
      );
      const receipt = await tx.wait();
      const grantEvent = receipt!.logs
        .map((l) => { try { return council.interface.parseLog(l); } catch { return null; } })
        .find((e) => e?.name === "GrantProposed");
      expect(grantEvent).to.not.be.null;
      expect(grantEvent!.args.recipient).to.equal(recipient.address);
      expect(grantEvent!.args.amount).to.equal(amount);
    });

    it("Proposing above the per-proposal cap reverts", async function () {
      const tooBig = 60_000n * UNIT;
      await expect(
        council.connect(member1).proposeGrant(recipient.address, tooBig, "too big")
      ).to.be.revertedWith("above per-proposal cap");
    });

    it("Zero recipient or zero amount reverts", async function () {
      await expect(
        council.connect(member1).proposeGrant(ethers.ZeroAddress, 100n * UNIT, "zero")
      ).to.be.revertedWith("E00");
      await expect(
        council.connect(member1).proposeGrant(recipient.address, 0n, "zero amount")
      ).to.be.revertedWith("E11");
    });

    it("Non-member cannot propose a grant", async function () {
      await expect(
        council.connect(recipient).proposeGrant(recipient.address, 1000n * UNIT, "outsider")
      ).to.be.revertedWith("E18");
    });
  });

  describe("Grant execution flow", function () {
    let proposalId: bigint;
    const grantAmount = 25_000n * UNIT;

    before(async function () {
      // Create + pass + execute a 25k grant
      await council.connect(member1).proposeGrant(recipient.address, grantAmount, "stipend");
      proposalId = (await council.nextProposalId()) - 1n;
      await council.connect(member1).vote(proposalId);
      await council.connect(member2).vote(proposalId);
      await mineBlocks(Number(EXEC_DELAY) + 1);
    });

    it("execute disburses WDATUM to recipient", async function () {
      const recipientBefore = await wrapper.balanceOf(recipient.address);
      const treasuryBefore = await wrapper.balanceOf(await council.getAddress());
      await council.execute(proposalId);

      const recipientAfter = await wrapper.balanceOf(recipient.address);
      const treasuryAfter = await wrapper.balanceOf(await council.getAddress());

      expect(recipientAfter - recipientBefore).to.equal(grantAmount);
      expect(treasuryBefore - treasuryAfter).to.equal(grantAmount);
    });

    it("grantMonthlyUsed reflects the disbursement", async function () {
      expect(await council.grantMonthlyUsed()).to.equal(grantAmount);
    });

    it("executeGrant cannot be called directly (only via council proposal)", async function () {
      await expect(
        council.connect(member1).executeGrant(recipient.address, 100n * UNIT)
      ).to.be.revertedWith("E18");
    });
  });

  describe("Monthly cap enforcement", function () {
    it("Above-monthly-cap grant reverts at execution", async function () {
      // We've used 25k. Monthly max = 200k. Should be able to grant up to 175k more.
      // Two further grants of 50k each = 100k more (total 125k, well under 200k) → both succeed.
      // Third grant of 50k = 175k total → still under, succeeds.
      // Fourth grant of 50k = 225k total → exceeds cap, executeGrant reverts.

      for (let i = 0; i < 3; i++) {
        await council.connect(member1).proposeGrant(recipient.address, 50_000n * UNIT, `grant ${i}`);
        const id = (await council.nextProposalId()) - 1n;
        await council.connect(member1).vote(id);
        await council.connect(member2).vote(id);
        await mineBlocks(Number(EXEC_DELAY) + 1);
        await council.execute(id);
      }

      // Now monthly used = 25k + 150k = 175k. One more 50k grant would push to 225k.
      expect(await council.grantMonthlyUsed()).to.equal(175_000n * UNIT);

      await council.connect(member1).proposeGrant(recipient.address, 50_000n * UNIT, "over cap");
      const overCapId = (await council.nextProposalId()) - 1n;
      await council.connect(member1).vote(overCapId);
      await council.connect(member2).vote(overCapId);
      await mineBlocks(Number(EXEC_DELAY) + 1);
      // Council.execute() wraps the inner call; the inner revert bubbles via require(ok)
      await expect(council.execute(overCapId)).to.be.revertedWith("E02");
    });
  });

  describe("Caps tunability via council self-vote", function () {
    it("Council can raise per-proposal cap up to 100k", async function () {
      const newCap = 100_000n * UNIT;
      const calldata = council.interface.encodeFunctionData(
        "setGrantCaps", [newCap, 300_000n * UNIT],
      );
      await council.connect(member1).propose(
        [await council.getAddress()], [0n], [calldata], "raise caps",
      );
      const id = (await council.nextProposalId()) - 1n;
      await council.connect(member1).vote(id);
      await council.connect(member2).vote(id);
      await mineBlocks(Number(EXEC_DELAY) + 1);
      await council.execute(id);
      expect(await council.grantPerProposalMax()).to.equal(newCap);
      expect(await council.grantMonthlyMax()).to.equal(300_000n * UNIT);
    });

    it("Caps above hard bounds revert", async function () {
      // 200k per-proposal exceeds the 100k upper bound
      const calldata = council.interface.encodeFunctionData(
        "setGrantCaps", [200_000n * UNIT, 300_000n * UNIT],
      );
      await council.connect(member1).propose(
        [await council.getAddress()], [0n], [calldata], "too high",
      );
      const id = (await council.nextProposalId()) - 1n;
      await council.connect(member1).vote(id);
      await council.connect(member2).vote(id);
      await mineBlocks(Number(EXEC_DELAY) + 1);
      await expect(council.execute(id)).to.be.revertedWith("E02");
    });
  });
});
