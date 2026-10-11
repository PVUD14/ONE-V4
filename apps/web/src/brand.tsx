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
export type BrandSurface = 'light' | 'dark';

export const BRAND_NAME = 'ONE by AI8HT';

const LOCKUP: Record<BrandSurface, string> = {
  light: '/assets/one-logo-light.png',
  dark: '/assets/one-logo-dark.png',
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
  return <img
    className={`brand-logo${compact ? ' brand-logo-compact' : ''}${className ? ` ${className}` : ''}`}
    src={compact ? MARK[surface] : LOCKUP[surface]}
    alt={BRAND_NAME}
    draggable={false}
    style={{ height, width: 'auto', display: 'block', flex: '0 0 auto', userSelect: 'none' }}
  />;
}
