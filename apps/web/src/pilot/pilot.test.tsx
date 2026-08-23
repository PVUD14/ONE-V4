import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PilotApp, pilotPersonaFor } from './PilotApp.js';
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

  it('renders the Tier 2 pages with real sample content', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }));
    expect(screen.getByRole('heading', { name: 'Practice' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Company Prep' }));
    expect(screen.getByRole('heading', { name: 'Company Preparation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Career Tools' }));
    expect(screen.getByRole('heading', { name: 'Career Tools' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scholarships' }));
    expect(screen.getByRole('heading', { name: 'Scholarships' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume Builder' }));
    expect(screen.getByRole('heading', { name: 'Resume Builder' })).toBeInTheDocument();
  });

  it('opens a relevant sample dialog for any unwired control', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'View Calendar' }));
    expect(screen.getByRole('dialog', { name: 'Calendar' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('walks an application through the sample form to the applied state', () => {
    render(<PilotApp email="demo.student@uat.example.test" onSignOut={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply Now' })[0]!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit Application' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Applied ✓' })).toBeInTheDocument();
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

describe('persona resolution and cross-portal coherence', () => {
  it('maps demo addresses to the right portal', () => {
    expect(pilotPersonaFor('demo.student@uat.example.test')).toBe('student');
    expect(pilotPersonaFor('demo.institution@uat.example.test')).toBe('institution');
    expect(pilotPersonaFor('demo.placement@uat.example.test')).toBe('institution');
    expect(pilotPersonaFor('demo.employer@uat.example.test')).toBe('employer');
    expect(pilotPersonaFor('demo.recruiter@uat.example.test')).toBe('employer');
    expect(pilotPersonaFor('demo.client@partner.example')).toBe('student');
  });

  it('shows the placement officer her college, with Arjun in the roster at his real number', () => {
    render(<PilotApp email="demo.institution@uat.example.test" onSignOut={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Placement Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Sample data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Students' }));
    // The same student the client met in the first demo, same readiness figure.
    expect(screen.getByText('Arjun Reddy')).toBeInTheDocument();
    expect(screen.getByText(/Shortlisted · Zenvia Labs/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Placement Drives' }));
    expect(screen.getByRole('heading', { name: 'Placement Drives' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }));
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
  });

  it('shows the recruiter Zenvia Labs, with Arjun shortlisted in the pipeline', () => {
    render(<PilotApp email="demo.employer@uat.example.test" onSignOut={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Recruiter Dashboard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Applicants' }));
    expect(screen.getByText('Arjun Reddy')).toBeInTheDocument();
    expect(screen.getAllByText('Shortlisted').length).toBeGreaterThan(0);
    // Advancing a candidate moves the stage chip live - the demo moment.
    fireEvent.click(screen.getAllByRole('button', { name: 'Advance' })[0]!);
    expect(screen.getAllByText('Assessment').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));
    expect(screen.getByText('Graduate Software Engineer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Interviews' }));
    expect(screen.getByRole('heading', { name: 'Interviews' })).toBeInTheDocument();
  });
});
