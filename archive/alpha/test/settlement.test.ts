import { expect } from "chai";
import { ethers } from "hardhat";
import { DatumSettlement, DatumRelay, MockCampaigns, DatumPauseRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, isSubstrate } from "./helpers/mine";

// Settlement tests: S1-S8
// Plus: gap-at-claim-5, genesis-hash, take-rate-snapshot
// Plus: R1-R6 relay tests (DatumRelay)
// Plus: R7-R10 publisher co-signature tests
//
// On substrate, contract deployments are very slow (>5 min for large PVM bytecodes).
// Contracts are deployed once in `before`. Each test uses a unique campaign ID.

describe("DatumSettlement", function () {
  let settlement: DatumSettlement;
  let relay: DatumRelay;
  let mock: MockCampaigns;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let protocol: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;           // 50% to publisher
  // 0.016 DOT CPM — chosen so all 3-way split amounts (publisher/user/protocol) are
  // exact multiples of 10^6 planck.  Substrate eth-rpc rejects native transfers where
  // value % 10^6 >= 500_000 (denomination rounding bug), so amounts must be "clean".
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("10");        // 10 DOT
  const DAILY_CAP = parseDOT("1");      // 1 DOT

  let nextCampaignId = 1n;

  // Build a claim hash chain for testing
  function buildClaimChain(
    campaignId: bigint,
    publisherAddr: string,
    userAddr: string,
    count: number,
    baseCpm: bigint,
    impressionsPerClaim: bigint
  ) {
    const claims = [];
    let prevHash = ethers.ZeroHash;

    for (let i = 1; i <= count; i++) {
      const nonce = BigInt(i);
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [campaignId, publisherAddr, userAddr, impressionsPerClaim, baseCpm, nonce, prevHash]
      );
      claims.push({
        campaignId,
        publisher: publisherAddr,
        impressionCount: impressionsPerClaim,
        clearingCpmPlanck: baseCpm,
        nonce,
        previousClaimHash: prevHash,
        claimHash: hash,
        zkProof: "0x",
      });
      prevHash = hash;
    }
    return claims;
  }

  function advertiserAddr() { return owner.address; }

  // Create a fresh Active campaign in the mock with its own ID
  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
    const id = nextCampaignId++;
    await mock.setCampaign(
      id, advertiserAddr(), publisher.address, budget, dailyCap, BID_CPM, TAKE_RATE_BPS,
      1 // CampaignStatus.Active
    );
    // Fund the mock with DOT (planck) to handle deductBudget
    await owner.sendTransaction({ to: await mock.getAddress(), value: budget });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher, protocol, other] = await ethers.getSigners();

    // Deploy pause registry
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    const pauseReg = await PauseFactory.deploy();

    // Deploy MockCampaigns
    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    // Deploy DatumSettlement
    const SettlementFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementFactory.deploy(await mock.getAddress(), await pauseReg.getAddress());

    // Deploy DatumRelay
    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(await settlement.getAddress(), await mock.getAddress(), await pauseReg.getAddress());

    // Wire: settlement authorizes relay, mock authorizes settlement
    await settlement.setRelayContract(await relay.getAddress());
    await mock.setSettlementContract(await settlement.getAddress());
  });

  // S1: Single claim — correct payment split
  it("S1: single claim produces correct 3-way split", async function () {
    const cid = await createTestCampaign();
    const impressions = 1000n;
    const cpm = BID_CPM;

    // totalPayment = cpm * impressions / 1000 = 0.016 DOT
    const totalPayment = (cpm * impressions) / 1000n;
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    // Record balances before
    const pubBalBefore = await settlement.publisherBalance(publisher.address);
    const userBalBefore = await settlement.userBalance(user.address);
    const protoBalBefore = await settlement.protocolBalance();

    const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
    const batch = { user: user.address, campaignId: cid, claims };

    await settlement.connect(user).settleClaims([batch]);

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(publisherPmt);
    expect(await settlement.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await settlement.protocolBalance() - protoBalBefore).to.equal(protocolFee);
  });

  // S2: Multiple sequential claims accumulate correctly
  it("S2: five sequential claims accumulate balances correctly", async function () {
    const cid = await createTestCampaign();
    const impressions = 500n;
    const cpm = BID_CPM;
    const count = 5;

    const claims = buildClaimChain(cid, publisher.address, user.address, count, cpm, impressions);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(BigInt(count));
    expect(result.rejectedCount).to.equal(0n);

    const pubBalBefore = await settlement.publisherBalance(publisher.address);
    const userBalBefore = await settlement.userBalance(user.address);
    const protoBalBefore = await settlement.protocolBalance();

    await settlement.connect(user).settleClaims([batch]);

    const totalPayment = (cpm * impressions) / 1000n * BigInt(count);
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(publisherPmt);
    expect(await settlement.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await settlement.protocolBalance() - protoBalBefore).to.equal(protocolFee);
  });

  // S3: Issue 7 — caller must be batch.user or relay
  it("S3: unauthorized caller reverts", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };

    await expect(
      settlement.connect(other).settleClaims([batch])
    ).to.be.revertedWith("E32");
  });

  // S4: Issue 2 — CPM exceeding bidCpmPlanck is rejected
  it("S4: claim with clearingCpmPlanck > bidCpmPlanck is rejected", async function () {
    const cid = await createTestCampaign();
    const highCpm = BID_CPM + 1n;
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, 1000n, highCpm, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: 1000n,
      clearingCpmPlanck: highCpm,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // S5: Campaign must be Active — Paused/Pending/Completed are rejected
  it("S5: claims on non-Active campaign are rejected", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(cid, 0); // Pending
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S6: Genesis claim must have previousClaimHash == bytes32(0)
  it("S6: genesis claim with non-zero previousClaimHash is rejected", async function () {
    const cid = await createTestCampaign();
    const nonZeroPrev = ethers.keccak256(ethers.toUtf8Bytes("not-zero"));
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, 1000n, BID_CPM, 1n, nonZeroPrev]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: 1000n,
      clearingCpmPlanck: BID_CPM,
      nonce: 1n,
      previousClaimHash: nonZeroPrev,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S7: Hash chain is validated — tampered hash is rejected
  it("S7: tampered claimHash is rejected", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    claims[0].claimHash = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S8: Publisher balance withdrawal works
  it("S8: publisher can withdraw accumulated balance", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const balance = await settlement.publisherBalance(publisher.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(publisher.address);
    const tx = await settlement.connect(publisher).withdrawPublisher();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(publisher.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    } else {
      // On substrate, verify contract balance zeroed (gas costs may dwarf transfer amount)
      expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
    }
    expect(await settlement.publisherBalance(publisher.address)).to.equal(0n);
  });

  // A2: Zero-impression claims rejected
  it("A2: zero-impression claim is rejected", async function () {
    const cid = await createTestCampaign();
    const nonce = 1n;
    const hash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
      [cid, publisher.address, user.address, 0n, BID_CPM, nonce, ethers.ZeroHash]
    );
    const claims = [{
      campaignId: cid,
      publisher: publisher.address,
      impressionCount: 0n,
      clearingCpmPlanck: BID_CPM,
      nonce,
      previousClaimHash: ethers.ZeroHash,
      claimHash: hash,
      zkProof: "0x",
    }];
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
    expect(result.settledCount).to.equal(0n);
  });

  // Gap-at-claim-3: only claims 1-2 settle; 3 and beyond rejected (within MAX_CLAIMS_PER_BATCH=5)
  it("Gap: gap at nonce 3 of 5 — only 1-2 settle", async function () {
    const cid = await createTestCampaign();
    // Build 5 claims but skip nonce 3 (set nonce 3 to 4, creating a gap)
    const all5 = buildClaimChain(cid, publisher.address, user.address, 5, BID_CPM, 100n);

    // Introduce gap: replace claim at index 2 (nonce 3) with wrong nonce
    const gapped = [...all5];
    gapped[2] = { ...gapped[2], nonce: 4n }; // skip nonce 3

    const batch = { user: user.address, campaignId: cid, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);

    expect(result.settledCount).to.equal(2n);
    expect(result.rejectedCount).to.equal(3n); // 3 gapped + 4,5 rejected too
  });

  // Take rate snapshot test
  it("Snapshot: settlement uses snapshotTakeRateBps, not current publisher rate", async function () {
    const cid = await createTestCampaign();

    const impressions = 1000n;
    const cpm = BID_CPM;
    const totalPayment = (cpm * impressions) / 1000n;
    const expectedPublisherPmt = (totalPayment * 5000n) / 10000n; // 50%

    const pubBalBefore = await settlement.publisherBalance(publisher.address);

    const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(expectedPublisherPmt);
  });

  // claimHash computed off-chain (solidityPackedKeccak256) matches what the contract accepts
  it("off-chain claimHash: hash built by buildClaimChain is accepted by settleClaims", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid, claims }
    ]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // User balance withdrawal
  it("User can withdraw accumulated balance", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const balance = await settlement.userBalance(user.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(user.address);
    const tx = await settlement.connect(user).withdrawUser();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(user.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    } else {
      expect(await settlement.userBalance(user.address)).to.equal(0n);
    }
  });

  // Double-withdrawal: second call with zero balance should revert
  it("Double-withdraw: withdrawUser with zero balance reverts E03", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    // First withdrawal drains balance
    await settlement.connect(user).withdrawUser();
    expect(await settlement.userBalance(user.address)).to.equal(0n);

    // Second withdrawal — nothing to send
    await expect(settlement.connect(user).withdrawUser()).to.be.revertedWith("E03");
  });

  // Protocol fee withdrawal (owner only)
  it("Protocol fee: only owner can withdraw; recipient receives correct amount", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const fee = await settlement.protocolBalance();
    expect(fee).to.be.gt(0n);

    await expect(
      settlement.connect(other).withdrawProtocol(other.address)
    ).to.be.reverted;

    const balBefore = await ethers.provider.getBalance(protocol.address);
    await settlement.connect(owner).withdrawProtocol(protocol.address);
    const balAfter = await ethers.provider.getBalance(protocol.address);

    if (!(await isSubstrate())) {
      expect(balAfter - balBefore).to.equal(fee);
    } else {
      expect(await settlement.protocolBalance()).to.equal(0n);
    }
    expect(await settlement.protocolBalance()).to.equal(0n);
  });

  // -----------------------------------------------------------------------
  // Publisher Relay Settlement (DatumRelay.settleClaimsFor) — R1-R6
  // -----------------------------------------------------------------------

  describe("Publisher Relay (DatumRelay)", function () {
    // EIP-712 domain and types for signing (verifyingContract is the relay)
    async function getEIP712Domain() {
      return {
        name: "DatumRelay",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await relay.getAddress(),
      };
    }

    const eip712Types = {
      ClaimBatch: [
        { name: "user", type: "address" },
        { name: "campaignId", type: "uint256" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    async function signBatch(
      signer: HardhatEthersSigner,
      campaignId: bigint,
      claims: any[],
      deadline: number
    ) {
      const domain = await getEIP712Domain();
      const value = {
        user: signer.address,
        campaignId,
        firstNonce: claims[0].nonce,
        lastNonce: claims[claims.length - 1].nonce,
        claimCount: claims.length,
        deadline,
      };
      return signer.signTypedData(domain, eip712Types, value);
    }

    // R1: publisher can relay settlement for user with valid EIP-712 signature
    it("R1: publisher can relay settlement with valid signature", async function () {
      const cid = await createTestCampaign();
      const impressions = 1000n;
      const cpm = BID_CPM;
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig: "0x",
      };

      const pubBalBefore = await settlement.publisherBalance(publisher.address);
      const userBalBefore = await settlement.userBalance(user.address);
      const protoBalBefore = await settlement.protocolBalance();

      const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      await relay.connect(publisher).settleClaimsFor([signedBatch]);

      // Verify 3-way split
      const totalPayment = (cpm * impressions) / 1000n;
      const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
      const remainder = totalPayment - publisherPmt;
      const userPmt = (remainder * 7500n) / 10000n;
      const protocolFee = remainder - userPmt;

      expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(publisherPmt);
      expect(await settlement.userBalance(user.address) - userBalBefore).to.equal(userPmt);
      expect(await settlement.protocolBalance() - protoBalBefore).to.equal(protocolFee);
    });

    // R2: relay with expired deadline reverts
    it("R2: relay with expired deadline reverts E29", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      // Deadline in the past
      const deadline = (await ethers.provider.getBlockNumber()) - 1;
      const signature = await signBatch(user, cid, claims, deadline);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig: "0x",
      };

      await expect(
        relay.connect(publisher).settleClaimsFor([signedBatch])
      ).to.be.revertedWith("E29");
    });

    // R3: relay with invalid signature reverts
    it("R3: relay with tampered signature reverts E31", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);

      // Tamper with the signature
      const sigBytes = ethers.getBytes(signature);
      sigBytes[64] = sigBytes[64] === 0x1b ? 0x1c : 0x1b; // flip v
      sigBytes[0] ^= 0xff; // corrupt r
      const tamperedSig = ethers.hexlify(sigBytes);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature: tamperedSig,
        publisherSig: "0x",
      };

      await expect(
        relay.connect(publisher).settleClaimsFor([signedBatch])
      ).to.be.revertedWith("E31");
    });

    // R4: relay with wrong signer reverts
    it("R4: relay with wrong signer reverts E31", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      // Sign with `other` instead of `user`
      const signature = await signBatch(other, cid, claims, deadline);

      const signedBatch = {
        user: user.address,  // batch says user, but signature is from other
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig: "0x",
      };

      await expect(
        relay.connect(publisher).settleClaimsFor([signedBatch])
      ).to.be.revertedWith("E31");
    });

    // R5: replay of settled batch — claims rejected on nonce
    it("R5: replay of settled batch rejects all claims", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 200;
      const signature = await signBatch(user, cid, claims, deadline);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig: "0x",
      };

      // First submission succeeds
      await relay.connect(publisher).settleClaimsFor([signedBatch]);
      expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);

      // Replay: same claims, same signature — nonce already consumed
      const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
      expect(result.settledCount).to.equal(0n);
      expect(result.rejectedCount).to.equal(1n);
    });

    // -----------------------------------------------------------------------
    // Publisher co-signature tests — R7-R10
    // -----------------------------------------------------------------------

    const publisherAttestationTypes = {
      PublisherAttestation: [
        { name: "campaignId", type: "uint256" },
        { name: "user", type: "address" },
        { name: "firstNonce", type: "uint256" },
        { name: "lastNonce", type: "uint256" },
        { name: "claimCount", type: "uint256" },
      ],
    };

    async function signPublisherAttestation(
      signer: HardhatEthersSigner,
      campaignId: bigint,
      userAddr: string,
      claims: any[]
    ) {
      const domain = await getEIP712Domain();
      const value = {
        campaignId,
        user: userAddr,
        firstNonce: claims[0].nonce,
        lastNonce: claims[claims.length - 1].nonce,
        claimCount: claims.length,
      };
      return signer.signTypedData(domain, publisherAttestationTypes, value);
    }

    // R7: publisher co-signed relay settles successfully
    it("R7: publisher co-signed relay settles successfully", async function () {
      const cid = await createTestCampaign();
      const impressions = 1000n;
      const cpm = BID_CPM;
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
      const publisherSig = await signPublisherAttestation(publisher, cid, user.address, claims);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig,
      };

      const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      await relay.connect(publisher).settleClaimsFor([signedBatch]);
      expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);
    });

    // R8: publisher co-sig with wrong signer reverts E34
    it("R8: publisher co-sig with wrong signer reverts E34", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
      // Sign publisher attestation with `other` — not the campaign's publisher
      const publisherSig = await signPublisherAttestation(other, cid, user.address, claims);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig,
      };

      await expect(
        relay.connect(publisher).settleClaimsFor([signedBatch])
      ).to.be.revertedWith("E34");
    });

    // R9: publisher co-sig with invalid sig length reverts E33
    it("R9: publisher co-sig with invalid sig length reverts E33", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
      // 32-byte sig — wrong length (must be 65)
      const publisherSig = ethers.hexlify(ethers.randomBytes(32));

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig,
      };

      await expect(
        relay.connect(publisher).settleClaimsFor([signedBatch])
      ).to.be.revertedWith("E33");
    });

    // R10: publisher co-sig with tampered signature reverts E34
    it("R10: publisher co-sig with tampered signature reverts E34", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
      const validPubSig = await signPublisherAttestation(publisher, cid, user.address, claims);

      // Tamper with the publisher signature
      const sigBytes = ethers.getBytes(validPubSig);
      sigBytes[0] ^= 0xff;
      sigBytes[64] = sigBytes[64] === 0x1b ? 0x1c : 0x1b;
      const tamperedPubSig = ethers.hexlify(sigBytes);

      const signedBatch = {
        user: user.address,
        campaignId: cid,
        claims,
        deadline,
        signature,
        publisherSig: tamperedPubSig,
      };

      await expect(
        relay.connect(publisher).settleClaimsFor([signedBatch])
      ).to.be.revertedWith("E34");
    });

    // R6: direct settleClaims still works unchanged (regression)
    it("R6: direct settleClaims still works after relay addition", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const batch = { user: user.address, campaignId: cid, claims };

      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      await settlement.connect(user).settleClaims([batch]);
      expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);
    });
  });

  // -----------------------------------------------------------------------
  // ZK Verifier (DatumZKVerifier stub) — Z1-Z3
  // -----------------------------------------------------------------------

  describe("ZK Verifier (DatumZKVerifier)", function () {
    // Z1: settlement accepts non-empty zkProof when stub verifier is wired
    it("Z1: non-empty zkProof accepted with stub verifier", async function () {
      const ZKFactory = await ethers.getContractFactory("DatumZKVerifier");
      const zkVerifier = await ZKFactory.deploy();
      // Wire ZK verifier directly
      await settlement.setZKVerifier(await zkVerifier.getAddress());

      const cid = await createTestCampaign();
      const impressions = 1000n;
      const cpm = BID_CPM;

      // Build claim with non-empty zkProof
      const nonce = 1n;
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [cid, publisher.address, user.address, impressions, cpm, nonce, ethers.ZeroHash]
      );
      const claims = [{
        campaignId: cid,
        publisher: publisher.address,
        impressionCount: impressions,
        clearingCpmPlanck: cpm,
        nonce,
        previousClaimHash: ethers.ZeroHash,
        claimHash: hash,
        zkProof: "0x1234",
      }];
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      // Clean up: reset zkVerifier
      await settlement.setZKVerifier(ethers.ZeroAddress);
    });

    // Z2: empty zkProof is accepted even with verifier wired (skips verification)
    it("Z2: empty zkProof accepted with stub verifier (skips verification)", async function () {
      const ZKFactory = await ethers.getContractFactory("DatumZKVerifier");
      const zkVerifier = await ZKFactory.deploy();
      // Wire ZK verifier directly
      await settlement.setZKVerifier(await zkVerifier.getAddress());

      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
      // claims[0].zkProof is "0x" (empty) from buildClaimChain
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      // Clean up
      await settlement.setZKVerifier(ethers.ZeroAddress);
    });

    // Z3: settlement ignores zkProof when no verifier is set
    it("Z3: zkProof ignored when no verifier set", async function () {
      // Ensure no verifier is set
      expect(await settlement.zkVerifier()).to.equal(ethers.ZeroAddress);

      const cid = await createTestCampaign();
      const nonce = 1n;
      const hash = ethers.solidityPackedKeccak256(
        ["uint256", "address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [cid, publisher.address, user.address, 1000n, BID_CPM, nonce, ethers.ZeroHash]
      );
      const claims = [{
        campaignId: cid,
        publisher: publisher.address,
        impressionCount: 1000n,
        clearingCpmPlanck: BID_CPM,
        nonce,
        previousClaimHash: ethers.ZeroHash,
        claimHash: hash,
        zkProof: "0xdeadbeef",
      }];
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // Open Campaign Settlement Tests — OC1-OC4
  // -----------------------------------------------------------------------

  describe("Open Campaign Settlement", function () {
    // Helper: create open campaign (publisher = address(0)) in mock
    async function createOpenCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
      const id = nextCampaignId++;
      await mock.setCampaign(
        id, advertiserAddr(), ethers.ZeroAddress, budget, dailyCap, BID_CPM, 5000,
        1 // Active
      );
      await owner.sendTransaction({ to: await mock.getAddress(), value: budget });
      return id;
    }

    // OC1: settlement with open campaign + any non-zero publisher succeeds
    it("OC1: open campaign settles with any non-zero publisher", async function () {
      const cid = await createOpenCampaign();
      const impressions = 1000n;
      const cpm = BID_CPM;

      const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);

      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);
    });

    // OC2: open campaign rejects claim with publisher=address(0)
    it("OC2: open campaign rejects claim with publisher=address(0)", async function () {
      const cid = await createOpenCampaign();
      const impressions = 1000n;
      const cpm = BID_CPM;

      const claims = buildClaimChain(cid, ethers.ZeroAddress, user.address, 1, cpm, impressions);
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);

      expect(result.settledCount).to.equal(0n);
      expect(result.rejectedCount).to.equal(1n);
    });

    // OC3: open campaign uses snapshot take rate (DEFAULT_TAKE_RATE_BPS = 50%)
    it("OC3: open campaign uses snapshot take rate (50%)", async function () {
      const cid = await createOpenCampaign();
      const impressions = 1000n;
      const cpm = BID_CPM;

      const totalPayment = (cpm * impressions) / 1000n;
      // Snapshot take rate is 5000 bps (50%) — DEFAULT_TAKE_RATE_BPS
      const expectedPublisherPmt = (totalPayment * 5000n) / 10000n;

      const pubBalBefore = await settlement.publisherBalance(publisher.address);

      const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
      await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

      expect(await settlement.publisherBalance(publisher.address) - pubBalBefore).to.equal(expectedPublisherPmt);
    });

    // OC4: sentinel fix — non-existent campaign (cBidCpm == 0) is rejected
    it("OC4: sentinel fix — non-existent campaign rejected via cBidCpm==0", async function () {
      const fakeCid = 99999n;
      const claims = buildClaimChain(fakeCid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const batch = { user: user.address, campaignId: fakeCid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.rejectedCount).to.equal(1n);
      expect(result.settledCount).to.equal(0n);
    });
  });

  // =========================================================================
  // T-2 Settlement edge cases
  // =========================================================================

  it("T2-1: replay same nonce is rejected", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };

    // First submission succeeds
    await settlement.connect(user).settleClaims([batch]);
    expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);

    // Replay with same nonce — rejected (nonce mismatch)
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(0n);
    expect(result.rejectedCount).to.equal(1n);
  });

  it("T2-2: claim with rounding-to-zero payment settles with zero payout", async function () {
    // Create campaign with very low CPM
    const lowCpmId = nextCampaignId++;
    const lowCpm = 1n; // 1 planck per 1000 impressions
    await mock.setCampaign(
      lowCpmId, advertiserAddr(), publisher.address, BUDGET, DAILY_CAP, lowCpm, TAKE_RATE_BPS, 1
    );
    await owner.sendTransaction({ to: await mock.getAddress(), value: BUDGET });

    // 1 impression at 1 planck CPM = totalPayment = (1 * 1) / 1000 = 0 planck (integer division)
    const claims = buildClaimChain(lowCpmId, publisher.address, user.address, 1, lowCpm, 1n);
    const batch = { user: user.address, campaignId: lowCpmId, claims };

    // Contract settles zero-payment claims (impressionCount > 0 passes validation)
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
    expect(result.totalPaid).to.equal(0n);
  });

  // T-7 Integration: multiple batches in single settleClaims call
  it("T7-1: multiple batches in single settleClaims call", async function () {
    const cid1 = await createTestCampaign();
    const cid2 = await createTestCampaign();

    const claims1 = buildClaimChain(cid1, publisher.address, user.address, 3, BID_CPM, 1000n);
    const claims2 = buildClaimChain(cid2, publisher.address, user.address, 2, BID_CPM, 1000n);

    const batch1 = { user: user.address, campaignId: cid1, claims: claims1 };
    const batch2 = { user: user.address, campaignId: cid2, claims: claims2 };

    const result = await settlement.connect(user).settleClaims.staticCall([batch1, batch2]);
    expect(result.settledCount).to.equal(5n);
    expect(result.rejectedCount).to.equal(0n);

    await settlement.connect(user).settleClaims([batch1, batch2]);

    expect(await settlement.lastNonce(user.address, cid1)).to.equal(3n);
    expect(await settlement.lastNonce(user.address, cid2)).to.equal(2n);
  });
});
