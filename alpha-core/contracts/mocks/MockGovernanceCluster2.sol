// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../DatumGovernanceV2.sol";
import "../DatumParameterGovernance.sol";
import "../DatumCouncil.sol";
contract MockGovernanceV2Next is DatumGovernanceV2 {
    constructor(address c, uint256 q, uint256 s, uint256 tq, uint256 bg, uint256 gpq, uint256 mg, address pr)
        DatumGovernanceV2(c, q, s, tq, bg, gpq, mg, pr) {}
    function version() public pure override returns (uint256) { return 3; }
}
contract MockParameterGovernanceNext is DatumParameterGovernance {
    constructor(address pr, uint256 vp, uint256 tl, uint256 q, uint256 pb)
        DatumParameterGovernance(pr, vp, tl, q, pb) {}
    function version() public pure override returns (uint256) { return 2; }
}
contract MockCouncilNext is DatumCouncil {
    constructor(address[] memory m, uint256 t, address g, uint256 vp, uint256 ed, uint256 vw, uint256 mw)
        DatumCouncil(m, t, g, vp, ed, vw, mw) {}
    function version() public pure override returns (uint256) { return 2; }
}
