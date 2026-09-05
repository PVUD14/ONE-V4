/**
 * Register jest-dom's matchers with Vitest.
 *
 * The documented entry point is `@testing-library/jest-dom/vitest`, but that
 * module imports `vitest` itself and jest-dom does not declare it as a peer
 * dependency. Under pnpm's strict layout it therefore cannot resolve it, and
 * every suite fails during setup on a clean install — including in CI. Pulling
 * the matchers in here resolves both packages from the app, which owns them,
 * and needs no hoisting configuration.
 *
 * jest-dom ships CommonJS: TypeScript models the matchers behind `default`,
 * while Vite's ESM interop puts them on the namespace itself. Accept either
 * rather than picking one and breaking the other.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { configure } from '@testing-library/react';
import { expect } from 'vitest';

type MatcherSet = Parameters<typeof expect.extend>[0];

const namespace = jestDomMatchers as unknown as { readonly default?: MatcherSet };
const matchers: MatcherSet = namespace.default ?? (jestDomMatchers as unknown as MatcherSet);

expect.extend(matchers);

/**
 * Several suites render the whole <App/>, which now mounts the student dashboard
 * with its readiness, mastery and activity fetches before the assertion under test
 * can run. On this machine the heaviest of those waits lands around 700ms against
 * testing-library's 1000ms default, so the suite passes here and fails on slower
 * hardware — the worst kind of red, because it depends on who runs it.
 *
 * Raising the async budget does not slow a passing test: the timeout only bounds
 * how long a *failing* wait is given before it gives up.
 */
configure({ asyncUtilTimeout: 5000 });
