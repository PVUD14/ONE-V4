/**
 * Dismisses the boot screen that index.html shows before the application has loaded (the
 * approved splash, design inventory 05-brand/splash.html). Once React has painted its first
 * frame the splash fades out over --m-base (450ms) and is removed; with reduced motion it is
 * removed at once. Nothing else depends on it, so a missing element is not an error.
 */
export function dismissBootSplash(doc: Document = document): void {
  const splash = doc.getElementById('one-boot');
  if (!splash) return;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { splash.remove(); return; }
  splash.classList.add('is-done');
  splash.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => splash.remove(), 500);
}
