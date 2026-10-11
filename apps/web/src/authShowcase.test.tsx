/**
 * The Infinity Loop brand panel of the signed-out pages: the four stage chips, the reduced-motion
 * final frame, the stage cycle when motion is allowed, and that the panel carries fixed product
 * copy only, with no person, figure or score.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthLayout } from './authLayout.js';
import { dismissBootSplash } from './bootSplash.js';

function mockMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') ? reduced : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const litStages = (): string[] => within(screen.getByRole('list', { name: 'Learn, prepare, build, grow' })).getAllByRole('listitem').filter((item) => item.classList.contains('on')).map((item) => item.textContent ?? '');

describe('sign-in brand panel', () => {
  it('shows the final frame at once under reduced motion: all four stages lit, nothing waiting to enter', () => {
    mockMotion(true);
    const { container } = render(<AuthLayout onNavigate={() => undefined}><p>card</p></AuthLayout>);
    expect(litStages()).toEqual(['LEARN', 'PREPARE', 'BUILD', 'GROW']);
    const frame = container.querySelector('.auth-split')!;
    expect(frame).toHaveClass('is-played');
    expect(frame).not.toHaveClass('si-motion');
  });

  it('lights one stage at a time, 1.2s each, once the entrance has played', async () => {
    mockMotion(false);
    vi.useFakeTimers();
    const { container } = render(<AuthLayout onNavigate={() => undefined}><p>card</p></AuthLayout>);
    const frame = container.querySelector('.auth-split')!;
    expect(frame).toHaveClass('si-motion');
    expect(frame).not.toHaveClass('is-played');
    expect(litStages()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(frame).toHaveClass('is-played');
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(litStages()).toEqual(['LEARN']);
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(litStages()).toEqual(['PREPARE']);
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    expect(litStages()).toEqual(['GROW']);
  });

  it('carries the approved promises and no score, percentage or sample person', () => {
    mockMotion(true);
    render(<AuthLayout onNavigate={() => undefined}><p>card</p></AuthLayout>);
    const panel = screen.getByRole('complementary', { name: 'About ONE' });
    expect(within(panel).getByRole('heading', { name: 'One workspace from learning to landing the role.' })).toBeInTheDocument();
    expect(within(panel).getByRole('list', { name: 'What ONE promises' })).toHaveTextContent('Verified evidenceA band, never a scoreNever shared with employers');
    expect(panel.textContent).not.toMatch(/\d+\s*%|\bscore:|Arjun|Lakeview|\bNA\b/);
    expect(within(panel).getByRole('img', { name: 'ONE by AI8HT' })).toHaveAttribute('data-artwork', 'lockup');
  });
});

describe('boot splash', () => {
  it('fades the index.html boot screen out and removes it', () => {
    mockMotion(false);
    vi.useFakeTimers();
    document.body.insertAdjacentHTML('beforeend', '<div id="one-boot" role="status"></div>');
    dismissBootSplash();
    const splash = document.getElementById('one-boot');
    expect(splash).toHaveClass('is-done');
    vi.advanceTimersByTime(500);
    expect(document.getElementById('one-boot')).toBeNull();
  });

  it('removes it at once under reduced motion, and is a no-op when there is none', () => {
    mockMotion(true);
    document.body.insertAdjacentHTML('beforeend', '<div id="one-boot"></div>');
    dismissBootSplash();
    expect(document.getElementById('one-boot')).toBeNull();
    expect(() => dismissBootSplash()).not.toThrow();
  });
});
