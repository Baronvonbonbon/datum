// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title DatumCouncil
/// @notice Phase 1 governance: N-of-M trusted member council.
///
///         Any member can propose an arbitrary set of calls (targets + calldatas).
///         A proposal passes when it accumulates `threshold` YES votes.
///         After passing, there is an `executionDelayBlocks` cooldown before
///         anyone can execute.  A `guardian` address can veto any non-executed
///         proposal within `vetoWindowBlocks` of its creation.
///
///         Self-governance: members are managed by council proposals that target
///         this contract (addMember / removeMember / setGuardian / setThreshold /
///         setVotingPeriod / setExecutionDelay / setVetoWindow / setMaxExecutionWindow).
///         These functions are gated to onlyCouncil (msg.sender == address(this)).
///
///         Usage with DatumGovernanceRouter:
///           router.setGovernor(Council, address(this))   // via Timelock
///           → proposals target the Router directly, e.g.:
///               targets = [router],  calldatas = [activateCampaign(id)]
contract DatumCouncil {
    // -------------------------------------------------------------------------
    // Ownership
    // -------------------------------------------------------------------------

    address public owner;
    address public pendingOwner;
    uint256 private _locked;

    // -------------------------------------------------------------------------
    // Proposal state
    // -------------------------------------------------------------------------

    struct Proposal {
        address proposer;
        uint256 proposedBlock;
        uint256 votingEndsBlock;
        uint256 executableAfterBlock;  // 0 until threshold reached
        uint256 executionExpiresBlock; // 0 until threshold reached
        uint256 voteCount;
        bool executed;
        bool vetoed;
        bool cancelled;  // M-7: separate from vetoed
    }

    uint256 public nextProposalId;

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => address[]) private _targets;
    mapping(uint256 => uint256[]) private _values;
    mapping(uint256 => bytes[]) private _calldatas;
    mapping(uint256 => string) private _descriptions;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    mapping(address => bool) public isMember;
    address[] private _memberList;
    mapping(address => uint256) private _memberIndex;  // M-8: O(1) lookup for swap-and-pop
    uint256 public memberCount;
    address public guardian;

    uint256 public threshold;
    uint256 public votingPeriodBlocks;
    uint256 public executionDelayBlocks;
    uint256 public vetoWindowBlocks;
    uint256 public maxExecutionWindowBlocks;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Proposed(uint256 indexed proposalId, address indexed proposer, string description);
    event Voted(uint256 indexed proposalId, address indexed voter, uint256 newCount);
    event ThresholdReached(uint256 indexed proposalId, uint256 executableAfterBlock);
    event Executed(uint256 indexed proposalId);
    event Vetoed(uint256 indexed proposalId, address indexed guardian);
    event Cancelled(uint256 indexed proposalId, address indexed proposer);
    event MemberAdded(address indexed member);
    event MemberRemoved(address indexed member);
    event GuardianSet(address indexed guardian);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "E18");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 0, "E57");
        _locked = 1;
        _;
        _locked = 0;
    }

    modifier onlyMember() {
        require(isMember[msg.sender], "E18");
        _;
    }

    modifier onlyCouncil() {
        require(msg.sender == address(this), "E18");
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param initialMembers Array of initial member addresses
    /// @param _threshold     Minimum YES votes to pass a proposal
    /// @param _guardian      Guardian that can veto (address(0) to disable)
    /// @param _votingPeriodBlocks      Blocks members can vote after proposal
    /// @param _executionDelayBlocks    Blocks to wait after threshold before execution
    /// @param _vetoWindowBlocks        Blocks from proposal creation within which guardian can veto
    /// @param _maxExecutionWindowBlocks  Blocks after executableAfterBlock before proposal expires
    constructor(
        address[] memory initialMembers,
        uint256 _threshold,
        address _guardian,
        uint256 _votingPeriodBlocks,
        uint256 _executionDelayBlocks,
        uint256 _vetoWindowBlocks,
        uint256 _maxExecutionWindowBlocks
    ) {
        owner = msg.sender;
        require(initialMembers.length > 0, "E00");
        require(_threshold > 0 && _threshold <= initialMembers.length, "E00");
        require(_votingPeriodBlocks > 0, "E00");
        require(_maxExecutionWindowBlocks > 0, "E00");
        for (uint256 i = 0; i < initialMembers.length; i++) {
            require(initialMembers[i] != address(0), "E00");
            require(!isMember[initialMembers[i]], "E00");
            isMember[initialMembers[i]] = true;
            _memberIndex[initialMembers[i]] = _memberList.length;
            _memberList.push(initialMembers[i]);
        }
        memberCount = initialMembers.length;
        threshold = _threshold;
        guardian = _guardian;
        votingPeriodBlocks = _votingPeriodBlocks;
        executionDelayBlocks = _executionDelayBlocks;
        vetoWindowBlocks = _vetoWindowBlocks;
        maxExecutionWindowBlocks = _maxExecutionWindowBlocks;
    }

    // -------------------------------------------------------------------------
    // Core proposal lifecycle
    // -------------------------------------------------------------------------

    /// @notice Create a new proposal. Callable by any member.
    function propose(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        string calldata description
    ) external onlyMember returns (uint256 proposalId) {
        require(targets.length > 0, "E00");
        require(targets.length == values.length, "E00");
        require(targets.length == calldatas.length, "E00");

        proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            proposedBlock: block.number,
            votingEndsBlock: block.number + votingPeriodBlocks,
            executableAfterBlock: 0,
            executionExpiresBlock: 0,
            voteCount: 0,
            executed: false,
            vetoed: false,
            cancelled: false
        });
        _targets[proposalId] = targets;
        _values[proposalId] = values;
        _calldatas[proposalId] = calldatas;
        _descriptions[proposalId] = description;

        emit Proposed(proposalId, msg.sender, description);
    }

    /// @notice Cast a YES vote. Each member can vote once per proposal.
    ///         When threshold is first reached, executableAfterBlock is set.
    function vote(uint256 proposalId) external onlyMember {
        Proposal storage p = proposals[proposalId];
        require(p.proposedBlock > 0, "E01");      // proposal exists
        require(!p.executed && !p.vetoed && !p.cancelled, "E50");
        require(block.number <= p.votingEndsBlock, "E51");
        require(!hasVoted[proposalId][msg.sender], "E42");

        hasVoted[proposalId][msg.sender] = true;
        p.voteCount++;

        emit Voted(proposalId, msg.sender, p.voteCount);

        if (p.voteCount >= threshold && p.executableAfterBlock == 0) {
            p.executableAfterBlock = block.number + executionDelayBlocks;
            p.executionExpiresBlock = p.executableAfterBlock + maxExecutionWindowBlocks;
            emit ThresholdReached(proposalId, p.executableAfterBlock);
        }
    }

    /// @notice Execute a passed proposal. Callable by anyone.
    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.proposedBlock > 0, "E01");
        require(!p.executed, "E52");
        require(!p.vetoed && !p.cancelled, "E53");
        require(p.executableAfterBlock > 0, "E54");  // threshold not yet reached
        require(block.number >= p.executableAfterBlock, "E55");
        require(block.number <= p.executionExpiresBlock, "E56");

        p.executed = true;

        address[] memory targets = _targets[proposalId];
        uint256[] memory values = _values[proposalId];
        bytes[] memory calldatas = _calldatas[proposalId];

        for (uint256 i = 0; i < targets.length; i++) {
            (bool ok,) = targets[i].call{value: values[i]}(calldatas[i]);
            require(ok, "E02");
        }

        emit Executed(proposalId);
    }

    /// @notice Guardian veto — blocks execution of a proposal.
    ///         Can be called any time before execution, within vetoWindowBlocks.
    function veto(uint256 proposalId) external {
        require(msg.sender == guardian, "E18");
        Proposal storage p = proposals[proposalId];
        require(p.proposedBlock > 0, "E01");
        require(!p.executed, "E52");
        require(!p.vetoed, "E53");
        require(block.number <= p.proposedBlock + vetoWindowBlocks, "E56");

        p.vetoed = true;
        emit Vetoed(proposalId, msg.sender);
    }

    /// @notice Proposer can cancel their own non-executed, non-vetoed proposal.
    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.proposedBlock > 0, "E01");
        require(msg.sender == p.proposer, "E18");
        require(!p.executed, "E52");
        require(!p.vetoed && !p.cancelled, "E53");

        p.cancelled = true;
        emit Cancelled(proposalId, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Self-governance — only callable via council proposal execution
    // -------------------------------------------------------------------------

    function addMember(address member) external onlyCouncil {
        require(member != address(0), "E00");
        require(!isMember[member], "E00");
        isMember[member] = true;
        _memberIndex[member] = _memberList.length;
        _memberList.push(member);
        memberCount++;
        emit MemberAdded(member);
    }

    function removeMember(address member) external onlyCouncil {
        require(isMember[member], "E01");
        require(memberCount > threshold, "E00");  // prevent locking council
        isMember[member] = false;

        // M-8: swap-and-pop to keep _memberList compact
        uint256 idx = _memberIndex[member];
        uint256 lastIdx = _memberList.length - 1;
        if (idx != lastIdx) {
            address lastMember = _memberList[lastIdx];
            _memberList[idx] = lastMember;
            _memberIndex[lastMember] = idx;
        }
        _memberList.pop();
        delete _memberIndex[member];

        memberCount--;
        emit MemberRemoved(member);
    }

    function setGuardian(address _guardian) external onlyCouncil {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    function setThreshold(uint256 _threshold) external onlyCouncil {
        require(_threshold > 0 && _threshold <= memberCount, "E00");
        threshold = _threshold;
    }

    function setVotingPeriod(uint256 blocks) external onlyCouncil {
        require(blocks > 0, "E00");
        votingPeriodBlocks = blocks;
    }

    function setExecutionDelay(uint256 blocks) external onlyCouncil {
        executionDelayBlocks = blocks;
    }

    function setVetoWindow(uint256 blocks) external onlyCouncil {
        vetoWindowBlocks = blocks;
    }

    function setMaxExecutionWindow(uint256 blocks) external onlyCouncil {
        require(blocks > 0, "E00");
        maxExecutionWindowBlocks = blocks;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getProposalActions(uint256 proposalId) external view returns (
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) {
        return (
            _targets[proposalId],
            _values[proposalId],
            _calldatas[proposalId],
            _descriptions[proposalId]
        );
    }

    function getMemberList() external view returns (address[] memory) {
        return _memberList;
    }

    /// @notice Proposal state summary.
    /// @return state 0=Active, 1=Passed(pending exec), 2=Executed, 3=Vetoed, 4=Expired, 5=Cancelled
    function proposalState(uint256 proposalId) external view returns (uint8 state) {
        Proposal storage p = proposals[proposalId];
        if (p.proposedBlock == 0) return 4; // not found
        if (p.executed) return 2;
        if (p.vetoed) return 3;
        if (p.cancelled) return 5;
        if (p.executableAfterBlock > 0) {
            if (block.number > p.executionExpiresBlock) return 4; // expired
            return 1; // passed, waiting for execution
        }
        if (block.number > p.votingEndsBlock) return 4; // voting ended, threshold not reached
        return 0; // active voting
    }

    /// @notice Transfer ownership to a new owner (2-step process).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "E00");
        pendingOwner = newOwner;
    }

    /// @notice New owner accepts ownership.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "E18");
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Accept ETH so proposals with value can be funded and executed.
    receive() external payable {}
}
