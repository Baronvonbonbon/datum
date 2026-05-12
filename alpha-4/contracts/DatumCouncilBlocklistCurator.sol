// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";
import "./interfaces/IDatumBlocklistCurator.sol";

/// @title DatumCouncilBlocklistCurator
/// @notice B2 (2026-05-12): Council-driven blocklist implementation of
///         IDatumBlocklistCurator. Designed to be plugged into DatumPublishers
///         as `setBlocklistCurator(this)`.
///
///         Mutations (`block`, `unblock`) are gated to a designated council
///         address — in production this is the `DatumCouncil` contract, which
///         drives the calls via its propose+vote+execute pipeline. Council
///         members vote off-chain on the merits, then the Council contract
///         executes a proposal that calls this curator.
///
///         The owner can be set to Timelock and is only authorized to rotate
///         the council pointer itself (e.g., upgrade from a v1 council to a v2)
///         — it cannot directly block/unblock. The cypherpunk credible
///         commitment is `lockCouncil()`, which permanently freezes the council
///         pointer so even the timelock can no longer change it.
contract DatumCouncilBlocklistCurator is IDatumBlocklistCurator, DatumOwnable {
    /// @notice The contract authorized to call block/unblock. Typically DatumCouncil.
    address public council;
    /// @notice Once true, `council` is frozen — even owner can't change it.
    bool public councilLocked;

    /// @notice Per-address blocklist state.
    mapping(address => bool) private _blocked;
    /// @notice Reason hash (optional, IPFS CID) for each block, for transparency.
    mapping(address => bytes32) public blockReason;

    event CouncilSet(address indexed council);
    event CouncilLocked();
    event AddrBlocked(address indexed addr, bytes32 reasonHash);
    event AddrUnblocked(address indexed addr);

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
    function lockCouncil() external onlyOwner {
        require(!councilLocked, "already locked");
        require(council != address(0), "council unset");
        councilLocked = true;
        emit CouncilLocked();
    }

    /// @notice Block an address. Called by the Council contract after a passing vote.
    /// @param addr        The address to block.
    /// @param reasonHash  IPFS CID (or similar) pointing at the evidence/decision rationale.
    function blockAddr(address addr, bytes32 reasonHash) external onlyCouncil {
        require(addr != address(0), "E00");
        _blocked[addr] = true;
        blockReason[addr] = reasonHash;
        emit AddrBlocked(addr, reasonHash);
    }

    /// @notice Unblock an address. Called by the Council contract after a passing vote.
    function unblockAddr(address addr) external onlyCouncil {
        require(addr != address(0), "E00");
        _blocked[addr] = false;
        blockReason[addr] = bytes32(0);
        emit AddrUnblocked(addr);
    }

    /// @inheritdoc IDatumBlocklistCurator
    function isBlocked(address addr) external view returns (bool) {
        return _blocked[addr];
    }
}
