/**
 * The sliding active-item indicator shared by the student rail and the labelled sidebars.
 *
 * The Momentum shell marks the current page with one gradient bar at the sidebar's edge that
 * travels to the item you choose, instead of a bar drawn on each item. It reads the position of
 * the item carrying `aria-current="page"` inside the nav, so it follows the same state the
 * screen reader hears and needs no knowledge of routes. Under `prefers-reduced-motion` the
 * stylesheet drops the transition and the bar simply appears at its place.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';

interface IndicatorPosition { readonly top: number; readonly height: number }

/** Render it as a direct child of the scrolling nav element (position: relative); the bar is
 *  positioned inside that element. It reads its parent itself because a child's layout effect
 *  runs before React attaches the parent's ref. */
export function NavIndicator({ activeKey, layoutKey }: {
  /** Changes whenever the current page changes. */
  readonly activeKey: string;
  /** Changes whenever the layout of the items changes (collapsed or expanded). */
  readonly layoutKey?: string;
}): React.ReactElement {
  const [position, setPosition] = useState<IndicatorPosition | null>(null);
  const [settled, setSettled] = useState(false);
  const barRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const nav = barRef.current?.parentElement;
    if (!nav) return undefined;
    const measure = (): void => {
      const item = nav.querySelector<HTMLElement>('[aria-current="page"]');
      // On the icon rail the bar lines up with the item's icon tile, not the tile and label.
      const anchor = item?.querySelector<HTMLElement>('.rail-tile') ?? item;
      const box = anchor?.getBoundingClientRect();
      if (!box || box.height === 0) { setPosition(null); return; }
      // The bar is a little shorter than the item and centred on it, as in the approved shell.
      const height = Math.min(24, Math.max(16, box.height - 8));
      const top = box.top - nav.getBoundingClientRect().top + nav.scrollTop + (box.height - height) / 2;
      setPosition({ top, height });
    };
    measure();
    // Only travel once the first position is set, so the bar never slides in from the top.
    const frame = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(() => setSettled(true)) : undefined;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(nav);
    window.addEventListener('resize', measure);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeKey, layoutKey]);

  return <span ref={barRef} className={`nav-indicator${position ? ' on' : ''}${settled ? ' settled' : ''}`} aria-hidden="true"
    style={position ? { top: `${position.top}px`, height: `${position.height}px` } : undefined} />;
}
