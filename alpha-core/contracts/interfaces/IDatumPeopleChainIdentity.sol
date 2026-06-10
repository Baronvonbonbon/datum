// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumPeopleChainIdentity
/// @notice On-chain cache of Polkadot People Chain identity verification state.
///
///         People Chain is a Polkadot system chain that maintains decentralized
///         identity records with registrar judgments. We surface those judgments
///         on the Hub via this cached attestation surface — Settlement reads
///         `isVerified(user, minLevel)` to gate per-campaign and per-user
///         identity requirements.
///
///         Identity levels follow People Chain's registrar judgments:
///           0 = None / Unknown
///           1 = Reasonable  (registrar reviewed but didn't field-verify)
///           2 = KnownGood   (registrar performed off-chain verification)
///
///         Higher levels are strict supersets — KnownGood satisfies any
///         requirement at level Reasonable.
interface IDatumPeopleChainIdentity {
    /// @notice Per-user identity record.
    /// @param level             Current verification tier (0 = none, 1 = Reasonable, 2 = KnownGood).
    /// @param expiryBlock       Hub block at which this record becomes stale (treated as level=0).
    /// @param lastUpdatedBlock  Hub block this record was last written. Drives staleness UX.
    struct IdentityRecord {
        uint8  level;
        uint64 expiryBlock;
        uint64 lastUpdatedBlock;
    }

    /// @notice Returns true iff the user has a non-expired record at >= minLevel.
    /// @dev    Settlement reads this on the hot path; MUST stay view + cheap.
    function isVerified(address user, uint8 minLevel) external view returns (bool);

    /// @notice Returns the current cached record (level=0, expiry=0 if absent/expired).
    function getIdentity(address user) external view returns (IdentityRecord memory);

    /// @notice The block number after which the user's record expires and
    ///         `isVerified` returns false regardless of stored level.
    function expiryBlock(address user) external view returns (uint64);
}
