// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IDatumAdvertiserGovernance
/// @notice CB4: conviction-weighted fraud governance targeting advertisers.
///         Mirrors the relevant subset of IDatumPublisherGovernance — slashing
///         path only. Council-arbitrated cross-direction claims continue to
///         flow through DatumPublisherGovernance.
interface IDatumAdvertiserGovernance {
    struct Proposal {
        address advertiser;
        bytes32 evidenceHash;
        uint256 ayeWeighted;
        uint256 nayWeighted;
        uint256 startBlock;
        uint256 lastNayBlock;
        bool    resolved;
        bool    upheld;
        address proposer;
        uint256 bondLocked;
    }

    event AdvertiserFraudProposed(uint256 indexed id, address indexed advertiser, address indexed proposer, bytes32 evidenceHash);
    event AdvertiserFraudVoted(uint256 indexed id, address indexed voter, bool aye, uint8 conviction, uint256 weight);
    event AdvertiserFraudResolved(uint256 indexed id, bool upheld, uint256 slashed);
    event AdvertiserSlashed(address indexed advertiser, uint256 amount);
}
