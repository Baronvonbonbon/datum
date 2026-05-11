// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "../DatumOwnable.sol";

interface IDatumMintAuthority_Bootstrap {
    function mintForBootstrap(address user, uint256 amount) external;
}

/// @title DatumBootstrapPool
/// @notice One-time-per-address WDATUM dispenser for the house-ad onboarding.
///
///         Bootstraps initial circulating supply by giving each new user a
///         small WDATUM grant on their first qualifying engagement with the
///         protocol's house ad campaign.
///
///         Distribution is bounded: BOOTSTRAP_RESERVE is set at deploy and
///         cannot be topped up. When the pool depletes, the dispenser
///         silently stops paying; the house ad campaign reverts to its
///         non-paying fallback role.
///
/// @dev    Per the TOKENOMICS §3.9 design, this contract is called by
///         DatumSettlement when a claim against the reserved house-ad
///         campaign settles. Owner is the founder multisig at deploy,
///         transitioning to Council via the standard sunset path.
contract DatumBootstrapPool is DatumOwnable {

    /// @notice Total WDATUM reserved for the house-ad bootstrap.
    /// @dev    BAKED at deploy. No top-up function exists.
    uint256 public constant BOOTSTRAP_RESERVE = 1_000_000 * 10**10;  // 1M DATUM

    /// @notice The single contract permitted to trigger a bootstrap mint.
    address public immutable settlement;

    /// @notice Mint authority — bridges to canonical asset on Asset Hub.
    address public immutable mintAuthority;

    /// @notice Per-address bonus. Governance-tunable within bounds [MIN, MAX].
    uint256 public bootstrapPerAddress = 3 * 10**10;  // 3 DATUM (Variant B)
    uint256 public constant BOOTSTRAP_PER_ADDRESS_MIN = 1  * 10**10;
    uint256 public constant BOOTSTRAP_PER_ADDRESS_MAX = 10 * 10**10;

    /// @notice WDATUM remaining in the pool. Depletes as bonuses pay out.
    uint256 public bootstrapRemaining = BOOTSTRAP_RESERVE;

    /// @notice One-time gate per recipient.
    mapping(address => bool) public hasReceivedBootstrap;

    event BootstrapClaimed(address indexed user, uint256 amount, uint256 remaining);
    event BootstrapPerAddressUpdated(uint256 oldAmount, uint256 newAmount);
    event PoolDepleted();

    constructor(address _settlement, address _mintAuthority) {
        require(_settlement != address(0), "E00");
        require(_mintAuthority != address(0), "E00");
        settlement = _settlement;
        mintAuthority = _mintAuthority;
    }

    // -------------------------------------------------------------------------
    // Claim — called by settlement on house-ad campaign settlement
    // -------------------------------------------------------------------------

    /// @notice Dispense the bootstrap bonus to a recipient.
    /// @dev    Settlement-gated. Silent no-op if the recipient has already
    ///         received the bonus or the pool is depleted — never reverts so
    ///         that the broader settlement flow isn't disrupted.
    /// @return paid The amount actually paid (0 if not eligible / depleted).
    function claim(address user) external returns (uint256 paid) {
        require(msg.sender == settlement, "E18");
        if (user == address(0))                  return 0;
        if (hasReceivedBootstrap[user])          return 0;
        if (bootstrapRemaining < bootstrapPerAddress) {
            // Pool depleted (or insufficient for one more grant).
            // Emit on the transition (when it first goes empty).
            if (bootstrapRemaining > 0) {
                // Edge case: dust below the per-address minimum. Silently bypass.
            }
            return 0;
        }

        hasReceivedBootstrap[user] = true;
        bootstrapRemaining -= bootstrapPerAddress;
        paid = bootstrapPerAddress;

        IDatumMintAuthority_Bootstrap(mintAuthority).mintForBootstrap(user, paid);

        emit BootstrapClaimed(user, paid, bootstrapRemaining);
        if (bootstrapRemaining < bootstrapPerAddress) {
            emit PoolDepleted();
        }
    }

    // -------------------------------------------------------------------------
    // Governance
    // -------------------------------------------------------------------------

    /// @notice Adjust the per-address bonus within hard limits.
    function setBootstrapPerAddress(uint256 newAmount) external onlyOwner {
        require(newAmount >= BOOTSTRAP_PER_ADDRESS_MIN, "below min");
        require(newAmount <= BOOTSTRAP_PER_ADDRESS_MAX, "above max");
        uint256 old = bootstrapPerAddress;
        bootstrapPerAddress = newAmount;
        emit BootstrapPerAddressUpdated(old, newAmount);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function isExhausted() external view returns (bool) {
        return bootstrapRemaining < bootstrapPerAddress;
    }

    function estimatedRecipientsRemaining() external view returns (uint256) {
        if (bootstrapPerAddress == 0) return 0;
        return bootstrapRemaining / bootstrapPerAddress;
    }
}
