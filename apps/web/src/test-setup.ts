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
import { expect } from 'vitest';

type MatcherSet = Parameters<typeof expect.extend>[0];

const namespace = jestDomMatchers as unknown as { readonly default?: MatcherSet };
const matchers: MatcherSet = namespace.default ?? (jestDomMatchers as unknown as MatcherSet);

expect.extend(matchers);
