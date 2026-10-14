/**
 * The ONE logo — the application's brand mark, and the one component that renders it.
 * ONE is the product; AI8HT is the organisation behind it, which is why the lockup reads
 * "one by ai8ht" and the accessible name is "ONE by AI8HT".
 *
 * The artwork is the approved vector set (design inventory 05-brand/logo-vector and
 * 05-brand/svg, copied into /brand/), chosen by the width of the slot it fills:
 *  - the full lockup with the "by ai8ht" byline at 140px wide and more;
 *  - the "one"-only wordmark from 56px up to that (icon rail, mobile header), because the
 *    byline stops reading below 140px;
 *  - the lens mark alone below 56px (collapsed rails), in its small optical size below 48px.
 * Each comes drawn for a light surface (graphite letters) and a dark one (chrome letters); a
 * CSS invert is not used, because inverting the two-colour metal art turns the blue orange.
 *
 * Clear space is half the lens height on every side, kept as margin on the image. Product
 * chrome (rails, top bars, sidebars) is dense, where the guide allows half of that.
 */
import { useSyncExternalStore } from 'react';
import { currentTheme, subscribeTheme } from './themePreference.js';

export type BrandSurface = 'light' | 'dark';
export type BrandArtwork = 'lockup' | 'wordmark' | 'lens' | 'lens-small';

export const BRAND_NAME = 'ONE by AI8HT';

/** Width ÷ height of each artwork (from the SVG viewBoxes). */
export const BRAND_ASPECT: Record<BrandArtwork, number> = {
  lockup: 521 / 236,
  wordmark: 521 / 189,
  lens: 1,
  'lens-small': 1,
};

/** Share of the artwork's height taken by the lens "o" (lockup ≈ 76%, wordmark ≈ 95%). */
const LENS_SHARE: Record<BrandArtwork, number> = { lockup: 0.76, wordmark: 0.95, lens: 0.8, 'lens-small': 0.8 };

export const LOCKUP_MIN_WIDTH = 140;
export const WORDMARK_MIN_WIDTH = 56;
const LENS_DETAIL_MIN = 48;

const FILES: Record<BrandArtwork, Record<BrandSurface, string>> = {
  lockup: { light: '/brand/one-lockup-full-color-on-light.svg', dark: '/brand/one-lockup-full-color-on-dark.svg' },
  wordmark: { light: '/brand/one-wordmark-full-color-on-light.svg', dark: '/brand/one-wordmark-full-color-on-dark.svg' },
  lens: { light: '/brand/lens-mark-on-light.svg', dark: '/brand/lens-mark-on-dark.svg' },
  'lens-small': { light: '/brand/lens-mark-small-on-light.svg', dark: '/brand/lens-mark-small-on-dark.svg' },
};

const round = (value: number): number => Math.round(value * 10) / 10;

/** The artwork the size rule picks for a slot this many pixels wide. */
export function brandArtworkForWidth(width: number): BrandArtwork {
  if (width >= LOCKUP_MIN_WIDTH) return 'lockup';
  if (width >= WORDMARK_MIN_WIDTH) return 'wordmark';
  return width >= LENS_DETAIL_MIN ? 'lens' : 'lens-small';
}

/** The file for an artwork on a surface. */
export function brandSource(artwork: BrandArtwork, surface: BrandSurface): string {
  return FILES[artwork][surface];
}

/** Clear space around the artwork: half the lens height, or half of that in dense chrome. */
export function brandClearSpace(artwork: BrandArtwork, height: number, dense: boolean): number {
  const x = (LENS_SHARE[artwork] * height) / 2;
  return round(dense ? x / 2 : x);
}

/**
 * Size by `width` (the slot the logo fills). `height` is still accepted and is read as the
 * lockup's height; `compact` asks for the lens mark. Both exist so older call sites keep
 * working; whichever is given, the artwork still follows the size rule.
 */
function resolveSize({ width, height, compact }: { readonly width?: number | undefined; readonly height?: number | undefined; readonly compact: boolean }): { readonly artwork: BrandArtwork; readonly width: number; readonly height: number } {
  if (compact) {
    const side = Math.min(width ?? height ?? 40, WORDMARK_MIN_WIDTH - 1);
    return { artwork: side >= LENS_DETAIL_MIN ? 'lens' : 'lens-small', width: side, height: side };
  }
  if (width !== undefined) {
    const artwork = brandArtworkForWidth(width);
    return { artwork, width, height: round(width / BRAND_ASPECT[artwork]) };
  }
  const h = height ?? 30;
  const lockupWidth = h * BRAND_ASPECT.lockup;
  if (lockupWidth >= LOCKUP_MIN_WIDTH) return { artwork: 'lockup', width: round(lockupWidth), height: h };
  const wordmarkWidth = h * BRAND_ASPECT.wordmark;
  if (wordmarkWidth >= WORDMARK_MIN_WIDTH) return { artwork: 'wordmark', width: round(wordmarkWidth), height: h };
  return { artwork: h >= LENS_DETAIL_MIN ? 'lens' : 'lens-small', width: h, height: h };
}

export function BrandLogo({ width, height, surface = 'light', compact = false, clearSpace = 'dense', className }: {
  /** The slot width in CSS pixels; the artwork follows the size rule. */
  readonly width?: number;
  /** Legacy: the lockup height. Prefer `width`. */
  readonly height?: number;
  /** `light` follows the theme (page surfaces turn dark in the dark theme); `dark` is fixed. */
  readonly surface?: BrandSurface;
  /** The lens mark alone (collapsed rails). */
  readonly compact?: boolean;
  /** `full` keeps half the lens height clear on every side; `dense` (chrome) half that; `none` leaves it to the slot. */
  readonly clearSpace?: 'full' | 'dense' | 'none';
  readonly className?: string;
}): React.ReactElement {
  // A logo placed on page surfaces (`light`) follows the theme: in the dark theme those
  // surfaces are dark, so it takes the chrome rendition drawn for dark grounds.
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light' as const);
  const resolved: BrandSurface = surface === 'light' && theme === 'dark' ? 'dark' : surface;
  const size = resolveSize({ width, height, compact });
  const margin = clearSpace === 'none' ? undefined : brandClearSpace(size.artwork, size.height, clearSpace === 'dense');
  return <img
    className={`brand-logo brand-logo-${size.artwork}${className ? ` ${className}` : ''}`}
    src={brandSource(size.artwork, resolved)}
    alt={BRAND_NAME}
    width={size.width}
    height={size.height}
    data-artwork={size.artwork}
    draggable={false}
    style={{ width: size.width, height: size.height, margin, display: 'block', flex: '0 0 auto', userSelect: 'none' }}
  />;
}

/** The name the repository rules use for the brand component; it is the same component. */
export const BrandWordmark = BrandLogo;
