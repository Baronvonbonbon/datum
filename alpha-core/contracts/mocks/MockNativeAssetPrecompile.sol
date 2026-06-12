// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title  MockNativeAssetPrecompile
/// @notice Faithful test double of a Polkadot Hub `pallet_assets` ERC-20
///         precompile (the per-asset `0120`/`0220`/`0320` precompiles).
///
///         Per the Polkadot Hub docs, the assets ERC-20 precompile implements
///         ONLY the core surface — `totalSupply / balanceOf / allowance /
///         transfer / approve / transferFrom` (all returning bool) — and
///         deliberately does **NOT** implement the optional metadata
///         (`decimals / name / symbol`), which live in the Assets pallet, not
///         the precompile. This mock mirrors that exactly so we can verify the
///         sidecar's asset gate + credit path against a native-asset-shaped
///         token, not a textbook ERC-20.
///
///         `mint` stands in for the Assets-pallet issuance an admin performs
///         off the EVM, so tests/scripts can seed balances. The real precompile
///         has no mint() — issuance is a substrate extrinsic.
contract MockNativeAssetPrecompile {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _total;
    address public immutable admin;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() { admin = msg.sender; }

    // ── Core ERC-20 surface (the only functions the precompile exposes) ──────
    function totalSupply() external view returns (uint256) { return _total; }
    function balanceOf(address a) external view returns (uint256) { return _balances[a]; }
    function allowance(address o, address s) external view returns (uint256) { return _allowances[o][s]; }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = _allowances[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) _allowances[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    // ── Test-only issuance (stands in for the Assets pallet) ─────────────────
    function mint(address to, uint256 amount) external {
        require(msg.sender == admin, "admin");
        _balances[to] += amount;
        _total += amount;
        emit Transfer(address(0), to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }

    // NOTE: intentionally NO decimals() / name() / symbol() — matches the real
    // assets ERC-20 precompile (metadata is Assets-pallet-only).
}
