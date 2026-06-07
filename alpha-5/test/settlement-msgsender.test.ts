// DELEGATECALL chain semantics for the two-Logic Settlement split
// (alpha-4 EIP-170 phase 8d hedge #2).
//
// The two-Logic split routes through:
//   Settlement.settleClaims        --DELEGATECALL--> LogicA.settleClaims
//   LogicA.settleClaims            --DELEGATECALL--> LogicB.processBatch
//   Settlement.processVerifiedBatch--DELEGATECALL--> LogicB.processBatch
//
// Two properties an auditor needs to convince themselves of:
//
//   (1) Storage / address context preservation: LogicA + LogicB run as
//       Settlement -- so any *outgoing* CALL they make (e.g. to
//       paymentVault.creditSettlement) shows msg.sender == Settlement's
//       address, not LogicA's or LogicB's. If a DELEGATECALL hop were
//       mistakenly written as a CALL, paymentVault would see LogicA or
//       LogicB as its caller and silently corrupt accounting.
//
//   (2) Outer-caller msg.sender preservation: the original tx sender
//       (relay EOA, user, attestation verifier, publisher relay)
//       propagates correctly through Settlement -> LogicA, where the
//       per-batch auth check enforces it.
//
// Both properties are exercised here against a probe that records the
// msg.sender it observes.
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumSettlement,
  DatumPauseRegistry,
  DatumBudgetLedger,
  DatumClaimValidator,
  MockCampaigns,
  MockMsgSenderProbe,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { ethersKeccakAbi } from "./helpers/hash";
import { fundSigners } from "./helpers/mine";
import { wireSettlementLogic } from "./helpers/settlementLogic";

describe("Settlement DELEGATECALL chain msg.sender semantics (phase 8d hedge #2)", function () {
  let settlement: DatumSettlement;
  let pauseReg: DatumPauseRegistry;
  let mock: MockCampaigns;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;
  let probe: MockMsgSenderProbe;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let relayEoa: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("10");
  const DAILY_CAP = parseDOT("1");

  function buildOneClaim(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    cpm: bigint,
    impressions: bigint
  ) {
    const nonce = 1n;
    const prevHash = ethers.ZeroHash;
    const hash = ethersKeccakAbi(
      [
        "uint256", "address", "address", "uint256", "uint256", "uint8",
        "bytes32", "uint256", "bytes32", "bytes32",
      ],
      [
        campaignId, publisherAddr, userAddr, impressions, cpm, 0,
        ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash,
      ]
    );
    return [{
      campaignId,
      publisher: publisherAddr,
      eventCount: impressions,
      rateWei: cpm,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof: new Array(8).fill(ethers.ZeroHash),
      nullifier: ethers.ZeroHash,
      stakeRootUsed: ethers.ZeroHash,
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      powNonce: ethers.ZeroHash,
    }];
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher, relayEoa, other] = await ethers.getSigners();

    pauseReg = await (await ethers.getContractFactory("DatumPauseRegistry"))
      .deploy(owner.address, user.address, publisher.address);

    mock = await (await ethers.getContractFactory("MockCampaigns")).deploy();

    ledger = await (await ethers.getContractFactory("DatumBudgetLedger")).deploy();

    // Probe replaces the real DatumPaymentVault in the paymentVault slot.
    // Settlement's `configure(...)` is lock-once but accepts any non-zero
    // address -- exactly what we need to point at the probe.
    probe = await (await ethers.getContractFactory("MockMsgSenderProbe")).deploy();

    validator = await (await ethers.getContractFactory("DatumClaimValidator"))
      .deploy(
        await mock.getAddress(),
        await mock.getAddress(),
        await pauseReg.getAddress()
      );

    settlement = await (await ethers.getContractFactory("DatumSettlement"))
      .deploy(await pauseReg.getAddress());
    await wireSettlementLogic(settlement as any);

    // relayContract is set to a known EOA (relayEoa) so we can drive the
    // relay-path auth check without deploying the full DatumRelay
    // contract.
    await settlement.configure(
      await ledger.getAddress(),
      await probe.getAddress(),                  // probe in paymentVault slot
      await mock.getAddress(),                   // lifecycle placeholder
      relayEoa.address                           // relayContract = bare EOA
    );
    await settlement.setClaimValidator(await validator.getAddress());

    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress());
    await mock.setBudgetLedger(await ledger.getAddress());
    await settlement.setPublishers(await mock.getAddress());
    await settlement.setCampaigns(await mock.getAddress());

    // Seed a campaign + budget so a single claim can settle.
    await mock.setCampaign(
      1n, owner.address, publisher.address, BID_CPM, TAKE_RATE_BPS, 1
    );
    await mock.initBudget(1n, 0, BUDGET, DAILY_CAP, { value: BUDGET });
  });

  it("paymentVault sees Settlement's address as msg.sender (DELEGATECALL chain held)", async function () {
    // Property (1): Settlement -> LogicA -> LogicB -> paymentVault.
    // If any hop were a regular CALL, the probe would see LogicA's or
    // LogicB's address. It MUST see Settlement's.
    const claims = buildOneClaim(
      1n, publisher.address, user.address, BID_CPM, 1000n
    );
    const batch = { user: user.address, campaignId: 1n, claims };
    await settlement.connect(user).settleClaims([batch]);

    const settlementAddr = (await settlement.getAddress()).toLowerCase();
    const observedCaller = (await probe.lastCaller()).toLowerCase();
    const logicA = (await settlement.logicA()).toLowerCase();
    const logicB = (await settlement.logicB()).toLowerCase();

    expect(observedCaller).to.equal(
      settlementAddr,
      "paymentVault saw the wrong msg.sender -- a DELEGATECALL hop in the " +
      "chain was effectively a CALL. Outgoing satellite calls would " +
      "lose Settlement's address-of-record."
    );
    expect(observedCaller).to.not.equal(
      logicA,
      "msg.sender observed at LogicA's address -- DELEGATECALL preservation broke"
    );
    expect(observedCaller).to.not.equal(
      logicB,
      "msg.sender observed at LogicB's address -- DELEGATECALL preservation broke"
    );

    expect(await probe.callCount()).to.equal(1n);
    expect(await probe.lastUser()).to.equal(user.address);
    expect(await probe.lastPublisher()).to.equal(publisher.address);
  });

  it("relay path: msg.sender == relayContract propagates through Settlement -> LogicA auth check", async function () {
    // Property (2a): the auth check inside LogicA.settleClaims is
    //   msg.sender == batch.user || msg.sender == _relayContract ||
    //   msg.sender == _attestationVerifier || isPublisherRelay
    // If Settlement -> LogicA were a regular CALL, msg.sender inside
    // LogicA would be Settlement's address (not relayEoa), so this
    // call would revert E32. Success here proves msg.sender survives
    // the first DELEGATECALL hop.
    //
    // We use nonce=2 because nonce=1 was consumed by the previous test.
    const cpm = BID_CPM;
    const impressions = 1000n;
    const prevHash = (await settlement.lastClaimHash(user.address, 1n, 0));
    const nonce = 2n;
    const hash = ethersKeccakAbi(
      [
        "uint256", "address", "address", "uint256", "uint256", "uint8",
        "bytes32", "uint256", "bytes32", "bytes32",
      ],
      [
        1n, publisher.address, user.address, impressions, cpm, 0,
        ethers.ZeroHash, nonce, prevHash, ethers.ZeroHash,
      ]
    );
    const claim = {
      campaignId: 1n,
      publisher: publisher.address,
      eventCount: impressions,
      rateWei: cpm,
      actionType: 0,
      clickSessionHash: ethers.ZeroHash,
      nonce,
      previousClaimHash: prevHash,
      claimHash: hash,
      zkProof: new Array(8).fill(ethers.ZeroHash),
      nullifier: ethers.ZeroHash,
      stakeRootUsed: ethers.ZeroHash,
      actionSig: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      powNonce: ethers.ZeroHash,
    };
    const batch = { user: user.address, campaignId: 1n, claims: [claim] };
    await settlement.connect(relayEoa).settleClaims([batch]);

    // probe.callCount went 1 -> 2; lastCaller still Settlement
    expect(await probe.callCount()).to.equal(2n);
    const settlementAddr = (await settlement.getAddress()).toLowerCase();
    expect((await probe.lastCaller()).toLowerCase()).to.equal(settlementAddr);
  });

  it("unauthorized caller (not user/relay/attestation/publisher-relay) reverts E32 from LogicA", async function () {
    // Property (2b): the same auth check on LogicA must REJECT a
    // randomly-signing EOA. This proves the check actually fires
    // (rather than being silently bypassed by some incorrect msg.sender
    // overlap with the storage-base default values).
    const claims = buildOneClaim(
      1n, publisher.address, user.address, BID_CPM, 1000n
    );
    const batch = { user: user.address, campaignId: 1n, claims };

    // `other` is none of: batch.user, relayContract, attestationVerifier,
    // publisher's relaySigner. Should hit E32.
    await expect(
      settlement.connect(other).settleClaims([batch])
    ).to.be.revertedWithCustomError(settlement, "E32");
  });
});
