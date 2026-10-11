// Tests for the Momentum motion runtime (re-skin phase 11): reduced motion shows the final state
// at once, the band climb walks the marker step by step only when motion is allowed, a count under
// five never counts up, and the in-view runtime reveals every host when it cannot observe.
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadinessBand } from './readinessBand.js';
import { CountUp, shouldCountUp } from './useCountUp.js';
import { installMotion, prefersReducedMotion } from './motion.js';
import { PeopleCount } from '../rolePortal/institutionMomentum.js';

type Observed = { readonly callback: IntersectionObserverCallback; readonly elements: Element[] };
let observers: Observed[] = [];
afterEach(() => { cleanup(); });

function allowMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
}

/** An IntersectionObserver the test drives: nothing is in view until `enterView()`. */
function installObserver(): void {
  observers = [];
  class FakeObserver {
    private readonly entry: Observed;
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback, elements: [] }; observers.push(this.entry); }
    observe(element: Element): void { this.entry.elements.push(element); }
    unobserve(): void { /* no-op */ }
    disconnect(): void { this.entry.elements.length = 0; }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
}

function enterView(): void {
  for (const observer of observers) {
    const entries = observer.elements.map((target) => ({ target, isIntersecting: true } as unknown as IntersectionObserverEntry));
    if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
  }
}

describe('reduced motion', () => {
  beforeEach(() => { allowMotion(true); installObserver(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is honoured: the band shows its final state at once, with nothing held back', () => {
    expect(prefersReducedMotion()).toBe(true);
    const { container } = render(<ReadinessBand band="PROGRESSING" variant="hero" />);
    const band = container.querySelector('.rb')!;
    // No pre / climbing phase, the marker on the current step, the next climb shown.
    expect(band.classList.contains('pre')).toBe(false);
    expect(band.classList.contains('climbing')).toBe(false);
    expect(band.classList.contains('live')).toBe(true);
    expect(container.querySelector('.rb-s.cur .rb-l')?.textContent).toBe('Progressing');
    expect(container.querySelectorAll('.rb-s.done')).toHaveLength(2);
    expect(container.querySelector('.rb-s.next')).not.toBeNull();
    expect((band as HTMLElement).style.getPropertyValue('--cur')).toBe('3');
  });

  it('shows the final number of a count-up at once', () => {
    render(<CountUp value={33} />);
    expect(screen.getByText('33')).toBeInTheDocument();
  });
});

describe('the band climb with motion allowed', () => {
  beforeEach(() => { allowMotion(false); installObserver(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('waits for the band to be in view, then hops the marker one step at a time to the current band', () => {
    const { container } = render(<ReadinessBand band="PROGRESSING" variant="compact" />);
    const band = (): Element => container.querySelector('.rb')!;
    // Before it is seen: no step lit, the marker hidden (styles: .rb.pre .rb-pin).
    expect(band().classList.contains('pre')).toBe(true);
    expect(container.querySelector('.rb-s.cur')).toBeNull();

    act(() => { enterView(); });
    act(() => { vi.advanceTimersByTime(700); });
    // The marker appears on the first step.
    expect(band().classList.contains('climbing')).toBe(true);
    expect(container.querySelector('.rb-s.cur .rb-l')?.textContent).toBe('Not Enough Evidence');
    act(() => { vi.advanceTimersByTime(420); });
    expect(container.querySelector('.rb-s.cur .rb-l')?.textContent).toBe('Developing');
    expect(container.querySelector('.rb-hop')?.className).toMatch(/\bh[AB]\b/);
    // The next climb is not shown mid-climb.
    expect(container.querySelector('.rb-s.next')).toBeNull();
    act(() => { vi.advanceTimersByTime(440); });
    expect(container.querySelector('.rb-s.cur .rb-l')?.textContent).toBe('Progressing');
    act(() => { vi.advanceTimersByTime(440); });
    expect(band().classList.contains('live')).toBe(true);
    expect(band().classList.contains('landed')).toBe(true);
    expect(container.querySelector('.rb-s.next .rb-l')?.textContent).toBe('Ready For Next Step');
    // The climb never puts a figure on the screen.
    expect((container.textContent ?? '').replace('Advisory band · never a score · never shown to employers', '')).not.toMatch(/\d/);
  });
});

describe('count-up', () => {
  beforeEach(() => { allowMotion(false); installObserver(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('never animates a value under five', () => {
    expect(shouldCountUp(4)).toBe(false);
    expect(shouldCountUp(0)).toBe(false);
    expect(shouldCountUp(5)).toBe(true);
    render(<CountUp value={4} />);
    // Shown as itself straight away, never passing through smaller numbers.
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('draws a people count under five as "<5", never counting', () => {
    render(<PeopleCount value={3} />);
    expect(screen.getByText('<5')).toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('holds a larger figure at zero until it is in view, with the final value for screen readers', () => {
    const { container } = render(<CountUp value={33} />);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('0');
    expect(container.querySelector('.sr-only')?.textContent).toBe('33');
  });
});

describe('installMotion', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('reveals every entrance host when the browser cannot observe, so nothing stays invisible', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    document.body.innerHTML = '<section class="m-io"></section><section class="m-io"></section>';
    const uninstall = installMotion(document);
    expect(document.querySelectorAll('.m-io[data-m-in]')).toHaveLength(2);
    uninstall();
  });
});
