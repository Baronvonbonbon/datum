// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "../DatumOwnable.sol";

interface IDatumMintAuthority_Bootstrap {
    function mintForBootstrap(address user, uint256 amount) external;
}

interface IDatumCampaigns_BootstrapView {
    function getCampaignAssuranceLevel(uint256 campaignId) external view returns (uint8);
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

    /// @notice M3-fix: the Campaigns contract for AssuranceLevel verification.
    ///         Lock-once wiring so a hostile owner can't swap to a permissive
    ///         lookup that always returns L2.
    IDatumCampaigns_BootstrapView public campaigns;

    /// @notice M3-fix: minimum AssuranceLevel the house-ad campaign must have
    ///         configured for `claim` to dispense. Defaults to 1 (publisher
    ///         cosig required), hard-floor at 1 — owner can only raise.
    ///
    ///         Rationale: bootstrap is settlement-gated, so a Sybil's cost is
    ///         the cost of producing a valid settlement against the house-ad
    ///         campaign. If house-ad is L0, fresh EOAs drain the pool. The
    ///         L1 floor pushes Sybil cost up to "must produce valid publisher
    ///         cosig," which composes with publisher staking.
    uint8 public minHouseAdAssuranceLevel = 1;
    uint8 public constant MIN_HOUSE_AD_ASSURANCE_FLOOR = 1;

    event BootstrapClaimed(address indexed user, uint256 amount, uint256 remaining);
    event BootstrapPerAddressUpdated(uint256 oldAmount, uint256 newAmount);
    event PoolDepleted();
    event CampaignsSet(address indexed campaigns);
    event MinHouseAdAssuranceLevelSet(uint8 newLevel);
    event BootstrapRefusedAssurance(address indexed user, uint256 indexed campaignId, uint8 level);

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
    ///         received the bonus, the pool is depleted, or the house-ad
    ///         campaign's AssuranceLevel is below the floor (M3-fix).
    ///         Never reverts so that the broader settlement flow isn't disrupted.
    /// @param  user        Bootstrap recipient.
    /// @param  campaignId  The house-ad campaign this bootstrap is settling against.
    /// @return paid The amount actually paid (0 if not eligible / depleted / under-assured).
    function claim(address user, uint256 campaignId) external returns (uint256 paid) {
        require(msg.sender == settlement, "E18");
        if (user == address(0))                  return 0;
        if (hasReceivedBootstrap[user])          return 0;
        if (bootstrapRemaining < bootstrapPerAddress) return 0;

        // M3-fix: refuse to dispense if the house-ad campaign isn't at the
        // minimum AssuranceLevel. Fail closed on unreadable level so a
        // mis-wired Campaigns ref can't bypass the Sybil floor.
        if (address(campaigns) == address(0)) {
            emit BootstrapRefusedAssurance(user, campaignId, 0);
            return 0;
        }
        uint8 level = 0;
        try campaigns.getCampaignAssuranceLevel(campaignId) returns (uint8 l) {
            level = l;
        } catch {
            emit BootstrapRefusedAssurance(user, campaignId, 0);
            return 0;
        }
        if (level < minHouseAdAssuranceLevel) {
            emit BootstrapRefusedAssurance(user, campaignId, level);
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

    /// @notice M3-fix: lock-once wiring for the Campaigns AssuranceLevel reader.
    function setCampaigns(address _campaigns) external onlyOwner {
        require(_campaigns != address(0), "E00");
        require(address(campaigns) == address(0), "already set");
        campaigns = IDatumCampaigns_BootstrapView(_campaigns);
        emit CampaignsSet(_campaigns);
    }

    /// @notice M3-fix: raise (only) the minimum AssuranceLevel for bootstrap
    ///         dispense. Hard floor at MIN_HOUSE_AD_ASSURANCE_FLOOR — owner
    ///         cannot relax below it.
    function setMinHouseAdAssuranceLevel(uint8 newLevel) external onlyOwner {
        require(newLevel >= MIN_HOUSE_AD_ASSURANCE_FLOOR, "below floor");
        require(newLevel <= 3, "above max");
        require(newLevel >= minHouseAdAssuranceLevel, "monotonic-up only");
        minHouseAdAssuranceLevel = newLevel;
        emit MinHouseAdAssuranceLevelSet(newLevel);
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
