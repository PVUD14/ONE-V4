/**
 * Badge artwork, loaded on demand. The approved SVGs (design inventory 04-badges/svg and
 * animated) are inlined rather than drawn through <img>, because the in-progress art fills to
 * the CSS custom property --p, and the one-shot unlock animates the layers tagged bd-*. Each file
 * is its own lazy chunk, so a page that shows no badge loads none of them.
 *
 * Before inlining, the markup is made safe to repeat and quiet for assistive technology: the
 * root loses its role and label (the Badge component names the badge once, with its state), the
 * in-progress file loses its baked demonstration value of --p (the caller's real count applies),
 * and the animated file loses its own 6s looping <style> (the product plays a one-shot instead).
 */
const loaders = import.meta.glob<string>('./art/**/*.svg', { query: '?raw', import: 'default' });

export function hasBadgeArt(file: string): boolean {
  return `./art/${file}` in loaders;
}

export function prepareBadgeMarkup(markup: string): string {
  return markup
    .replace(/<style>[\s\S]*?<\/style>/g, (style) => (style.includes('@keyframes') ? '' : style))
    .replace(/<svg([^>]*)>/, (_tag, attributes: string) => `<svg${attributes
      .replace(/\s(role|aria-label)="[^"]*"/g, '')
      .replace(/\sstyle="--p:[^"]*"/, '')} aria-hidden="true" focusable="false">`)
    .replace(/<title>[\s\S]*?<\/title>/g, '');
}

const cache = new Map<string, Promise<string>>();

/** The prepared markup of a catalogue file (e.g. "svg/streak-7-progress.svg"). */
export function loadBadgeArt(file: string): Promise<string> {
  const key = `./art/${file}`;
  const loader = loaders[key];
  if (!loader) return Promise.reject(new Error(`no badge art ${file}`));
  let pending = cache.get(key);
  if (!pending) {
    pending = loader().then(prepareBadgeMarkup);
    cache.set(key, pending);
  }
  return pending;
}
