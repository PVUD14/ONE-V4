/**
 * The sidebar starts as the icon rail on laptop widths, and a person's own choice wins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialSidebarCollapsed, rememberSidebarCollapsed } from './sidebarPreference.js';

function atWidth(width: number): void {
  vi.stubGlobal('innerWidth', width);
}

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sidebar preference', () => {
  it('starts collapsed at 1366px and below, expanded above, when nothing is remembered', () => {
    atWidth(1366);
    expect(initialSidebarCollapsed()).toBe(true);
    atWidth(1280);
    expect(initialSidebarCollapsed()).toBe(true);
    atWidth(1440);
    expect(initialSidebarCollapsed()).toBe(false);
  });

  it('keeps the choice a person made, whatever the screen width', () => {
    atWidth(1280);
    rememberSidebarCollapsed(false);
    expect(initialSidebarCollapsed()).toBe(false);
    atWidth(1920);
    rememberSidebarCollapsed(true);
    expect(initialSidebarCollapsed()).toBe(true);
  });

  it('falls back to the screen-size default when storage is unavailable', () => {
    atWidth(1280);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => rememberSidebarCollapsed(false)).not.toThrow();
    expect(initialSidebarCollapsed()).toBe(true);
  });
});
