// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./interfaces/IDatumBlocklistCurator.sol";

/// @notice Test fixture for the M-6 audit regression: a curator that always
///         reverts on `isBlocked`. Used to verify that DatumPublishers'
///         registerPublisher path is fail-CLOSED on curator revert.
contract MockRevertingCurator is IDatumBlocklistCurator {
    function isBlocked(address) external pure returns (bool) {
        revert("curator-down");
    }
}
