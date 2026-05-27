// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import "./DatumUpgradable.sol";

/// @title  DatumBrandRegistry
/// @notice Per-address brand profile — the "hot fields" layer of the
///         two-layer profile design (see `project_brand_profiles.md`).
///         Holds name, logo CID, homepage, brand color, and a pointer to
///         a long-tail off-chain JSON. Self-only writes — every address
///         is its own brand admin. Standalone; no protocol wiring.
///
/// @dev    Storage shape kept narrow on purpose:
///           - `name` capped at 32 bytes so it fits in a single slot.
///           - `homepage` capped at 128 bytes (1 slot + a bit) — the
///             advertiser/publisher web display only ever shows host
///             + path-prefix, so this is plenty.
///           - `logoCid` is a raw 32-byte IPFS CIDv1 digest. The codec
///             is implied (PNG/JPG/WEBP); the frontend validates the
///             actual bytes on fetch.
///           - `brandColor` is a 24-bit RRGGBB packed in a uint24. 0 =
///             default theme.
///           - `profileHash` is the pointer to the long-tail JSON for
///             description/socials/address book. Same convention as
///             DatumPublishers.profileHash — re-used so existing
///             publisher off-chain JSON works for the new brand layer
///             without migration.
///
/// @dev    Verification is rendered at view-time; this contract holds
///         only the self-declared layer. Higher tiers (domain-verify,
///         People Chain, Council) layer on top via separate reads:
///           - Domain: UI fetches /.well-known/datum-verify.json.
///           - People Chain: UI calls DatumPeopleChainIdentity.isVerified.
///           - Council: UI calls DatumBrandCurator.isApproved.
contract DatumBrandRegistry is DatumUpgradable {
    /// @notice Upgrade ladder version.
    function version() public pure override returns (uint256) { return 1; }

    // ─────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────

    struct BrandProfile {
        // Display fields — load on every chip render.
        string  name;          // <= 32 bytes; ASCII recommended
        bytes32 logoCid;       // IPFS CIDv1 raw 32-byte digest; image expected
        string  homepage;      // <= 128 bytes; SHOULD start with https://
        uint24  brandColor;    // 0xRRGGBB; 0 = use UI default

        // Long-tail pointer — for description, socials, additional addresses,
        // optional OG snapshot. Same shape as DatumPublishers.profileHash.
        bytes32 profileHash;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Per-address brand. Default value (empty strings, zero hashes)
    ///         is the "unregistered" state — clients render an identicon.
    mapping(address => BrandProfile) internal _brands;

    /// @notice Per-name uniqueness lookup. Optional soft constraint: enforces
    ///         that a display name maps to at most one address. Cleared when
    ///         the name is changed away from. Name == "" is never owned.
    mapping(bytes32 => address) public nameOwner;

    /// @notice Per-address: block number of the last brand update. Used by
    ///         the UI to render "updated N blocks ago" + by anti-fraud
    ///         checks to detect a sudden brand swap.
    mapping(address => uint256) public lastUpdateBlock;

    // ─────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────

    error NameTooLong();        // name > 32 bytes
    error HomepageTooLong();    // homepage > 128 bytes
    error HomepageScheme();     // homepage didn't start with "https://"
    error NameTaken();          // another address already owns this name

    // ─────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────

    event BrandSet(
        address indexed addr,
        string name,
        bytes32 logoCid,
        string homepage,
        uint24 brandColor,
        bytes32 profileHash
    );
    event BrandCleared(address indexed addr);

    // ─────────────────────────────────────────────────────────────────────
    // Writes
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Set the calling address's brand. Replaces any prior brand.
    ///         Passing the zero values for every field deletes the brand.
    /// @param name           Display name; <= 32 bytes. Empty allowed.
    /// @param logoCid        IPFS CIDv1 raw 32-byte digest of the logo. Zero allowed.
    /// @param homepage       <= 128 bytes; must start with "https://" if non-empty.
    /// @param brandColor     uint24 RRGGBB. Zero allowed.
    /// @param profileHash    bytes32 pointer to long-tail JSON. Zero allowed.
    function setBrand(
        string calldata name,
        bytes32 logoCid,
        string calldata homepage,
        uint24 brandColor,
        bytes32 profileHash
    ) external whenNotFrozen {
        bytes memory nameBytes = bytes(name);
        if (nameBytes.length > 32) revert NameTooLong();

        bytes memory hpBytes = bytes(homepage);
        if (hpBytes.length > 128) revert HomepageTooLong();
        if (hpBytes.length > 0 && !_startsWithHttps(hpBytes)) revert HomepageScheme();

        // Soft name-uniqueness. Allows the same address to keep its own
        // name across updates; allows transferring the name by clearing
        // it on the old address first (the new owner will see NameTaken
        // until that happens).
        bytes32 nameHash = nameBytes.length == 0 ? bytes32(0) : keccak256(nameBytes);
        if (nameHash != bytes32(0)) {
            address current = nameOwner[nameHash];
            if (current != address(0) && current != msg.sender) revert NameTaken();
        }

        // Clear the old name → owner mapping if the name is changing.
        BrandProfile storage prev = _brands[msg.sender];
        bytes memory prevName = bytes(prev.name);
        if (prevName.length > 0) {
            bytes32 prevNameHash = keccak256(prevName);
            if (prevNameHash != nameHash) {
                nameOwner[prevNameHash] = address(0);
            }
        }
        if (nameHash != bytes32(0)) {
            nameOwner[nameHash] = msg.sender;
        }

        prev.name = name;
        prev.logoCid = logoCid;
        prev.homepage = homepage;
        prev.brandColor = brandColor;
        prev.profileHash = profileHash;

        lastUpdateBlock[msg.sender] = block.number;

        emit BrandSet(msg.sender, name, logoCid, homepage, brandColor, profileHash);
    }

    /// @notice Convenience: clear your brand entirely. Equivalent to
    ///         setBrand("", 0, "", 0, 0).
    function clearBrand() external whenNotFrozen {
        BrandProfile storage prev = _brands[msg.sender];
        bytes memory prevName = bytes(prev.name);
        if (prevName.length > 0) {
            nameOwner[keccak256(prevName)] = address(0);
        }
        delete _brands[msg.sender];
        lastUpdateBlock[msg.sender] = block.number;
        emit BrandCleared(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Reads
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Read a brand by address. Returns the empty profile (zero
    ///         fields) when the address is unregistered.
    function getBrand(address addr) external view returns (BrandProfile memory) {
        return _brands[addr];
    }

    /// @notice Convenience tuple read — keeps gas low when the caller only
    ///         needs the display fields (a common chip-render path).
    function getBrandHotFields(address addr)
        external
        view
        returns (string memory name, bytes32 logoCid, string memory homepage, uint24 brandColor)
    {
        BrandProfile storage b = _brands[addr];
        return (b.name, b.logoCid, b.homepage, b.brandColor);
    }

    /// @notice Has a brand been registered (any field set)?
    function isRegistered(address addr) external view returns (bool) {
        BrandProfile storage b = _brands[addr];
        return bytes(b.name).length > 0
            || b.logoCid != bytes32(0)
            || bytes(b.homepage).length > 0
            || b.profileHash != bytes32(0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    /// @dev Strict prefix check for "https://" (8 bytes). Avoids importing
    ///      OpenZeppelin Strings for one helper. Case-sensitive — the
    ///      scheme is lowercase by RFC convention and we don't need to be
    ///      lenient here.
    function _startsWithHttps(bytes memory s) internal pure returns (bool) {
        if (s.length < 8) return false;
        return s[0] == "h" && s[1] == "t" && s[2] == "t" && s[3] == "p"
            && s[4] == "s" && s[5] == ":" && s[6] == "/" && s[7] == "/";
    }
}
