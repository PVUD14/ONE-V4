/**
 * <ReadinessBand>: the only way readiness is drawn (product rule 1).
 *
 * Readiness is an advisory band — Not Enough Evidence → Developing → Progressing → Ready For Next
 * Step — never a score, percentage, rank or progress figure. The component takes the band enum
 * and nothing else: its `band` prop is typed to the four codes, so a number cannot be passed,
 * and a value that is not one of the codes at run time draws the "no band yet" state rather
 * than anything derived from it. Step heights show band order, not an amount.
 *
 * Variants follow the approved sheet (components.html §14): `hero` on the gradient hero card,
 * `compact` in cards and on mobile, `mini` inline in rows (four slanted bars plus a band chip).
 * The privacy line is part of the component, so it cannot be left out: hero and compact show it
 * in full under the steps; mini shows a lock with the same line as its accessible text, and the
 * list that holds mini bands carries <ReadinessPrivacyLine> once.
 *
 * Motion (re-skin phase 11, MOTION-NOTES "Readiness band"): when the band comes into view the
 * steps rise, then the "You" marker appears on the first step and hops up one step at a time
 * (440ms per hop) to the current band, lands, and only then shows the next climb and its
 * breathing glow. The sequence is presentational: it walks the step index the band code already
 * gives, never a number from the server. Under reduced motion the marker is placed on the
 * current step at once.
 *
 * Never import this from employer code: employers never see readiness (rule 2). A test fails
 * the build if an employer file does.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon.js';
import { prefersReducedMotion, useInView } from './motion.js';

export const READINESS_BANDS = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP'] as const;
export type ReadinessBandCode = (typeof READINESS_BANDS)[number];

export const READINESS_BAND_LABELS: Readonly<Record<ReadinessBandCode, string>> = {
  NOT_ENOUGH_EVIDENCE: 'Not Enough Evidence',
  DEVELOPING: 'Developing',
  PROGRESSING: 'Progressing',
  READY_FOR_NEXT_STEP: 'Ready For Next Step',
};

/** The privacy statement the app already uses beside readiness (pilot band card). */
export const READINESS_PRIVACY_LINE = 'Advisory band · never a score · never shown to employers';

/** The band code for an API value, or null when it is not one of the four codes. */
export function toReadinessBand(value: unknown): ReadinessBandCode | null {
  return typeof value === 'string' && (READINESS_BANDS as readonly string[]).includes(value) ? value as ReadinessBandCode : null;
}

/** Band swatch colours are fills only (never text); the same in both themes. */
const BAND_FILL = ['var(--band-1)', 'var(--band-2)', 'var(--band-3)', 'var(--band-4)'] as const;

export interface ReadinessBandProps {
  /** The advisory band code, or null when the learner has no band yet. Never a number. */
  readonly band: ReadinessBandCode | null;
  readonly variant?: 'hero' | 'compact' | 'mini';
  readonly className?: string;
}

type ClimbPhase = 'pre' | 'climbing' | 'live';
interface ClimbState { readonly phase: ClimbPhase; readonly cur: number; readonly hop: 'hA' | 'hB' | null; readonly landed: boolean }

/** MOTION-NOTES timings: the marker appears at t0 (hero 1250ms after the band enters view, as on
 *  the approved home; 700ms elsewhere), then one 440ms hop per step, then the landing. */
const HOP_MS = 440;
const APPEAR_MS = 420;

/**
 * The band-climb sequencer (the approved runtime's `M.hooks.climb`): walks the marker from step 1
 * to `target` once, when `start` turns true. `target` is a step index (1–4) derived from the band
 * code; 0 means no band, which never climbs.
 */
export function useBandClimb(target: number, start: boolean, t0: number): ClimbState {
  const reduce = prefersReducedMotion();
  const final: ClimbState = { phase: 'live', cur: target, hop: null, landed: false };
  const [state, setState] = useState<ClimbState>(() => (reduce || target < 1 ? final : { phase: 'pre', cur: 1, hop: null, landed: false }));
  const played = useRef(false);

  useEffect(() => {
    if (reduce || target < 1 || played.current) { setState(final); return undefined; }
    if (!start) return undefined;
    played.current = true;
    const timers: number[] = [];
    const at = (ms: number, next: ClimbState): void => { timers.push(window.setTimeout(() => setState(next), ms)); };
    at(t0, { phase: 'climbing', cur: 1, hop: null, landed: false });
    let when = t0 + APPEAR_MS;
    for (let step = 2; step <= target; step += 1) {
      at(when, { phase: 'climbing', cur: step, hop: step % 2 === 0 ? 'hA' : 'hB', landed: false });
      when += HOP_MS;
    }
    at(when, { phase: 'live', cur: target, hop: null, landed: true });
    return () => { timers.forEach((timer) => window.clearTimeout(timer)); };
    // `final` is derived from target; the sequence runs once per mount.
  }, [reduce, target, start, t0]);

  return state;
}

export function ReadinessPrivacyLine({ onGradient = false }: { readonly onGradient?: boolean }): React.ReactElement {
  return <p className={`rb-privacy${onGradient ? ' on-grad' : ''}`}><Icon name="lock" size={16} />{READINESS_PRIVACY_LINE}</p>;
}

export function ReadinessBand({ band, variant = 'compact', className }: ReadinessBandProps): React.ReactElement {
  const code = toReadinessBand(band);
  const current = code ? READINESS_BANDS.indexOf(code) : -1;
  const label = code ? `Readiness band: ${READINESS_BAND_LABELS[code]}` : 'No advisory band yet';
  const extra = className ? ` ${className}` : '';

  if (variant === 'mini') {
    return <span className={`mband${extra}`} data-band={code ?? 'NONE'}>
      <span className="mb" role="img" aria-label={label}>
        {READINESS_BANDS.map((candidate, index) => <i key={candidate} className={index <= current ? (index === current ? 'f c' : 'f') : undefined} />)}
      </span>
      <span className={`tag ${code ? 't-band' : 't-mute'}`}><i aria-hidden="true" />{code ? READINESS_BAND_LABELS[code] : 'No advisory band yet'}</span>
      <span className="rb-mini-lock" title={READINESS_PRIVACY_LINE}><Icon name="lock" size={16} label={READINESS_PRIVACY_LINE} /></span>
    </span>;
  }

  return <ClimbingBand code={code} current={current} variant={variant} label={label} extra={extra} />;
}

function ClimbingBand({ code, current, variant, label, extra }: {
  readonly code: ReadinessBandCode | null; readonly current: number; readonly variant: 'hero' | 'compact';
  readonly label: string; readonly extra: string;
}): React.ReactElement {
  const onGradient = variant === 'hero';
  const atTop = current === READINESS_BANDS.length - 1;
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { enabled: Boolean(code) && !prefersReducedMotion() });
  const climb = useBandClimb(current + 1, inView, onGradient ? 1250 : 700);
  const shownCurrent = climb.cur - 1;
  const settled = climb.phase === 'live';
  const style = { '--cur': climb.cur } as React.CSSProperties;
  const phaseClass = climb.phase === 'pre' ? ' pre' : climb.phase === 'climbing' ? ' climbing' : ' live';
  return <div className={`rb-wrap rb-wrap--${variant}${extra}`} data-band={code ?? 'NONE'}>
    <div ref={ref} className={`rb m-io m-loop${variant === 'compact' ? ' compact' : ''}${onGradient ? ' on-grad' : ''}${atTop ? ' at-top' : ''}${code ? phaseClass : ' is-empty'}${climb.landed ? ' landed' : ''}`}
      style={style} role="img" aria-label={label}>
      {READINESS_BANDS.map((candidate, index) => {
        // Before the marker appears no step is lit; the next climb shows only once it has landed.
        const state = climb.phase === 'pre' || !code ? ''
          : index < shownCurrent ? 'done' : index === shownCurrent ? 'cur' : index === shownCurrent + 1 && settled ? 'next' : '';
        return <div key={candidate} className={`rb-s${state ? ` ${state}` : ''}`} style={{ '--i': index + 1, '--c': BAND_FILL[index] } as React.CSSProperties}>
          <div className="rb-bar" aria-hidden="true"><i className="rb-base" /><i className="rb-done" /><i className="rb-cur" /><i className="rb-next" /></div>
          <div className="rb-l" aria-hidden="true"><span>{READINESS_BAND_LABELS[candidate]}</span></div>
        </div>;
      })}
      {code ? <div className="rb-pin" aria-hidden="true"><span className={`rb-hop${climb.hop ? ` ${climb.hop}` : ''}`}><span className="lens" />You</span></div> : null}
      {code && !atTop ? <div className="rb-nx" aria-hidden="true">Next climb</div> : null}
    </div>
    {code ? null : <p className="rb-empty">No advisory band yet</p>}
    <ReadinessPrivacyLine onGradient={onGradient} />
  </div>;
}
