// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumRelayGovernance.sol";
import "../DatumPublisherGovernance.sol";
import "../DatumAdvertiserGovernance.sol";
/// @dev Test-only successors for the governance-cluster migration.
contract MockRelayGovernanceNext is DatumRelayGovernance {
    constructor(uint256 q, uint256 g, uint256 pb, uint16 s, uint16 cb, uint16 tb)
        DatumRelayGovernance(q, g, pb, s, cb, tb) {}
    function version() public pure override returns (uint256) { return 2; }
}
contract MockPublisherGovernanceNext is DatumPublisherGovernance {
    constructor(address ps, address cb, address pr, uint256 q, uint256 s, uint256 bb, uint256 g, uint256 pb)
        DatumPublisherGovernance(ps, cb, pr, q, s, bb, g, pb) {}
    function version() public pure override returns (uint256) { return 2; }
}
contract MockAdvertiserGovernanceNext is DatumAdvertiserGovernance {
    constructor(uint256 q, uint256 s, uint256 g, uint256 pb, address pr)
        DatumAdvertiserGovernance(q, s, g, pb, pr) {}
    function version() public pure override returns (uint256) { return 3; }
}
