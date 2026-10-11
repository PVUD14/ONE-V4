/**
 * <EmptyState id="…">: the Momentum empty and system states (re-skin phase 8), after the approved
 * Lens illustrations (inventory 03-illustrations; unified/EMPTY-STATES-NOTES.md).
 *
 * It exists so every empty list, unbuilt page and system page draws the same way: the illustration
 * for its id, then the title, one line, the actions and an optional privacy note, with the words
 * taken from copy.json (assets/one/illustrations, copied unchanged from the inventory). Two rules
 * keep it honest:
 *   - Copy passes through `illustrationCopy`, which replaces the inventory's demo names (a sample
 *     college, company, person and role) with neutral words; a caller whose real state differs
 *     from the stock line passes its own `title`/`body`. The stock `count` line is never drawn: a
 *     caller passes a real count.
 *   - An action renders only when the caller gives it a real destination; the stock label alone
 *     never produces a button that goes nowhere.
 * The art is inlined (so it themes with the app and racks in when it scrolls into view) from the
 * animated SVG, or from the static SVG under reduced motion. It is decorative: the title carries
 * the meaning, so the art is hidden from assistive technology. Styles: styles/empty-states.css and
 * styles/illustrations.css.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon, type IconName } from '../icons/Icon.js';
import COPY from '../assets/one/illustrations/copy.json' with { type: 'json' };
import { useInView, useReducedMotion } from './motion.js';

export type IllustrationId = keyof typeof COPY;

export interface IllustrationCopy {
  readonly title: string;
  readonly body: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly note?: string;
  readonly helper?: string;
}

/**
 * The inventory copy is written around a demo world (a sample college, a sample employer, a sample
 * student and a sample role). None of those may reach a real screen, so each such line is replaced
 * here with neutral wording that stays true for every account.
 */
const COPY_FIXES: Partial<Record<IllustrationId, Partial<IllustrationCopy>>> = {
  'no-assessments': { body: 'Assessments from your college or employers will show up here. Each one you complete becomes a verified evidence record.' },
  'no-messages': { body: 'Messages from your college’s staff and employers you’ve applied to will appear here.' },
  'queue-clear': { body: 'New evidence submitted by your students will appear here for review.' },
  'success-generic': { body: 'Your evidence record was sent to your college. We’ll notify you when it’s reviewed.' },
  'no-opportunities-posted': { body: 'Describe the role and the evidence you’d like to see.' },
  'no-applicants': { body: 'Applicants appear here with the evidence they choose to share.' },
  'onboarding-welcome': { title: 'Welcome to ONE' },
  'learning-not-started': { body: 'Start your first lesson to build evidence for your goal.', primary: 'Start learning' },
};

/** The copy for an illustration id, from copy.json with the demo-world lines replaced. */
export function illustrationCopy(id: IllustrationId): IllustrationCopy {
  const stock = COPY[id] as IllustrationCopy & { readonly count?: string };
  const { count: _count, ...rest } = stock;
  return { ...rest, ...COPY_FIXES[id] };
}

export const ILLUSTRATION_IDS = Object.keys(COPY) as IllustrationId[];

export function isIllustrationId(value: string): value is IllustrationId {
  return Object.prototype.hasOwnProperty.call(COPY, value);
}

// Each SVG is its own lazily loaded chunk, so a page pays only for the art it shows.
const SVG_SOURCES = import.meta.glob('../assets/one/illustrations/svg/*.svg', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const cache = new Map<string, string>();

function sourceKey(id: IllustrationId, variant: 'animated' | 'static'): string {
  return `../assets/one/illustrations/svg/${id}${variant === 'static' ? '-static' : ''}.svg`;
}

/**
 * Prepares a standalone SVG for inlining: drops its own <style> (styles/illustrations.css carries
 * the same rules once, themed by the app), its fixed size and the `go` class (added when in view),
 * and prefixes every id so two pieces of art on one page never share a gradient.
 */
export function inlineIllustration(svg: string, prefix: string, animated: boolean): string {
  let out = svg.replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')
    .replace(/(<svg[^>]*?)\s+width="\d+"\s+height="\d+"/, '$1')
    .replace(/(<svg[^>]*?)class="lx(?: go)?"/, `$1class="lx${animated ? ' lx-anim' : ''}"`)
    .replace(/(<svg[^>]*?)\s+role="img"/, '$1 focusable="false"')
    .replace(/(<svg[^>]*?)\s+aria-label="[^"]*"/, '$1');
  const ids = [...out.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  for (const original of ids) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`id="${escaped}"`, 'g'), `id="${prefix}-${original}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${prefix}-${original})`)
      .replace(new RegExp(`href="#${escaped}"`, 'g'), `href="#${prefix}-${original}"`);
  }
  return out;
}

/** The illustration alone: inlined, racking in once when it comes into view, paused off-screen. */
export function IllustrationArt({ id, className }: { readonly id: IllustrationId; readonly className?: string }): React.ReactElement {
  const reduce = useReducedMotion();
  const variant = reduce ? 'static' : 'animated';
  const key = sourceKey(id, variant);
  const [svg, setSvg] = useState<string | null>(() => cache.get(key) ?? null);
  const prefix = `lx${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const host = useRef<HTMLSpanElement>(null);
  const inView = useInView(host, { enabled: !reduce });

  useEffect(() => {
    const cached = cache.get(key);
    if (cached) { setSvg(cached); return undefined; }
    const load = SVG_SOURCES[key];
    if (!load) { setSvg(null); return undefined; }
    let live = true;
    void load().then((text) => { cache.set(key, text); if (live) setSvg(text); }).catch(() => { if (live) setSvg(null); });
    return () => { live = false; };
  }, [key]);

  // Rack in once, when first seen (EMPTY-STATES-NOTES: the page adds `.go` when the card enters view).
  useEffect(() => {
    if (!svg || reduce || !inView) return;
    host.current?.querySelector('svg')?.classList.add('go');
  }, [svg, reduce, inView]);

  const markup = svg ? inlineIllustration(svg, prefix, variant === 'animated') : null;
  return <span ref={host} className={`es-art m-loop${className ? ` ${className}` : ''}`} aria-hidden="true" data-illustration={id} data-variant={variant}
    {...(markup ? { dangerouslySetInnerHTML: { __html: markup } } : {})} />;
}

export interface EmptyStateAction {
  /** Defaults to the copy.json label for this slot. */
  readonly label?: string;
  /** An in-app path (navigated with history, like the rest of the app) … */
  readonly to?: string;
  /** … or a handler. Without either, the action is not drawn. */
  readonly onClick?: () => void;
  readonly icon?: IconName;
}

export interface EmptyStateProps {
  readonly id: IllustrationId;
  readonly title?: React.ReactNode;
  readonly body?: React.ReactNode;
  readonly primary?: EmptyStateAction;
  readonly secondary?: EmptyStateAction;
  /** Shows the copy.json privacy note (true) or a caller's own note. */
  readonly note?: boolean | React.ReactNode;
  /** Shows the copy.json helper line (true) or a caller's own helper. */
  readonly helper?: boolean | React.ReactNode;
  /** A real count, e.g. "0 records waiting for a decision"; never the stock line. */
  readonly count?: { readonly value: React.ReactNode; readonly label: React.ReactNode };
  /** h1 for a page of its own (system pages); h2 inside a page (default). */
  readonly headingLevel?: 1 | 2 | 3;
  /** Drawn inside an existing card: no card chrome of its own. */
  readonly bare?: boolean;
  readonly className?: string;
  readonly children?: React.ReactNode;
}

function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function ActionButton({ action, fallback, kind }: { readonly action: EmptyStateAction | undefined; readonly fallback: string | undefined; readonly kind: 'primary' | 'secondary' }): React.ReactElement | null {
  if (!action || (!action.to && !action.onClick)) return null;
  const label = action.label ?? fallback;
  if (!label) return null;
  const onClick = (): void => { if (action.onClick) action.onClick(); else if (action.to) navigate(action.to); };
  return <button type="button" className={kind === 'primary' ? 'pilot-btn es-primary' : 'pilot-btn ghost'} onClick={onClick}>
    {action.icon ? <Icon name={action.icon} size={16} /> : null}{label}{kind === 'primary' ? <Icon name="arrow-right" size={16} /> : null}
  </button>;
}

export function EmptyState({ id, title, body, primary, secondary, note, helper, count, headingLevel = 2, bare = false, className, children }: EmptyStateProps): React.ReactElement {
  const copy = illustrationCopy(id);
  const Heading = `h${headingLevel}` as 'h1' | 'h2' | 'h3';
  const noteText = note === true ? copy.note : note || null;
  const helperText = helper === true ? copy.helper : helper || null;
  const hasActions = Boolean(primary?.to || primary?.onClick || secondary?.to || secondary?.onClick);
  return <section className={`es m-io${bare ? ' es--bare' : ''}${className ? ` ${className}` : ''}`} data-empty-state={id}>
    <IllustrationArt id={id} />
    <Heading className="es-title es-a">{title ?? copy.title}</Heading>
    {count ? <div className="es-count es-a"><b className="num">{count.value}</b><span>{count.label}</span></div> : null}
    <p className="es-body es-a">{body ?? copy.body}</p>
    {helperText ? <div className="es-helper es-a"><Icon name="evidence" size={16} /><span>{helperText}</span></div> : null}
    {hasActions ? <div className="es-ctas es-a">
      <ActionButton action={primary} fallback={copy.primary} kind="primary" />
      <ActionButton action={secondary} fallback={copy.secondary} kind="secondary" />
    </div> : null}
    {children}
    {noteText ? <p className="es-note es-a"><Icon name="lock" size={16} /><span>{noteText}</span></p> : null}
  </section>;
}
