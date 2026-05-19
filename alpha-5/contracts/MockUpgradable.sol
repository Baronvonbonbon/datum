// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./DatumUpgradable.sol";

/// @title MockUpgradable
/// @notice Test-only concrete realization of DatumUpgradable. Exposes
///         enough surface to exercise the base's mechanics (pause,
///         onlyGovernance, migration round-trip).
contract MockUpgradable is DatumUpgradable {
    uint256 private _ver;
    uint256 public counter;
    uint256 public migrationCounterReceived;

    constructor(uint256 ver_) {
        _ver = ver_;
    }

    function version() public pure virtual override returns (uint256) {
        return 1;
    }

    /// @notice Reflective override so tests can deploy multiple "versions"
    ///         without separate contract files.
    function reportedVersion() external view returns (uint256) {
        return _ver;
    }

    /// @notice State-mutating call protected by whenNotFrozen, so pause
    ///         semantics can be tested end-to-end.
    function increment() external whenNotFrozen {
        counter += 1;
    }

    /// @notice Owner-only test entry to seed state pre-migration.
    function setCounter(uint256 v) external onlyOwner {
        counter = v;
    }

    /// @dev Test migration: pull counter from old contract.
    function _migrate(address oldContract) internal override {
        migrationCounterReceived = MockUpgradable(oldContract).counter();
        counter = migrationCounterReceived;
    }
}

/// @notice Sibling concrete with a non-default version() override, used to
///         exercise the version-must-strictly-increase rule in migrate().
contract MockUpgradableV2 is DatumUpgradable {
    uint256 public counter;
    uint256 public migrationCounterReceived;

    function version() public pure override returns (uint256) {
        return 2;
    }

    function increment() external whenNotFrozen {
        counter += 1;
    }

    function setCounter(uint256 v) external onlyOwner {
        counter = v;
    }

    function _migrate(address oldContract) internal override {
        migrationCounterReceived = MockUpgradable(oldContract).counter();
        counter = migrationCounterReceived;
    }
}
