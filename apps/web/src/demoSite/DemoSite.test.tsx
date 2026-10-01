/**
 * The demo site (demo.oneby8.com) is what a college sees before it signs. These tests
 * hold it to the rules that matter there: every role opens and every page in it
 * renders, every screen carries the demo marker, the ONE logo and tagline are present,
 * readiness is only ever a band (and never reaches the employer), and no real
 * institution's name is borrowed for the fiction.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_MARKER, DEMO_ROLES, DEMO_TAGLINE, DemoSite, JOIN_PATH } from './DemoSite.js';

const REAL_INSTITUTIONS = /\bVIT\b|Vellore|\bNIT\b|Anna University|\bSRM\b|\bIIT\b|\bBITS\b|Manipal|Amrita/;
const NUMERIC_READINESS = /readiness[^.]{0,30}\b\d{1,3}\s*(\/\s*100|%)|\b\d{1,3}\s*(\/\s*100|%)[^.]{0,12}readiness|readiness score/i;
const BAND_LABELS = /Ready for next step|Not enough evidence|\bProgressing\b|\bDeveloping\b/;

function openAt(path: string): void {
  window.history.pushState(null, '', path);
  render(<DemoSite />);
}

function navButtons(): HTMLElement[] {
  const nav = screen.getByRole('complementary', { name: 'Pilot navigation' });
  return within(nav).getAllByRole('button');
}

beforeEach(() => window.history.pushState(null, '', '/'));
afterEach(() => cleanup());

describe('demo site landing', () => {
  it('shows the ONE logo, the tagline, the demo marker and every role', () => {
    openAt('/');
    expect(screen.getAllByAltText('ONE by AI8HT').length).toBeGreaterThan(0);
    expect(screen.getByText(DEMO_TAGLINE)).toBeInTheDocument();
    expect(screen.getByText(DEMO_MARKER)).toBeInTheDocument();
    for (const role of ['Student', 'Graduate', 'Placement Officer', 'Lecturer', 'Employer', 'Operations', 'Growth']) {
      expect(screen.getByRole('button', { name: `Open ${role} demo` })).toBeInTheDocument();
    }
    expect(document.title).toBe('Demo | ONE by AI8HT');
  });

  it('opens a role from its card and comes back with Switch role', () => {
    openAt('/');
    fireEvent.click(screen.getByRole('button', { name: 'Open Lecturer demo' }));
    expect(window.location.pathname).toBe('/lecturer');
    expect(screen.getByRole('heading', { name: 'Good morning, Prof. Raman' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch role' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('button', { name: 'Open Student demo' })).toBeInTheDocument();
  });

  it('walks a student through joining and lands on the dashboard', () => {
    openAt(JOIN_PATH);
    expect(screen.getByText(DEMO_MARKER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept Invitation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'These Are Right' }));
    expect(screen.getByText('Readiness band visible to employers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open My Dashboard/ }));
    expect(window.location.pathname).toBe('/student');
    expect(screen.getByText('Good morning, Arjun! 👋')).toBeInTheDocument();
  });
});

describe('every role, every page', () => {
  for (const role of DEMO_ROLES) {
    it(`${role.role}: each page renders with the marker, the brand, bands only and fictional names`, () => {
      openAt(role.path);
      const labels = navButtons().map((button) => button.textContent?.trim() ?? '');
      expect(labels.length).toBeGreaterThanOrEqual(3);
      for (const label of labels) {
        fireEvent.click(within(screen.getByRole('complementary', { name: 'Pilot navigation' })).getByRole('button', { name: label }));
        expect(screen.getByText(DEMO_MARKER)).toBeInTheDocument();
        expect(screen.getByText(DEMO_TAGLINE)).toBeInTheDocument();
        expect(screen.getAllByAltText('ONE by AI8HT').length).toBeGreaterThan(0);
        const text = document.body.textContent ?? '';
        expect(text, `${role.role} → ${label}`).not.toMatch(NUMERIC_READINESS);
        expect(text, `${role.role} → ${label}`).not.toMatch(REAL_INSTITUTIONS);
        if (role.role === 'Employer') expect(text, `Employer → ${label}`).not.toMatch(BAND_LABELS);
      }
    });
  }
});

describe('demo stories', () => {
  it('placement officer uploads a roster and sees the invited batch', () => {
    openAt('/placement-officer');
    fireEvent.click(screen.getByRole('button', { name: 'Students' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload Roster' }));
    fireEvent.click(screen.getByRole('button', { name: /Use sample file/ }));
    expect(screen.getByText('Row 88')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Import 117/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText(/117 students invited/)).toBeInTheDocument();
  });

  it('a graduate requests verification and the request is listed as waiting', () => {
    openAt('/graduate');
    fireEvent.click(screen.getByRole('button', { name: 'Request Verification' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: /Send Request/ }));
    expect(screen.getByText(/marked as a former student/)).toBeInTheDocument();
    expect(screen.getByText('Degree awarded, Final CGPA')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for college').length).toBeGreaterThan(0);
  });

  it('the lecturer sees the graduate as a former student and verifies the record', () => {
    openAt('/lecturer');
    fireEvent.click(screen.getByRole('button', { name: 'Evidence & Verification' }));
    fireEvent.click(screen.getByRole('button', { name: /Academic record requests/ }));
    const row = screen.getByText('Kavitha Selvam').closest('tr') as HTMLElement;
    expect(within(row).getByText('Former student')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(within(screen.getByText('Kavitha Selvam').closest('tr') as HTMLElement).getByText('Verified')).toBeInTheDocument();
  });

  it('operations onboards a college and it joins the table at "Admin invited"', () => {
    openAt('/operations');
    fireEvent.click(screen.getByRole('button', { name: 'Colleges' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onboard a College' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Verified' }));
    fireEvent.click(screen.getByRole('button', { name: /Send Invitation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const row = screen.getByText('Greenfield Polytechnic College').closest('tr') as HTMLElement;
    expect(within(row).getByText('Admin invited')).toBeInTheDocument();
  });

  it('the employer sees only consented evidence, and is told readiness is never shared', () => {
    openAt('/employer');
    fireEvent.click(screen.getByRole('button', { name: 'Applicants' }));
    const row = screen.getByText('Arjun Reddy').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Profile' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Skill evidence shared with consent')).toBeInTheDocument();
    expect(within(dialog).getByText(/Readiness bands, marks they did not share and counselling notes are never visible to employers/)).toBeInTheDocument();
    expect(dialog.textContent ?? '').not.toMatch(BAND_LABELS);
  });

  it('resets on reload: a fresh mount has none of the previous session’s changes', () => {
    openAt('/operations');
    fireEvent.click(screen.getByRole('button', { name: 'Colleges' }));
    fireEvent.click(screen.getByRole('button', { name: 'Onboard a College' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Verified' }));
    fireEvent.click(screen.getByRole('button', { name: /Send Invitation/ }));
    cleanup();
    openAt('/operations');
    fireEvent.click(screen.getByRole('button', { name: 'Colleges' }));
    expect(screen.queryByText('Greenfield Polytechnic College')).not.toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
