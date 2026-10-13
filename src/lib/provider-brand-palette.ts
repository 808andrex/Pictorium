/**
 * Fixed provider-glass brand palette (client-safe leaf, no imports).
 *
 * The `provider-glass` Card skin tints ONLY its frame/background glass from
 * this fixed 8-provider map — never from sampled logo/artwork pixels. The
 * keys are the canonical `networkKey` values produced by the existing
 * network resolver (`network-svgs.ts:getNetworkKey`): aliases (HBO/Max,
 * Prime/Amazon, NOW/Sky, …) are already canonicalized there, so this module
 * performs NO name matching of its own — strict exact-key lookup only.
 *
 * - `sky` covers both Sky and NOW (same service, the bundled mark is the Now
 *   logo): the approved NOW color.
 * - Unlisted/missing providers (including TMDB logo fallbacks for unknown
 *   networks) use the neutral gray — irrespective of their pixels.
 * - An explicit manual accent (`ac=` query / saved mapping) still wins when
 *   valid (existing public contract); an invalid manual accent is ignored
 *   and the brand lookup applies.
 * - The rank numeral stays neutral crystal (`cardNumeralMaterial` ignores
 *   any accent for `provider-glass`) — this palette never recolors numbers.
 * - `nuvio`/`stremio`/`standard`/`fresh` visuals are untouched: the generic
 *   unresolved-accent fallback (`#555555`) still applies everywhere else.
 */

/** Canonical brand key (exactly the resolver's `networkKey`, lowercase). */
export type ProviderGlassBrandKey =
  | "netflix"
  | "prime"
  | "disney"
  | "hbo"
  | "apple"
  | "paramount"
  | "crunchyroll"
  | "sky"

/** Approved fixed brand colors, keyed by canonical brand key. */
export const PROVIDER_GLASS_BRAND_PALETTE: Readonly<
  Record<ProviderGlassBrandKey, string>
> = {
  netflix: "#E50914",
  prime: "#00A8E1",
  disney: "#176BCA",
  hbo: "#7138E8",
  apple: "#A8ADB5",
  paramount: "#0064FF",
  crunchyroll: "#F47521",
  sky: "#00D98B",
} as const

/** Neutral glass for unlisted/missing providers (provider-glass only). */
export const PROVIDER_GLASS_NEUTRAL_ACCENT = "#707780"

/** Strict `#rrggbb` check (local: this leaf must stay dependency-free). */
function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
}

/** True only for an exact canonical brand key (no aliasing, no coercion). */
export function isProviderGlassBrandKey(
  value: unknown,
): value is ProviderGlassBrandKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PROVIDER_GLASS_BRAND_PALETTE, value)
  )
}

/**
 * Fixed brand hex for a canonical brand key, or null when the key is not
 * one of the 8 approved brands (unlisted/TMDB-fallback/missing/malformed —
 * never a guess, never raw caller text).
 */
export function resolveProviderGlassBrandHex(
  networkKey: unknown,
): string | null {
  if (!isProviderGlassBrandKey(networkKey)) return null
  return PROVIDER_GLASS_BRAND_PALETTE[networkKey]
}

/**
 * Effective provider-glass accent: an explicit manual accent wins when it
 * is a valid `#rrggbb` hex (existing `ac=`/mapping contract); otherwise
 * the fixed brand lookup applies. Returns null when neither applies —
 * the caller renders the documented neutral glass. Never samples pixels,
 * never throws, never invents a brand color.
 */
export function resolveProviderGlassAccent(
  networkKey: unknown,
  accentOverride: { genreColor: string; rankColor: string } | null | undefined,
): string | null {
  if (accentOverride && isHexColor(accentOverride.genreColor))
    return accentOverride.genreColor
  return resolveProviderGlassBrandHex(networkKey)
}
