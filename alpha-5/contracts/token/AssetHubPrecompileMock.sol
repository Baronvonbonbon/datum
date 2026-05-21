// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "../DatumOwnable.sol";

/// @title AssetHubPrecompileMock
/// @notice Devnet-only stand-in for the pallet-revive Asset Hub precompile.
///
///         On Polkadot Hub mainnet, this contract is replaced by the real
///         precompile that bridges to Asset Hub native assets. For devnet /
///         hardhat / local-EVM testing we use this mock: it stores balances
///         in EVM state and exposes the precompile's mint / burn / transfer
///         surface.
///
///         The mock is intentionally faithful to the precompile's interface
///         so that contracts that integrate it (DatumMintAuthority,
///         DatumWrapper) can be tested locally without changes.
///
/// @dev The real precompile would expose:
///         - mint(uint256 assetId, address to, uint256 amount) onlyIssuer
///         - burn(uint256 assetId, address from, uint256 amount) onlyIssuer
///         - balanceOf(uint256 assetId, address who)
///         - totalSupply(uint256 assetId)
///         - transferIssuer(uint256 assetId, address newIssuer) onlyIssuer
///
///       The mock implements these against EVM storage. It uses one mapping
///       per asset id so we can test multiple assets if we ever need to.
contract AssetHubPrecompileMock is DatumOwnable {

    /// @dev Per-asset issuer (who can mint/burn). Set at asset registration.
    mapping(uint256 => address) public issuerOf;

    /// @dev Per-asset metadata.
    mapping(uint256 => string)  public nameOf;
    mapping(uint256 => string)  public symbolOf;
    mapping(uint256 => uint8)   public decimalsOf;

    /// @dev Per-asset balances and supplies.
    mapping(uint256 => uint256) private _totalSupply;
    mapping(uint256 => mapping(address => uint256)) private _balances;

    event AssetRegistered(uint256 indexed assetId, address indexed issuer, string name, string symbol, uint8 decimals);
    event Minted(uint256 indexed assetId, address indexed to, uint256 amount);
    event Burned(uint256 indexed assetId, address indexed from, uint256 amount);
    event Transferred(uint256 indexed assetId, address indexed from, address indexed to, uint256 amount);
    event IssuerTransferred(uint256 indexed assetId, address indexed oldIssuer, address indexed newIssuer);

    modifier onlyIssuer(uint256 assetId) {
        require(msg.sender == issuerOf[assetId], "E18");
        _;
    }

    // -------------------------------------------------------------------------
    // Asset lifecycle
    // -------------------------------------------------------------------------

    /// @notice Register a new asset with an initial issuer.
    /// @dev    On mainnet this is performed by the Asset Hub registry pallet.
    function registerAsset(
        uint256 assetId,
        address issuer,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external onlyOwner {
        require(issuerOf[assetId] == address(0), "asset exists");
        require(issuer != address(0), "E00");

        issuerOf[assetId] = issuer;
        nameOf[assetId] = name_;
        symbolOf[assetId] = symbol_;
        decimalsOf[assetId] = decimals_;

        emit AssetRegistered(assetId, issuer, name_, symbol_, decimals_);
    }

    /// @notice Transfer issuer rights for an asset. Only the current issuer can call.
    function transferIssuer(uint256 assetId, address newIssuer) external onlyIssuer(assetId) {
        require(newIssuer != address(0), "E00");
        address old = issuerOf[assetId];
        issuerOf[assetId] = newIssuer;
        emit IssuerTransferred(assetId, old, newIssuer);
    }

    // -------------------------------------------------------------------------
    // Balance operations
    // -------------------------------------------------------------------------

    function mint(uint256 assetId, address to, uint256 amount) external onlyIssuer(assetId) {
        require(to != address(0), "E00");
        _totalSupply[assetId] += amount;
        _balances[assetId][to] += amount;
        emit Minted(assetId, to, amount);
    }

    function burn(uint256 assetId, address from, uint256 amount) external onlyIssuer(assetId) {
        require(_balances[assetId][from] >= amount, "E03");
        _balances[assetId][from] -= amount;
        _totalSupply[assetId] -= amount;
        emit Burned(assetId, from, amount);
    }

    /// @notice User-initiated transfer of asset between accounts.
    /// @dev    Caller pays; signature is the caller's authority. No allowance pattern
    ///         on the precompile side — that's an EVM convention layered above.
    function transfer(uint256 assetId, address to, uint256 amount) external {
        require(to != address(0), "E00");
        require(_balances[assetId][msg.sender] >= amount, "E03");
        _balances[assetId][msg.sender] -= amount;
        _balances[assetId][to] += amount;
        emit Transferred(assetId, msg.sender, to, amount);
    }

    // -------------------------------------------------------------------------
    // ERC-20-style allowance + transferFrom (F-026 fix)
    //
    // Asset Hub pallet-assets exposes an approve/transferFrom surface on the
    // EVM precompile side. The mock implements the same shape so DatumWrapper
    // can pull canonical atomically during `wrap`.
    // -------------------------------------------------------------------------

    /// @dev (assetId, owner, spender) → allowance.
    mapping(uint256 => mapping(address => mapping(address => uint256))) private _allowances;

    event Approval(uint256 indexed assetId, address indexed owner, address indexed spender, uint256 amount);

    function approve(uint256 assetId, address spender, uint256 amount) external {
        require(spender != address(0), "E00");
        _allowances[assetId][msg.sender][spender] = amount;
        emit Approval(assetId, msg.sender, spender, amount);
    }

    function allowance(uint256 assetId, address owner, address spender) external view returns (uint256) {
        return _allowances[assetId][owner][spender];
    }

    /// @notice F-026: pull `amount` from `from` to `to`, consuming caller's
    ///         allowance. uint256.max is treated as infinite (no decrement) to
    ///         match ERC-20 convention.
    function transferFrom(uint256 assetId, address from, address to, uint256 amount) external {
        require(from != address(0) && to != address(0), "E00");
        require(_balances[assetId][from] >= amount, "E03");
        uint256 a = _allowances[assetId][from][msg.sender];
        require(a >= amount, "E03");
        if (a != type(uint256).max) {
            _allowances[assetId][from][msg.sender] = a - amount;
        }
        _balances[assetId][from] -= amount;
        _balances[assetId][to] += amount;
        emit Transferred(assetId, from, to, amount);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function balanceOf(uint256 assetId, address who) external view returns (uint256) {
        return _balances[assetId][who];
    }

    function totalSupply(uint256 assetId) external view returns (uint256) {
        return _totalSupply[assetId];
    }
}
