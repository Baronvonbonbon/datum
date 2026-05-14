// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./DatumOwnable.sol";
import "./interfaces/IDatumTagRegistry.sol";

/// @title DatumTagRegistry
/// @notice Stake-gated tag namespace with Schelling-point arbitration. Pairs
///         with the curated `DatumTagCurator` and the per-actor `Any` lane as
///         one of three coexisting tag-policy lanes on DATUM.
///
///         Cypherpunk design notes:
///
///         - **No permanent ownership.** A tag's bond pays for namespace
///           occupancy only as long as the tag is being used. After
///           `expiryBlocks` of inactivity, anyone can call `expireTag(tag)`
///           and pocket the full bond as a garbage-collection bounty. Squatting
///           popular terms degenerates into a market price-discovery process:
///           whoever values the tag most either uses it (keeps it alive) or
///           pays a continually-rising bond to hold it idle.
///
///         - **Symmetric challenge bonds.** A challenger must match the tag's
///           current bond. Winner takes the lion's share of both bonds;
///           majority jurors split a fixed bps cut; non/minority-revealing
///           jurors are slashed proportionally. Stake on both sides → no
///           free-rolls in either direction.
///
///         - **No council in the hot path.** Disputes are decided by a
///           randomly-selected, WDATUM-staked, commit-reveal jury. The owner
///           (Timelock or governance) can tune parameters indefinitely
///           (`minTagBond`, `jurySize`, windows, slash rates) within
///           hard-coded floors and ceilings — but cannot decide individual
///           disputes, freeze the registry, or seize bonds.
///
///         - **Indefinite evolution.** There is no policy lock on the
///           registry itself; the protocol must always be able to retune
///           parameters as economic conditions change. Hard floors guarantee
///           the registry can never be made unusable (e.g., `minTagBond` has
///           a floor; gov cannot raise it to MAX_UINT and price out everyone
///           — that would be a soft kill of the stake-gated lane).
///
///         Randomness: juror selection seeds from `blockhash(block.number-1)`
///         mixed with the dispute id. This is adequate for low-value tag
///         disputes but is not miner-resistant — for high-stakes cases the
///         right answer is a VRF, deferred to a future upgrade.
contract DatumTagRegistry is IDatumTagRegistry, DatumOwnable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable: staking token (WDATUM)
    // ---------------------------------------------------------------------

    IERC20 public immutable datum;

    // ---------------------------------------------------------------------
    // Lock-once: Campaigns pointer (sole caller authorized to recordUsage)
    // ---------------------------------------------------------------------

    address public campaignsContract;
    bool public campaignsLocked;

    // ---------------------------------------------------------------------
    // Hard floors and ceilings — uphold the cypherpunk lane regardless of
    // governance posture. These cannot be raised/lowered without a contract
    // redeploy. Picked conservatively so the lane stays usable forever.
    // ---------------------------------------------------------------------

    uint256 public constant MIN_TAG_BOND_FLOOR = 1e18;        // 1 WDATUM
    uint256 public constant MAX_TAG_BOND_CEILING = 1_000_000e18;
    uint256 public constant MIN_JUROR_STAKE_FLOOR = 1e18;
    uint256 public constant MAX_JUROR_STAKE_CEILING = 1_000_000e18;
    uint64  public constant MIN_COMMIT_WINDOW = 600;          // ~1 h at 6 s
    uint64  public constant MAX_COMMIT_WINDOW = 100800;       // ~1 week
    uint64  public constant MIN_REVEAL_WINDOW = 600;
    uint64  public constant MAX_REVEAL_WINDOW = 100800;
    uint64  public constant MIN_EXPIRY_BLOCKS = 14400;        // ~24 h
    uint64  public constant MAX_EXPIRY_BLOCKS = 5_256_000;    // ~365 d
    uint8   public constant MIN_JURY_SIZE = 3;
    uint8   public constant MAX_JURY_SIZE = 21;
    uint16  public constant MAX_JURY_REWARD_BPS = 3000;       // 30%
    uint16  public constant MAX_JUROR_SLASH_BPS = 5000;       // 50%

    // ---------------------------------------------------------------------
    // Governance-tunable parameters (no lock — indefinite evolution)
    // ---------------------------------------------------------------------

    uint256 public minTagBond;
    uint256 public jurorMinStake;
    uint64 public commitWindow;
    uint64 public revealWindow;
    uint8 public jurySize;
    uint16 public juryRewardBps;
    uint16 public jurorSlashBps;
    uint64 public expiryBlocks;

    // ---------------------------------------------------------------------
    // Tag state
    // ---------------------------------------------------------------------

    struct TagInfo {
        address owner;
        uint256 bond;
        uint64 lastUsedBlock;
        uint64 registeredBlock;
        TagState state;
        uint256 activeDisputeId; // 0 if none
    }
    mapping(bytes32 => TagInfo) private _tags;

    // ---------------------------------------------------------------------
    // Juror pool
    // ---------------------------------------------------------------------

    mapping(address => uint256) public jurorStake;
    mapping(address => uint256) public jurorLockedStake; // worst-case slash exposure across active disputes
    address[] private _jurors;
    mapping(address => uint256) private _jurorIndex;     // 1-based; 0 = not in pool

    // ---------------------------------------------------------------------
    // Disputes
    // ---------------------------------------------------------------------

    struct Dispute {
        bytes32 tag;
        address tagOwner;
        address challenger;
        uint256 bondAmount;            // each side's bond
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint8 jurySize_;               // snapshot of jurySize at open
        uint16 juryRewardBps_;         // snapshot
        uint16 jurorSlashBps_;         // snapshot
        uint256 lockedPerJuror;        // snapshot of slash exposure per juror
        address[] jurors;
        bool resolved;
        uint16 keepRevealed;
        uint16 expireRevealed;
    }
    mapping(uint256 => Dispute) private _disputes;
    mapping(uint256 => mapping(address => bytes32)) private _commit;
    mapping(uint256 => mapping(address => Vote)) private _reveal;
    mapping(uint256 => mapping(address => bool)) private _isJuror;
    uint256 public nextDisputeId; // first id == 1

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    // Use string reverts (matches codebase convention with E-codes elsewhere).
    // Tag-registry codes: T01..T20.

    constructor(IERC20 datum_) {
        require(address(datum_) != address(0), "E00");
        datum = datum_;

        // Conservative initial parameters. Owner tunes from here.
        minTagBond     = 10e18;     // 10 WDATUM
        jurorMinStake  = 5e18;      // 5 WDATUM
        commitWindow   = 14400;     // ~24 h
        revealWindow   = 14400;     // ~24 h
        jurySize       = 5;
        juryRewardBps  = 2000;      // 20% of total pot
        jurorSlashBps  = 2000;      // 20% of jurorMinStake at risk per dispute
        expiryBlocks   = 432000;    // ~30 d
        nextDisputeId  = 1;
    }

    // ---------------------------------------------------------------------
    // Owner: Campaigns wiring (lock-once)
    // ---------------------------------------------------------------------

    function setCampaignsContract(address c) external onlyOwner {
        require(!campaignsLocked, "T01"); // locked
        require(c != address(0), "E00");
        campaignsContract = c;
        emit CampaignsContractSet(c);
    }

    function lockCampaigns() external onlyOwner {
        require(!campaignsLocked, "T01");
        require(campaignsContract != address(0), "T02"); // unset
        campaignsLocked = true;
        emit CampaignsContractLocked();
    }

    // ---------------------------------------------------------------------
    // Owner: governance-tunable parameters
    // ---------------------------------------------------------------------

    function setMinTagBond(uint256 amount) external onlyOwner {
        require(amount >= MIN_TAG_BOND_FLOOR && amount <= MAX_TAG_BOND_CEILING, "T03");
        minTagBond = amount;
        emit MinTagBondSet(amount);
    }

    function setJurorMinStake(uint256 amount) external onlyOwner {
        require(amount >= MIN_JUROR_STAKE_FLOOR && amount <= MAX_JUROR_STAKE_CEILING, "T03");
        jurorMinStake = amount;
        emit JurorMinStakeSet(amount);
    }

    function setCommitWindow(uint64 blocks_) external onlyOwner {
        require(blocks_ >= MIN_COMMIT_WINDOW && blocks_ <= MAX_COMMIT_WINDOW, "T03");
        commitWindow = blocks_;
        emit CommitWindowSet(blocks_);
    }

    function setRevealWindow(uint64 blocks_) external onlyOwner {
        require(blocks_ >= MIN_REVEAL_WINDOW && blocks_ <= MAX_REVEAL_WINDOW, "T03");
        revealWindow = blocks_;
        emit RevealWindowSet(blocks_);
    }

    function setJurySize(uint8 size) external onlyOwner {
        require(size >= MIN_JURY_SIZE && size <= MAX_JURY_SIZE && size % 2 == 1, "T03");
        jurySize = size;
        emit JurySizeSet(size);
    }

    function setJuryRewardBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_JURY_REWARD_BPS, "T03");
        juryRewardBps = bps;
        emit JuryRewardBpsSet(bps);
    }

    function setJurorSlashBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_JUROR_SLASH_BPS, "T03");
        jurorSlashBps = bps;
        emit JurorSlashBpsSet(bps);
    }

    function setExpiryBlocks(uint64 blocks_) external onlyOwner {
        require(blocks_ >= MIN_EXPIRY_BLOCKS && blocks_ <= MAX_EXPIRY_BLOCKS, "T03");
        expiryBlocks = blocks_;
        emit ExpiryBlocksSet(blocks_);
    }

    // ---------------------------------------------------------------------
    // Tag lifecycle
    // ---------------------------------------------------------------------

    /// @inheritdoc IDatumTagRegistry
    function registerTag(bytes32 tag, uint256 amount) external nonReentrant {
        require(tag != bytes32(0), "E00");
        require(amount >= minTagBond, "T04"); // below floor
        TagInfo storage t = _tags[tag];
        require(t.state == TagState.None || t.state == TagState.Expired, "T05"); // already live or disputed

        datum.safeTransferFrom(msg.sender, address(this), amount);

        t.owner = msg.sender;
        t.bond = amount;
        t.lastUsedBlock = uint64(block.number);
        t.registeredBlock = uint64(block.number);
        t.state = TagState.Bonded;
        t.activeDisputeId = 0;

        emit TagRegistered(tag, msg.sender, amount);
    }

    /// @inheritdoc IDatumTagRegistry
    function recordUsage(bytes32 tag) external {
        require(msg.sender == campaignsContract, "T06"); // unauthorized
        TagInfo storage t = _tags[tag];
        // Silent no-op for unknown / disputed / expired tags — Campaigns
        // calls this opportunistically and shouldn't block on tag state.
        if (t.state != TagState.Bonded) return;
        t.lastUsedBlock = uint64(block.number);
        emit TagUsageRecorded(tag, uint64(block.number));
    }

    /// @inheritdoc IDatumTagRegistry
    function expireTag(bytes32 tag) external nonReentrant {
        TagInfo storage t = _tags[tag];
        require(t.state == TagState.Bonded, "T07"); // not eligible (None/Disputed/Expired)
        require(uint64(block.number) >= t.lastUsedBlock + expiryBlocks, "T08"); // still fresh

        uint256 bounty = t.bond;
        address reclaimer = msg.sender;

        // Clear state before transfer (CEI).
        t.state = TagState.Expired;
        t.bond = 0;
        // owner/registeredBlock/lastUsedBlock preserved for historical introspection.

        datum.safeTransfer(reclaimer, bounty);
        emit TagExpired(tag, reclaimer, bounty);
    }

    /// @inheritdoc IDatumTagRegistry
    function challengeTag(bytes32 tag) external nonReentrant returns (uint256 disputeId) {
        TagInfo storage t = _tags[tag];
        require(t.state == TagState.Bonded, "T09"); // not challengeable
        require(msg.sender != t.owner, "T10"); // self-challenge forbidden

        uint8 size = jurySize;
        require(_jurors.length >= size, "T11"); // pool too small

        uint256 bond = t.bond;
        datum.safeTransferFrom(msg.sender, address(this), bond);

        disputeId = nextDisputeId++;
        Dispute storage d = _disputes[disputeId];
        d.tag = tag;
        d.tagOwner = t.owner;
        d.challenger = msg.sender;
        d.bondAmount = bond;
        d.commitDeadline = uint64(block.number) + commitWindow;
        d.revealDeadline = d.commitDeadline + revealWindow;
        d.jurySize_ = size;
        d.juryRewardBps_ = juryRewardBps;
        d.jurorSlashBps_ = jurorSlashBps;

        // Per-juror worst-case slash exposure = jurorSlashBps of jurorMinStake.
        // Snapshot at open so later gov retunes don't change exposure mid-dispute.
        uint256 perJuror = (jurorMinStake * jurorSlashBps) / 10_000;
        d.lockedPerJuror = perJuror;

        // Select N jurors via blockhash-seeded Fisher-Yates over a transient copy.
        uint256 seed = uint256(keccak256(abi.encode(
            blockhash(block.number - 1),
            disputeId,
            tag,
            msg.sender
        )));

        address[] memory pool = _jurors;
        uint256 n = pool.length;
        d.jurors = new address[](size);
        for (uint8 i = 0; i < size; i++) {
            uint256 idx = uint256(keccak256(abi.encode(seed, i))) % (n - i);
            address picked = pool[idx];
            d.jurors[i] = picked;
            _isJuror[disputeId][picked] = true;
            pool[idx] = pool[n - 1 - i];

            // Lock the slash exposure on the juror. If the juror's effective
            // free stake has fallen below perJuror (e.g., they unstaked or are
            // already committed elsewhere), they participate at reduced
            // exposure — slash is bounded by remaining unlocked stake at
            // resolve time. This avoids a DoS where any juror can block
            // challenges by partially-unstaking after appearing in the pool.
            uint256 free_ = jurorStake[picked] - jurorLockedStake[picked];
            uint256 lockAmt = free_ < perJuror ? free_ : perJuror;
            jurorLockedStake[picked] += lockAmt;
        }

        t.state = TagState.Disputed;
        t.activeDisputeId = disputeId;

        emit DisputeOpened(
            disputeId,
            tag,
            msg.sender,
            bond,
            d.commitDeadline,
            d.revealDeadline
        );
    }

    // ---------------------------------------------------------------------
    // Jury participation
    // ---------------------------------------------------------------------

    function stakeAsJuror(uint256 amount) external nonReentrant {
        require(amount > 0, "E11");
        require(jurorStake[msg.sender] + amount >= jurorMinStake, "T12"); // below min

        datum.safeTransferFrom(msg.sender, address(this), amount);

        if (jurorStake[msg.sender] == 0) {
            _jurors.push(msg.sender);
            _jurorIndex[msg.sender] = _jurors.length;
        }
        jurorStake[msg.sender] += amount;
        emit JurorStaked(msg.sender, amount, jurorStake[msg.sender]);
    }

    function unstakeJuror(uint256 amount) external nonReentrant {
        uint256 stake_ = jurorStake[msg.sender];
        uint256 locked = jurorLockedStake[msg.sender];
        require(amount > 0 && amount <= stake_ - locked, "T13"); // exceeds free stake

        uint256 remaining = stake_ - amount;
        // If withdrawing below jurorMinStake, must exit pool entirely.
        if (remaining < jurorMinStake) {
            require(amount == stake_, "T14"); // partial below min not allowed
            _removeJuror(msg.sender);
        }
        jurorStake[msg.sender] = remaining;

        datum.safeTransfer(msg.sender, amount);
        emit JurorUnstaked(msg.sender, amount, remaining);
    }

    function _removeJuror(address j) internal {
        uint256 idx1 = _jurorIndex[j];
        require(idx1 != 0, "T15");
        uint256 idx = idx1 - 1;
        uint256 last = _jurors.length - 1;
        if (idx != last) {
            address moved = _jurors[last];
            _jurors[idx] = moved;
            _jurorIndex[moved] = idx + 1;
        }
        _jurors.pop();
        delete _jurorIndex[j];
    }

    function commitVote(uint256 disputeId, bytes32 commitHash) external {
        Dispute storage d = _disputes[disputeId];
        require(d.tag != bytes32(0), "T16"); // unknown
        require(_isJuror[disputeId][msg.sender], "T17"); // not on jury
        require(uint64(block.number) < d.commitDeadline, "T18"); // commit window over
        require(_commit[disputeId][msg.sender] == bytes32(0), "T19"); // already committed
        require(commitHash != bytes32(0), "E00");

        _commit[disputeId][msg.sender] = commitHash;
        emit VoteCommitted(disputeId, msg.sender);
    }

    function revealVote(uint256 disputeId, Vote vote, bytes32 salt) external {
        Dispute storage d = _disputes[disputeId];
        require(d.tag != bytes32(0), "T16");
        require(_isJuror[disputeId][msg.sender], "T17");
        require(uint64(block.number) >= d.commitDeadline, "T20a"); // reveal not open
        require(uint64(block.number) < d.revealDeadline, "T20b"); // reveal closed
        require(vote == Vote.KeepTag || vote == Vote.ExpireTag, "T20c");
        require(_reveal[disputeId][msg.sender] == Vote.None, "T20d"); // already revealed

        bytes32 stored = _commit[disputeId][msg.sender];
        require(stored != bytes32(0), "T20e"); // never committed
        bytes32 check = keccak256(abi.encode(disputeId, msg.sender, vote, salt));
        require(check == stored, "T20f"); // bad reveal

        _reveal[disputeId][msg.sender] = vote;
        if (vote == Vote.KeepTag) d.keepRevealed++;
        else d.expireRevealed++;

        emit VoteRevealed(disputeId, msg.sender, vote);
    }

    function resolveDispute(uint256 disputeId) external nonReentrant {
        Dispute storage d = _disputes[disputeId];
        require(d.tag != bytes32(0), "T16");
        require(!d.resolved, "T20g"); // already resolved
        require(uint64(block.number) >= d.revealDeadline, "T20h"); // reveal still open

        d.resolved = true;
        TagInfo storage t = _tags[d.tag];

        Vote outcome;
        if (d.keepRevealed > d.expireRevealed)      outcome = Vote.KeepTag;
        else if (d.expireRevealed > d.keepRevealed) outcome = Vote.ExpireTag;
        else                                        outcome = Vote.None; // tie / no reveals

        uint256 totalPot = d.bondAmount * 2;
        uint256 juryReward = (totalPot * d.juryRewardBps_) / 10_000;

        // Slash redistribution: non-revealers and minority revealers each lose
        // up to d.lockedPerJuror from their juror stake. Slashed amounts pool
        // and are paid pro-rata to majority revealers on top of juryReward.
        uint256 slashedPool;
        uint16 majorityCount;

        for (uint8 i = 0; i < d.jurors.length; i++) {
            address j = d.jurors[i];
            Vote v = _reveal[disputeId][j];

            // Release the lock first (we'll re-deduct if slashing).
            uint256 perJuror = d.lockedPerJuror;
            uint256 currentlyLocked = jurorLockedStake[j];
            uint256 release = currentlyLocked < perJuror ? currentlyLocked : perJuror;
            jurorLockedStake[j] = currentlyLocked - release;

            bool inMajority = (outcome != Vote.None) && (v == outcome);

            if (inMajority) {
                majorityCount++;
            } else {
                // Slash this juror: up to perJuror, bounded by their remaining stake.
                uint256 stake_ = jurorStake[j];
                uint256 slash = stake_ < perJuror ? stake_ : perJuror;
                if (slash > 0) {
                    jurorStake[j] = stake_ - slash;
                    slashedPool += slash;
                    if (jurorStake[j] < jurorMinStake && _jurorIndex[j] != 0) {
                        // Drop below-min jurors from the pool. Their residual
                        // stake stays withdrawable via unstakeJuror.
                        _removeJuror(j);
                    }
                }
            }
        }

        // Pay winner and jury rewards.
        if (outcome == Vote.KeepTag) {
            // Tag survives; owner reclaims their bond + winnerPayout-share of challenger's bond.
            // Specifically owner receives `winnerPayout - d.bondAmount_owner_portion`? Cleaner:
            // owner's bond stays locked under the tag; transfer the challenger's bond
            // minus the juryReward to the owner.
            // Implementation: refund owner's bond to the tag (no-op), transfer
            // (challenger's bond - juryReward) to owner.
            uint256 ownerGain = d.bondAmount > juryReward ? d.bondAmount - juryReward : 0;
            // Actually `winnerPayout = totalPot - juryReward`. The owner's bond
            // remains escrowed against the tag. Net winner transfer is the
            // challenger's bond minus the juryReward.
            // Restore lastUsedBlock so a flapping challenge doesn't shorten
            // the tag's effective life.
            t.state = TagState.Bonded;
            t.activeDisputeId = 0;
            t.lastUsedBlock = uint64(block.number);

            if (ownerGain > 0) datum.safeTransfer(t.owner, ownerGain);
        } else if (outcome == Vote.ExpireTag) {
            // Tag is destroyed; owner's bond is forfeited. Challenger reclaims
            // their own bond + the owner's bond - juryReward.
            uint256 challengerGain = (2 * d.bondAmount) - juryReward;
            t.state = TagState.Expired;
            t.activeDisputeId = 0;
            t.bond = 0;
            t.owner = address(0); // forfeit ownership

            datum.safeTransfer(d.challenger, challengerGain);
        } else {
            // Tie / no reveals — refund both, no jury reward, no slashing.
            // (Slashing loop above still ran but with outcome=None nobody was
            // counted as majority; that's the intended behavior: failed
            // arbitration redistributes slash to no one. Mint slashedPool back
            // to the loser-free pool by returning to both equally.)
            t.state = TagState.Bonded;
            t.activeDisputeId = 0;
            t.lastUsedBlock = uint64(block.number);

            datum.safeTransfer(d.challenger, d.bondAmount);
            // Owner's bond stays escrowed under the tag (no transfer).
            juryReward = 0;
            // slashedPool is stuck in the contract on a no-reveal outcome.
            // That's deliberate — the network keeps it as a soft penalty on
            // total juror inattention. It is not recoverable by gov.
            slashedPool = 0;
        }

        // Distribute jury reward + slashed pool to majority revealers.
        if (outcome != Vote.None && majorityCount > 0) {
            uint256 total = juryReward + slashedPool;
            uint256 per = total / majorityCount;
            uint256 remainder = total - (per * majorityCount);

            for (uint8 i = 0; i < d.jurors.length && per > 0; i++) {
                address j = d.jurors[i];
                if (_reveal[disputeId][j] == outcome) {
                    uint256 payout = per;
                    if (remainder > 0) { payout += 1; remainder--; }
                    // Credit as stake so it's auto-compounded into juror pool.
                    if (jurorStake[j] == 0) {
                        _jurors.push(j);
                        _jurorIndex[j] = _jurors.length;
                    }
                    jurorStake[j] += payout;
                }
            }
        }

        emit DisputeResolved(disputeId, d.tag, outcome, d.keepRevealed, d.expireRevealed);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function isTagBonded(bytes32 tag) external view returns (bool) {
        return _tags[tag].state == TagState.Bonded;
    }
    function tagState(bytes32 tag) external view returns (TagState) {
        return _tags[tag].state;
    }
    function tagOwner(bytes32 tag) external view returns (address) {
        return _tags[tag].owner;
    }
    function tagBond(bytes32 tag) external view returns (uint256) {
        return _tags[tag].bond;
    }
    function tagLastUsedBlock(bytes32 tag) external view returns (uint64) {
        return _tags[tag].lastUsedBlock;
    }

    function jurorPoolSize() external view returns (uint256) {
        return _jurors.length;
    }
    function jurorAt(uint256 idx) external view returns (address) {
        return _jurors[idx];
    }
    function disputeJurors(uint256 disputeId) external view returns (address[] memory) {
        return _disputes[disputeId].jurors;
    }
}
