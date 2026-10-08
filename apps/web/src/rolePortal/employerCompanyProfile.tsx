/**
 * ONE · Employer portal — Company Profile (EMP-04).
 *
 * The screen behind the employer navigation's existing "Company Profile" label, which said
 * "Not built yet" until the company-profile API existed. It shows what students see about the
 * company on every job, and lets the employer's owner and admins describe the company — about,
 * industry, size band and careers page. Recruiters see the same profile read-only.
 *
 * The details AI8HT operations verifies the employer against (legal name, display name,
 * website, address, contact email) are shown read-only with "Managed by AI8HT operations":
 * the server refuses them from the employer side, so a verified record cannot drift. Whether
 * the viewer may edit is the server's answer (canEdit); this page never decides authority.
 * Nothing is invented: a field nobody has filled says "Not provided".
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getProtectedAccessToken } from '../api.js';
import {
  companyIndustryLabels,
  companySizeLabel,
  getEmployerCompanyProfile,
  updateEmployerCompanyProfile,
  type EmployerCompanyProfileDto,
} from '../api/hiring.js';
import { V2Stat } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { formatApiError } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import * as dates from '../dates.js';

const notProvided = 'Not provided';
const verificationLabels: Readonly<Record<string, string>> = {
  PENDING: 'Awaiting review',
  UNDER_REVIEW: 'Under review',
  VERIFIED: 'Verified',
  REJECTED: 'Not approved',
  SUSPENDED: 'Suspended',
};

function formatDate(value: string | null): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : dates.formatDate(date);
}

function location(profile: EmployerCompanyProfileDto): string {
  return [profile.city, profile.stateOrProvince, profile.countryCode].filter(Boolean).join(', ') || notProvided;
}

interface Draft { about: string; industry: string; companySizeBand: string; careersPageUrl: string }

function draftFrom(profile: EmployerCompanyProfileDto): Draft {
  return { about: profile.about ?? '', industry: profile.industry ?? '', companySizeBand: profile.companySizeBand ?? '', careersPageUrl: profile.careersPageUrl ?? '' };
}

export function EmployerCompanyProfilePage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [profile, setProfile] = useState<EmployerCompanyProfileDto | null>(null);
  const [draft, setDraft] = useState<Draft>({ about: '', industry: '', companySizeBand: '', careersPageUrl: '' });
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getEmployerCompanyProfile(token, employerId, controller.signal).then(({ companyProfile }) => {
      if (controller.signal.aborted) return;
      setProfile(companyProfile); setDraft(draftFrom(companyProfile)); setLoadError('');
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(cause instanceof ApiRequestError && cause.code === 'EMPLOYER_ORGANISATION_INACTIVE'
        ? `Your employer account is suspended or was not approved, so the company profile is not available.${supportCodeSuffix(cause.correlationId)}`
        : formatApiError(cause, 'Your company profile could not be loaded.'));
    });
    return () => controller.abort();
  }, [token, employerId]);

  const subtitle = 'What students see about your company on every job you post.';
  if (!token) return <StaffPilotWrap title="Company Profile" subtitle="Sign in with an employer identity to see your company profile."><p role="status">You are not signed in.</p></StaffPilotWrap>;
  if (loadError) return <StaffPilotWrap title="Company Profile" subtitle={subtitle}><p className="form-error" role="alert">{loadError}</p></StaffPilotWrap>;
  if (!profile) return <StaffPilotWrap title="Company Profile" subtitle={subtitle}><p role="status">Loading your company profile…</p></StaffPilotWrap>;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!profile) return;
    const original = draftFrom(profile);
    const changes: Record<string, string | null> = {};
    for (const key of ['about', 'industry', 'companySizeBand', 'careersPageUrl'] as const) {
      if (draft[key].trim() !== original[key]) changes[key] = draft[key].trim() || null;
    }
    if (!Object.keys(changes).length) { setNotice('Nothing to save.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { companyProfile } = await updateEmployerCompanyProfile(token!, employerId, changes);
      setProfile(companyProfile); setDraft(draftFrom(companyProfile));
      setNotice('Company profile saved. Students see it on your jobs.');
    } catch (cause) {
      setError(formatApiError(cause, 'The company profile could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  const industry = profile.industry ? companyIndustryLabels[profile.industry] ?? profile.industry : null;
  const name = profile.displayName ?? profile.legalName;

  return <StaffPilotWrap title="Company Profile" subtitle={subtitle}>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🛡️" tone="teal" value={verificationLabels[profile.verificationState] ?? 'NA'} label="Verification" />
      <V2Stat icon="🏭" tone="blue" value={industry ?? 'NA'} label="Industry" />
      <V2Stat icon="👥" tone="amber" value={profile.companySizeBand ?? 'NA'} label="Company size" />
      <V2Stat icon="🕒" tone="purple" value={formatDate(profile.updatedAt)} label="Last updated" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    <section className="role-card role-wide" aria-label="How students see you">
      <h2>How students see you</h2>
      <p><strong>{name}</strong>{industry ? ` · ${industry}` : ''}{profile.companySizeBand ? ` · ${companySizeLabel(profile.companySizeBand)}` : ''}</p>
      <p>{profile.about ?? 'No description yet.'}</p>
      <p className="hiring-meta">{location(profile)}{profile.careersPageUrl ? ` · Careers: ${profile.careersPageUrl}` : ''}</p>
      {profile.verificationState !== 'VERIFIED' ? <p className="hiring-meta">Students see this profile only once AI8HT operations has verified your company.</p> : null}
    </section>

    {profile.canEdit ? <form className="role-card role-wide role-management-form" aria-label="Edit company profile" onSubmit={(event) => void save(event)}>
      <h2>Describe your company</h2>
      {!profile.profileSetUp ? <p>AI8HT operations has not finished setting up your company record, so this cannot be saved yet.</p> : null}
      <label><span>About the company</span><textarea value={draft.about} maxLength={2000} rows={5}
        onChange={(event) => setDraft((value) => ({ ...value, about: event.target.value }))} /></label>
      <label><span>Industry</span><select value={draft.industry} onChange={(event) => setDraft((value) => ({ ...value, industry: event.target.value }))}>
        <option value="">Not provided</option>
        {profile.options.industries.map((code) => <option key={code} value={code}>{companyIndustryLabels[code] ?? code}</option>)}
      </select></label>
      <label><span>Company size</span><select value={draft.companySizeBand} onChange={(event) => setDraft((value) => ({ ...value, companySizeBand: event.target.value }))}>
        <option value="">Not provided</option>
        {profile.options.sizeBands.map((band) => <option key={band} value={band}>{companySizeLabel(band)}</option>)}
      </select></label>
      <label><span>Careers page (on your website)</span><input type="url" value={draft.careersPageUrl} placeholder={profile.websiteUrl ?? 'https://'}
        onChange={(event) => setDraft((value) => ({ ...value, careersPageUrl: event.target.value }))} /></label>
      <button type="submit" disabled={busy || !profile.profileSetUp}>Save profile</button>
    </form> : <section className="role-card role-wide"><h2>Managed by your owner or admin</h2>
      <p>Recruiters see the company profile but do not change it. Ask your employer's owner or admin if something here needs to change.</p>
    </section>}

    <section className="role-card role-wide" aria-label="Verified details">
      <h2>Verified details</h2>
      <p>Managed by AI8HT operations. These are what your company was verified against, so they change only through operations.</p>
      <div className="role-record-table-wrap"><table className="role-record-table">
        <tbody>
          <tr><th scope="row">Legal name</th><td>{profile.legalName}</td></tr>
          <tr><th scope="row">Display name</th><td>{profile.displayName ?? notProvided}</td></tr>
          <tr><th scope="row">Website</th><td>{profile.websiteUrl ?? notProvided}</td></tr>
          <tr><th scope="row">Location</th><td>{location(profile)}</td></tr>
          <tr><th scope="row">Contact email</th><td>{profile.primaryContactEmail ?? notProvided}</td></tr>
        </tbody>
      </table></div>
    </section>
  </StaffPilotWrap>;
}
