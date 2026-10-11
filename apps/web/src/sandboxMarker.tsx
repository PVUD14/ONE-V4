/**
 * The "Demo - sample data" marker every sandbox screen carries (ADR-046).
 *
 * demo.oneby8.com runs the real application over fictional sample data. This strip sits
 * above every page of that build - sign-in, workspace chooser and every portal - so
 * nobody mistakes the sandbox for the live product. It uses an existing notice class,
 * and main.tsx renders it only in the sandbox build: the oneby8.com bundle never
 * contains it (scripts/check-demo-boundary.mjs proves both).
 */
import React from 'react';

export function SandboxMarker(): React.ReactElement {
  return <div className="staff-demo-notice" role="note" data-one-sandbox="true">
    <span><strong>Demo — sample data</strong></span>
    <span>This is the ONE sandbox. Every person, college and company here is fictional, and it resets every night.</span>
  </div>;
}
