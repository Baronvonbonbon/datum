// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

interface IDatumMintAuthority_Vesting {
    function mintForVesting(address recipient, uint256 amount) external;
}

/// @title DatumVesting
/// @notice Single-beneficiary linear vesting with cliff.
///
///         At deploy, holds the right to mint `TOTAL_ALLOCATION` DATUM to a
///         single beneficiary on a linear schedule. The first `CLIFF_DURATION`
///         after `startTime` is non-vested (everything cliffs at zero); from
///         the cliff to `endTime` the unlock is linear; everything is unlocked
///         at `endTime`.
///
/// @dev Mint flows through `DatumMintAuthority.mintForVesting()`, which mints
///      canonical DATUM and WDATUM atomically. Beneficiary receives WDATUM
///      directly — no separate wrap step needed.
///
///      No revoke. No clawback. Vesting continues per the original schedule
///      regardless of beneficiary activity. Aligned with credible-neutrality.
///
///      Beneficiary may call `extendVesting(newEndTime)` to slow their own
///      unlock — extend only, never accelerate.
contract DatumVesting {
    uint256 public constant TOTAL_ALLOCATION = 5_000_000 * 10**10;  // 5M DATUM (10 decimals)
    uint256 public constant CLIFF_DURATION   = 365 days;
    uint256 public constant TOTAL_DURATION   = 4 * 365 days;

    address public immutable beneficiary;
    uint256 public immutable startTime;
    address public immutable mintAuthority;

    /// @notice End of vesting period. Extendable via `extendVesting()`.
    uint256 public endTime;

    /// @notice Total amount released to date.
    uint256 public released;

    event Released(uint256 amount, uint256 cumulative);
    event VestingExtended(uint256 oldEndTime, uint256 newEndTime);

    constructor(address _beneficiary, address _mintAuthority, uint256 _startTime) {
        require(_beneficiary != address(0), "E00");
        require(_mintAuthority != address(0), "E00");
        beneficiary = _beneficiary;
        mintAuthority = _mintAuthority;
        startTime = _startTime;
        endTime = _startTime + TOTAL_DURATION;
    }

    /// @notice Trigger release of vested-but-unreleased DATUM to the beneficiary.
    /// @dev    Permissionless — anyone can call. The beneficiary doesn't have
    ///         to wake up every month to claim.
    function release() external {
        uint256 vested = vestedAmount();
        require(vested > released, "nothing to release");
        uint256 toRelease = vested - released;
        released = vested;
        IDatumMintAuthority_Vesting(mintAuthority).mintForVesting(beneficiary, toRelease);
        emit Released(toRelease, released);
    }

    /// @notice Linear vesting after cliff.
    function vestedAmount() public view returns (uint256) {
        if (block.timestamp < startTime + CLIFF_DURATION) return 0;
        if (block.timestamp >= endTime) return TOTAL_ALLOCATION;
        uint256 elapsed = block.timestamp - startTime;
        uint256 duration = endTime - startTime;
        return (TOTAL_ALLOCATION * elapsed) / duration;
    }

    /// @notice Slowable-only: beneficiary extends their own vesting end date.
    function extendVesting(uint256 newEndTime) external {
        require(msg.sender == beneficiary, "E18");
        require(newEndTime > endTime, "can only extend");
        uint256 old = endTime;
        endTime = newEndTime;
        emit VestingExtended(old, newEndTime);
    }
}
