/**
 * Light or dark theme for the Momentum re-skin.
 *
 * ONE follows the operating system by default (prefers-color-scheme, handled entirely in
 * styles/tokens.css). A person can override it with the theme toggle; that choice sets
 * data-theme on <html> and is remembered on this device. There is no account-level display
 * preference in the API, so the choice is per device, like the sidebar state. Storage can be
 * unavailable (private windows, blocked site data); the OS theme then applies and nothing
 * breaks.
 */
export type ThemeChoice = 'light' | 'dark';

const storageKey = 'one.theme';

export function storedTheme(): ThemeChoice | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* storage unavailable: follow the OS */ }
  return null;
}

export function systemTheme(): ThemeChoice {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Put a remembered choice on <html> at start-up; without one, the OS decides. */
export function applyStoredTheme(): void {
  const choice = storedTheme();
  if (choice) document.documentElement.setAttribute('data-theme', choice);
  else document.documentElement.removeAttribute('data-theme');
}

export function chooseTheme(choice: ThemeChoice): void {
  document.documentElement.setAttribute('data-theme', choice);
  try { window.localStorage.setItem(storageKey, choice); } catch { /* applied, not remembered */ }
}

/**
 * Subscribe to changes of the theme in force: the toggle (data-theme on <html>) or the OS.
 * Returns the unsubscribe function. Used with React's useSyncExternalStore.
 */
export function subscribeTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(onChange) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let query: MediaQueryList | undefined;
  try { query = window.matchMedia?.('(prefers-color-scheme: dark)'); } catch { query = undefined; }
  query?.addEventListener?.('change', onChange);
  return () => { observer?.disconnect(); query?.removeEventListener?.('change', onChange); };
}

/** The theme in force right now, read from <html> first so the toggle wins over the OS. */
export function currentTheme(): ThemeChoice {
  if (typeof document === 'undefined') return 'light';
  const attribute = document.documentElement.getAttribute('data-theme');
  if (attribute === 'light' || attribute === 'dark') return attribute;
  return systemTheme();
}
