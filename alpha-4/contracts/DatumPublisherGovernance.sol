// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumPublisherGovernance.sol";
import "./interfaces/IDatumPublisherStake.sol";
import "./interfaces/IDatumChallengeBonds.sol";
import "./interfaces/IDatumPauseRegistry.sol";
import "./DatumOwnable.sol";
import "./PaseoSafeSender.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DatumPublisherGovernance
/// @notice FP-3: Conviction-weighted fraud proposals targeting publishers.
///
///         Participants lock DOT to vote aye (fraud) or nay (not fraud) on a proposal.
///         Conviction table is identical to GovernanceV2:
///           0→1x/0d  1→2x/1d  2→3x/3d  3→4x/7d  4→6x/21d
///           5→9x/90d 6→14x/180d 7→18x/270d 8→21x/365d
///
///         Resolution conditions:
///           - ayeWeighted > nayWeighted  AND  ayeWeighted >= quorum  → FRAUD UPHELD
///           - nayWeighted >= ayeWeighted OR ayeWeighted < quorum      → NOT FRAUD
///           - A grace period (minGraceBlocks) must elapse after any nay vote
///             before resolution is allowed.
///
///         On fraud upheld:
///           - slashBps of publisher's stake is slashed via DatumPublisherStake.
///           - bondBonusBps of the slashed amount is forwarded to ChallengeBonds.addToPool().
///           - Remainder stays in this contract (protocol treasury).
///
///         Losing voters' DOT is NOT slashed (unlike GovernanceV2 campaign slash) —
///         they simply can't withdraw until lockup expires.
contract DatumPublisherGovernance is IDatumPublisherGovernance, PaseoSafeSender, DatumOwnable {
    uint8 public constant MAX_CONVICTION = 8;

    // ── Conviction curve (governable, quadratic) ──────────────────────────────
    //   weight(c) = (convictionA * c² + convictionB * c) / CONVICTION_SCALE + 1
    //   Defaults A=25, B=50 match the legacy step-function endpoint at c=8 (21x).

    uint256 public constant CONVICTION_SCALE = 100;
    uint256 public constant MAX_LOCKUP_BLOCKS = 10_512_000;  // 2y

    uint256 public convictionA;
    uint256 public convictionB;
    uint256[9] public convictionLockup;

    event ConvictionCurveSet(uint256 a, uint256 b);
    event ConvictionLockupsSet(uint256[9] lockups);

    function _weight(uint8 c) internal view returns (uint256) {
        uint256 cu = uint256(c);
        return (convictionA * cu * cu + convictionB * cu) / CONVICTION_SCALE + 1;
    }

    function _lockup(uint8 c) internal view returns (uint256) {
        return convictionLockup[c];
    }

    // ── Configuration ──────────────────────────────────────────────────────────

    IDatumPublisherStake public publisherStake;
    IDatumChallengeBonds public challengeBonds;
    IDatumPauseRegistry public pauseRegistry;

    uint256 public quorum;
    uint256 public slashBps;
    uint256 public bondBonusBps;
    uint256 public minGraceBlocks;
    /// @notice G-M5: required propose bond. Forfeited to treasury when a proposal
    ///         fails to reach quorum; refunded otherwise. 0 = no bond required.
    uint256 public proposeBond;

    /// @notice G-M3 / G-M5 / G-M6: pull-pattern queue. Any DOT the contract
    ///         needs to send out (refunded bonds, swept treasury) lands here;
    ///         recipient pulls via claimGovPayout[To].
    mapping(address => uint256) public pendingGovPayout;

    /// @notice Slashed remainder accumulated for the treasury (G-M6). Owner
    ///         calls sweepTreasury() to move it into pendingGovPayout[owner()].
    uint256 public treasuryBalance;

    event GovPayoutQueued(address indexed recipient, uint256 amount, string reason);
    event GovPayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
    event TreasurySwept(address indexed owner, uint256 amount);

    // -------------------------------------------------------------------------
    // #3 (2026-05-12): Council-arbitrated advertiser fraud claims
    // -------------------------------------------------------------------------
    // Parallel track to the conviction-weighted vote: an advertiser stakes a
    // bond and submits an evidence CID. The Council (via DatumCouncil → propose
    // → vote → execute) calls councilResolveAdvertiserClaim with upheld/dismissed.
    //
    //   upheld    → publisher stake slashed (same distribution as conviction
    //               track: bondBonusBps share → ChallengeBonds, remainder →
    //               treasury); advertiser bond refunded.
    //   dismissed → advertiser bond forwarded to publisher as compensation
    //               for the false claim. Anti-griefing.
    //
    // Advertisers prove fraud via off-chain analytics referenced by the IPFS
    // CID; Council members do the substantive review off-chain and only commit
    // their verdict on-chain. The bond+anti-griefing structure means both
    // parties have skin in the game.

    struct AdvertiserFraudClaim {
        address advertiser;       // who filed
        address publisher;        // target
        uint256 campaignId;       // 0 = publisher-wide claim
        bytes32 evidenceHash;     // IPFS CID of analytics report
        uint256 bond;             // advertiser-staked bond (refunded/slashed)
        bool resolved;
        bool upheld;
        uint256 createdBlock;
    }

    /// @notice Council contract authorized to resolve advertiser fraud claims.
    address public councilArbiter;
    /// @notice Bond required to file an advertiser fraud claim. Governable; 0 disables.
    uint256 public advertiserClaimBond;
    /// @notice Auto-incrementing claim id.
    uint256 public nextAdvertiserClaimId = 1;
    mapping(uint256 => AdvertiserFraudClaim) public advertiserClaims;

    event CouncilArbiterSet(address indexed arbiter);
    event AdvertiserClaimBondSet(uint256 amount);
    event AdvertiserFraudClaimFiled(
        uint256 indexed claimId,
        address indexed advertiser,
        address indexed publisher,
        uint256 campaignId,
        bytes32 evidenceHash,
        uint256 bond
    );
    event AdvertiserFraudClaimResolved(
        uint256 indexed claimId,
        address indexed publisher,
        bool upheld,
        uint256 slashAmount,
        uint256 bondDisposition // refunded to advertiser if upheld, forwarded to publisher if dismissed
    );

    modifier onlyCouncilArbiter() {
        require(councilArbiter != address(0) && msg.sender == councilArbiter, "E18");
        _;
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.pausedGovernance(), "P");
        _;
    }

    // ── State ──────────────────────────────────────────────────────────────────

    uint256 public nextProposalId;

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => Vote)) private _votes;

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(
        address _publisherStake,
        address _challengeBonds,
        address _pauseRegistry,
        uint256 _quorum,
        uint256 _slashBps,
        uint256 _bondBonusBps,
        uint256 _minGraceBlocks,
        uint256 _proposeBond
    ) DatumOwnable() {
        require(_publisherStake != address(0), "E00");
        require(_pauseRegistry != address(0), "E00");
        require(_slashBps <= 10000, "E00");
        require(_bondBonusBps <= 10000, "E00");
        publisherStake = IDatumPublisherStake(_publisherStake);
        challengeBonds = _challengeBonds == address(0) ? IDatumChallengeBonds(address(0)) : IDatumChallengeBonds(_challengeBonds);
        pauseRegistry = IDatumPauseRegistry(_pauseRegistry);
        quorum = _quorum;
        slashBps = _slashBps;
        bondBonusBps = _bondBonusBps;
        minGraceBlocks = _minGraceBlocks;
        proposeBond = _proposeBond;
        nextProposalId = 1;

        // Default quadratic conviction curve (matches V2 endpoints).
        convictionA = 25;
        convictionB = 50;
        convictionLockup[0] = 0;
        convictionLockup[1] = 14400;
        convictionLockup[2] = 43200;
        convictionLockup[3] = 100800;
        convictionLockup[4] = 302400;
        convictionLockup[5] = 1296000;
        convictionLockup[6] = 2592000;
        convictionLockup[7] = 3888000;
        convictionLockup[8] = 5256000;
    }

    // ── Governable gating parameters ──────────────────────────────────────────
    event QuorumSet(uint256 value);
    event SlashBpsSet(uint256 value);
    event BondBonusBpsSet(uint256 value);
    event MinGraceBlocksSet(uint256 value);
    event ProposeBondSet(uint256 value);

    function setQuorum(uint256 v) external onlyOwner { quorum = v; emit QuorumSet(v); }
    function setSlashBps(uint256 v) external onlyOwner { require(v <= 10000, "E11"); slashBps = v; emit SlashBpsSet(v); }
    function setBondBonusBps(uint256 v) external onlyOwner { require(v <= 10000, "E11"); bondBonusBps = v; emit BondBonusBpsSet(v); }
    function setMinGraceBlocks(uint256 v) external onlyOwner { minGraceBlocks = v; emit MinGraceBlocksSet(v); }
    function setProposeBond(uint256 v) external onlyOwner { proposeBond = v; emit ProposeBondSet(v); }

    function setConvictionCurve(uint256 a, uint256 b) external onlyOwner {
        uint256 maxWeight = (a * 64 + b * 8) / CONVICTION_SCALE + 1;
        require(maxWeight <= 1000, "E11");
        convictionA = a; convictionB = b;
        emit ConvictionCurveSet(a, b);
    }

    function setConvictionLockups(uint256[9] calldata l) external onlyOwner {
        for (uint256 i = 0; i < 9; i++) {
            require(l[i] <= MAX_LOCKUP_BLOCKS, "E11");
            convictionLockup[i] = l[i];
        }
        emit ConvictionLockupsSet(l);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    /// @dev Cypherpunk lock-once: PublisherStake is where this contract reads
    ///      stake + calls slash. Hot-swap = unilateral slash of any publisher.
    function setPublisherStake(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(publisherStake) == address(0), "already set");
        publisherStake = IDatumPublisherStake(addr);
    }

    /// @dev Cypherpunk lock-once on first non-zero write; address(0) leaves the
    ///      challenge-bonds reward path disabled. Once non-zero, frozen.
    function setChallengeBonds(address addr) external onlyOwner {
        require(address(challengeBonds) == address(0), "already set");
        challengeBonds = IDatumChallengeBonds(addr);
    }

    /// @dev Cypherpunk lock-once: pauseRegistry gates vote/resolve. Hot-swap to
    ///      a fake "always-unpaused" registry would bypass emergency pause.
    function setPauseRegistry(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        require(address(pauseRegistry) == address(0), "already set");
        pauseRegistry = IDatumPauseRegistry(addr);
    }

    function setParams(uint256 _quorum, uint256 _slashBps, uint256 _bondBonusBps, uint256 _minGrace) external onlyOwner {
        require(_slashBps <= 10000, "E00");
        require(_bondBonusBps <= 10000, "E00");
        quorum = _quorum;
        slashBps = _slashBps;
        bondBonusBps = _bondBonusBps;
        minGraceBlocks = _minGrace;
    }

    /// @notice #3: Set the Council contract authorized to resolve advertiser
    ///         fraud claims.
    /// @dev    D3 cypherpunk lock-once: a hot-swappable arbiter is a unilateral
    ///         slash backdoor. address(0) leaves the Council-arbitrated track
    ///         disabled; once set non-zero it's frozen for the life of the
    ///         contract. To rotate arbiters, the Council itself rotates its
    ///         membership at the Council contract level.
    function setCouncilArbiter(address arbiter) external onlyOwner {
        require(councilArbiter == address(0), "already set");
        councilArbiter = arbiter;
        emit CouncilArbiterSet(arbiter);
    }

    /// @notice #3: Set the bond required for filing an advertiser fraud claim.
    ///         Bond is refunded on upheld, forwarded to publisher on dismissed.
    ///         Set to 0 to disable the Council-arbitrated track entirely.
    function setAdvertiserClaimBond(uint256 amount) external onlyOwner {
        advertiserClaimBond = amount;
        emit AdvertiserClaimBondSet(amount);
    }

    // ── #3: Council-arbitrated advertiser fraud claims ───────────────────────

    /// @notice File a fraud claim against a publisher. Stake `advertiserClaimBond`
    ///         to file. Council resolves later via `councilResolveAdvertiserClaim`.
    /// @param publisher     Publisher being accused.
    /// @param campaignId    Campaign-specific claim, or 0 for publisher-wide.
    /// @param evidenceHash  IPFS CID of analytics evidence (bot rate, conversion
    ///                      anomalies, IP clustering, etc.). Reviewed by Council off-chain.
    function fileAdvertiserFraudClaim(address publisher, uint256 campaignId, bytes32 evidenceHash)
        external
        payable
        whenNotPaused
        returns (uint256 claimId)
    {
        require(publisher != address(0), "E00");
        require(evidenceHash != bytes32(0), "E00");
        require(advertiserClaimBond > 0, "E01"); // track disabled
        require(msg.value == advertiserClaimBond, "E11");
        require(councilArbiter != address(0), "E01");
        // Cannot accuse self (mirrors A6 anti-laundering check on conviction track).
        require(msg.sender != publisher, "E18");

        claimId = nextAdvertiserClaimId++;
        advertiserClaims[claimId] = AdvertiserFraudClaim({
            advertiser: msg.sender,
            publisher: publisher,
            campaignId: campaignId,
            evidenceHash: evidenceHash,
            bond: msg.value,
            resolved: false,
            upheld: false,
            createdBlock: block.number
        });
        emit AdvertiserFraudClaimFiled(claimId, msg.sender, publisher, campaignId, evidenceHash, msg.value);
    }

    /// @notice Council resolves a filed advertiser fraud claim. Called by the
    ///         Council contract after its propose+vote+execute cycle.
    /// @param claimId  The advertiser claim id.
    /// @param upheld   true = fraud confirmed; false = claim dismissed.
    function councilResolveAdvertiserClaim(uint256 claimId, bool upheld) external onlyCouncilArbiter nonReentrant {
        AdvertiserFraudClaim storage c = advertiserClaims[claimId];
        require(c.createdBlock > 0, "E01");
        require(!c.resolved, "E41");
        c.resolved = true;
        c.upheld = upheld;

        uint256 slashAmount = 0;
        uint256 bond = c.bond;
        c.bond = 0;

        if (upheld) {
            // Slash publisher stake — same distribution as conviction track.
            uint256 publisherStakeAmt = publisherStake.staked(c.publisher);
            slashAmount = (publisherStakeAmt * slashBps) / 10000;
            if (slashAmount > 0) {
                publisherStake.slash(c.publisher, slashAmount, address(this));
                uint256 forwarded;
                if (address(challengeBonds) != address(0) && bondBonusBps > 0) {
                    uint256 bonusShare = (slashAmount * bondBonusBps) / 10000;
                    if (bonusShare > 0 && bonusShare <= address(this).balance) {
                        challengeBonds.addToPool{value: bonusShare}(c.publisher);
                        forwarded = bonusShare;
                    }
                }
                treasuryBalance += (slashAmount - forwarded);
            }
            // Bond refunded to advertiser (queue pull).
            if (bond > 0) {
                pendingGovPayout[c.advertiser] += bond;
                emit GovPayoutQueued(c.advertiser, bond, "advertiser fraud claim upheld");
            }
        } else {
            // Dismissed: bond → publisher (compensation for false claim).
            if (bond > 0) {
                pendingGovPayout[c.publisher] += bond;
                emit GovPayoutQueued(c.publisher, bond, "advertiser fraud claim dismissed");
            }
        }
        emit AdvertiserFraudClaimResolved(claimId, c.publisher, upheld, slashAmount, bond);
    }

    // ── Publisher governance actions ───────────────────────────────────────────

    /// @inheritdoc IDatumPublisherGovernance
    /// @dev G-M5: requires `proposeBond` to be sent. Refunded on quorum reached;
    ///      forfeited to the treasury (owner-claimable via sweepTreasury) otherwise.
    function propose(address publisher, bytes32 evidenceHash) external payable whenNotPaused {
        require(publisher != address(0), "E00");
        require(evidenceHash != bytes32(0), "E00");
        require(msg.value == proposeBond, "E11");
        // A6: a publisher cannot be the proposer on their own fraud proposal.
        // Without this, the proposer can vote against themselves to launder
        // stake into the bond-bonus pool they (qua advertiser) can draw on.
        require(msg.sender != publisher, "E18");

        uint256 proposalId = nextProposalId++;
        _proposals[proposalId] = Proposal({
            publisher: publisher,
            evidenceHash: evidenceHash,
            createdBlock: block.number,
            resolved: false,
            ayeWeighted: 0,
            nayWeighted: 0,
            firstNayBlock: 0,
            proposer: msg.sender,
            bond: msg.value
        });

        emit ProposalCreated(proposalId, publisher, evidenceHash);
        if (msg.value > 0) emit ProposeBondLocked(proposalId, msg.sender, msg.value);
    }

    /// @inheritdoc IDatumPublisherGovernance
    function vote(uint256 proposalId, bool aye, uint8 conviction) external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "E11");
        require(conviction <= MAX_CONVICTION, "E40");

        Proposal storage p = _proposals[proposalId];
        require(p.createdBlock > 0, "E01");
        require(!p.resolved, "E41");

        Vote storage v = _votes[proposalId][msg.sender];

        // Remove existing vote weight (re-vote support)
        if (v.direction != 0) {
            uint256 existingWeight = v.lockAmount * _weight(v.conviction);
            if (v.direction == 1) {
                p.ayeWeighted -= existingWeight;
            } else {
                p.nayWeighted -= existingWeight;
                // Note: firstNayBlock remains set (most conservative)
            }
            // Refund prior lock if unlocked; otherwise fail gracefully
            // (voter must wait for their lockup to expire before re-voting)
            require(block.number >= v.lockedUntilBlock, "E42"); // prior lock still active
            // Refund old locked amount — AUDIT-007: emit event for auditability
            uint256 refundAmount = v.lockAmount;
            emit VoteRefunded(proposalId, msg.sender, refundAmount);
            _safeSend(msg.sender, refundAmount);
        }

        uint256 weight = msg.value * _weight(conviction);
        uint256 lockup = _lockup(conviction);

        v.direction = aye ? 1 : 2;
        v.lockAmount = msg.value;
        v.conviction = conviction;
        v.lockedUntilBlock = block.number + lockup;

        if (aye) {
            p.ayeWeighted += weight;
        } else {
            p.nayWeighted += weight;
            if (p.firstNayBlock == 0) p.firstNayBlock = block.number;
        }

        emit VoteCast(proposalId, msg.sender, aye, msg.value, conviction);
    }

    /// @inheritdoc IDatumPublisherGovernance
    function withdrawVote(uint256 proposalId) external nonReentrant {
        Vote storage v = _votes[proposalId][msg.sender];
        require(v.direction != 0, "E01");
        require(block.number >= v.lockedUntilBlock, "E42");

        // G-L4: rely on Solidity 0.8 checked arithmetic — silently capping at zero
        //       hides invariant violations. If weight tracking ever desyncs, revert.
        Proposal storage p = _proposals[proposalId];
        uint256 weight = v.lockAmount * _weight(v.conviction);
        if (v.direction == 1) p.ayeWeighted -= weight;
        else                   p.nayWeighted -= weight;

        uint256 amount = v.lockAmount;
        v.direction = 0;
        v.lockAmount = 0;
        v.conviction = 0;
        v.lockedUntilBlock = 0;

        emit VoteWithdrawn(proposalId, msg.sender, amount);
        _safeSend(msg.sender, amount);
    }

    /// @inheritdoc IDatumPublisherGovernance
    function resolve(uint256 proposalId) external nonReentrant whenNotPaused {
        Proposal storage p = _proposals[proposalId];
        require(p.createdBlock > 0, "E01");
        require(!p.resolved, "E41");

        // Grace period: must wait minGraceBlocks after first nay vote (if any)
        if (p.firstNayBlock > 0) {
            require(block.number >= p.firstNayBlock + minGraceBlocks, "E43");
        }

        p.resolved = true;

        bool fraudUpheld = p.ayeWeighted > p.nayWeighted && p.ayeWeighted >= quorum;
        uint256 slashAmount = 0;

        if (fraudUpheld) {
            // Slash publisher stake
            uint256 publisherStakeAmt = publisherStake.staked(p.publisher);
            slashAmount = (publisherStakeAmt * slashBps) / 10000;

            if (slashAmount > 0) {
                // Slash to this contract first, then distribute
                publisherStake.slash(p.publisher, slashAmount, address(this));

                uint256 forwarded = 0;
                // Forward bondBonusBps share to challenge bonds pool
                if (address(challengeBonds) != address(0) && bondBonusBps > 0) {
                    uint256 bonusShare = (slashAmount * bondBonusBps) / 10000;
                    if (bonusShare > 0 && bonusShare <= address(this).balance) {
                        challengeBonds.addToPool{value: bonusShare}(p.publisher);
                        forwarded = bonusShare;
                    }
                }
                // G-M6: track remainder explicitly so sweepTreasury doesn't need to
                //       reason about balance deltas vs pending queues.
                treasuryBalance += (slashAmount - forwarded);
            }
        }

        // G-M5: bond accounting.
        //   - Quorum reached (aye OR nay weight ≥ quorum) → proposer gets bond back.
        //   - Otherwise → bond forfeited to treasury (owner pull via sweepTreasury).
        bool quorumReached = p.ayeWeighted >= quorum || p.nayWeighted >= quorum;
        uint256 bond = p.bond;
        p.bond = 0;
        if (bond > 0) {
            address recipient = quorumReached ? p.proposer : owner();
            pendingGovPayout[recipient] += bond;
            emit ProposeBondQueued(recipient, bond, quorumReached);
        }

        emit ProposalResolved(proposalId, p.publisher, fraudUpheld, slashAmount);
    }

    /// @notice G-M6: Move accumulated slashed remainder into the owner's
    ///         pull-payout queue. Permissionless trigger; only owner can claim.
    function sweepTreasury() external nonReentrant {
        uint256 amount = treasuryBalance;
        require(amount > 0, "E03");
        treasuryBalance = 0;
        pendingGovPayout[owner()] += amount;
        emit TreasurySwept(owner(), amount);
        emit GovPayoutQueued(owner(), amount, "treasury sweep");
    }

    /// @notice G-M3/G-M5/G-M6: Pull a queued payout to msg.sender.
    function claimGovPayout() external nonReentrant {
        _claimGovPayout(msg.sender);
    }

    /// @notice G-M3/G-M5/G-M6: Pull a queued payout to a chosen recipient.
    function claimGovPayoutTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claimGovPayout(recipient);
    }

    function _claimGovPayout(address recipient) internal {
        uint256 amount = pendingGovPayout[msg.sender];
        require(amount > 0, "E03");
        pendingGovPayout[msg.sender] = 0;
        emit GovPayoutClaimed(msg.sender, recipient, amount);
        _safeSend(recipient, amount);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function proposals(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVote(uint256 proposalId, address voter) external view returns (Vote memory) {
        return _votes[proposalId][voter];
    }

    /// @notice Returns the weight multiplier for a conviction level.
    function convictionWeight(uint8 conviction) external view returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _weight(conviction);
    }

    /// @notice Returns the lockup duration in blocks for a conviction level.
    function convictionLockupBlocks(uint8 conviction) external view returns (uint256) {
        require(conviction <= MAX_CONVICTION, "E40");
        return _lockup(conviction);
    }

    /// @notice Allow receiving slashed funds from PublisherStake.slash().
    receive() external payable {}
}
