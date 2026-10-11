// Momentum tokens load first, ahead of every other stylesheet (including pilot.css, which
// App pulls in), so later rules can only consume them, never be undercut by them.
import './styles/tokens.css';
import './styles/aliases.css';
// Sora (headings, figures) and DM Sans (UI) are bundled and served from the app itself, so
// every device renders the same faces instead of falling back to its own system font.
import '@fontsource-variable/sora';
import '@fontsource-variable/dm-sans/opsz.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SandboxMarker } from './sandboxMarker.js';
import './styles.css';
// The Momentum app shell (rail, sidebar, top bars) restyles the shell rules in styles.css, so it loads after it.
import './styles/shell.css';
// Momentum icons: base two-tone rules, then the play-once hover cues for module icons.
import './styles/icons.css';
import './styles/icon-motion.css';
// Momentum components (buttons, fields, tags, cards, KPI tiles, tables, banners, modals, the
// readiness band and small counts) restyle the app's shared classes, so they load last.
import './styles/components.css';
// The Momentum student home (hero, next climb, streak, card rows); scoped under .sh.
import './styles/student-home.css';
import './styles/institution-home.css';
// The employer, operations and growth homes (phase 7) build on the institution-home blocks.
import './styles/business-home.css';
// The signed-out pages: the Infinity Loop sign-in (re-skin phase 10); scoped under .auth-split.si.
import './styles/sign-in.css';
import { applyStoredTheme } from './themePreference.js';
import { dismissBootSplash } from './bootSplash.js';

// A theme chosen with the top-bar toggle is applied before the first paint; otherwise the OS decides.
applyStoredTheme();

const root = createRoot(document.getElementById('root') as HTMLElement);
// One application, two hosts (ADR-046). The sandbox build for demo.oneby8.com is the same
// real application over its own sample database, with the "Demo - sample data" marker
// above every screen. The condition is a build-time literal, so the oneby8.com bundle
// carries no marker; scripts/check-demo-boundary.mjs proves it.
if (import.meta.env.VITE_SANDBOX === 'true') {
  root.render(<React.StrictMode><SandboxMarker /><App /></React.StrictMode>);
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}
// The boot screen in index.html stays until React has painted its first frame, then fades out.
requestAnimationFrame(() => requestAnimationFrame(() => dismissBootSplash()));
