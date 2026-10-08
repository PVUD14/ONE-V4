import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SandboxMarker } from './sandboxMarker.js';
// Inter is bundled and served from oneby8.com itself. Without it each device fell back to its
// own system face (Segoe UI, San Francisco, Roboto) and ONE looked different everywhere.
import '@fontsource-variable/inter';
import './styles.css';

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
