/**
 * The ONE logo — the application's brand mark. ONE is the product; AI8HT is the
 * organisation behind it, which is why the lockup reads "one by ai8ht" and the
 * accessible name is "ONE by AI8HT". Divakar supplied the logo on 2026-09-30
 * (logo/one-logo.png); every file under /assets/one-*.png is derived from it by
 * scripts/brand/make_brand_assets.py, never edited by hand.
 *
 * The master art is brushed silver and blue on a near-black ground, so it comes
 * in two renditions: `dark` (the original metal, for dark bands) and `light`
 * (the silver re-rendered as graphite, the blue kept, for white surfaces). A CSS
 * invert is deliberately not used: inverting metallic, two-colour art turns the
 * blue orange and the highlights into shadows.
 *
 * `compact` shows the "o" mark alone, for collapsed navigation rails. The
 * tagline (LEARN | PREPARE | BUILD | GROW) is drawn onto the sign-in backdrop
 * (/assets/login-background.png), which the same script builds.
 */
import { useSyncExternalStore } from 'react';
import { currentTheme, subscribeTheme } from './themePreference.js';

export type BrandSurface = 'light' | 'dark';

export const BRAND_NAME = 'ONE by AI8HT';

const LOCKUP: Record<BrandSurface, string> = {
  light: '/assets/one-logo-light.png',
  dark: '/assets/one-logo-dark.png',
};

/** The lockups at the source crop's full resolution, for high-density screens and large slots. */
const LOCKUP_HD: Record<BrandSurface, string> = {
  light: '/assets/one-logo-light@2x.webp',
  dark: '/assets/one-logo-dark@2x.webp',
};

const MARK: Record<BrandSurface, string> = {
  light: '/assets/one-mark-light.png',
  dark: '/assets/one-mark-dark.png',
};

export function BrandLogo({ height = 30, surface = 'light', compact = false, className }: {
  readonly height?: number;
  readonly surface?: BrandSurface;
  readonly compact?: boolean;
  readonly className?: string;
}): React.ReactElement {
  // A logo placed on page surfaces (`light`) follows the theme: in the dark theme those
  // surfaces are dark, so it takes the metal rendition drawn for dark grounds.
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light' as const);
  const resolved: BrandSurface = surface === 'light' && theme === 'dark' ? 'dark' : surface;
  return <img
    className={`brand-logo${compact ? ' brand-logo-compact' : ''}${className ? ` ${className}` : ''}`}
    src={compact ? MARK[resolved] : LOCKUP[resolved]}
    srcSet={compact ? undefined : `${LOCKUP[resolved]} 1x, ${LOCKUP_HD[resolved]} 2x`}
    alt={BRAND_NAME}
    draggable={false}
    style={{ height, width: 'auto', display: 'block', flex: '0 0 auto', userSelect: 'none' }}
  />;
}
