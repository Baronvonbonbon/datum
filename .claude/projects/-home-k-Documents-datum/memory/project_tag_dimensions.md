---
name: Tag dimension trimming needed
description: TX-5 tag dictionary should remove or label dimensions that imply user-level data the extension can't provide
type: project
---

TX-5 standard tag dictionary needs trimming before publishing.

**Verifiable dimensions (keep):**
- `topic:*` — publisher content category (self-declared)
- `locale:*` — publisher site language (self-declared)
- `platform:*` — desktop/mobile/tablet (extension can verify via userAgent)
- `audience:*` — publisher-asserted audience type (unverified but reasonable)

**Problematic dimensions (remove or label as unverified publisher claims):**
- `city:*` — extension has no geolocation access, can't verify
- `geo:*` — same issue, publisher self-reported only
- `interest:*` — would require user profiling, contradicts DATUM privacy model

**Why:** Extension runs in browser with no GPS/geolocation permissions, no IP lookup, no user profiling. Targeting is publisher-attribute based, not user-attribute based. Publisher honesty enforced by governance termination + slash economics, not technical verification.

**How to apply:** When implementing TX-5 (standard tag dictionary IPFS JSON), only include verifiable/reasonable dimensions. If geo dimensions are included, clearly mark them as "publisher-asserted, unverified."
