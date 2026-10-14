/**
 * The Momentum motion runtime (re-skin phase 11), ported from the approved pages' `M` runtime
 * (inventory directions-animated/C-momentum/MOTION-NOTES.md, unified/student-home.html).
 *
 * It exists so motion plays the way the approved pages play it — when a block comes into view,
 * once per mount — without every screen wiring its own observer. A screen only adds classes:
 *   - `.m-io`  an entrance host. Its own and its descendants' entrance keyframes stay paused on
 *              their first frame until the host is in view; then `data-m-in` is set and they run.
 *              A host that enters view after the page's opening choreography (700ms) also gets
 *              `--m-load: 0`, which stylesheets use to drop the "wait for the hero" part of their
 *              delays, as the approved runtime does with `data-initd0`.
 *   - `.m-loop` an ambient loop host (hero drift and sweep, streak flame, next-step nudge). Its
 *              animations pause while it is off-screen (`data-m-off`) or the tab is hidden
 *              (`data-m-hidden` on <html>), so nothing animates that nobody can see.
 * Everything here is presentational. Under `prefers-reduced-motion: reduce` no keyframe is
 * defined at all (styles/motion.css), so the final state renders and nothing waits on this code.
 */
import { useEffect, useState, type RefObject } from 'react';

/** True when motion is unwanted, or when the browser cannot run it (tests, very old engines). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || typeof window.requestAnimationFrame !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The current reduced-motion preference, kept up to date if the person changes it. */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduce(prefersReducedMotion());
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduce;
}

/** The approved runtime's in-view rule: 18% of the element visible. */
const IN_VIEW_THRESHOLD = 0.18;

/**
 * True once the element has been in view (and stays true: entrances run once per mount). Where
 * IntersectionObserver is missing the element counts as in view at once, so nothing is held back.
 */
export function useInView<T extends Element>(ref: RefObject<T | null>, { threshold = IN_VIEW_THRESHOLD, enabled = true }: { readonly threshold?: number; readonly enabled?: boolean } = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!enabled || inView) return undefined;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setInView(true); return undefined; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setInView(true); observer.disconnect(); }
    }, { threshold });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold, enabled, inView]);
  return inView;
}

/** How long the page's opening choreography lasts; later entrances skip its waits. */
const OPENING_MS = 700;

/**
 * Installs the `.m-io` / `.m-loop` runtime on a document once (main.tsx). Returns an uninstall
 * function (used by tests). Safe to call where IntersectionObserver or MutationObserver are
 * missing: every host is then marked in view straight away.
 */
export function installMotion(doc: Document = document): () => void {
  const html = doc.documentElement;
  const started = performance.now();
  const supported = typeof IntersectionObserver !== 'undefined' && typeof MutationObserver !== 'undefined';

  const reveal = (element: Element): void => {
    if (element.hasAttribute('data-m-in')) return;
    if (performance.now() - started > OPENING_MS && element instanceof HTMLElement) element.style.setProperty('--m-load', '0');
    element.setAttribute('data-m-in', '');
  };

  if (!supported) {
    const all = (): void => doc.querySelectorAll('.m-io').forEach(reveal);
    all();
    return () => undefined;
  }

  const entrances = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entrances.unobserve(entry.target);
      reveal(entry.target);
    }
  }, { threshold: IN_VIEW_THRESHOLD });

  const loops = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute('data-m-off', !entry.isIntersecting);
  }, { threshold: 0 });

  const seen = new WeakSet<Element>();
  const scan = (root: ParentNode): void => {
    const viewport = doc.defaultView?.innerHeight ?? 0;
    root.querySelectorAll('.m-io, .m-loop').forEach((element) => {
      if (seen.has(element)) return;
      seen.add(element);
      if (element.classList.contains('m-loop')) loops.observe(element);
      if (!element.classList.contains('m-io')) return;
      // Above the fold at mount: play now, in the same frame, so the opening choreography holds.
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.top < viewport * 0.92 && box.bottom > 0) reveal(element);
      else entrances.observe(element);
    });
  };

  let queued = false;
  const mutations = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // A microtask, not a frame: hosts are seen before the browser paints their first frame.
    queueMicrotask(() => { queued = false; scan(doc); });
  });
  // Class changes too: a block can become a host when its data arrives.
  mutations.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  scan(doc);

  const onVisibility = (): void => { html.toggleAttribute('data-m-hidden', doc.visibilityState === 'hidden'); };
  doc.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  return () => {
    mutations.disconnect();
    entrances.disconnect();
    loops.disconnect();
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
