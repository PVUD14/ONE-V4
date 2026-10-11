/**
 * brand.test.tsx - the ONE logo component. The brand is the approved vector set (lockup,
 * "one"-only wordmark, lens mark), chosen by the width of the slot. These tests pin the
 * accessible name, the size rule (lockup at 140px and up, wordmark down to 56px, lens below),
 * the surface renditions and the clear space, so a later edit cannot quietly fall back to text,
 * initials, a raster logo or the retired AI8HT wordmark.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_NAME, BrandLogo, BrandWordmark, brandArtworkForWidth, brandClearSpace } from './brand.js';

afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-theme'); });

const logo = (): HTMLElement => screen.getByRole('img', { name: 'ONE by AI8HT' });

describe('BrandLogo', () => {
  it('renders the vector lockup named "ONE by AI8HT" at 140px and wider', () => {
    render(<BrandLogo width={160} />);
    expect(BRAND_NAME).toBe('ONE by AI8HT');
    expect(logo()).toHaveAttribute('src', '/brand/one-lockup-full-color-on-light.svg');
    expect(logo()).toHaveAttribute('data-artwork', 'lockup');
    expect(logo()).toHaveStyle({ width: '160px', height: '72.5px' });
  });

  it('switches to the "one"-only wordmark below 140px, down to 56px', () => {
    const { rerender } = render(<BrandLogo width={139} />);
    expect(logo()).toHaveAttribute('src', '/brand/one-wordmark-full-color-on-light.svg');
    rerender(<BrandLogo width={56} />);
    expect(logo()).toHaveAttribute('data-artwork', 'wordmark');
  });

  it('uses the lens mark alone below 56px, in its small optical size below 48px', () => {
    const { rerender } = render(<BrandLogo width={52} />);
    expect(logo()).toHaveAttribute('src', '/brand/lens-mark-on-light.svg');
    rerender(<BrandLogo width={40} />);
    expect(logo()).toHaveAttribute('src', '/brand/lens-mark-small-on-light.svg');
    rerender(<BrandLogo width={96} compact />);
    expect(logo()).toHaveAttribute('data-artwork', 'lens');
  });

  it('keeps the size rule when an older call site passes a height', () => {
    const { rerender } = render(<BrandLogo height={72} />);
    expect(logo()).toHaveAttribute('data-artwork', 'lockup');
    rerender(<BrandLogo height={30} />);
    expect(logo()).toHaveAttribute('data-artwork', 'wordmark');
  });

  it('uses the chrome rendition on dark surfaces and follows the dark theme on page surfaces', () => {
    const { rerender } = render(<BrandLogo width={190} surface="dark" />);
    expect(logo()).toHaveAttribute('src', '/brand/one-lockup-full-color-on-dark.svg');
    document.documentElement.setAttribute('data-theme', 'dark');
    rerender(<BrandLogo width={64} />);
    expect(logo()).toHaveAttribute('src', '/brand/one-wordmark-full-color-on-dark.svg');
  });

  it('keeps clear space of half the lens height, halved again in dense chrome', () => {
    expect(brandClearSpace('lockup', 100, false)).toBe(38);
    expect(brandClearSpace('lockup', 100, true)).toBe(19);
    render(<BrandLogo width={221} clearSpace="full" />);
    expect(logo()).toHaveStyle({ margin: '38px' });
  });

  it('picks artwork by width exactly at the published minimums', () => {
    expect(brandArtworkForWidth(140)).toBe('lockup');
    expect(brandArtworkForWidth(139.9)).toBe('wordmark');
    expect(brandArtworkForWidth(56)).toBe('wordmark');
    expect(brandArtworkForWidth(55)).toBe('lens');
    expect(brandArtworkForWidth(47)).toBe('lens-small');
  });

  it('is the same component under the name the repository rules use', () => {
    expect(BrandWordmark).toBe(BrandLogo);
  });

  it('never renders a raster logo or the retired AI8HT wordmark slices', () => {
    const { container } = render(<BrandLogo width={160} />);
    expect(container.querySelector('img[src*="ai8ht-"], img[src$=".png"], img[src$=".webp"]')).toBeNull();
    expect(screen.queryByRole('img', { name: 'AI8HT' })).toBeNull();
  });
});
