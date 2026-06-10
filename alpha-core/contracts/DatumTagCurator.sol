// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumUpgradable.sol";
import "./PaseoSafeSender.sol";
import "./interfaces/IDatumTagCurator.sol";

/// @title DatumTagCurator
/// @notice M5-fix: council-driven tag-approval registry. Plugs into
///         DatumCampaigns as `setTagCurator(this)`. Mutations are gated to a
///         designated council address (typically the DatumCouncil contract),
///         which drives approve/remove via its propose+vote+execute pipeline.
///
///         Mirrors the cypherpunk lock pattern of DatumCouncilBlocklistCurator:
///         the owner (Timelock) can rotate the council pointer up until
///         `lockCouncil()` is called, after which the pointer is permanently
///         frozen.
///
///         DatumCampaigns OR-merges the curator's verdict with its own
///         `approvedTags` mapping, so a deployer can use either path or
///         both. When no curator is wired, `approvedTags` is consulted alone.
contract DatumTagCurator is IDatumTagCurator, PaseoSafeSender, DatumUpgradable {

    /// @notice Upgrade ladder version.
    function version() public pure override returns (uint256) { return 1; }

    address public council;
    bool public councilLocked;

    mapping(bytes32 => bool) private _approved;

    event CouncilSet(address indexed council);
    event CouncilLocked();
    event TagApproved(bytes32 indexed tag);
    event TagRemoved(bytes32 indexed tag);

    modifier onlyCouncil() {
        require(council != address(0) && msg.sender == council, "E18");
        _;
    }

    function setCouncil(address newCouncil) external onlyOwner {
        require(!councilLocked, "council-locked");
        council = newCouncil;
        emit CouncilSet(newCouncil);
    }

    function lockCouncil() external onlyOwner whenOpenGovPhase {
        require(!councilLocked, "already locked");
        require(council != address(0), "council unset");
        councilLocked = true;
        emit CouncilLocked();
    }

    function approveTag(bytes32 tag) external onlyCouncil whenNotFrozen {
        require(tag != bytes32(0), "E00");
        _approved[tag] = true;
        emit TagApproved(tag);
    }

    function removeTag(bytes32 tag) external onlyCouncil whenNotFrozen {
        require(tag != bytes32(0), "E00");
        _approved[tag] = false;
        emit TagRemoved(tag);
    }

    /// @inheritdoc IDatumTagCurator
    function isTagApproved(bytes32 tag) external view returns (bool) {
        return _approved[tag];
    }

    // -------------------------------------------------------------------------
    // G-6 mirror (2026-05-21): bonded appeal mechanism
    // -------------------------------------------------------------------------
    //
    // Mirrors the bonded-appeal pattern from DatumCouncilBlocklistCurator.
    // Anyone files an appeal with a bond + evidence CID, naming a specific
    // tag they believe should be approved. Council resolves on-chain after
    // off-chain review.
    //
    //   upheld    → tag.approveTag(tag) + bond refunded to appellant (idempotent
    //               if tag was already approved).
    //   dismissed → bond forfeited to treasuryBalance (anti-grief; owner
    //               sweeps via sweepTreasury).
    //
    // Lock-once is not added here: appealBond is governance-tunable forever
    // because economic calibration is operational discipline, not an
    // invariant. Setting bond to 0 disables the track.

    /// @notice Bond required to file a tag-approval appeal. 0 = appeal
    ///         track disabled.
    uint256 public appealBond;

    struct TagAppeal {
        address appellant;
        bytes32 tag;
        bytes32 evidenceHash;
        uint256 bond;
        bool resolved;
        bool upheld;
        uint256 createdBlock;
    }

    uint256 public nextAppealId = 1;
    mapping(uint256 => TagAppeal) public appeals;

    /// @notice Pull-payment queue for refunds + treasury sweeps.
    mapping(address => uint256) public pendingPayout;
    /// @notice Owner-claimable residue from forfeited appeal bonds.
    uint256 public treasuryBalance;

    event AppealBondSet(uint256 amount);
    event TagAppealFiled(
        uint256 indexed appealId,
        address indexed appellant,
        bytes32 indexed tag,
        bytes32 evidenceHash,
        uint256 bond
    );
    event TagAppealResolved(
        uint256 indexed appealId,
        bytes32 indexed tag,
        bool upheld,
        uint256 bondDisposition
    );
    event PayoutQueued(address indexed recipient, uint256 amount, string reason);
    event PayoutClaimed(address indexed recipient, address indexed to, uint256 amount);
    event TreasurySwept(address indexed owner, uint256 amount);

    function setAppealBond(uint256 amount) external onlyOwner whenNotFrozen {
        appealBond = amount;
        emit AppealBondSet(amount);
    }

    /// @notice File an appeal asking Council to approve a tag. Permissionless.
    function fileTagAppeal(bytes32 tag, bytes32 evidenceHash)
        external
        payable
        whenNotFrozen
        returns (uint256 appealId)
    {
        require(tag != bytes32(0), "E00");
        require(evidenceHash != bytes32(0), "E00");
        require(appealBond > 0, "E01");
        require(msg.value == appealBond, "E11");
        require(!_approved[tag], "E22");           // already approved — no need to appeal

        appealId = nextAppealId++;
        appeals[appealId] = TagAppeal({
            appellant: msg.sender,
            tag: tag,
            evidenceHash: evidenceHash,
            bond: msg.value,
            resolved: false,
            upheld: false,
            createdBlock: block.number
        });
        emit TagAppealFiled(appealId, msg.sender, tag, evidenceHash, msg.value);
    }

    /// @notice Council resolves a filed appeal. Upheld → approve the tag +
    ///         refund bond. Dismissed → bond forfeited to treasury.
    function councilResolveAppeal(uint256 appealId, bool upheld)
        external
        onlyCouncil
        whenNotFrozen
    {
        TagAppeal storage a = appeals[appealId];
        require(a.createdBlock > 0, "E01");
        require(!a.resolved, "E41");
        a.resolved = true;
        a.upheld = upheld;

        uint256 bond = a.bond;
        a.bond = 0;

        if (upheld) {
            // Approve the tag (idempotent if already approved via direct path).
            if (!_approved[a.tag]) {
                _approved[a.tag] = true;
                emit TagApproved(a.tag);
            }
            if (bond > 0) {
                pendingPayout[a.appellant] += bond;
                emit PayoutQueued(a.appellant, bond, "appeal upheld");
            }
        } else {
            if (bond > 0) {
                treasuryBalance += bond;
            }
        }
        emit TagAppealResolved(appealId, a.tag, upheld, bond);
    }

    function claimPayout() external whenNotFrozen {
        _claim(msg.sender, msg.sender);
    }

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

    function sweepTreasury() external whenNotFrozen {
        uint256 amount = treasuryBalance;
        require(amount > 0, "E03");
        treasuryBalance = 0;
        pendingPayout[owner()] += amount;
        emit TreasurySwept(owner(), amount);
        emit PayoutQueued(owner(), amount, "treasury sweep");
    }
}
