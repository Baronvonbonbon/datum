// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumBlocklistCurator
/// @notice B2-fix (2026-05-12): pluggable curator contract that decides whether
///         an address is on the protocol's blocklist. Replaces the owner-managed
///         `blocked[]` mapping as the source of truth.
///
///         A curator can implement whatever governance model it wants:
///           - DAO/Council N-of-M vote
///           - Reputation-weighted slashing
///           - Whitelist-of-curators that users subscribe to
///           - No-op (default: nothing is blocked)
///
///         By making the curator swappable AND lockable, the protocol can credibly
///         commit to a specific governance authority and remove the deployer's
///         unilateral censorship power.
interface IDatumBlocklistCurator {
    function isBlocked(address addr) external view returns (bool);
}
