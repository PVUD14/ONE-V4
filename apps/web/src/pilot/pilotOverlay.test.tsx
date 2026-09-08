/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-08
 * Agent-assisted: yes (Claude) · Reviewed: pending
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PilotOverlayProvider, useOverlay } from './pilotOverlay.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Toaster(): React.ReactElement {
  const overlay = useOverlay();
  return <button type="button" onClick={() => overlay.toast('Saved')}>toast</button>;
}

describe('pilot overlay toast lifecycle', () => {
  it('clears the toast after its delay while still mounted', () => {
    vi.useFakeTimers();
    render(<PilotOverlayProvider><Toaster /></PilotOverlayProvider>);

    act(() => { screen.getByRole('button', { name: 'toast' }).click(); });
    expect(screen.getByText('Saved')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(3200); });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('leaves no timer running after unmount', () => {
    vi.useFakeTimers();
    const view = render(<PilotOverlayProvider><Toaster /></PilotOverlayProvider>);

    act(() => { screen.getByRole('button', { name: 'toast' }).click(); });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();

    // The regression this guards: the toast timer used to survive the provider and
    // fire against a torn-down document, which surfaced elsewhere in the suite as
    // "ReferenceError: window is not defined" long after the test that caused it.
    expect(vi.getTimerCount()).toBe(0);
    expect(() => act(() => { vi.runAllTimers(); })).not.toThrow();
  });

  it('replaces a pending toast rather than stacking timers', () => {
    vi.useFakeTimers();
    render(<PilotOverlayProvider><Toaster /></PilotOverlayProvider>);
    const button = screen.getByRole('button', { name: 'toast' });

    act(() => { button.click(); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { button.click(); });

    expect(vi.getTimerCount()).toBe(1);
  });
});
