/**
 * <StatusTag>: the one status tag for hiring stages, offers and verification states.
 *
 * Momentum tags lean on the 12° slant: a 6px-radius slanted fill behind upright text
 * (components.css `.tag`). Colours are the approved ones (decision log 2026-10-10):
 *
 *   application  Applied, Screening, Shortlisted, Assessment → brand blue · Interview → cyan ·
 *                Offer → orange (its celebration moment) · Hired → green ·
 *                Withdrawn, Not selected (REJECTED) → neutral
 *   verification Verified → green · Pending review → amber · Changes requested → orange ·
 *                Not verified → red · Expired → neutral · Self-reported → outline
 *
 * Text on every soft fill uses the -ink tokens, so it holds 4.5:1 in both themes. The tag keeps
 * the older `hiring-state state-<code>` classes so existing selectors and styles still find it.
 */
import React from 'react';
import { Icon, type IconName } from '../icons/Icon.js';

/** `gold` is the celebration variant for a view whose one orange is already a streak (approved 2026-10-11). */
export type StatusTone = 'band' | 'cyan' | 'hot' | 'gold' | 'ok' | 'warn' | 'danger' | 'mute' | 'line';
export type StatusKind = 'application' | 'offer' | 'verification' | 'general';

const APPLICATION: Readonly<Record<string, StatusTone>> = {
  APPLIED: 'band', SCREENING: 'band', SHORTLISTED: 'band', ASSESSMENT: 'band',
  INTERVIEW: 'cyan', OFFER: 'hot', HIRED: 'ok',
  WITHDRAWN: 'mute', REJECTED: 'mute', NOT_SELECTED: 'mute', DRAFT: 'mute',
};

const OFFER: Readonly<Record<string, StatusTone>> = {
  EXTENDED: 'hot', ACCEPTED: 'ok', DECLINED: 'mute', EXPIRED: 'mute', WITHDRAWN: 'mute', DRAFT: 'mute',
};

const VERIFICATION: Readonly<Record<string, StatusTone>> = {
  VERIFIED: 'ok',
  PENDING: 'warn', PENDING_REVIEW: 'warn', UNDER_REVIEW: 'warn', SUBMITTED: 'warn', IN_REVIEW: 'warn',
  CHANGES_REQUESTED: 'hot',
  REJECTED: 'danger', NOT_VERIFIED: 'danger', SUSPENDED: 'danger',
  EXPIRED: 'mute', REVOKED: 'mute',
  SELF_REPORTED: 'line', SELF_DECLARED: 'line', UNVERIFIED: 'line',
};

/** Lifecycle states that are not hiring or verification (jobs, drives, questions, requests). */
const GENERAL: Readonly<Record<string, StatusTone>> = {
  ...APPLICATION,
  PUBLISHED: 'ok', LIVE: 'ok', ACTIVE: 'ok', APPROVED: 'ok', COMPLETED: 'ok', ACCEPTED: 'ok', VERIFIED: 'ok', SUCCEEDED: 'ok',
  OPEN: 'band', SCHEDULED: 'band', RESCHEDULED: 'band', EXTENDED: 'hot',
  PENDING: 'warn', REQUESTED: 'warn', IN_REVIEW: 'warn', UNDER_REVIEW: 'warn', QUEUED: 'warn', CHANGES_REQUESTED: 'hot',
  FAILED: 'danger', REFUSED: 'danger', SUSPENDED: 'danger',
  PAUSED: 'mute', CLOSED: 'mute', ARCHIVED: 'mute', CANCELLED: 'mute', DECLINED: 'mute', EXPIRED: 'mute', SUPERSEDED: 'mute',
};

const TABLES: Readonly<Record<StatusKind, Readonly<Record<string, StatusTone>>>> = {
  application: APPLICATION, offer: OFFER, verification: VERIFICATION, general: GENERAL,
};

/** The approved tone for a state code (e.g. 'INTERVIEW'), by kind; unknown codes are neutral. */
export function statusTone(state: string, kind: StatusKind = 'general'): StatusTone {
  return TABLES[kind][state.trim().toUpperCase().replace(/[\s-]+/g, '_')] ?? 'mute';
}

/** The marker drawn before the label: a slanted dot, a hollow dot, or a small icon. */
function marker(tone: StatusTone, state: string): React.ReactNode {
  const code = state.trim().toUpperCase();
  let icon: IconName | null = null;
  if (code === 'HIRED' || code === 'VERIFIED' || code === 'ACCEPTED') icon = 'check';
  else if (tone === 'warn') icon = 'clock';
  else if (tone === 'danger') icon = 'close';
  if (icon) return <Icon name={icon} size={16} className="tag-icon" />;
  const hollow = tone === 'line' || code === 'REJECTED' || code === 'NOT_SELECTED' || code === 'EXPIRED';
  return <i className={hollow ? 'h' : undefined} aria-hidden="true" />;
}

export interface StatusTagProps {
  /** The state code the API sent, e.g. 'SHORTLISTED' or 'VERIFIED'. Drives the colour. */
  readonly state: string;
  /** The words shown; defaults to the code, sentence-cased. */
  readonly label?: React.ReactNode;
  readonly kind?: StatusKind;
  /** Overrides the tone for a state with no approved mapping. */
  readonly tone?: StatusTone;
  readonly size?: 'md' | 'lg';
  readonly className?: string;
}

function sentence(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusTag({ state, label, kind = 'general', tone, size = 'md', className }: StatusTagProps): React.ReactElement {
  // A hiring stage the API calls REJECTED always reads "Not selected", whatever label was passed.
  const code = state.trim().toUpperCase();
  if (kind === 'application' && (code === 'REJECTED' || code === 'NOT_SELECTED')) label = 'Not selected';
  const resolved = tone ?? statusTone(state, kind);
  const slug = state.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const classes = ['tag', `t-${resolved}`, 'hiring-state', `state-${state.trim().toLowerCase()}`, `state-${slug}`, size === 'lg' ? 'lg' : '', className ?? '']
    .filter((name, index, all) => name && all.indexOf(name) === index).join(' ');
  return <span className={classes} data-tone={resolved}>{marker(resolved, state)}{label ?? sentence(state)}</span>;
}
