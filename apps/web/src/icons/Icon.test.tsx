// Tests for the Momentum <Icon> component and the nav label -> icon mapping.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { Icon, iconNames, utilityIconNames, type IconName } from './Icon.js';
import { approvedNavIcons, extraNavIcons, navIconFor } from './navIcons.js';

const iconMap = JSON.parse(readFileSync(join(process.cwd(), 'src/assets/one/icons/icon-map.json'), 'utf8')) as {
  readonly portals: Record<string, { readonly nav: Record<string, string> }>;
  readonly utility: Record<string, string>;
};

describe('Icon', () => {
  it('renders an inline svg in currentColor at the requested size, hidden from assistive tech by default', () => {
    const { container } = render(<Icon name="readiness" size={24} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('height', '24');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(svg?.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('defaults to 20px', () => {
    const { container } = render(<Icon name="home" />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '20');
  });

  it('is announced as an image when it carries a label', () => {
    const { getByRole } = render(<Icon name="bell" label="Notifications" />);
    const img = getByRole('img', { name: 'Notifications' });
    expect(img).not.toHaveAttribute('aria-hidden');
  });

  it('fills the active icon with its own Momentum gradient and keeps the second tone', () => {
    const { container } = render(<><Icon name="students" active /><Icon name="students" active /></>);
    const [first, second] = [...container.querySelectorAll('svg')];
    const gradientId = (svg: Element | undefined) => svg?.querySelector('linearGradient')?.getAttribute('id');
    expect(first).toHaveClass('is-active');
    expect(first?.getAttribute('fill')).toBe(`url(#${gradientId(first)})`);
    // Two active icons never share a gradient id.
    expect(gradientId(first)).not.toBe(gradientId(second));
    const stops = [...(first?.querySelectorAll('stop') ?? [])].map((stop) => stop.getAttribute('stop-color'));
    expect(stops).toEqual(['#2B1BB8', '#1E6BFF', '#18C8E8']);
    expect(first?.querySelector('[opacity=".42"]')).not.toBeNull();
  });

  it('gives masked icons per-instance mask ids', () => {
    const { container } = render(<><Icon name="assessments" /><Icon name="assessments" /></>);
    const ids = [...container.querySelectorAll('mask')].map((mask) => mask.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const masked = container.querySelector('[mask]');
    expect(masked?.getAttribute('mask')).toBe(`url(#${ids[0]})`);
  });

  it('marks only requested icons for the hover cue', () => {
    const { container } = render(<><Icon name="home" animated /><Icon name="search" /></>);
    const [moving, still] = [...container.querySelectorAll('svg')];
    expect(moving).toHaveClass('one-icon--motion', 'ai-home');
    expect(still).not.toHaveClass('one-icon--motion');
  });

  it('carries every icon in the approved set and every utility icon from the map', () => {
    expect(iconNames).toHaveLength(97);
    for (const name of Object.values(iconMap.utility)) expect(utilityIconNames.has(name as IconName)).toBe(true);
    for (const name of iconNames) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector('path, rect, polyline')).not.toBeNull();
      unmount();
    }
  });
});

describe('navIconFor', () => {
  it('resolves every nav label in the approved icon map to the mapped icon', () => {
    for (const portal of Object.values(iconMap.portals)) {
      for (const [label, icon] of Object.entries(portal.nav)) {
        expect(navIconFor(label), label).toBe(icon);
        expect(approvedNavIcons[label], label).toBe(icon);
      }
    }
  });

  it('uses home for every dashboard, home and overview item', () => {
    expect(['Dashboard', 'Home', 'Overview', 'Dashboards'].map(navIconFor)).toEqual(['home', 'home', 'home', 'home']);
  });

  it('only names real icons for labels outside the map', () => {
    for (const icon of Object.values(extraNavIcons)) expect(iconNames).toContain(icon);
  });
});

describe('portal navigation icons', () => {
  it('maps every portal nav item through the icon map', async () => {
    const { rolePortals, growthPortal } = await import('../rolePortalConfig.js');
    const { staffNavItems } = await import('../staffConfig.js');
    const items = [...rolePortals.flatMap((portal) => portal.nav), ...growthPortal.nav, ...staffNavItems];
    expect(items.length).toBeGreaterThan(50);
    for (const item of items) expect(item.icon, item.label).toBe(navIconFor(item.label));
  });
});
