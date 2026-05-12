// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PaseoSafeSender
/// @notice Native-DOT transfer helper that sidesteps the Paseo eth-rpc
///         denomination bug: the gateway rejects any payable call where
///         `value % 10^6 >= 500_000`. Half of all otherwise-valid amounts
///         hit this and revert at submission, locking funds in the sender.
///
///         Two-part strategy:
///           1. If the requested amount happens to be in the accepted range
///              (`value % 10^6 < 500_000`) we send it verbatim.
///           2. Otherwise we round down to the nearest 10^6 planck, send
///              that, and stash the remainder in `pendingPaseoDust[to]`.
///              The recipient pulls accumulated dust later via `claimPaseoDust`.
///
///         Recipients never lose value — every fraction is recoverable. The
///         worst case is a per-recipient ~999,999-planck (≈0.0001 DOT) lag
///         until they bother to pull dust.
///
/// @dev    Inheriting contracts replace their `(bool ok,) = to.call{value:}("")`
///         pattern with `_safeSend(to, amount)`. The `claimPaseoDust*`
///         externals live on the inheriting contract via this base — each
///         contract keeps its own dust pool.
abstract contract PaseoSafeSender is ReentrancyGuard {
    /// @notice The denomination floor enforced by Paseo eth-rpc. Values
    ///         below 500_000 planck of the trailing 10^6 are accepted; the
    ///         upper half is rejected. We round down to the nearest 10^6
    ///         whenever the amount falls in the rejected band.
    uint256 internal constant PASEO_UNIT = 10**6;
    uint256 internal constant PASEO_REJECT_THRESHOLD = 500_000;

    mapping(address => uint256) public pendingPaseoDust;

    event PaseoDustQueued(address indexed recipient, uint256 dust, uint256 totalPending);
    event PaseoDustClaimed(address indexed recipient, address indexed to, uint256 amount);

    /// @dev Send `amount` native to `to` while never tripping the eth-rpc
    ///      rounding bug. Any remainder is queued in `pendingPaseoDust`.
    function _safeSend(address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 sendable = _cleanAmount(amount);
        uint256 dust = amount - sendable;
        if (dust > 0) {
            pendingPaseoDust[to] += dust;
            emit PaseoDustQueued(to, dust, pendingPaseoDust[to]);
        }
        if (sendable > 0) {
            (bool ok,) = payable(to).call{value: sendable}("");
            require(ok, "E02");
        }
    }

    /// @notice Pull accumulated Paseo dust to self.
    function claimPaseoDust() external nonReentrant {
        _claimPaseoDust(msg.sender);
    }

    /// @notice Pull accumulated Paseo dust to a chosen recipient (cold wallet).
    function claimPaseoDustTo(address recipient) external nonReentrant {
        require(recipient != address(0), "E00");
        _claimPaseoDust(recipient);
    }

    function _claimPaseoDust(address recipient) internal {
        uint256 d = pendingPaseoDust[msg.sender];
        require(d > 0, "E03");
        uint256 sendable = _cleanAmount(d);
        require(sendable > 0, "E58"); // dust below paseo-acceptable threshold
        pendingPaseoDust[msg.sender] = d - sendable;
        emit PaseoDustClaimed(msg.sender, recipient, sendable);
        (bool ok,) = payable(recipient).call{value: sendable}("");
        require(ok, "E02");
    }

    /// @dev Return the largest amount ≤ `amount` that Paseo eth-rpc will accept.
    function _cleanAmount(uint256 amount) internal pure returns (uint256) {
        uint256 trailing = amount % PASEO_UNIT;
        if (trailing < PASEO_REJECT_THRESHOLD) return amount; // already accepted
        return amount - trailing;                              // round down to multiple of 10^6
    }
}
