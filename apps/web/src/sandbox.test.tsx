/**
 * The sandbox build's two differences (ADR-046), pinned from the normal build's side: the
 * real application sends its token in Authorization, and the marker says what it is.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { authHeaderName, bearerHeader, isSandboxBuild } from './sandbox.js';
import { SandboxMarker } from './sandboxMarker.js';

describe('sandbox build switches', () => {
  it('is off in a normal build, so the token travels in Authorization', () => {
    expect(isSandboxBuild).toBe(false);
    expect(authHeaderName).toBe('Authorization');
    expect(bearerHeader('abc')).toEqual({ Authorization: 'Bearer abc' });
  });

  it('labels the sandbox as sample data', () => {
    render(<SandboxMarker />);
    expect(screen.getByRole('note')).toHaveTextContent('Demo — sample data');
    expect(screen.getByRole('note')).toHaveTextContent('fictional');
  });
});
