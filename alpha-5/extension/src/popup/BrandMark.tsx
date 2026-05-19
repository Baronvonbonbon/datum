/**
 * DATUM brand mark — corner-bracket reticle framing a Polkadot-pink dot.
 * Mirrors the inline SVG used by the SDK's house ads (sdk/datum-sdk.js → brandSvg).
 * Brackets use `currentColor` so callers can tint via `color`; dot is fixed pink.
 */
export function BrandMark({ size = 16, dotColor = "#E6007A" }: { size?: number; dotColor?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path
        d="M2 5 L2 2 L5 2 M11 2 L14 2 L14 5 M14 11 L14 14 L11 14 M5 14 L2 14 L2 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.6" fill={dotColor} />
    </svg>
  );
}
