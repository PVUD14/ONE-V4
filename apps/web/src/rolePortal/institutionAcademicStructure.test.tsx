/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, listInstitutionUnits } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { InstitutionAcademicStructurePage } from './institution.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(),
  getProtectedAccessToken: vi.fn(),
  listInstitutionUnits: vi.fn(),
}));

const institutionId = crypto.randomUUID();
const departmentId = crypto.randomUUID();
const units = [
  { id: departmentId, institutionId, kind: 'DEPARTMENT', name: 'Local department' },
  { id: crypto.randomUUID(), institutionId, kind: 'BATCH', name: 'Local batch', parentUnitId: departmentId },
];
const portal = rolePortals.find((item) => item.key === 'placement-officer')!;

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  vi.mocked(listInstitutionUnits).mockReset().mockResolvedValue({ units });
});
afterEach(cleanup);

describe('InstitutionAcademicStructurePage management modes', () => {
  it.each([
    { mode: 'default', props: {}, role: 'INSTITUTION_ADMIN', manage: true },
    { mode: 'explicit management', props: { canManage: true }, role: 'INSTITUTION_ADMIN', manage: true },
    { mode: 'read-only Placement Officer', props: { canManage: false }, role: 'PLACEMENT_ADMIN', manage: false },
    { mode: 'read-only administrator', props: { canManage: false }, role: 'INSTITUTION_ADMIN', manage: false },
  ])('renders the unit table with appropriate controls in $mode mode', async ({ props, role, manage }) => {
    render(<InstitutionAcademicStructurePage portal={portal}
      authenticatedWorkspace={{ role, organizationId: institutionId }} {...props} />);
    const table = screen.getByRole('table', { name: portal.roleName + ' academic units' });
    expect(await within(table).findByRole('row', { name: /Local batch/ })).toHaveTextContent('Local department');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(listInstitutionUnits).toHaveBeenCalledWith(getProtectedAccessToken(), institutionId);
    if (manage) {
      expect(screen.getByRole('heading', { name: 'Add academic unit' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create unit' })).toBeInTheDocument();
      expect(within(table).getAllByRole('button', { name: 'Edit unit' })).toHaveLength(2);
    } else {
      expect(screen.queryByRole('heading', { name: 'Add academic unit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create unit' })).not.toBeInTheDocument();
      expect(within(table).queryByRole('button', { name: 'Edit unit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(departmentId)).not.toBeInTheDocument();
  });

  it('does not grant a Placement Officer management access when the prop is omitted', async () => {
    vi.mocked(listInstitutionUnits).mockReturnValue(new Promise(() => {}));
    render(<InstitutionAcademicStructurePage portal={portal}
      authenticatedWorkspace={{ role: 'PLACEMENT_ADMIN', organizationId: institutionId }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission');
    expect(screen.queryByRole('button', { name: 'Create unit' })).not.toBeInTheDocument();
  });

  it('still requires authentication in read-only mode', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<InstitutionAcademicStructurePage portal={portal} canManage={false}
      authenticatedWorkspace={{ role: 'PLACEMENT_ADMIN', organizationId: institutionId }} />);
    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
    expect(listInstitutionUnits).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
