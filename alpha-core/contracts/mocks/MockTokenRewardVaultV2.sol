// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumTokenRewardVault.sol";
/// @dev Test-only successor exercising migrate() against DatumTokenRewardVault.
contract MockTokenRewardVaultV2 is DatumTokenRewardVault {
    constructor(address c) DatumTokenRewardVault(c) {}
    function version() public pure override returns (uint256) { return 2; }
}
