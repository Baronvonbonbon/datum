// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumPublisherStake.sol";
import "./DatumOwnable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DatumPublisherStake
/// @notice FP-1 + FP-4: Publisher staking with bonding-curve required stake.
///
///         Publishers lock native DOT to signal commitment. The minimum required
///         stake grows with cumulative settled impressions:
///
///           requiredStake = baseStakePlanck + cumulativeImpressions * planckPerImpression
///
///         Unstaking is subject to a delay (default 100,800 blocks ≈ 7 days at 6s/block).
///         Requesters cannot drop below requiredStake at unstake-request time.
///
///         Settlement calls recordImpressions() after each successful batch to
///         advance the bonding curve. If the stake feature is enabled on Settlement
///         (publisherStake != address(0)), claims from inadequately staked publishers
///         are rejected with reason code 15.
///
///         Slash is called by PublisherGovernance when a fraud proposal resolves aye.
contract DatumPublisherStake is IDatumPublisherStake, ReentrancyGuard, DatumOwnable {
    /// @notice Settlement contract — authorised to call recordImpressions.
    address public settlementContract;

    /// @notice Slash contract — authorised to call slash (PublisherGovernance).
    address public slashContract;

    // ── Bonding curve params ───────────────────────────────────────────────────

    uint256 public baseStakePlanck;
    uint256 public planckPerImpression;
    uint256 public unstakeDelayBlocks;
    /// @notice AUDIT-012: Cap on requiredStake to prevent bonding curve runaway.
    ///         Default 10^14 planck = 10,000 DOT.
    uint256 public maxRequiredStake = 10**14;

    // ── State ──────────────────────────────────────────────────────────────────

    mapping(address => uint256) private _staked;
    mapping(address => uint256) private _cumulativeImpressions;
    mapping(address => UnstakeRequest) private _pendingUnstake;

    constructor(
        uint256 _baseStakePlanck,
        uint256 _planckPerImpression,
        uint256 _unstakeDelayBlocks
    ) {
        require(_unstakeDelayBlocks > 0, "E00");
        baseStakePlanck = _baseStakePlanck;
        planckPerImpression = _planckPerImpression;
        unstakeDelayBlocks = _unstakeDelayBlocks;
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setSettlementContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        settlementContract = addr;
    }

    function setSlashContract(address addr) external onlyOwner {
        require(addr != address(0), "E00");
        slashContract = addr;
    }

    function setParams(uint256 _base, uint256 _perImpression, uint256 _delay) external onlyOwner {
        require(_delay > 0, "E00");
        baseStakePlanck = _base;
        planckPerImpression = _perImpression;
        unstakeDelayBlocks = _delay;
        emit ParamsUpdated(_base, _perImpression, _delay);
    }

    /// @notice AUDIT-012: Set the bonding curve cap. Owner-only.
    function setMaxRequiredStake(uint256 cap) external onlyOwner {
        require(cap > 0, "E00");
        maxRequiredStake = cap;
    }

    receive() external payable { revert("E03"); }

    // ── Publisher actions ──────────────────────────────────────────────────────

    /// @inheritdoc IDatumPublisherStake
    function stake() external payable {
        require(msg.value > 0, "E11");
        _staked[msg.sender] += msg.value;
        emit Staked(msg.sender, msg.value, _staked[msg.sender]);
    }

    /// @inheritdoc IDatumPublisherStake
    function requestUnstake(uint256 amount) external {
        require(amount > 0, "E11");
        require(_staked[msg.sender] >= amount, "E03");
        require(_pendingUnstake[msg.sender].amount == 0, "E68"); // already pending

        uint256 remaining = _staked[msg.sender] - amount;
        uint256 req = requiredStake(msg.sender);
        require(remaining >= req, "E69"); // would drop below required

        _staked[msg.sender] = remaining;
        uint256 avail = block.number + unstakeDelayBlocks;
        _pendingUnstake[msg.sender] = UnstakeRequest({ amount: amount, availableBlock: avail });
        emit UnstakeRequested(msg.sender, amount, avail);
    }

    /// @inheritdoc IDatumPublisherStake
    function unstake() external nonReentrant {
        UnstakeRequest memory req = _pendingUnstake[msg.sender];
        require(req.amount > 0, "E01");
        require(block.number >= req.availableBlock, "E70"); // delay not elapsed

        delete _pendingUnstake[msg.sender];

        (bool ok,) = msg.sender.call{value: req.amount}("");
        require(ok, "E02");
        emit Unstaked(msg.sender, req.amount);
    }

    // ── Settlement callback ────────────────────────────────────────────────────

    /// @inheritdoc IDatumPublisherStake
    function recordImpressions(address publisher, uint256 count) external {
        require(msg.sender == settlementContract, "E18");
        _cumulativeImpressions[publisher] += count;
        emit ImpressionsRecorded(publisher, count, _cumulativeImpressions[publisher]);
    }

    // ── Governance slash ───────────────────────────────────────────────────────

    /// @inheritdoc IDatumPublisherStake
    function slash(address publisher, uint256 amount, address recipient) external nonReentrant {
        require(msg.sender == slashContract, "E18");
        require(recipient != address(0), "E00");
        uint256 available = _staked[publisher];
        if (amount > available) amount = available;
        if (amount == 0) return;
        _staked[publisher] = available - amount;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "E02");
        emit Slashed(publisher, amount, recipient);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function staked(address publisher) external view returns (uint256) {
        return _staked[publisher];
    }

    function cumulativeImpressions(address publisher) external view returns (uint256) {
        return _cumulativeImpressions[publisher];
    }

    function pendingUnstake(address publisher) external view returns (UnstakeRequest memory) {
        return _pendingUnstake[publisher];
    }

    function requiredStake(address publisher) public view returns (uint256) {
        uint256 uncapped = baseStakePlanck + _cumulativeImpressions[publisher] * planckPerImpression;
        return Math.min(uncapped, maxRequiredStake); // AUDIT-012: cap bonding curve runaway
    }

    function isAdequatelyStaked(address publisher) external view returns (bool) {
        return _staked[publisher] >= requiredStake(publisher);
    }
}
