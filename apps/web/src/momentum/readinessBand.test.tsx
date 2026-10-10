// Tests for <ReadinessBand>: band enum in, four states, three variants, privacy line always shown,
// no number anywhere, and never imported by employer code.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { READINESS_BANDS, READINESS_BAND_LABELS, READINESS_PRIVACY_LINE, ReadinessBand, toReadinessBand } from './readinessBand.js';

describe('<ReadinessBand>', () => {
  it('draws each of the four bands with its label, the You marker and the privacy line', () => {
    for (const band of READINESS_BANDS) {
      const { container, unmount } = render(<ReadinessBand band={band} />);
      expect(screen.getByRole('img', { name: `Readiness band: ${READINESS_BAND_LABELS[band]}` })).toBeInTheDocument();
      expect(container.querySelectorAll('.rb-s')).toHaveLength(4);
      expect(container.querySelector('.rb-s.cur .rb-l')?.textContent).toBe(READINESS_BAND_LABELS[band]);
      expect(container.querySelector('.rb-hop')?.textContent).toBe('You');
      expect(screen.getByText(READINESS_PRIVACY_LINE)).toBeInTheDocument();
      // The top band has no next climb.
      expect(container.querySelector('.rb-nx') === null).toBe(band === 'READY_FOR_NEXT_STEP');
      unmount();
    }
  });

  it('shows the privacy line in every variant', () => {
    for (const variant of ['hero', 'compact'] as const) {
      const { unmount } = render(<ReadinessBand band="PROGRESSING" variant={variant} />);
      expect(screen.getByText(READINESS_PRIVACY_LINE)).toBeVisible();
      unmount();
    }
    render(<ReadinessBand band="PROGRESSING" variant="mini" />);
    expect(screen.getByText('Progressing')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: READINESS_PRIVACY_LINE })).toBeInTheDocument();
  });

  it('marks the hero variant for the gradient and the mini variant with four slanted bars', () => {
    const hero = render(<ReadinessBand band="DEVELOPING" variant="hero" />);
    expect(hero.container.querySelector('.rb.on-grad')).not.toBeNull();
    hero.unmount();
    const mini = render(<ReadinessBand band="DEVELOPING" variant="mini" />);
    expect(mini.container.querySelectorAll('.mb i')).toHaveLength(4);
    expect(mini.container.querySelectorAll('.mb i.f')).toHaveLength(2);
    expect(mini.container.querySelectorAll('.mb i.c')).toHaveLength(1);
  });

  it('has a no-band state and shows no digit, percent or score anywhere', () => {
    const { container, unmount } = render(<ReadinessBand band={null} />);
    expect(screen.getByText('No advisory band yet')).toBeInTheDocument();
    expect(container.querySelector('.rb-hop')).toBeNull();
    unmount();
    for (const band of [...READINESS_BANDS, null]) {
      for (const variant of ['hero', 'compact', 'mini'] as const) {
        const view = render(<ReadinessBand band={band} variant={variant} />);
        // The privacy line itself says "never a score"; everything else carries no figure at all.
        expect((view.container.textContent ?? '').replace(READINESS_PRIVACY_LINE, '')).not.toMatch(/\d|%|score/i);
        expect(view.container.querySelector('[aria-valuenow], progress')).toBeNull();
        view.unmount();
      }
    }
  });

  it('cannot be given a number: it is a type error, and a non-band value at run time draws the no-band state', () => {
    // @ts-expect-error a numeric readiness value is not a band and must not compile
    const numeric = <ReadinessBand band={3} />;
    // @ts-expect-error nor may a percentage string pass as a band
    const percent = <ReadinessBand band="75%" />;
    const { container } = render(<>{numeric}{percent}</>);
    expect(container.textContent).not.toMatch(/\d/);
    expect(screen.getAllByText('No advisory band yet')).toHaveLength(2);
    expect(toReadinessBand(3)).toBeNull();
    expect(toReadinessBand('PRIVATE_UPSTREAM_STATE')).toBeNull();
    expect(toReadinessBand('PROGRESSING')).toBe('PROGRESSING');
  });
});

/** Every source file an employer can reach: employer pages, the talent pool and the shared hiring screens. */
function employerFacingFiles(): string[] {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const shared = /^(hiringPages|talentPool|applicationSnapshotView|applicationMessages|skillEvidence|interviewScheduling|staffDashboardsV3)\.tsx$/;
  return files.filter((path) => {
    const name = path.split(/[\\/]/).pop()!;
    return /employer|recruiter/i.test(name) || shared.test(name);
  });
}

describe('employer code and readiness (rule 2)', () => {
  it('finds the employer-facing files it guards', () => {
    const names = employerFacingFiles().map((path) => path.split(/[\\/]/).pop());
    expect(names).toEqual(expect.arrayContaining(['employer.tsx', 'employerReports.tsx', 'talentPool.tsx', 'hiringPages.tsx', 'pilotEmployerPages.tsx']));
  });

  it('never imports or renders the readiness band in any employer-facing file', () => {
    const offenders = employerFacingFiles().filter((path) => {
      const source = readFileSync(path, 'utf8');
      return /momentum\/readinessBand|\bReadinessBand\b|READINESS_BAND/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
