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

    event Wrapped(address indexed user, uint256 amount);
    event Unwrapped(address indexed user, bytes32 indexed assetHubRecipient, uint256 amount);

    constructor(
        address _mintAuthority,
        address _precompile,
        uint256 _canonicalAssetId
    ) ERC20("Wrapped DATUM", "WDATUM") {
        require(_mintAuthority != address(0), "E00");
        require(_precompile != address(0), "E00");
        mintAuthority = _mintAuthority;
        precompile = IAssetHubPrecompile(_precompile);
        canonicalAssetId = _canonicalAssetId;
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

    /// @notice User-initiated wrap: caller transfers canonical to this contract,
    ///         mints WDATUM in exchange.
    /// @dev    Caller must have transferred (or arranged for transfer of)
    ///         `amount` canonical to this wrapper before calling. The
    ///         invariant check enforces the 1:1 backing.
    function wrap(uint256 amount) external {
        require(amount > 0, "E11");
        // Caller is responsible for ensuring canonical balance grew by `amount`
        // since the last invariant check. The precompile transfer should be
        // bundled with this call in the same tx, or pre-transferred.
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
        _burn(msg.sender, amount);
        // Forward canonical to the recipient on Asset Hub via the precompile.
        // For the devnet mock this stays in the EVM; mainnet routes via XCM.
        // Here we transfer to the wrapper's own EVM-side address representation
        // of the substrate recipient — the precompile abstracts the address shape.
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
        require(totalSupply() <= canonical, "broken peg");
    }

    /// @notice Public view of the invariant — for off-chain monitoring.
    function backingRatio() external view returns (uint256 totalSupply_, uint256 canonicalHeld) {
        totalSupply_ = totalSupply();
        canonicalHeld = precompile.balanceOf(canonicalAssetId, address(this));
    }
}
