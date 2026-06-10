// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "../DatumAdvertiserRegistry.sol";

/// @dev Test-only successor used to exercise the DatumUpgradable migrate() flow
///      against DatumAdvertiserRegistry. A real v2 would carry actual changes;
///      here it just bumps version() and inherits the enumerable _migrate, so the
///      migration test can verify state is copied from a frozen v1 predecessor.
contract MockAdvertiserRegistryV2 is DatumAdvertiserRegistry {
    constructor(address p) DatumAdvertiserRegistry(p) {}
    function version() public pure override returns (uint256) { return 2; }
}
