/**
 * The theme follows the OS until a person picks one with the top-bar toggle; that choice is
 * put on <html> and remembered on this device, and the logo follows it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrandLogo } from './brand.js';
import { applyStoredTheme, chooseTheme, currentTheme, storedTheme } from './themePreference.js';
import { ThemeToggle } from './themeToggle.js';

function osPrefersDark(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('dark'), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

describe('theme preference', () => {
  it('follows the OS when nothing is remembered and sets no data-theme', () => {
    osPrefersDark(true);
    applyStoredTheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(currentTheme()).toBe('dark');
    osPrefersDark(false);
    expect(currentTheme()).toBe('light');
  });

  it('puts a chosen theme on <html>, remembers it, and lets it win over the OS', () => {
    osPrefersDark(true);
    chooseTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(storedTheme()).toBe('light');
    document.documentElement.removeAttribute('data-theme');
    applyStoredTheme();
    expect(currentTheme()).toBe('light');
  });

  it('keeps working when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(storedTheme()).toBeNull();
    expect(() => chooseTheme('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    vi.restoreAllMocks();
  });

  it('toggles between themes with a label that says what pressing it does, and the logo follows', async () => {
    osPrefersDark(false);
    render(<><ThemeToggle /><BrandLogo /></>);
    expect(screen.getByRole('img', { name: 'ONE by AI8HT' }).getAttribute('src')).toBe('/brand/one-wordmark-full-color-on-light.svg');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // The toggle and logo hear about the change through a MutationObserver, which runs async.
    expect(await screen.findByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'ONE by AI8HT' }).getAttribute('src')).toBe('/brand/one-wordmark-full-color-on-dark.svg');
  });
});
