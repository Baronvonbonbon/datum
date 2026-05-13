// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./DatumOwnable.sol";

/// @title DatumStakeRoot
/// @notice Path A: per-epoch Merkle root commitments over user-stake leaves.
///         A leaf is `Poseidon(userCommitment, datumBalance)` where
///         `userCommitment = Poseidon(secret)`. The ZK circuit proves the user
///         knows a `secret` whose leaf is in the tree under one of the recent
///         roots, with `balance >= minStake`.
///
///         Off-chain workers build the tree from DATUM token state and commit
///         the root via `commitStakeRoot(epoch, root)`. N-of-M relayer cross-
///         signing is enforced via the `reporters` set + threshold; a single
///         compromised reporter cannot push a fraudulent root.
///
///         Roots are kept for `LOOKBACK_EPOCHS` so users with slightly stale
///         witnesses can still prove. Beyond that, the root expires and a
///         fresh witness must be generated.
contract DatumStakeRoot is DatumOwnable {
    // ── Storage ──────────────────────────────────────────────────────────
    /// @notice Authoritative root for each epoch.
    mapping(uint256 => bytes32) public rootAt;
    /// @notice The most-recently-committed epoch (max of all keys in rootAt).
    uint256 public latestEpoch;

    /// @notice Reporter set + threshold. Threshold of distinct reporter sigs
    ///         (off-chain by the reporters submitting separate txs and signing
    ///         a pending proposal) needed to finalize a root.
    mapping(address => bool) public isReporter;
    address[] public reporters;
    uint256 public threshold;

    /// @notice Pending proposals for an (epoch, root) pair. Voters tracked
    ///         per proposal; proposal is keyed by keccak(epoch, root).
    struct Proposal {
        bytes32 root;
        uint256 epoch;
        uint256 approvals;
        bool finalized;
        mapping(address => bool) voted;
    }
    mapping(bytes32 => Proposal) private _proposals;

    /// @notice Sliding window: any root committed at epoch e is queryable for
    ///         the next LOOKBACK_EPOCHS epochs via `isRecent(root)`.
    uint256 public constant LOOKBACK_EPOCHS = 8;

    // ── Events ───────────────────────────────────────────────────────────
    event ReporterAdded(address indexed who);
    event ReporterRemoved(address indexed who);
    event ThresholdSet(uint256 threshold);
    event StakeRootProposed(uint256 indexed epoch, bytes32 indexed root, address indexed by);
    event StakeRootApproved(uint256 indexed epoch, bytes32 indexed root, address indexed by);
    event StakeRootCommitted(uint256 indexed epoch, bytes32 indexed root);

    // ── Errors ───────────────────────────────────────────────────────────
    // E00 zero addr, E01 not found / not reporter, E11 invalid arg, E18 not owner,
    // E22 already finalized / already voted, E64 epoch must increase

    // ── Admin ────────────────────────────────────────────────────────────

    /// @notice Add a reporter. Owner-only; intended to be timelocked at deploy.
    function addReporter(address who) external onlyOwner {
        require(who != address(0), "E00");
        require(!isReporter[who], "E11");
        isReporter[who] = true;
        reporters.push(who);
        emit ReporterAdded(who);
    }

    function removeReporter(address who) external onlyOwner {
        require(isReporter[who], "E01");
        isReporter[who] = false;
        // Compact array
        uint256 n = reporters.length;
        for (uint256 i = 0; i < n; i++) {
            if (reporters[i] == who) {
                reporters[i] = reporters[n - 1];
                reporters.pop();
                break;
            }
        }
        emit ReporterRemoved(who);
    }

    function setThreshold(uint256 t) external onlyOwner {
        require(t > 0 && t <= reporters.length, "E11");
        threshold = t;
        emit ThresholdSet(t);
    }

    // ── Reporter flow ────────────────────────────────────────────────────

    /// @notice Propose (or co-sign existing) a stake root for `epoch`.
    ///         First reporter creates the proposal; subsequent reporters add
    ///         approvals. When approvals >= threshold, the root is finalized
    ///         and `rootAt[epoch]` is set.
    /// @dev    Reporters submit their own txs — each pays own gas, no aggregation.
    function commitStakeRoot(uint256 epoch, bytes32 root) external {
        require(isReporter[msg.sender], "E01");
        require(epoch >= latestEpoch, "E64");
        require(root != bytes32(0), "E11");

        bytes32 pid = keccak256(abi.encode(epoch, root));
        Proposal storage p = _proposals[pid];

        if (p.root == bytes32(0)) {
            // First vote — initialize proposal
            p.root = root;
            p.epoch = epoch;
            emit StakeRootProposed(epoch, root, msg.sender);
        } else {
            require(!p.finalized, "E22");
        }

        require(!p.voted[msg.sender], "E22");
        p.voted[msg.sender] = true;
        p.approvals++;
        emit StakeRootApproved(epoch, root, msg.sender);

        if (p.approvals >= threshold) {
            // If another root has already been finalized for this same epoch,
            // we OVERWRITE — this is intentional: later proposals reflect
            // newer reporter consensus (e.g. after a fork or correction).
            // To prevent oscillation, off-chain reporters MUST sign monotonically.
            p.finalized = true;
            rootAt[epoch] = root;
            if (epoch > latestEpoch) latestEpoch = epoch;
            emit StakeRootCommitted(epoch, root);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice Returns true if `root` was committed within the lookback window.
    ///         Used by DatumClaimValidator to accept slightly-stale witnesses.
    function isRecent(bytes32 root) external view returns (bool) {
        if (root == bytes32(0)) return false;
        uint256 start = latestEpoch < LOOKBACK_EPOCHS ? 0 : latestEpoch - LOOKBACK_EPOCHS + 1;
        for (uint256 e = start; e <= latestEpoch; e++) {
            if (rootAt[e] == root) return true;
        }
        return false;
    }

    function reporterCount() external view returns (uint256) { return reporters.length; }
}
