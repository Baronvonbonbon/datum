// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumSettlementStorage.sol";

/// @title  MockAssuranceProbe
/// @notice Diagnostic test fixture (phase 8d hedge #5) that exposes the
///         pure `_assuranceDecision` helper from DatumSettlementStorage as
///         an external pure function so the test harness can table-drive
///         the cartesian product of inputs without touching the live
///         Settlement / LogicA / LogicB triple.
///
/// @dev    Not deployed by `deploy.ts`. Test-only.
contract MockAssuranceProbe is DatumSettlementStorage {
    function version() public pure override returns (uint256) { return 1; }

    function assuranceDecision(
        uint8 campaignLevel,
        uint8 userMinAssurance,
        bool advertiserConsented,
        bool fromRelay,
        bool fromPublisherRelay
    ) external pure returns (bool accept, uint8 reasonCode) {
        return _assuranceDecision(
            campaignLevel,
            userMinAssurance,
            advertiserConsented,
            fromRelay,
            fromPublisherRelay
        );
    }
}
