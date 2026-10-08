/**
 * Whether the navigation sidebar starts collapsed.
 *
 * On laptop screens (1366px wide or less, which includes 1920px screens at 150% scaling)
 * the full 230-268px sidebar left the page too little room, so it starts as the icon rail
 * there. Once a person expands or collapses it themselves, that choice is remembered on this
 * device and wins over the screen-size default. Storage can be unavailable (private windows,
 * blocked site data); the default then applies and nothing breaks.
 */
const storageKey = 'one.sidebarCollapsed';
export const compactSidebarMaxWidth = 1366;

export function initialSidebarCollapsed(): boolean {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'true' || stored === 'false') return stored === 'true';
  } catch { /* storage unavailable: fall back to the screen-size default */ }
  return typeof window !== 'undefined' && window.innerWidth <= compactSidebarMaxWidth;
}

export function rememberSidebarCollapsed(collapsed: boolean): void {
  try { window.localStorage.setItem(storageKey, String(collapsed)); } catch { /* not remembered */ }
}
