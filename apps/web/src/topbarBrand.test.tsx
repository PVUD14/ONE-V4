/**
 * topbarBrand.test.tsx - the ONE logo in the top bar. Below the drawer breakpoint the sidebar,
 * and the logo it carries, is off-canvas, so both the student top bar and every role portal's
 * top bar carry the logo themselves (CSS shows it only at those widths). These tests pin that
 * the logo is the real BrandLogo, never text or initials, and that no top-bar control was lost.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { BRAND_NAME } from './brand.js';
import { RolePortal } from './rolePortalPages.js';
import { rolePortals } from './rolePortalConfig.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('top bar brand', () => {
  it('puts the ONE logo in the student top bar beside the navigation button', () => {
    window.history.pushState(null, '', '/demo/student');
    render(<App />);
    const menu = screen.getByRole('button', { name: 'Open student navigation' });
    const topbar = menu.closest('header');
    expect(topbar).not.toBeNull();
    const brand = topbar!.querySelector('.topbar-brand');
    expect(brand).not.toBeNull();
    expect(within(brand as HTMLElement).getByRole('img', { name: BRAND_NAME })).toHaveAttribute('src', '/brand/one-wordmark-full-color-on-light.svg');
  });

  it.each(['placement-officer', 'recruiter', 'operations-admin'])('puts the ONE logo in the %s portal top bar and keeps its controls', (key) => {
    const portal = rolePortals.find((item) => item.key === key)!;
    window.history.replaceState(null, '', `/demo${portal.basePath}`);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()} demoMode />);
    const topbar = screen.getByRole('button', { name: `Open ${portal.roleName} navigation` }).closest('header')!;
    const brand = topbar.querySelector('.topbar-brand');
    expect(brand).not.toBeNull();
    expect(within(brand as HTMLElement).getByRole('img', { name: BRAND_NAME })).toBeInTheDocument();
    expect(within(topbar).getByRole('button', { name: 'Switch preview portal' })).toBeInTheDocument();
    expect(within(topbar).getByRole('button', { name: 'Messages' })).toBeInTheDocument();
    expect(within(topbar).getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(within(topbar).getByRole('search')).toBeInTheDocument();
  });
});
