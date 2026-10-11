/**
 * EMP-06 on the employer's Opportunity Detail screen: the job's eligibility, skills and stages
 * as the server returned them, and the editor that saves them as a new version with the current
 * terms sent back unchanged. Rendered through the real route dispatcher for the existing
 * "Opportunity Detail" label, with the API stubbed at fetch; the navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));
vi.mock('../auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../auth.js')>(), getAccessToken: vi.fn(() => 'test-access-token'),
}));

const employerId = crypto.randomUUID();
const jobId = crypto.randomUUID();
const versionTwo = crypto.randomUUID();
const topicId = crypto.randomUUID();
const roleId = crypto.randomUUID();
const portal = rolePortals.find((item) => item.key === 'recruiter') ?? rolePortals[0]!;
const base = `/api/v1/employers/${employerId}/opportunities`;
const navBefore = portal.nav.map((item) => item.label);

function detailWith(requirements: unknown) {
  return {
    opportunity: {
      id: jobId, referenceCode: 'GA-01', lifecycleState: 'PUBLISHED', publishedAt: '2026-09-01T00:00:00Z', closedAt: null,
      createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', canEdit: true, availableActions: ['PAUSE', 'CLOSE', 'WITHDRAW'],
      reasonCodes: { PAUSE: [], CLOSE: ['POSITION_FILLED'], REOPEN: [], WITHDRAW: ['POSTED_IN_ERROR'] },
      audiences: [{ kind: 'PUBLIC', institutionName: null, unitName: null }],
      applicationCount: 1, openApplicationCount: 1, awaitingAcknowledgementCount: 0, lastLifecycleChange: null,
    },
    currentVersion: {
      id: versionTwo, versionNumber: 2, title: 'Graduate analyst', summary: 'Analyse data.', responsibilities: null,
      employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai', positionsAvailable: 3, durationMonths: null,
      compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: '800000.00', compensationMax: null, compensationPeriod: 'YEAR',
      joiningConditions: null, applicationDeadline: '2030-01-01T00:00:00.000Z', createdAt: '2026-09-20T00:00:00Z', requirements,
    },
    versions: [{ id: versionTwo, versionNumber: 2, title: 'Graduate analyst', createdAt: '2026-09-20T00:00:00Z', isCurrent: true, change: 'EDITORIAL', changedTerms: [], changedDetails: ['skills', 'stages'] }],
    requirementReasonCodes: ['ELIGIBILITY_TIGHTENED', 'ELIGIBILITY_RELAXED', 'STAGES_UPDATED'],
  };
}

const withRequirements = {
  eligibilityRules: [
    { ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, valueText: null, isBlocking: true, displayValue: '7' },
    { ruleType: 'CUSTOM', comparator: 'EQ', valueNumeric: null, valueText: 'Willing to relocate', isBlocking: false, displayValue: 'Willing to relocate' },
  ],
  skills: [{ name: 'SQL querying', level: 'REQUIRED', taxonomyTopicId: topicId, catalogue: true }, { name: 'Excel', level: 'PREFERRED', taxonomyTopicId: null, catalogue: false }],
  stages: [{ order: 1, kind: 'SCREENING', label: 'Résumé screen', detail: null, applicationState: 'SCREENING' }, { order: 2, kind: 'INTERVIEW', label: 'Panel interview', detail: 'One hour', applicationState: 'INTERVIEW' }],
  careerRole: null,
};

let detail: ReturnType<typeof detailWith>;
let failWith: { status: number; body: unknown } | null;

beforeEach(() => {
  detail = detailWith(withRequirements);
  failWith = null;
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const requested = new URL(url, window.location.origin).pathname;
    if (init?.method === 'POST') {
      if (failWith) return response(failWith.body, failWith.status);
      if (requested === `${base}/${jobId}/versions`) {
        return response({ version: { id: crypto.randomUUID(), versionNumber: 3, change: 'MATERIAL', changedTerms: ['eligibility'], changedDetails: ['stages'] },
          applicants: { termChangesRecorded: 1, acknowledgementsRequired: 1 } }, 201);
      }
      throw new Error('Unexpected POST ' + requested);
    }
    if (requested === base) return response({ opportunities: [{ id: jobId, referenceCode: 'GA-01', lifecycleState: 'PUBLISHED', title: 'Graduate analyst', versionNumber: 2, applicationCount: 1, openApplicationCount: 1 }] });
    if (requested === `${base}/${jobId}`) return response(detail);
    // EMP-11: the job's campus drives section (none for this job).
    if (requested === `/api/v1/employers/${employerId}/campus-drives`) return response({ drives: [] });
    if (requested === `/api/v1/employers/${employerId}/skill-catalogue`) {
      return response({ skills: [{ taxonomyTopicId: crypto.randomUUID(), name: 'Data visualisation' }], nextCursor: null,
        careerRoles: [{ id: roleId, code: 'D01', title: 'Data analyst', family: 'D' }] });
    }
    throw new Error('Unexpected endpoint ' + requested);
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.history.pushState(null, '', '/'); });

function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body, headers: new Headers() }; }
function show() { return render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Opportunity Detail" />); }
function posts() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> }));
}

describe('EMP-06 eligibility, skills and stages on Opportunity Detail', () => {
  it('shows the rules, skills and stages the current version asks for', async () => {
    show();
    const section = await screen.findByRole('region', { name: 'Eligibility, skills and stages' });
    expect(within(section).getByText(/Minimum CGPA 7 \(10-point scale\)/)).toBeInTheDocument();
    expect(within(section).getByText('Decides who can apply')).toBeInTheDocument();
    expect(within(section).getByText('(shown to students; does not stop anyone applying)')).toBeInTheDocument();
    expect(within(section).getByText('SQL querying (required)')).toBeInTheDocument();
    expect(within(section).getByText('Excel (preferred) · not in the ONE catalogue')).toBeInTheDocument();
    expect(within(section).getByText('Catalogue role: None linked')).toBeInTheDocument();
    expect(within(section).getAllByRole('listitem').map((item) => item.textContent)).toContain('Panel interview (Interview) — One hour');
    const history = screen.getByRole('region', { name: 'Version history' });
    expect(within(history).getByText('Skills, Selection stages')).toBeInTheDocument();
    expect(portal.nav.map((item) => item.label)).toEqual(navBefore);
  });

  it('says so when nothing is set, rather than showing anything invented', async () => {
    detail = detailWith({ eligibilityRules: [], skills: [], stages: [], careerRole: null });
    show();
    const section = await screen.findByRole('region', { name: 'Eligibility, skills and stages' });
    expect(within(section).getByText('No eligibility rules. Anyone the job reaches can apply.')).toBeInTheDocument();
    expect(within(section).getByText('No skills listed.')).toBeInTheDocument();
    expect(within(section).getByText(/No stages set/)).toBeInTheDocument();
  });

  it('saves the edit as a new version against the current one, with the terms unchanged and a reason', async () => {
    show();
    const section = await screen.findByRole('region', { name: 'Eligibility, skills and stages' });
    fireEvent.click(within(section).getByRole('button', { name: 'Edit eligibility, skills and stages' }));
    const form = screen.getByRole('form', { name: 'Edit eligibility, skills and stages' });

    // Tighten the CGPA, add a backlog rule, a catalogue skill, a stage, a role and a reason.
    const [cgpa] = within(form).getAllByRole('group', { name: 'Eligibility rule' });
    fireEvent.change(within(cgpa!).getByLabelText('Value'), { target: { value: '7.5' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add a rule' }));
    const added = within(form).getAllByRole('group', { name: 'Eligibility rule' }).at(-1)!;
    fireEvent.change(within(added).getByLabelText('Rule'), { target: { value: 'MAX_BACKLOGS' } });
    fireEvent.change(within(added).getByLabelText('Value'), { target: { value: '0' } });
    fireEvent.change(within(form).getByLabelText('Search the ONE skill catalogue'), { target: { value: 'visual' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Search' }));
    fireEvent.click(await within(form).findByRole('button', { name: 'Add Data visualisation' }));
    fireEvent.change(within(form).getByLabelText('Catalogue role this job maps to'), { target: { value: roleId } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add a stage' }));
    const stage = within(form).getByRole('group', { name: 'Stage 3' });
    fireEvent.change(within(stage).getByLabelText('Name'), { target: { value: 'HR interview' } });
    fireEvent.change(within(form).getByLabelText(/Reason for the change/), { target: { value: 'ELIGIBILITY_TIGHTENED' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));

    expect(await screen.findByText(/Saved as version 3\. Eligibility changed: 1 applicant must accept the new terms before you can move them on\./)).toBeInTheDocument();
    const [post] = posts();
    expect(post!.path).toBe(`${base}/${jobId}/versions`);
    expect(post!.body).toMatchObject({
      expectedCurrentVersionId: versionTwo, title: 'Graduate analyst', locationCity: 'Chennai', compensationMin: 800000, applicationDeadline: '2030-01-01T00:00:00.000Z',
      reasonCode: 'ELIGIBILITY_TIGHTENED', careerRoleId: roleId,
      eligibilityRules: [
        { ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7.5, isBlocking: true },
        { ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Willing to relocate', isBlocking: false },
        { ruleType: 'MAX_BACKLOGS', comparator: 'LTE', valueNumeric: 0, isBlocking: true },
      ],
      stages: [{ kind: 'SCREENING', label: 'Résumé screen' }, { kind: 'INTERVIEW', label: 'Panel interview', detail: 'One hour' }, { kind: 'INTERVIEW', label: 'HR interview' }],
    });
    expect(post!.body.skills).toEqual([{ taxonomyTopicId: topicId, level: 'REQUIRED' }, { name: 'Excel', level: 'PREFERRED' }, { taxonomyTopicId: expect.any(String), level: 'REQUIRED' }]);
  });

  it('reports a refused rule plainly, with a reference', async () => {
    failWith = { status: 400, body: { error: { code: 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE', correlationId: 'corr-400' } } };
    show();
    fireEvent.click(within(await screen.findByRole('region', { name: 'Eligibility, skills and stages' })).getByRole('button', { name: 'Edit eligibility, skills and stages' }));
    fireEvent.click(within(screen.getByRole('form', { name: 'Edit eligibility, skills and stages' })).getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A rule cannot refer to gender, religion, caste, age, disability, marital status, region of origin or a photo. Support code: corr400');
  });
});
