// Tests for <EmptyState> (re-skin phase 8): the words come from copy.json, the demo-world names in
// that copy never reach a screen, an action is drawn only with a real destination, and the static
// illustration is used under reduced motion.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import COPY from '../assets/one/illustrations/copy.json' with { type: 'json' };
import { EmptyState, ILLUSTRATION_IDS, illustrationCopy, inlineIllustration } from './emptyState.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('<EmptyState>', () => {
  it('renders the title, line and helper from copy.json', () => {
    render(<EmptyState id="no-applications" helper />);
    expect(screen.getByRole('heading', { name: COPY['no-applications'].title })).toBeInTheDocument();
    expect(screen.getByText(COPY['no-applications'].body)).toBeInTheDocument();
    expect(screen.getByText(COPY['no-applications'].helper)).toBeInTheDocument();
  });

  it('draws an action only when it has somewhere real to go', () => {
    const { unmount } = render(<EmptyState id="no-applications" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    const onClick = vi.fn();
    render(<EmptyState id="no-applications" primary={{ onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore roles/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('uses the static illustration under reduced motion', async () => {
    // jsdom has no matchMedia; state the preference explicitly as well.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
    const { container } = render(<EmptyState id="coach" note />);
    const art = container.querySelector('.es-art')!;
    expect(art).toHaveAttribute('data-variant', 'static');
    expect(art).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(art.querySelector('svg')).not.toBeNull());
    const svg = art.querySelector('svg')!;
    // The static file: no animation class, never racked in, and no <style> of its own.
    expect(svg.classList.contains('lx')).toBe(true);
    expect(svg.classList.contains('lx-anim')).toBe(false);
    expect(svg.classList.contains('go')).toBe(false);
    expect(art.querySelector('style')).toBeNull();
    expect(screen.getByText(COPY.coach.note)).toBeInTheDocument();
  });

  it('never shows the inventory’s demo names, and never the stock count line', () => {
    for (const id of ILLUSTRATION_IDS) {
      const text = Object.values(illustrationCopy(id)).join(' ');
      expect(text).not.toMatch(/Lakeview|Corvane|Arjun|Graduate Software Engineer|Reddy/);
      expect(Object.keys(illustrationCopy(id))).not.toContain('count');
    }
    render(<EmptyState id="queue-clear" />);
    expect(screen.queryByText(/0 records waiting/)).not.toBeInTheDocument();
  });

  it('prefixes every id when inlining, so two pieces of art never share a gradient', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" class="lx go" viewBox="0 0 440 300" width="440" height="300" role="img" aria-label="x"><style>svg{}</style><defs><linearGradient id="a-grad"/></defs><circle fill="url(#a-grad)"/><use href="#a-grad"/></svg>';
    const out = inlineIllustration(svg, 'p1', true);
    expect(out).not.toContain('<style>');
    expect(out).toContain('class="lx lx-anim"');
    expect(out).toContain('id="p1-a-grad"');
    expect(out).toContain('url(#p1-a-grad)');
    expect(out).toContain('href="#p1-a-grad"');
    expect(out).not.toMatch(/width="440"/);
  });
});
