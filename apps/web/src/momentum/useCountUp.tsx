/**
 * useCountUp: the Momentum number count-up (MOTION-NOTES: "KPI / number count-up", 700–1100ms,
 * ease-out-cubic, once).
 *
 * It exists so a figure can tick up from zero when its card first mounts, and stay put on every
 * re-render after that. Three cases show the final value at once and never animate: a reduced-motion
 * preference, an environment without requestAnimationFrame or matchMedia (tests, old browsers), and
 * any value under five — a "<5"-sized number never counts up, so no small value is implied on the way.
 */
import React, { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || typeof window.requestAnimationFrame !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True when a value may count up: five or more, and motion is allowed. */
export function shouldCountUp(value: number): boolean {
  return Number.isFinite(value) && value >= 5 && !prefersReducedMotion();
}

export function useCountUp(value: number, { duration = 900, delay = 0 }: { readonly duration?: number; readonly delay?: number } = {}): number {
  const animate = shouldCountUp(value);
  const [shown, setShown] = useState(animate ? 0 : value);
  // Once per mount: after the first run, later value changes show directly.
  const played = useRef(false);

  useEffect(() => {
    if (!animate || played.current) {
      setShown(value);
      return undefined;
    }
    let frame = 0;
    let start = 0;
    const timer = window.setTimeout(() => {
      const step = (now: number): void => {
        if (!start) start = now;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 3;
        setShown(Math.round(value * eased));
        if (t < 1) frame = window.requestAnimationFrame(step);
        else played.current = true;
      };
      frame = window.requestAnimationFrame(step);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      setShown(value);
    };
  }, [animate, value, duration, delay]);

  return shown;
}

/** A number that counts up once on mount (see useCountUp); renders the final value under reduced motion. */
export function CountUp({ value, duration, delay, format }: {
  readonly value: number; readonly duration?: number; readonly delay?: number; readonly format?: (value: number) => string;
}): React.ReactElement {
  const shown = useCountUp(value, { ...(duration !== undefined ? { duration } : {}), ...(delay !== undefined ? { delay } : {}) });
  const text = format ? format(value) : String(value);
  if (shown === value) return <span className="num">{text}</span>;
  // Screen readers get the final value straight away, not every frame of the count.
  return <span className="num">
    <span aria-hidden="true">{format ? format(shown) : shown}</span>
    <span className="sr-only">{text}</span>
  </span>;
}
