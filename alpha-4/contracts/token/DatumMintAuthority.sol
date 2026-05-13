// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "../DatumOwnable.sol";

interface IAssetHubPrecompile_Auth {
    function mint(uint256 assetId, address to, uint256 amount) external;
    function transferIssuer(uint256 assetId, address newIssuer) external;
}

interface IDatumWrapper {
    function mintTo(address recipient, uint256 amount) external;
}

/// @title DatumMintAuthority
/// @notice Single bridge contract between EVM-side protocol contracts and the
///         canonical DATUM asset on Asset Hub.
///
///         Every DATUM mint flows through this contract. It atomically mints
///         canonical DATUM to the wrapper's reserve and instructs the wrapper
///         to issue WDATUM 1:1 to the recipient. From the user's perspective
///         they just received WDATUM; the canonical bridging is transparent.
///
///         This separation isolates the EVM ↔ Asset Hub coupling to one
///         contract. When the parachain launches and DATUM migrates to its
///         own native pallet, only this contract needs to be reconfigured
///         (via the sunset path); everything upstream is unaffected.
///
/// @dev    Owner: founder multisig at deploy → Council via timelock → eventual
///         parachain pallet via the sunset path. See §5.5 of the TOKENOMICS
///         spec for the full sunset roadmap.
contract DatumMintAuthority is DatumOwnable {

    // -------------------------------------------------------------------------
    // Configuration (immutable post-deploy)
    // -------------------------------------------------------------------------

    /// @notice Hard cap on total mints (matches HARD_CAP - FOUNDER_PREMINT
    ///         in the spec; this contract is responsible for the 95M emission
    ///         pool, of which 1M is reserved for the bootstrap pool).
    uint256 public constant MINTABLE_CAP = 95_000_000 * 10**10;

    IAssetHubPrecompile_Auth public immutable precompile;
    uint256 public immutable canonicalAssetId;

    // -------------------------------------------------------------------------
    // Configured at deploy + extendable
    // -------------------------------------------------------------------------

    /// @notice The WDATUM wrapper contract. Set once after wrapper is deployed.
    address public wrapper;

    /// @notice Settlement contract — only address that may invoke mintForSettlement.
    address public settlement;

    /// @notice Bootstrap pool — only address that may invoke mintForBootstrap.
    address public bootstrapPool;

    /// @notice Vesting contract — only address that may invoke mintForVesting.
    address public vesting;

    /// @notice Total DATUM minted via this authority. Capped at MINTABLE_CAP.
    uint256 public totalMinted;

    event WrapperSet(address indexed wrapper);
    event SettlementSet(address indexed settlement);
    event BootstrapPoolSet(address indexed pool);
    event VestingSet(address indexed vesting);
    event MintedForSettlement(address indexed user, address indexed publisher, address indexed advertiser, uint256 total);
    event MintedForBootstrap(address indexed user, uint256 amount);
    event MintedForVesting(address indexed recipient, uint256 amount);
    event IssuerTransferred(address indexed newIssuer);
    event IssuerTransferStaged(address indexed newIssuer);
    event IssuerTransferCancelled(address indexed newIssuer);

    /// @notice H3-fix: staged successor for the §5.5 sunset. Set by owner via
    ///         stageIssuerTransfer; must call acceptIssuerRole() from its own
    ///         context to finalize. Once the transfer fires, `issuerLocked` is
    ///         true forever — one transfer per deployment, by design.
    address public pendingIssuer;
    /// @notice True once the canonical issuer role has been handed off via the
    ///         sunset path. After this, no further transfers are possible from
    ///         this contract — the parachain pallet is the sole issuer.
    bool public issuerLocked;

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    constructor(address _precompile, uint256 _canonicalAssetId) {
        require(_precompile != address(0), "E00");
        precompile = IAssetHubPrecompile_Auth(_precompile);
        canonicalAssetId = _canonicalAssetId;
    }

    // -------------------------------------------------------------------------
    // One-time wiring (owner-only, can only be set once)
    // -------------------------------------------------------------------------

    function setWrapper(address _wrapper) external onlyOwner {
        require(_wrapper != address(0), "E00");
        require(wrapper == address(0), "already set");
        wrapper = _wrapper;
        emit WrapperSet(_wrapper);
    }

    function setSettlement(address _settlement) external onlyOwner {
        require(_settlement != address(0), "E00");
        require(settlement == address(0), "already set");
        settlement = _settlement;
        emit SettlementSet(_settlement);
    }

    function setBootstrapPool(address _pool) external onlyOwner {
        require(_pool != address(0), "E00");
        require(bootstrapPool == address(0), "already set");
        bootstrapPool = _pool;
        emit BootstrapPoolSet(_pool);
    }

    function setVesting(address _vesting) external onlyOwner {
        require(_vesting != address(0), "E00");
        require(vesting == address(0), "already set");
        vesting = _vesting;
        emit VestingSet(_vesting);
    }

    // -------------------------------------------------------------------------
    // Mint operations (gated to specific upstream contracts)
    // -------------------------------------------------------------------------

    /// @notice Called by DatumSettlement on every settled claim.
    /// @dev    Atomically mints canonical to wrapper + WDATUM to each recipient.
    function mintForSettlement(
        address user, uint256 userAmt,
        address publisher, uint256 publisherAmt,
        address advertiser, uint256 advertiserAmt
    ) external {
        require(msg.sender == settlement, "E18");
        uint256 total = userAmt + publisherAmt + advertiserAmt;
        require(totalMinted + total <= MINTABLE_CAP, "cap");

        if (total == 0) return;

        totalMinted += total;

        // Mint canonical to wrapper's reserve.
        precompile.mint(canonicalAssetId, wrapper, total);

        // Mint WDATUM to each recipient.
        if (userAmt > 0)       IDatumWrapper(wrapper).mintTo(user,       userAmt);
        if (publisherAmt > 0)  IDatumWrapper(wrapper).mintTo(publisher,  publisherAmt);
        if (advertiserAmt > 0) IDatumWrapper(wrapper).mintTo(advertiser, advertiserAmt);

        emit MintedForSettlement(user, publisher, advertiser, total);
    }

    /// @notice Called by DatumBootstrapPool when dispensing the house-ad bonus.
    /// @dev    Identical bridging shape — canonical to wrapper, WDATUM to user.
    function mintForBootstrap(address user, uint256 amount) external {
        require(msg.sender == bootstrapPool, "E18");
        require(totalMinted + amount <= MINTABLE_CAP, "cap");
        if (amount == 0) return;
        totalMinted += amount;
        precompile.mint(canonicalAssetId, wrapper, amount);
        IDatumWrapper(wrapper).mintTo(user, amount);
        emit MintedForBootstrap(user, amount);
    }

    /// @notice Called by DatumVesting on each release().
    /// @dev    Same bridging shape as settlement.
    function mintForVesting(address recipient, uint256 amount) external {
        require(msg.sender == vesting, "E18");
        require(totalMinted + amount <= MINTABLE_CAP, "cap");
        if (amount == 0) return;
        totalMinted += amount;
        precompile.mint(canonicalAssetId, wrapper, amount);
        IDatumWrapper(wrapper).mintTo(recipient, amount);
        emit MintedForVesting(recipient, amount);
    }

    // -------------------------------------------------------------------------
    // Sunset — transfer Asset Hub issuer rights
    // -------------------------------------------------------------------------

    /// @notice H3-fix step 1/2: stage the sunset successor. Owner-only.
    /// @dev    Successor must subsequently call acceptIssuerRole() from its
    ///         own context to finalize. Proves the successor address exists
    ///         and controls itself — protects against typos / dead contracts.
    function stageIssuerTransfer(address newAuthority) external onlyOwner {
        require(!issuerLocked, "issuer-locked");
        require(newAuthority != address(0), "E00");
        pendingIssuer = newAuthority;
        emit IssuerTransferStaged(newAuthority);
    }

    /// @notice H3-fix: cancel a staged sunset transfer prior to acceptance.
    function cancelIssuerTransfer() external onlyOwner {
        require(!issuerLocked, "issuer-locked");
        address staged = pendingIssuer;
        require(staged != address(0), "none staged");
        pendingIssuer = address(0);
        emit IssuerTransferCancelled(staged);
    }

    /// @notice H3-fix step 2/2: successor confirms control of itself and the
    ///         issuer role transfers irrevocably. Lock-once — after this call,
    ///         no further transfers possible from this contract. The parachain
    ///         pallet (or whichever successor is staged) becomes the sole
    ///         issuer of canonical DATUM forever.
    /// @dev    This is the §5.5 sunset endpoint. The single transfer this
    ///         contract supports is by design: parachain migration is the
    ///         one legitimate use, and after it the EVM-side authority must
    ///         not be able to reclaim issuance.
    function acceptIssuerRole() external {
        require(!issuerLocked, "issuer-locked");
        address staged = pendingIssuer;
        require(staged != address(0), "none staged");
        require(msg.sender == staged, "E19");
        issuerLocked = true;
        pendingIssuer = address(0);
        precompile.transferIssuer(canonicalAssetId, staged);
        emit IssuerTransferred(staged);
    }
}
