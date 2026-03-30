import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DatumSettlement,
  DatumRelay,
  DatumPauseRegistry,
  DatumPaymentVault,
  DatumBudgetLedger,
  DatumClaimValidator,
  MockCampaigns,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { parseDOT } from "./helpers/dot";
import { fundSigners, isSubstrate } from "./helpers/mine";

// Settlement tests for alpha-2:
// S1-S8: core settlement, payment split, rejection
// R1-R10: relay + EIP-712 + publisher co-signature
// OC1-OC4: open campaign settlement
// T2/T7: edge cases (replay, rounding, multi-batch)
//
// Alpha-2 changes:
// - Budget held by BudgetLedger (not MockCampaigns)
// - Pull-payments in PaymentVault (not Settlement)
// - getCampaignForSettlement returns 4 values (no remainingBudget)
// - No ZK verifier on Settlement (removed)

describe("DatumSettlement", function () {
  let settlement: DatumSettlement;
  let relay: DatumRelay;
  let mock: MockCampaigns;
  let pauseReg: DatumPauseRegistry;
  let vault: DatumPaymentVault;
  let ledger: DatumBudgetLedger;
  let validator: DatumClaimValidator;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let publisher: HardhatEthersSigner;
  let protocol: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const TAKE_RATE_BPS = 5000;
  const BID_CPM = parseDOT("0.016");
  const BUDGET = parseDOT("10");
  const DAILY_CAP = parseDOT("1");

  let nextCampaignId = 1n;

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

  async function createTestCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
    const id = nextCampaignId++;
    // Set campaign in mock (4-value: status, publisher, bidCpm, takeRate)
    await mock.setCampaign(
      id, advertiserAddr(), publisher.address, BID_CPM, TAKE_RATE_BPS,
      1 // Active
    );
    // Initialize budget via mock's initBudget helper (forwards to BudgetLedger)
    await mock.initBudget(id, budget, dailyCap, { value: budget });
    return id;
  }

  before(async function () {
    await fundSigners();
    [owner, user, publisher, protocol, other] = await ethers.getSigners();

    // Deploy infrastructure
    const PauseFactory = await ethers.getContractFactory("DatumPauseRegistry");
    pauseReg = await PauseFactory.deploy();

    const MockFactory = await ethers.getContractFactory("MockCampaigns");
    mock = await MockFactory.deploy();

    // Deploy BudgetLedger
    const LedgerFactory = await ethers.getContractFactory("DatumBudgetLedger");
    ledger = await LedgerFactory.deploy();

    // Deploy PaymentVault
    const VaultFactory = await ethers.getContractFactory("DatumPaymentVault");
    vault = await VaultFactory.deploy();

    // Deploy ClaimValidator (SE-1 satellite)
    const ValidatorFactory = await ethers.getContractFactory("DatumClaimValidator");
    validator = await ValidatorFactory.deploy(
      await mock.getAddress(),   // campaigns
      await mock.getAddress(),   // publishers (mock as placeholder)
      await pauseReg.getAddress()
    );

    // Deploy Settlement (alpha-3: constructor takes only pauseRegistry)
    const SettlementFactory = await ethers.getContractFactory("DatumSettlement");
    settlement = await SettlementFactory.deploy(await pauseReg.getAddress());

    // Deploy Relay
    const RelayFactory = await ethers.getContractFactory("DatumRelay");
    relay = await RelayFactory.deploy(
      await settlement.getAddress(),
      await mock.getAddress(),
      await pauseReg.getAddress()
    );
    await settlement.configure(
      await ledger.getAddress(),
      await vault.getAddress(),
      await mock.getAddress(), // lifecycle placeholder (non-zero)
      await relay.getAddress()
    );
    await settlement.setClaimValidator(await validator.getAddress());

    // Wire BudgetLedger
    await ledger.setCampaigns(await mock.getAddress());
    await ledger.setSettlement(await settlement.getAddress());
    await ledger.setLifecycle(await mock.getAddress()); // placeholder

    // Wire MockCampaigns → BudgetLedger (for initBudget helper)
    await mock.setBudgetLedger(await ledger.getAddress());

    // Wire PaymentVault
    await vault.setSettlement(await settlement.getAddress());
  });

  // S1: Single claim — correct payment split
  it("S1: single claim produces correct 3-way split", async function () {
    const cid = await createTestCampaign();
    const impressions = 1000n;
    const cpm = BID_CPM;

    const totalPayment = (cpm * impressions) / 1000n;
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    const claims = buildClaimChain(cid, publisher.address, user.address, 1, cpm, impressions);
    const batch = { user: user.address, campaignId: cid, claims };
    await settlement.connect(user).settleClaims([batch]);

    expect(await vault.publisherBalance(publisher.address)).to.equal(publisherPmt);
    expect(await vault.userBalance(user.address)).to.equal(userPmt);
    expect(await vault.protocolBalance()).to.equal(protocolFee);
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

    const pubBalBefore = await vault.publisherBalance(publisher.address);
    const userBalBefore = await vault.userBalance(user.address);
    const protoBalBefore = await vault.protocolBalance();

    await settlement.connect(user).settleClaims([batch]);

    const totalPayment = (cpm * impressions) / 1000n * BigInt(count);
    const publisherPmt = (totalPayment * BigInt(TAKE_RATE_BPS)) / 10000n;
    const remainder = totalPayment - publisherPmt;
    const userPmt = (remainder * 7500n) / 10000n;
    const protocolFee = remainder - userPmt;

    expect(await vault.publisherBalance(publisher.address) - pubBalBefore).to.equal(publisherPmt);
    expect(await vault.userBalance(user.address) - userBalBefore).to.equal(userPmt);
    expect(await vault.protocolBalance() - protoBalBefore).to.equal(protocolFee);
  });

  // S3: Unauthorized caller reverts
  it("S3: unauthorized caller reverts", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };

    await expect(
      settlement.connect(other).settleClaims([batch])
    ).to.be.revertedWith("E32");
  });

  // S4: CPM exceeding bidCpmPlanck is rejected
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

  // S5: Claims on non-Active campaign are rejected
  it("S5: claims on non-Active campaign are rejected", async function () {
    const cid = await createTestCampaign();
    await mock.setStatus(Number(cid), 0); // Pending
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S6: Genesis claim with non-zero previousClaimHash is rejected
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

  // S7: Tampered claimHash is rejected
  it("S7: tampered claimHash is rejected", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    claims[0].claimHash = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    const batch = { user: user.address, campaignId: cid, claims };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.rejectedCount).to.equal(1n);
  });

  // S8: Publisher can withdraw from PaymentVault
  it("S8: publisher can withdraw accumulated balance from vault", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const balance = await vault.publisherBalance(publisher.address);
    expect(balance).to.be.gt(0n);

    const balBefore = await ethers.provider.getBalance(publisher.address);
    const tx = await vault.connect(publisher).withdrawPublisher();
    const receipt = await tx.wait();
    const balAfter = await ethers.provider.getBalance(publisher.address);

    if (!(await isSubstrate())) {
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      expect(balAfter - balBefore + gasUsed).to.equal(balance);
    }
    expect(await vault.publisherBalance(publisher.address)).to.equal(0n);
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

  // Gap: gap at nonce 3 of 5 — only 1-2 settle
  it("Gap: gap at nonce 3 of 5 — only 1-2 settle", async function () {
    const cid = await createTestCampaign();
    const all5 = buildClaimChain(cid, publisher.address, user.address, 5, BID_CPM, 100n);
    const gapped = [...all5];
    gapped[2] = { ...gapped[2], nonce: 4n };

    const batch = { user: user.address, campaignId: cid, claims: gapped };
    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(2n);
    expect(result.rejectedCount).to.equal(3n);
  });

  // Off-chain claimHash matches
  it("off-chain claimHash: hash built by buildClaimChain is accepted", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const result = await settlement.connect(user).settleClaims.staticCall([
      { user: user.address, campaignId: cid, claims }
    ]);
    expect(result.settledCount).to.equal(1n);
    expect(result.rejectedCount).to.equal(0n);
  });

  // User balance withdrawal from vault
  it("User can withdraw accumulated balance from vault", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const balance = await vault.userBalance(user.address);
    expect(balance).to.be.gt(0n);

    await vault.connect(user).withdrawUser();
    expect(await vault.userBalance(user.address)).to.equal(0n);
  });

  // Double-withdrawal reverts
  it("Double-withdraw: withdrawUser with zero balance reverts E03", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    await vault.connect(user).withdrawUser();
    await expect(vault.connect(user).withdrawUser()).to.be.revertedWith("E03");
  });

  // Protocol fee withdrawal (owner only)
  it("Protocol fee: only owner can withdraw from vault", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    await settlement.connect(user).settleClaims([{ user: user.address, campaignId: cid, claims }]);

    const fee = await vault.protocolBalance();
    expect(fee).to.be.gt(0n);

    await expect(
      vault.connect(other).withdrawProtocol(other.address)
    ).to.be.reverted;

    await vault.connect(owner).withdrawProtocol(protocol.address);
    expect(await vault.protocolBalance()).to.equal(0n);
  });

  // -----------------------------------------------------------------------
  // Publisher Relay (DatumRelay) — R1-R6, R7-R10
  // -----------------------------------------------------------------------

  describe("Publisher Relay (DatumRelay)", function () {
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

    it("R1: publisher can relay settlement with valid signature", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

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

      const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
      expect(result.settledCount).to.equal(1n);
      expect(result.rejectedCount).to.equal(0n);

      await relay.connect(publisher).settleClaimsFor([signedBatch]);
    });

    it("R2: relay with expired deadline reverts E29", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
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

    it("R3: relay with tampered signature reverts E31", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);

      const sigBytes = ethers.getBytes(signature);
      sigBytes[64] = sigBytes[64] === 0x1b ? 0x1c : 0x1b;
      sigBytes[0] ^= 0xff;
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

    it("R4: relay with wrong signer reverts E31", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(other, cid, claims, deadline);

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
      ).to.be.revertedWith("E31");
    });

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

      await relay.connect(publisher).settleClaimsFor([signedBatch]);
      expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);

      const result = await relay.connect(publisher).settleClaimsFor.staticCall([signedBatch]);
      expect(result.settledCount).to.equal(0n);
      expect(result.rejectedCount).to.equal(1n);
    });

    it("R6: direct settleClaims still works after relay addition", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const batch = { user: user.address, campaignId: cid, claims };

      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);

      await settlement.connect(user).settleClaims([batch]);
      expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);
    });

    // Publisher co-signature tests

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

    it("R7: publisher co-signed relay settles successfully", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

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

      await relay.connect(publisher).settleClaimsFor([signedBatch]);
    });

    it("R8: publisher co-sig with wrong signer reverts E34", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
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

    it("R9: publisher co-sig with invalid sig length reverts E33", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
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

    it("R10: publisher co-sig with tampered signature reverts E34", async function () {
      const cid = await createTestCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);

      const deadline = (await ethers.provider.getBlockNumber()) + 100;
      const signature = await signBatch(user, cid, claims, deadline);
      const validPubSig = await signPublisherAttestation(publisher, cid, user.address, claims);

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
  });

  // -----------------------------------------------------------------------
  // Open Campaign Settlement Tests — OC1-OC4
  // -----------------------------------------------------------------------

  describe("Open Campaign Settlement", function () {
    async function createOpenCampaign(budget = BUDGET, dailyCap = DAILY_CAP): Promise<bigint> {
      const id = nextCampaignId++;
      await mock.setCampaign(
        id, advertiserAddr(), ethers.ZeroAddress, BID_CPM, 5000,
        1 // Active
      );
      await mock.initBudget(id, budget, dailyCap, { value: budget });
      return id;
    }

    it("OC1: open campaign settles with any non-zero publisher", async function () {
      const cid = await createOpenCampaign();
      const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(1n);
    });

    it("OC2: open campaign rejects claim with publisher=address(0)", async function () {
      const cid = await createOpenCampaign();
      const claims = buildClaimChain(cid, ethers.ZeroAddress, user.address, 1, BID_CPM, 1000n);
      const batch = { user: user.address, campaignId: cid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.settledCount).to.equal(0n);
      expect(result.rejectedCount).to.equal(1n);
    });

    it("OC4: sentinel fix — non-existent campaign rejected via cBidCpm==0", async function () {
      const fakeCid = 99999n;
      const claims = buildClaimChain(fakeCid, publisher.address, user.address, 1, BID_CPM, 1000n);
      const batch = { user: user.address, campaignId: fakeCid, claims };
      const result = await settlement.connect(user).settleClaims.staticCall([batch]);
      expect(result.rejectedCount).to.equal(1n);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it("T2-1: replay same nonce is rejected", async function () {
    const cid = await createTestCampaign();
    const claims = buildClaimChain(cid, publisher.address, user.address, 1, BID_CPM, 1000n);
    const batch = { user: user.address, campaignId: cid, claims };

    await settlement.connect(user).settleClaims([batch]);
    expect(await settlement.lastNonce(user.address, cid)).to.equal(1n);

    const result = await settlement.connect(user).settleClaims.staticCall([batch]);
    expect(result.settledCount).to.equal(0n);
    expect(result.rejectedCount).to.equal(1n);
  });

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
