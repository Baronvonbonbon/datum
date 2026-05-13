// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IAssetHubPrecompile {
    function mint(uint256 assetId, address to, uint256 amount) external;
    function burn(uint256 assetId, address from, uint256 amount) external;
    function transfer(uint256 assetId, address to, uint256 amount) external;
    function balanceOf(uint256 assetId, address who) external view returns (uint256);
}

/// @title DatumWrapper (WDATUM)
/// @notice ERC-20 wrapper for the canonical DATUM asset on Asset Hub.
///
///         This contract is the EVM-side handle for DATUM. It holds canonical
///         DATUM 1:1 in reserve (via the Asset Hub precompile) and issues
///         WDATUM to recipients. All EVM-side governance, staking, and
///         protocol utilities read WDATUM balances.
///
/// @dev No admin key. No upgradeability. Mint is gated to the mint authority
///      configured at construction. Burn is solely user-initiated via unwrap.
contract DatumWrapper is ERC20 {
    /// @notice The single contract permitted to mint WDATUM.
    /// @dev    Settlement and bootstrap mints both flow through this address.
    ///         Set at construction; cannot be changed.
    address public immutable mintAuthority;

    /// @notice The Asset Hub precompile address (mocked on devnet).
    IAssetHubPrecompile public immutable precompile;

    /// @notice The Asset Hub asset id for canonical DATUM (e.g. 31337).
    uint256 public immutable canonicalAssetId;

    /// @notice L3-fix: immutable flag set at construction. When true, the
    ///         `_ahAddressOf` devnet shim is permitted in `unwrap`. When false
    ///         (production), `unwrap` reverts with "xcm-required" — production
    ///         deploys must replace this contract with an XCM-aware variant
    ///         before unwrap can be enabled. Belt-and-suspenders against
    ///         accidentally shipping the mock shim path to mainnet.
    bool public immutable devnetUnwrapShimEnabled;

    /// @notice H1 fix: per-user committed canonical amount awaiting wrap.
    ///         Set by requestWrap; consumed by wrap. Prevents wrap() from
    ///         minting against canonical slack the caller didn't deposit.
    mapping(address => uint256) public pendingWrap;

    /// @notice Sum of all outstanding pendingWrap commitments. Used in wrap()
    ///         to reserve canonical for prior commitments so an attacker can't
    ///         frontrun by depositing-and-claiming against someone else's slack.
    uint256 public totalCommittedCanonical;

    event Wrapped(address indexed user, uint256 amount);
    event Unwrapped(address indexed user, bytes32 indexed assetHubRecipient, uint256 amount);
    event WrapRequested(address indexed user, uint256 amount, uint256 pending);
    event WrapRequestCancelled(address indexed user, uint256 amount);

    constructor(
        address _mintAuthority,
        address _precompile,
        uint256 _canonicalAssetId,
        bool _devnetUnwrapShimEnabled
    ) ERC20("Wrapped DATUM", "WDATUM") {
        require(_mintAuthority != address(0), "E00");
        require(_precompile != address(0), "E00");
        mintAuthority = _mintAuthority;
        precompile = IAssetHubPrecompile(_precompile);
        canonicalAssetId = _canonicalAssetId;
        devnetUnwrapShimEnabled = _devnetUnwrapShimEnabled;
    }

    /// @notice Override decimals to match the substrate-native 10-decimal canonical asset.
    /// @dev    Non-standard for ERC-20 (most assume 18), but cleanly avoids any scaling
    ///         math at the wrap/unwrap boundary.
    function decimals() public pure override returns (uint8) {
        return 10;
    }

    // -------------------------------------------------------------------------
    // Mint (only mint authority)
    // -------------------------------------------------------------------------

    /// @notice Mint WDATUM to a recipient.
    /// @dev    Callable only by `mintAuthority`. The authority is expected to
    ///         have minted matching canonical DATUM to this contract's address
    ///         before calling — otherwise the invariant check will revert.
    function mintTo(address recipient, uint256 amount) external {
        require(msg.sender == mintAuthority, "E18");
        _mint(recipient, amount);
        _checkInvariant();
    }

    // -------------------------------------------------------------------------
    // User-initiated wrap / unwrap
    // -------------------------------------------------------------------------

    /// @notice H1 step 1/2: declare intent to wrap `amount` canonical.
    /// @dev    Caller must subsequently transfer `amount` canonical to this
    ///         wrapper (via precompile.transfer from their own context), then
    ///         call wrap() to mint. Commitment reserves canonical against
    ///         simultaneous claims by other users.
    function requestWrap(uint256 amount) external {
        require(amount > 0, "E11");
        pendingWrap[msg.sender] += amount;
        totalCommittedCanonical += amount;
        emit WrapRequested(msg.sender, amount, pendingWrap[msg.sender]);
    }

    /// @notice Cancel a pending wrap commitment. Refundable only as a release
    ///         of the commitment slot; canonical the user already transferred
    ///         to the wrapper is NOT returned by this call — they recover it
    ///         by unwrap()ing the WDATUM they would otherwise mint, after
    ///         claiming via wrap(). Cancel exists so a user who over-committed
    ///         (e.g. RPC retry) can release the unfunded portion.
    function cancelWrapRequest(uint256 amount) external {
        require(amount > 0, "E11");
        require(pendingWrap[msg.sender] >= amount, "E03");
        pendingWrap[msg.sender] -= amount;
        totalCommittedCanonical -= amount;
        emit WrapRequestCancelled(msg.sender, amount);
    }

    /// @notice H1 step 2/2: redeem a prior commitment for WDATUM.
    /// @dev    Mints up to the caller's pendingWrap. Canonical held by the
    ///         wrapper must cover (totalSupply + totalCommittedCanonical) at
    ///         all times — meaning every existing WDATUM plus every other
    ///         user's outstanding commitment is reserved first. The caller
    ///         can only mint against canonical THEY contributed.
    function wrap(uint256 amount) external {
        require(amount > 0, "E11");
        require(pendingWrap[msg.sender] >= amount, "E03");

        uint256 canonical = precompile.balanceOf(canonicalAssetId, address(this));
        // Required: every already-minted WDATUM is backed, every other pending
        // commitment is reserved, and this claim is backed too.
        require(canonical >= totalSupply() + totalCommittedCanonical, "underfunded");

        pendingWrap[msg.sender] -= amount;
        totalCommittedCanonical -= amount;

        _mint(msg.sender, amount);
        _checkInvariant();
        emit Wrapped(msg.sender, amount);
    }

    /// @notice User-initiated unwrap: burns WDATUM, releases canonical to recipient.
    /// @param  amount Amount of WDATUM to burn.
    /// @param  assetHubRecipient 32-byte AccountId on Asset Hub to receive the canonical.
    function unwrap(uint256 amount, bytes32 assetHubRecipient) external {
        require(amount > 0, "E11");
        require(assetHubRecipient != bytes32(0), "E00");
        // L3-fix: refuse the devnet shim path on production builds. The
        // _ahAddressOf path maps a 32-byte AccountId to an EVM-shaped address
        // suitable only for the mock precompile's flat balance mapping.
        // Production deploys must replace this contract with an XCM-aware
        // variant; the shim is intentionally not on the production path.
        require(devnetUnwrapShimEnabled, "xcm-required");
        _burn(msg.sender, amount);
        precompile.transfer(canonicalAssetId, _ahAddressOf(assetHubRecipient), amount);
        emit Unwrapped(msg.sender, assetHubRecipient, amount);
        _checkInvariant();
    }

    /// @dev Devnet shim: convert the 32-byte AccountId to an EVM-shaped address
    ///      for the mock's balance mapping. On mainnet the precompile handles
    ///      AccountId natively — this conversion is mock-only.
    function _ahAddressOf(bytes32 accountId) internal pure returns (address) {
        return address(uint160(uint256(accountId)));
    }

    // -------------------------------------------------------------------------
    // Invariant
    // -------------------------------------------------------------------------

    /// @notice WDATUM supply must never exceed canonical held by this contract.
    /// @dev    Asserted after every state-changing operation. If this ever
    ///         reverts in production, something is seriously broken — the
    ///         wrapper's peg has been violated.
    function _checkInvariant() internal view {
        uint256 canonical = precompile.balanceOf(canonicalAssetId, address(this));
        // H1: canonical must cover both circulating WDATUM and outstanding
        // wrap commitments — any laxer check would re-open the slack-theft path.
        require(totalSupply() + totalCommittedCanonical <= canonical, "broken peg");
    }

    /// @notice Public view of the invariant — for off-chain monitoring.
    function backingRatio() external view returns (uint256 totalSupply_, uint256 canonicalHeld) {
        totalSupply_ = totalSupply();
        canonicalHeld = precompile.balanceOf(canonicalAssetId, address(this));
    }
}
