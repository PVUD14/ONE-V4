/**
 * The system pages (re-skin phase 8): 404, 500 (the error boundary), offline, no access,
 * maintenance and session expired, plus the first-sign-in welcome, each drawn with the matching
 * Lens illustration and its copy.json words (momentum/emptyState.tsx).
 *
 * They exist so a dead end in any portal looks like ONE and says plainly what happened and where to
 * go next, without ever showing an internal identifier, a stack trace or upstream error text: the
 * error boundary logs nothing to the screen but the approved line, and the pages take no error
 * object at all. Every action points at a route that exists for the person looking at it.
 *
 * Wired: 404 (unknown paths, App.tsx and the role portals), 500 (PageErrorBoundary around every
 * shell's content and the app root), offline (OfflineBanner, from the browser's own online state),
 * no access (AccessDeniedPage in App.tsx and the "Not permitted" states), session expired (a saved
 * session that ran out). Not wired, because the app has no such state yet: MaintenancePage (no
 * maintenance flag exists) and OnboardingWelcome (nothing records a first sign-in).
 */
import React, { useEffect, useState } from 'react';
import { EmptyState, illustrationCopy, type EmptyStateAction } from './momentum/emptyState.js';
import { getApiHealth } from './api/core.js';
import { Icon } from './icons/Icon.js';

function Page({ children, inline }: { readonly children: React.ReactNode; readonly inline: boolean }): React.ReactElement {
  if (inline) return <div className="sys-inline">{children}</div>;
  return <main className="sys-page" id="main-content">{children}</main>;
}

/** 404: the page does not exist (or no longer does). */
export function NotFoundPage({ home, help, inline = false }: {
  /** Where "Go to home" leads for this person. */
  readonly home: EmptyStateAction;
  readonly help?: EmptyStateAction;
  /** Drawn inside a portal's shell (navigation stays) rather than as a page of its own. */
  readonly inline?: boolean;
}): React.ReactElement {
  useEffect(() => { if (!inline) document.title = 'Page not found | ONE by AI8HT'; }, [inline]);
  return <Page inline={inline}><EmptyState id="404-not-found" headingLevel={inline ? 2 : 1} primary={home} {...(help ? { secondary: help } : {})} /></Page>;
}

/** 500: something failed while drawing the page. */
export function ServerErrorPage({ onRetry, inline = false }: { readonly onRetry: () => void; readonly inline?: boolean }): React.ReactElement {
  return <Page inline={inline}><EmptyState id="500-something-went-wrong" headingLevel={inline ? 2 : 1} primary={{ onClick: onRetry, icon: 'refresh' }} /></Page>;
}

/** No access: the signed-in person's role does not cover this page. */
export function NoAccessPage({ title, body, primary, children, inline = false }: {
  readonly title?: React.ReactNode; readonly body?: React.ReactNode; readonly primary?: EmptyStateAction;
  readonly children?: React.ReactNode; readonly inline?: boolean;
}): React.ReactElement {
  return <Page inline={inline}><EmptyState id="no-access" headingLevel={inline ? 2 : 1} {...(title ? { title } : {})} {...(body ? { body } : {})} {...(primary ? { primary } : {})}>{children}</EmptyState></Page>;
}

/** Session expired: a saved sign-in ran out; sign in again to continue. */
export function SessionExpiredPage({ onSignIn }: { readonly onSignIn: () => void }): React.ReactElement {
  useEffect(() => { document.title = 'Session expired | ONE by AI8HT'; }, []);
  return <Page inline={false}><EmptyState id="session-expired" headingLevel={1} primary={{ onClick: onSignIn }} /></Page>;
}

/** Maintenance. Built but not wired: the app has no maintenance state to show it from. */
export function MaintenancePage(): React.ReactElement {
  return <Page inline={false}><EmptyState id="maintenance" headingLevel={1} /></Page>;
}

/**
 * The first-sign-in welcome. Built but not wired: nothing in the API records a person's first
 * sign-in, and the app must not guess one (needs backend support).
 */
export function OnboardingWelcome({ firstName, onStart }: { readonly firstName?: string | null; readonly onStart: () => void }): React.ReactElement {
  return <EmptyState id="onboarding-welcome" title={firstName ? `Welcome to ONE, ${firstName}` : undefined} primary={{ onClick: onStart }} />;
}

/**
 * The error boundary behind the 500 page. A render error anywhere inside shows the approved
 * "Something went wrong on our side" page; "Try again" re-draws the content. Changing `resetKey`
 * (the route) clears it too, so moving to another page always tries afresh.
 */
export class PageErrorBoundary extends React.Component<{ readonly children: React.ReactNode; readonly resetKey?: string; readonly inline?: boolean }, { readonly failed: boolean; readonly key: string | undefined }> {
  override state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { readonly resetKey?: string }, state: { readonly failed: boolean; readonly key: string | undefined }): { failed: boolean; key: string | undefined } | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  override render(): React.ReactNode {
    if (this.state.failed) return <ServerErrorPage inline={this.props.inline ?? false} onRetry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * The offline banner: shown while the browser reports no connection, gone as soon as it is back.
 * "Retry now" asks the API's health endpoint; if that answers, the banner closes.
 */
export function OfflineBanner(): React.ReactElement | null {
  const [offline, setOffline] = useState(() => !browserOnline());
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const update = (): void => setOffline(!browserOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  if (!offline) return null;
  async function retry(): Promise<void> {
    setChecking(true);
    const health = await getApiHealth();
    setChecking(false);
    if (health === 'online') setOffline(false);
  }
  const copy = illustrationCopy('offline');
  return <div className="offline-banner" role="status" aria-live="polite" data-empty-state="offline">
    <Icon name="warning" size={20} />
    <div><b>{copy.title}</b><small>{copy.body}</small></div>
    <button type="button" className="pilot-btn small" onClick={() => void retry()} disabled={checking}>{checking ? 'Checking…' : copy.primary}</button>
  </div>;
}

/** The full offline page, for a first load with no connection. */
export function OfflinePage({ onRetry }: { readonly onRetry: () => void }): React.ReactElement {
  return <Page inline={false}><EmptyState id="offline" headingLevel={1} primary={{ onClick: onRetry, icon: 'refresh' }} /></Page>;
}
