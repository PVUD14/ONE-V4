/**
 * brand.test.tsx - the ONE logo component. The app's brand mark changed from the
 * AI8HT wordmark to the ONE logo on Divakar's 2026-09-30 instruction; these tests
 * pin the accessible name, the surface-specific renditions and the compact mark so
 * a later edit cannot quietly fall back to text, initials or the old wordmark.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_NAME, BrandLogo } from './brand.js';

afterEach(() => cleanup());

describe('BrandLogo', () => {
  it('renders the ONE lockup named "ONE by AI8HT" for light surfaces by default', () => {
    render(<BrandLogo />);
    const logo = screen.getByRole('img', { name: 'ONE by AI8HT' });
    expect(BRAND_NAME).toBe('ONE by AI8HT');
    expect(logo).toHaveAttribute('src', '/assets/one-logo-light.png');
    expect(logo).toHaveStyle({ height: '30px' });
  });

  it('uses the original silver rendition on dark surfaces', () => {
    render(<BrandLogo surface="dark" height={40} />);
    const logo = screen.getByRole('img', { name: 'ONE by AI8HT' });
    expect(logo).toHaveAttribute('src', '/assets/one-logo-dark.png');
    expect(logo).toHaveStyle({ height: '40px' });
  });

  it('shows the "o" mark alone when compact, keeping the same accessible name', () => {
    const { rerender } = render(<BrandLogo compact />);
    expect(screen.getByRole('img', { name: 'ONE by AI8HT' })).toHaveAttribute('src', '/assets/one-mark-light.png');
    rerender(<BrandLogo compact surface="dark" />);
    expect(screen.getByRole('img', { name: 'ONE by AI8HT' })).toHaveAttribute('src', '/assets/one-mark-dark.png');
  });

  it('never renders the retired AI8HT wordmark slices', () => {
    const { container } = render(<BrandLogo />);
    expect(container.querySelector('img[src*="ai8ht-"]')).toBeNull();
    expect(screen.queryByRole('img', { name: 'AI8HT' })).toBeNull();
  });
});
