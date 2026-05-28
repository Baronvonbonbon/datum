// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./DatumUpgradable.sol";

/// @title  DatumBrandCurator
/// @notice Council-curated verification + revocation for brand profiles.
///         Pure off-chain consumed: the UI calls `isApproved(addr)` to
///         render a Council-verified badge, and `isRevoked(addr)` to
///         render a "revoked / use caution" warning.
///
///         Mutations (`approveBrand`, `revokeBrand`, `restoreBrand`) are
///         gated to the council contract, which fires them only after a
///         propose+vote+execute pipeline. Owner can rotate the council
///         pointer; `lockCouncil()` permanently freezes the pointer as a
///         cypherpunk credible commitment.
///
/// @dev    Approval and revocation are independent flags. A brand can be
///         in any of four states:
///           - approved=false, revoked=false  → self-declared (default)
///           - approved=true,  revoked=false  → Council-verified
///           - approved=false, revoked=true   → revoked / use caution
///           - approved=true,  revoked=true   → previously approved, now
///                                              revoked (UI renders the
///                                              warning, not the badge)
contract DatumBrandCurator is DatumUpgradable {
    function version() public pure override returns (uint256) { return 1; }

    /// @notice The contract authorized to call approve/revoke. Typically DatumCouncil.
    address public council;

    /// @notice Once true, `council` is frozen — even owner can't change it.
    bool public councilLocked;

    /// @notice Per-address: has the Council approved this brand?
    mapping(address => bool) public approved;

    /// @notice Per-address: has the Council revoked / flagged this brand?
    mapping(address => bool) public revoked;

    /// @notice Reason hash (optional, IPFS CID) for the most recent
    ///         approval or revocation, for transparency.
    mapping(address => bytes32) public actionReason;

    event CouncilSet(address indexed council);
    event CouncilLocked();
    event BrandApproved(address indexed addr, bytes32 reasonHash);
    event BrandRevoked(address indexed addr, bytes32 reasonHash);
    event BrandRestored(address indexed addr);

    modifier onlyCouncil() {
        require(council != address(0) && msg.sender == council, "E18");
        _;
    }

    /// @notice Set the council pointer. Locked once `lockCouncil` is called.
    function setCouncil(address newCouncil) external onlyOwner {
        require(!councilLocked, "council-locked");
        council = newCouncil;
        emit CouncilSet(newCouncil);
    }

    /// @notice Permanently freeze the council pointer. After this, the owner
    ///         can no longer rotate the council contract. Irreversible.
    function lockCouncil() external onlyOwner whenOpenGovPhase {
        require(!councilLocked, "already locked");
        require(council != address(0), "council unset");
        councilLocked = true;
        emit CouncilLocked();
    }

    /// @notice Mark a brand as Council-verified. Called by the Council
    ///         contract after a passing vote. Clears any prior revocation.
    function approveBrand(address addr, bytes32 reasonHash) external onlyCouncil whenNotFrozen {
        require(addr != address(0), "E00");
        approved[addr] = true;
        revoked[addr] = false;
        actionReason[addr] = reasonHash;
        emit BrandApproved(addr, reasonHash);
    }

    /// @notice Revoke / flag a brand. Called by the Council contract after
    ///         a passing vote. The brand entry on DatumBrandRegistry is
    ///         untouched — only the curator's flag flips. UIs render a
    ///         warning rather than hiding the entry, so historical context
    ///         survives.
    function revokeBrand(address addr, bytes32 reasonHash) external onlyCouncil whenNotFrozen {
        require(addr != address(0), "E00");
        revoked[addr] = true;
        actionReason[addr] = reasonHash;
        emit BrandRevoked(addr, reasonHash);
    }

    /// @notice Clear a prior revocation. Approval status is preserved.
    function restoreBrand(address addr) external onlyCouncil whenNotFrozen {
        require(addr != address(0), "E00");
        revoked[addr] = false;
        actionReason[addr] = bytes32(0);
        emit BrandRestored(addr);
    }

    /// @notice Convenience: a brand is "Council-verified" exactly when
    ///         approved && !revoked. UIs should use this rather than
    ///         reading the two flags independently.
    function isCouncilVerified(address addr) external view returns (bool) {
        return approved[addr] && !revoked[addr];
    }
}
