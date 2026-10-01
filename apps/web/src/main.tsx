import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DemoSite } from './demoSite/DemoSite.js';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);
// One codebase, two sites, chosen at build time (ADR-045). VITE_DEMO_SITE=true builds
// demo.oneby8.com - sample data, no sign-in, no API. Anything else builds the real
// application for oneby8.com. The condition is a build-time literal, so each bundle
// carries only its own branch; scripts/check-demo-boundary.mjs proves it.
if (import.meta.env.VITE_DEMO_SITE === 'true') {
  root.render(<React.StrictMode><DemoSite /></React.StrictMode>);
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}
