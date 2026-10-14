/**
 * Script-aware text for lessons (ENG-16).
 *
 * Why this exists: a student may read lessons in Telugu, and the app's font stack (DM Sans, Segoe UI,
 * system UI) has no Telugu glyphs, so on a machine without a Telugu system font the text would show
 * as empty boxes. This registers the bundled Noto Sans Telugu (SIL Open Font License 1.1, licence in
 * public/fonts/NotoSansTelugu-OFL.txt) through the CSS Font Loading API — no stylesheet is added —
 * limited to the Telugu block so the file is fetched only when Telugu text is on the page, and gives
 * lesson text the `lang` attribute and font family for the language it is actually in.
 */
import type { CSSProperties } from 'react';

const TELUGU_FAMILY = 'ONE Telugu';
const TELUGU_SOURCE = "url('/fonts/NotoSansTelugu-Regular.ttf') format('truetype')";
/** The Telugu block, plus the joiners and the dotted circle Telugu shaping uses. */
const TELUGU_RANGE = 'U+0C00-0C7F, U+200C-200D, U+25CC';
/** The app's own stack after the script font, so Latin text inside a Telugu lesson keeps DM Sans. */
const APP_STACK = '"DM Sans Variable", "DM Sans", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

let registered = false;

/** Register the Telugu face once, where the browser supports it; a failure leaves system fonts. */
export function ensureLessonScriptFonts(): void {
  if (registered || typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return;
  registered = true;
  try {
    document.fonts.add(new FontFace(TELUGU_FAMILY, TELUGU_SOURCE, { unicodeRange: TELUGU_RANGE, display: 'swap' }));
  } catch {
    // The system's own Telugu font, if any, still renders the text.
  }
}

/** Props for an element holding lesson text in `language`: its `lang`, and a Telugu font where needed. */
export function lessonTextProps(language: string | null | undefined): { readonly lang: string; readonly style?: CSSProperties } {
  const lang = language || 'en';
  if (lang !== 'te') return { lang };
  ensureLessonScriptFonts();
  return { lang, style: { fontFamily: `"${TELUGU_FAMILY}", "Noto Sans Telugu", "Nirmala UI", ${APP_STACK}` } };
}
