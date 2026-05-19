// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  IDatumMintCoordinator
/// @notice Settlement-facing surface for the DATUM-token emission
///         orchestrator. Carved out of DatumSettlement for mainnet
///         EIP-170 (alpha-4).
interface IDatumMintCoordinator {
    /// @notice Called once per settled batch with the DOT amount paid. The
    ///         coordinator computes the DATUM mint amount (via the wired
    ///         emission engine OR the legacy flat-rate fallback), applies
    ///         the dust gate, splits the result across user / publisher /
    ///         advertiser per the configured bps, and delegates the mint
    ///         to the wired MintAuthority. Mint failures fail soft (try /
    ///         catch + DatumMintFailed event) so settlement is never
    ///         reverted by a mint-side issue.
    ///
    ///         msg.sender must equal the wired settlement contract;
    ///         reverts otherwise.
    function coordinate(
        address user,
        address publisher,
        address advertiser,
        uint256 dotPaid
    ) external;
}
