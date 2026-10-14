/**
 * useCountUp: the Momentum number count-up (MOTION-NOTES: "KPI / number count-up", 700–1100ms,
 * ease-out-cubic, once, when its card is in view).
 *
 * It exists so a figure can tick up from zero when it first comes into view, and stay put on
 * every re-render after that. Three cases show the final value at once and never animate: a
 * reduced-motion preference, an environment without requestAnimationFrame or matchMedia (tests,
 * old browsers), and any value under five — a "<5"-sized number never counts up, so no small value
 * is implied on the way (MOTION-NOTES: "`<5` privacy counts … fade only. They never count up").
 */
import React, { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion, useInView } from './motion.js';

/** True when a value may count up: five or more, and motion is allowed. */
export function shouldCountUp(value: number): boolean {
  return Number.isFinite(value) && value >= 5 && !prefersReducedMotion();
}

export function useCountUp(value: number, { duration = 900, delay = 0, start = true }: {
  readonly duration?: number; readonly delay?: number;
  /** False holds the count at zero until it may start (the figure is not in view yet). */
  readonly start?: boolean;
} = {}): number {
  const animate = shouldCountUp(value);
  const [shown, setShown] = useState(animate ? 0 : value);
  // Once per mount: after the first run, later value changes show directly.
  const played = useRef(false);

  useEffect(() => {
    if (!animate || played.current) {
      setShown(value);
      return undefined;
    }
    if (!start) return undefined;
    let frame = 0;
    let begun = 0;
    const timer = window.setTimeout(() => {
      const step = (now: number): void => {
        if (!begun) begun = now;
        const t = Math.min(1, (now - begun) / duration);
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
  }, [animate, value, duration, delay, start]);

  return shown;
}

/** A number that counts up once, when it comes into view (see useCountUp); the final value under reduced motion. */
export function CountUp({ value, duration, delay, format }: {
  readonly value: number; readonly duration?: number; readonly delay?: number; readonly format?: (value: number) => string;
}): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { enabled: shouldCountUp(value) });
  const shown = useCountUp(value, { ...(duration !== undefined ? { duration } : {}), ...(delay !== undefined ? { delay } : {}), start: inView });
  const text = format ? format(value) : String(value);
  if (shown === value) return <span ref={ref} className="num">{text}</span>;
  // Screen readers get the final value straight away, not every frame of the count.
  return <span ref={ref} className="num">
    <span aria-hidden="true">{format ? format(shown) : shown}</span>
    <span className="sr-only">{text}</span>
  </span>;
}
