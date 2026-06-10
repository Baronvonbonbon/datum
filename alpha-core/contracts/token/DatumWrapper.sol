// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../DatumUpgradable.sol";

interface IAssetHubPrecompile {
    function mint(uint256 assetId, address to, uint256 amount) external;
    function burn(uint256 assetId, address from, uint256 amount) external;
    function transfer(uint256 assetId, address to, uint256 amount) external;
    /// @notice F-026 fix: pull canonical from `from` to `to` under
    ///         allowance. Used by `DatumWrapper.wrap` to atomically deposit
    ///         canonical at mint time, eliminating the open-commitment DoS
    ///         surface that the previous two-step requestWrap/wrap flow
    ///         carried (anyone could inflate `totalCommittedCanonical`).
    ///         The user must call `precompile.approve(wrapper, amount)`
    ///         off-chain first (Asset Hub pallet-assets exposes the standard
    ///         ERC-20 approve/transferFrom surface).
    function transferFrom(uint256 assetId, address from, address to, uint256 amount) external;
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
/// @dev Mint is gated to the mint authority configured at construction.
///      Burn is solely user-initiated via unwrap. Upgrade ladder applies:
///      governance can freeze() and migrate() to a v2 if needed.
contract DatumWrapper is ERC20, DatumUpgradable {

    /// @notice Upgrade ladder version.
    function version() public pure override returns (uint256) { return 1; }

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

    /// @notice F-026 fix: legacy commitment surface retained for read-only
    ///         compatibility with off-chain monitoring. Always zero post-fix;
    ///         wrap() now pulls canonical via precompile.transferFrom in a
    ///         single atomic call, removing the open-commitment DoS vector.
    mapping(address => uint256) public pendingWrap;

    /// @notice F-026 fix: kept at zero post-fix. The original H1 design
    ///         used this to reserve canonical against simultaneous claims;
    ///         the atomic transferFrom path makes that reservation
    ///         unnecessary because canonical is debited from the user's
    ///         own balance the moment wrap is called.
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
    function mintTo(address recipient, uint256 amount) external whenNotFrozen {
        require(msg.sender == mintAuthority, "E18");
        _mint(recipient, amount);
        _checkInvariant();
    }

    // -------------------------------------------------------------------------
    // User-initiated wrap / unwrap
    // -------------------------------------------------------------------------

    /// @notice F-026 fix: deprecated no-op kept in the ABI so off-chain
    ///         tooling and tests don't break across the upgrade. The atomic
    ///         `wrap` below makes the intent-declaration step unnecessary
    ///         and removes the DoS surface where any caller could inflate
    ///         `totalCommittedCanonical` to brick the wrap path.
    function requestWrap(uint256 amount) external whenNotFrozen {
        require(amount > 0, "E11");
        emit WrapRequested(msg.sender, amount, 0);
    }

    /// @notice F-026 fix: deprecated no-op kept in the ABI. With the atomic
    ///         `wrap`, there is no commitment to cancel.
    function cancelWrapRequest(uint256 amount) external whenNotFrozen {
        require(amount > 0, "E11");
        emit WrapRequestCancelled(msg.sender, amount);
    }

    /// @notice F-026 fix: atomically pulls canonical from the caller and
    ///         mints WDATUM 1:1.
    /// @dev    Replaces the H1 two-step requestWrap/wrap flow. The previous
    ///         `pendingWrap` + `totalCommittedCanonical` machinery created
    ///         an open-commitment DoS surface (any caller could inflate
    ///         totalCommittedCanonical at zero cost, rendering the wrap
    ///         invariant unsatisfiable). The atomic `transferFrom` from the
    ///         caller debits canonical directly from their balance the
    ///         moment WDATUM is minted, so simultaneous claims race the
    ///         precompile's own balance accounting rather than a shared
    ///         contract-level commitment slot.
    ///
    ///         Caller MUST call `precompile.approve(address(this), amount)`
    ///         from their own context first (or have a pre-existing
    ///         allowance). Asset Hub pallet-assets exposes the standard
    ///         ERC-20 approve/transferFrom surface for this purpose.
    function wrap(uint256 amount) external whenNotFrozen {
        require(amount > 0, "E11");

        // Snapshot canonical balance before the pull so we can verify the
        // exact amount landed in this contract (defense against quirky
        // precompile implementations that take a fee, round, or otherwise
        // deliver less than requested).
        uint256 balBefore = precompile.balanceOf(canonicalAssetId, address(this));
        precompile.transferFrom(canonicalAssetId, msg.sender, address(this), amount);
        uint256 balAfter = precompile.balanceOf(canonicalAssetId, address(this));
        require(balAfter - balBefore == amount, "transferFrom-short");

        _mint(msg.sender, amount);
        _checkInvariant();
        emit Wrapped(msg.sender, amount);
    }

    /// @notice User-initiated unwrap: burns WDATUM, releases canonical to recipient.
    /// @param  amount Amount of WDATUM to burn.
    /// @param  assetHubRecipient 32-byte AccountId on Asset Hub to receive the canonical.
    function unwrap(uint256 amount, bytes32 assetHubRecipient) external whenNotFrozen {
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

    /// @notice F-028 fix (2026-05-20): sweep canonical held by the
    ///         wrapper that exceeds `totalSupply` + `totalCommittedCanonical`.
    ///         The two-step atomic mint flow (precompile.mint to wrapper →
    ///         wrapper.mintTo) is one tx but two state changes; if the
    ///         second step ever fails after the first, canonical can
    ///         accumulate on the wrapper with no matching WDATUM. This
    ///         entry point debits the excess and transfers to `recipient`.
    ///         Owner-only — in production owner is Timelock so each
    ///         sweep flows through a 48h proposal.
    function sweepSurplus(address recipient, uint256 amount) external onlyOwner whenNotFrozen {
        require(recipient != address(0), "E00");
        uint256 canonical = precompile.balanceOf(canonicalAssetId, address(this));
        uint256 floor = totalSupply() + totalCommittedCanonical;
        require(canonical > floor, "no surplus");
        uint256 surplus = canonical - floor;
        require(amount > 0 && amount <= surplus, "E11");
        precompile.transfer(canonicalAssetId, recipient, amount);
        emit SurplusSwept(recipient, amount);
        _checkInvariant();
    }
    event SurplusSwept(address indexed recipient, uint256 amount);

    /// @notice WDATUM supply must never exceed canonical held by this contract.
    /// @dev    Asserted after every state-changing operation. If this ever
    ///         reverts in production, something is seriously broken — the
    ///         wrapper's peg has been violated.
    function _checkInvariant() internal view {
        uint256 canonical = precompile.balanceOf(canonicalAssetId, address(this));
        // F-026 fix: totalCommittedCanonical is always zero post-fix
        // (atomic wrap eliminated the commitment surface), but it remains
        // in the check as a 0-add for explicit reads of the legacy field
        // by audit / monitoring tooling.
        require(totalSupply() + totalCommittedCanonical <= canonical, "broken peg");
    }

    /// @notice Public view of the invariant — for off-chain monitoring.
    function backingRatio() external view returns (uint256 totalSupply_, uint256 canonicalHeld) {
        totalSupply_ = totalSupply();
        canonicalHeld = precompile.balanceOf(canonicalAssetId, address(this));
    }
}
