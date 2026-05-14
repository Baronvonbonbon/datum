# DatumTagCurator

Sibling of `DatumCouncilBlocklistCurator`, but for taxonomy tags rather
than addresses. Plugs into `DatumCampaigns.setTagCurator(this)`, then the
Council drives `approveTag(bytes32)` / `removeTag(bytes32)` via standard
council proposals.

## What "tags" are

Tag-based targeting (alpha-3 TX-1) replaced the older 256-bit category
bitmask. Each tag is a `bytes32` identifier (typically `keccak256(name)`)
representing a topic, audience demographic, content category, etc.
Publishers self-declare a tag set on their site (`setPublisherTags`).
Campaigns declare a `requiredTags[]` set. Settlement-time matching:
publisher's tags must be a superset of the campaign's required tags.

The curator gatekeeper exists because *adding new tags to the taxonomy*
is a governance act. Random publishers shouldn't be able to mint
`keccak256("Premium Crypto Trading Audience")` into the namespace as a
free way to attract higher-paying campaigns. So tags must be approved.

## OR-merge with local approvedTags

`DatumCampaigns` keeps a `mapping(bytes32 => bool) approvedTags` for
direct owner-approved tags AND consults the curator. A tag is valid if
*either* path approves it. This dual path is useful for:

- Bootstrap (curator not yet wired → owner-approved set works).
- Hybrid (curator is the default, owner can hot-add specialty tags).
- Migration (deployer adds a new curator without immediately re-approving
  every existing tag).

## Lock pattern

Same as the blocklist curator:

- `setCouncil(newCouncil)` — owner sets the council address that may
  approve/remove tags.
- `lockCouncil()` — irreversibly freezes the council pointer.

Once locked, even the Timelock cannot redirect the tag authority.

## Why a separate curator from the blocklist one

They could share a curator since the council is the same, but the API
shapes differ:

- Blocklist: `block(addr, reasonHash)`, `unblock(addr)`, `isBlocked(addr)`.
- TagCurator: `approveTag(bytes32)`, `removeTag(bytes32)`, `isApproved(bytes32)`.

Mashing them together would force one of them into an awkward interface.
Separate curators with separate council pointers (which happen to point at
the same Council contract today) is cleaner and keeps the interface
clean for future swaps.

## Why governance approves tags at all

Without curation, the tag namespace becomes a free-for-all. Publishers
declare wildly inflated topics, advertisers target them, claims settle
with no real attention match. The curated taxonomy is a soft Schelling
point: agreed-upon tags are the ones high-quality campaigns reference,
and publishers can self-rank by which ones they declare.

The protocol could in principle have no taxonomy at all and let
campaigns/publishers settle their own terms via off-chain agreements.
That was the alpha-2 design. Alpha-3 added tags because operators wanted
on-chain targeting rules; alpha-4 added the curator because operators
wanted the tag set itself to be governable.
