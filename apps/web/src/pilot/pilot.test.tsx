import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PilotApp } from './PilotApp.js';
import { isPilotIdentity } from './pilotIdentity.js';
import { pilotCanon, pilotCompanies, pilotOpportunities, pilotSavedOpportunities } from './pilotData.js';

afterEach(() => cleanup());

describe('pilot identity gate', () => {
  it('admits demo-prefixed accounts and explicit allow-list entries only', () => {
    expect(isPilotIdentity('demo.student@uat.example.test', {})).toBe(true);
    expect(isPilotIdentity('DEMO.Client@one.example', {})).toBe(true);
    expect(isPilotIdentity('client@partner.example', { VITE_PILOT_ACCOUNTS: 'client@partner.example, other@x.y' })).toBe(true);
    // Real identities must never be routed into fiction.
    expect(isPilotIdentity('student.aanya@uat.example.test', {})).toBe(false);
    expect(isPilotIdentity('recruiter@uat.example.test', { VITE_PILOT_ACCOUNTS: 'client@partner.example' })).toBe(false);
    expect(isPilotIdentity('', {})).toBe(false);
    expect(isPilotIdentity(null, {})).toBe(false);
    expect(isPilotIdentity('demo.', {})).toBe(false);
  });
});

describe('pilot experience', () => {
  it('opens on the dashboard with ONE branding and the sample-data marker', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    expect(screen.getByText('Good morning, Arjun! 👋')).toBeInTheDocument();
    expect(screen.getByText('LEARN | PREPARE | BUILD | GROW')).toBeInTheDocument();
    // The honesty marker is always visible, and the mockup's placeholder brand is not.
    expect(screen.getByText('Sample data')).toBeInTheDocument();
    expect(screen.queryByText(/CareerPass/)).not.toBeInTheDocument();
  });

  it('keeps the story consistent: the canonical readiness number appears on the dashboard', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    expect(screen.getByText(pilotCanon.readinessLabel)).toBeInTheDocument();
  });

  it('navigates across all six Tier 1 pages', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'My Roadmap' }));
    expect(screen.getByRole('heading', { name: 'My Roadmap' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Learn' }));
    expect(screen.getByRole('heading', { name: 'Learn' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }));
    expect(screen.getByRole('heading', { name: 'Assessments' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));
    expect(screen.getByRole('heading', { name: 'Opportunities' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(screen.getByRole('heading', { name: 'My Profile' })).toBeInTheDocument();
  });

  it('labels Tier 2 modules as in build instead of faking them', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scholarships Soon' }));
    expect(screen.getByRole('heading', { name: /Scholarships is coming to the pilot/ })).toBeInTheDocument();
  });

  it('uses only fictional companies', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));
    for (const opportunity of pilotOpportunities) {
      expect(screen.getAllByText(new RegExp(opportunity.company.name)).length).toBeGreaterThan(0);
    }
    // No real employer brand anywhere in the dataset by decision.
    const fictional = new Set(pilotCompanies.map((company) => company.name));
    expect(fictional.size).toBe(pilotCompanies.length);
    for (const banned of ['TCS', 'Infosys', 'Wipro', 'Google', 'Amazon', 'Microsoft', 'Accenture']) {
      expect(screen.queryByText(new RegExp(`\\b${banned}\\b`))).not.toBeInTheDocument();
    }
    expect(pilotSavedOpportunities.every((saved) => fictional.has(saved.company.name))).toBe(true);
  });
});
