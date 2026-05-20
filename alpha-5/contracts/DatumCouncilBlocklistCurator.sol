// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumBlocklistCurator.sol";

/// @title DatumCouncilBlocklistCurator
/// @notice B2 (2026-05-12): Council-driven blocklist implementation of
///         IDatumBlocklistCurator. Designed to be plugged into DatumPublishers
///         as `setBlocklistCurator(this)`.
///
///         Mutations (`block`, `unblock`) are gated to a designated council
///         address — in production this is the `DatumCouncil` contract, which
///         drives the calls via its propose+vote+execute pipeline. Council
///         members vote off-chain on the merits, then the Council contract
///         executes a proposal that calls this curator.
///
///         The owner can be set to Timelock and is only authorized to rotate
///         the council pointer itself (e.g., upgrade from a v1 council to a v2)
///         — it cannot directly block/unblock. The cypherpunk credible
///         commitment is `lockCouncil()`, which permanently freezes the council
///         pointer so even the timelock can no longer change it.
contract DatumCouncilBlocklistCurator is IDatumBlocklistCurator, PaseoSafeSender, DatumUpgradable {

    /// @notice Upgrade ladder version.
    function version() public pure override returns (uint256) { return 1; }

    /// @notice The contract authorized to call block/unblock. Typically DatumCouncil.
    address public council;
    /// @notice Once true, `council` is frozen — even owner can't change it.
    bool public councilLocked;

    /// @notice Per-address blocklist state.
    mapping(address => bool) private _blocked;
    /// @notice Reason hash (optional, IPFS CID) for each block, for transparency.
    mapping(address => bytes32) public blockReason;

    event CouncilSet(address indexed council);
    event CouncilLocked();
    event AddrBlocked(address indexed addr, bytes32 reasonHash);
    event AddrUnblocked(address indexed addr);

    modifier onlyCouncil() {
        require(council != address(0) && msg.sender == council, "E18");
        _;
    }

    /// @notice Set the council pointer. Locked once `lockCouncil` is called.
    function setCouncil(address newCouncil) external onlyOwner {
        require(!councilLocked, "council-locked");
        council = newCouncil;
        emit CouncilSet(newCouncil);
    }

    /// @notice Permanently freeze the council pointer. After this, the owner
    ///         can no longer rotate the council contract. Irreversible.
    function lockCouncil() external onlyOwner whenOpenGovPhase {
        require(!councilLocked, "already locked");
        require(council != address(0), "council unset");
        councilLocked = true;
        emit CouncilLocked();
    }

    /// @notice Block an address. Called by the Council contract after a passing vote.
    /// @param addr        The address to block.
    /// @param reasonHash  IPFS CID (or similar) pointing at the evidence/decision rationale.
    function blockAddr(address addr, bytes32 reasonHash) external onlyCouncil whenNotFrozen {
        require(addr != address(0), "E00");
        _blocked[addr] = true;
        blockReason[addr] = reasonHash;
        emit AddrBlocked(addr, reasonHash);
    }

    /// @notice Unblock an address. Called by the Council contract after a passing vote.
    function unblockAddr(address addr) external onlyCouncil whenNotFrozen {
        require(addr != address(0), "E00");
        _blocked[addr] = false;
        blockReason[addr] = bytes32(0);
        emit AddrUnblocked(addr);
    }

    /// @inheritdoc IDatumBlocklistCurator
    function isBlocked(address addr) external view returns (bool) {
        return _blocked[addr];
    }

    // -------------------------------------------------------------------------
    // G-6 first close (2026-05-20): bonded appeal mechanism
    // -------------------------------------------------------------------------
    //
    // Closes gaps-in-checks-and-balances.md G-6 (No appeal for false-
    // positive curator entries). Anyone (typically the blocked address
    // itself) files an appeal with a bond + evidence CID; Council resolves
    // on-chain after off-chain review.
    //
    //   upheld    → blockedAddr unblocked + bond refunded to filer.
    //   dismissed → bond forfeited to the contract's treasuryBalance
    //               (anti-grief; owner sweeps via sweepTreasury).
    //
    // Lock-once is not added here: appealBond is governance-tunable forever
    // because economic calibration is operational discipline, not an
    // invariant. Setting bond to 0 disables the track.

    /// @notice Bond required to file an appeal. 0 = appeal track disabled.
    uint256 public appealBond;

    struct BlocklistAppeal {
        address appellant;        // who filed (typically the blocked addr; not enforced)
        address blockedAddr;      // address being appealed
        bytes32 evidenceHash;     // IPFS CID of appeal rationale
        uint256 bond;             // filer-staked bond
        bool resolved;
        bool upheld;
        uint256 createdBlock;
    }

    uint256 public nextAppealId = 1;
    mapping(uint256 => BlocklistAppeal) public appeals;

    /// @notice Pull-payment queue for refunds + treasury sweeps.
    mapping(address => uint256) public pendingPayout;
    /// @notice Owner-claimable residue from forfeited appeal bonds.
    uint256 public treasuryBalance;

    event AppealBondSet(uint256 amount);
    event BlocklistAppealFiled(
        uint256 indexed appealId,
        address indexed appellant,
        address indexed blockedAddr,
        bytes32 evidenceHash,
        uint256 bond
    );
    event BlocklistAppealResolved(
        uint256 indexed appealId,
        address indexed blockedAddr,
        bool upheld,
        uint256 bondDisposition
    );
    event PayoutQueued(address indexed recipient, uint256 amount, string reason);
    event PayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
    event TreasurySwept(address indexed owner, uint256 amount);

    /// @notice Set the bond required to file an appeal. 0 disables the
    ///         track. Owner-only (Timelock in production).
    function setAppealBond(uint256 amount) external onlyOwner whenNotFrozen {
        appealBond = amount;
        emit AppealBondSet(amount);
    }

    /// @notice File an appeal against a blocked address. Permissionless
    ///         caller — the blocked address can self-appeal, OR an
    ///         advocate (lawyer, friend, DAO) can appeal on their behalf
    ///         by paying the bond.
    function fileBlocklistAppeal(address blockedAddr, bytes32 evidenceHash)
        external
        payable
        whenNotFrozen
        returns (uint256 appealId)
    {
        require(blockedAddr != address(0), "E00");
        require(evidenceHash != bytes32(0), "E00");
        require(appealBond > 0, "E01");                // track disabled
        require(msg.value == appealBond, "E11");
        require(_blocked[blockedAddr], "E22");         // must be currently blocked

        appealId = nextAppealId++;
        appeals[appealId] = BlocklistAppeal({
            appellant: msg.sender,
            blockedAddr: blockedAddr,
            evidenceHash: evidenceHash,
            bond: msg.value,
            resolved: false,
            upheld: false,
            createdBlock: block.number
        });
        emit BlocklistAppealFiled(appealId, msg.sender, blockedAddr, evidenceHash, msg.value);
    }

    /// @notice Council resolves a filed appeal. Called via the Council
    ///         contract's propose+vote+execute pipeline. Upheld →
    ///         unblock the address + refund bond to appellant. Dismissed →
    ///         bond forfeited to treasury.
    function councilResolveAppeal(uint256 appealId, bool upheld)
        external
        onlyCouncil
        whenNotFrozen
    {
        BlocklistAppeal storage a = appeals[appealId];
        require(a.createdBlock > 0, "E01");
        require(!a.resolved, "E41");
        a.resolved = true;
        a.upheld = upheld;

        uint256 bond = a.bond;
        a.bond = 0;

        if (upheld) {
            // Unblock the address.
            if (_blocked[a.blockedAddr]) {
                _blocked[a.blockedAddr] = false;
                blockReason[a.blockedAddr] = bytes32(0);
                emit AddrUnblocked(a.blockedAddr);
            }
            // Refund bond to appellant via queue.
            if (bond > 0) {
                pendingPayout[a.appellant] += bond;
                emit PayoutQueued(a.appellant, bond, "appeal upheld");
            }
        } else {
            // Dismissed: bond → treasury (anti-grief). Owner sweeps via
            // sweepTreasury.
            if (bond > 0) {
                treasuryBalance += bond;
            }
        }
        emit BlocklistAppealResolved(appealId, a.blockedAddr, upheld, bond);
    }

    /// @notice Pull a queued refund.
    function claimPayout() external whenNotFrozen {
        _claim(msg.sender, msg.sender);
    }

    /// @notice Pull a queued refund to a chosen recipient (cold wallet).
    function claimPayoutTo(address recipient) external whenNotFrozen {
        require(recipient != address(0), "E00");
        _claim(msg.sender, recipient);
    }

    function _claim(address account, address recipient) internal {
        uint256 amount = pendingPayout[account];
        require(amount > 0, "E03");
        pendingPayout[account] = 0;
        emit PayoutClaimed(account, recipient, amount);
        _safeSend(recipient, amount);
    }

    /// @notice Move accumulated forfeited bonds into the owner's pull-payout
    ///         queue. Permissionless trigger; only owner can claim.
    function sweepTreasury() external whenNotFrozen {
        uint256 amount = treasuryBalance;
        require(amount > 0, "E03");
        treasuryBalance = 0;
        pendingPayout[owner()] += amount;
        emit TreasurySwept(owner(), amount);
        emit PayoutQueued(owner(), amount, "treasury sweep");
    }
}
