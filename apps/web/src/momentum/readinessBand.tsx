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
 * Never import this from employer code: employers never see readiness (rule 2). A test fails
 * the build if an employer file does.
 */
import React from 'react';
import { Icon } from '../icons/Icon.js';

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

  const onGradient = variant === 'hero';
  const atTop = current === READINESS_BANDS.length - 1;
  const style = { '--cur': current + 1 } as React.CSSProperties;
  return <div className={`rb-wrap rb-wrap--${variant}${extra}`} data-band={code ?? 'NONE'}>
    <div className={`rb${variant === 'compact' ? ' compact' : ''}${onGradient ? ' on-grad' : ''}${atTop ? ' at-top' : ''}${code ? '' : ' is-empty'}`}
      style={style} role="img" aria-label={label}>
      {READINESS_BANDS.map((candidate, index) => {
        const state = index < current ? 'done' : index === current ? 'cur' : index === current + 1 ? 'next' : '';
        return <div key={candidate} className={`rb-s${state ? ` ${state}` : ''}`} style={{ '--i': index + 1, '--c': BAND_FILL[index] } as React.CSSProperties}>
          <div className="rb-bar" aria-hidden="true"><i className="rb-base" /><i className="rb-done" /><i className="rb-cur" /><i className="rb-next" /></div>
          <div className="rb-l" aria-hidden="true"><span>{READINESS_BAND_LABELS[candidate]}</span></div>
        </div>;
      })}
      {code ? <div className="rb-pin" aria-hidden="true"><span className="rb-hop"><span className="lens" />You</span></div> : null}
      {code && !atTop ? <div className="rb-nx" aria-hidden="true">Next climb</div> : null}
    </div>
    {code ? null : <p className="rb-empty">No advisory band yet</p>}
    <ReadinessPrivacyLine onGradient={onGradient} />
  </div>;
}
