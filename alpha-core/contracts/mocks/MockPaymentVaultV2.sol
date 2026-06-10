// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "../DatumPaymentVault.sol";

/// @dev Test-only successor used to exercise the DatumUpgradable
///      redeploy-migrate-rewire flow against DatumPaymentVault. A real v2
///      would carry actual behavioural changes; here it just bumps version()
///      and inherits the enumerable `_migrate`, so the migration test can
///      verify balance accounting + recovery state are copied from a frozen v1
///      predecessor (and that `migrateFundsTo` moves the native DOT).
contract MockPaymentVaultV2 is DatumPaymentVault {
    function version() public pure override returns (uint256) { return 2; }
}
