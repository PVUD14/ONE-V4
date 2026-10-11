/**
 * ONE · Role portal — Stream E — Core
 *
 * Authenticated operations pages: organizations, users and access, content and
 * technical status.
 *
 * Split out of rolePortalPages.tsx so each stream owns its own surface. The
 * shell and the route dispatcher remain there and import from here.
 */
import { ApiRequestError, createOperationsOrganization, getOperationsOrganizationOnboardingStatus, getProtectedAccessToken, inviteInitialOrganizationAdmin, listFeatureFlags, listOperationsInvitations, listOperationsOrganizations, searchAuditEvents, setFeatureFlagState, transitionOrganizationVerification, updateOperationsOrganization } from '../api.js';
import { EmployerAccessRequestsSection } from './operationsEmployerAccessRequests.js';
import { GrowthHandoffsSection } from './growthPipeline.js';
import { EmployerTermsSection } from './operationsEmployerTerms.js';
import { CollegeExitsSection, InstitutionDataTermsOperationsSection } from './operationsInstitutionExits.js';
import type { AuditEventDto, AuditSearchFilters, FeatureFlagDto, OperationsInvitationDto, OrganizationManagementDto } from '../api.js';
import { V2Stat } from '../dashboardsV2.js';
import { OperationsCareerReadinessPanel } from '../operationsCareerReadinessPanel.js';
import type { RolePortalConfig } from '../rolePortalConfig.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError, RestrictedApiState } from './shared.js';
import { RequestApprovalDialog } from './approvals.js';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export function OperationsOrganizationsPage({ portal }: { readonly portal: RolePortalConfig }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [organizations, setOrganizations] = useState<readonly OrganizationManagementDto[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ q: '', kind: '', verification: '' });
  const [form, setForm] = useState({ kind: 'INSTITUTION', legalName: '', displayName: '', countryCode: 'IN', city: '', adminEmail: '' });
  // OPS-02: suspension is dual-controlled; the button files an approval request.
  const [suspending, setSuspending] = useState<OrganizationManagementDto | null>(null);
  const load = useMemo(() => async (signal?: AbortSignal) => {
    if (!token) return;
    const result = await listOperationsOrganizations(token, filters, signal);
    setOrganizations(result.organizations);
  }, [filters, token]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(() => setError('Unable to load organizations for this Operations identity.'));
    return () => controller.abort();
  }, [load]);
  if (!token) return <RestrictedApiState title="Organizations" message="Sign in with an Operations identity to manage organizations." />;
  const pending = organizations.filter((org) => ['PENDING', 'UNDER_REVIEW'].includes(org.verificationState)).length;
  const verified = organizations.filter((org) => org.verificationState === 'VERIFIED').length;
  const suspended = organizations.filter((org) => org.verificationState === 'SUSPENDED').length;
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await createOperationsOrganization(token!, { kind: form.kind, legalName: form.legalName, profile: { displayName: form.displayName, countryCode: form.countryCode, city: form.city, primaryContactEmail: form.adminEmail } });
      setForm({ kind: 'INSTITUTION', legalName: '', displayName: '', countryCode: 'IN', city: '', adminEmail: '' });
      setNotice('Organization created. Send the initial administrator invitation separately when ready.');
      await load();
    } catch {
      setError('Create organization failed. Check required fields and authorization.');
    }
  }
  async function transition(id: string, toState: string): Promise<void> {
    setError('');
    try {
      await transitionOrganizationVerification(token!, id, toState);
      setNotice(`Verification moved to ${toState}.`);
      await load();
    } catch {
      setError('Verification transition was rejected by policy.');
    }
  }
  async function invite(id: string): Promise<void> {
    const email = window.prompt('Initial administrator email');
    if (!email) return;
    try {
      await inviteInitialOrganizationAdmin(token!, id, email);
      setNotice('Initial administrator invitation persisted.');
      await load();
    } catch {
      setError('Initial administrator invitation failed.');
    }
  }
  async function onboarding(id: string): Promise<void> {
    try {
      const result = await getOperationsOrganizationOnboardingStatus(token!, id);
      setNotice(`Onboarding status: ${JSON.stringify(result.status)}`);
    } catch {
      setError('Onboarding status could not be loaded.');
    }
  }
  async function edit(org: OrganizationManagementDto): Promise<void> {
    const legalName = window.prompt('Legal name', org.legalName);
    if (!legalName) return;
    const city = window.prompt('City', org.profile.city ?? '') ?? org.profile.city ?? '';
    try {
      await updateOperationsOrganization(token!, org.id, { legalName, profile: { displayName: org.profile.displayName ?? '', countryCode: org.profile.countryCode ?? 'IN', city, primaryContactEmail: org.profile.primaryContactEmail ?? '', websiteUrl: org.profile.websiteUrl ?? '', institutionType: org.profile.institutionType ?? undefined } });
      setNotice('Organization details updated.');
      await load();
    } catch {
      setError('Organization update failed. Check required fields and authorization.');
    }
  }
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Organizations</h1><p>Manage platform organization onboarding. Operations can create, verify, suspend and invite initial administrators, but cannot manage students here.</p></div></div>
    <section className="role-kpi-grid" aria-label="Organization lifecycle summary"><article className="role-card role-kpi"><span>Total</span><strong>{organizations.length}</strong><p>Institutions and employers</p></article><article className="role-card role-kpi"><span>Pending / Review</span><strong>{pending}</strong><p>Need Operations action</p></article><article className="role-card role-kpi"><span>Verified</span><strong>{verified}</strong><p>Approved organizations</p></article><article className="role-card role-kpi"><span>Suspended</span><strong>{suspended}</strong><p>No student controls exposed</p></article></section>
    <section className="role-card role-wide"><h2>Search and filters</h2><div className="role-management-form"><label><span>Search</span><input value={filters.q} onChange={(event) => setFilters((value) => ({ ...value, q: event.target.value }))} placeholder="Legal/display name" /></label><label><span>Type</span><select value={filters.kind} onChange={(event) => setFilters((value) => ({ ...value, kind: event.target.value }))}><option value="">All</option><option>INSTITUTION</option><option>EMPLOYER</option></select></label><label><span>Verification</span><select value={filters.verification} onChange={(event) => setFilters((value) => ({ ...value, verification: event.target.value }))}><option value="">All</option><option>PENDING</option><option>UNDER_REVIEW</option><option>VERIFIED</option><option>REJECTED</option><option>SUSPENDED</option></select></label></div></section>
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add Organization</h2><label><span>Type *</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option value="INSTITUTION">Institution</option><option value="EMPLOYER">Employer</option></select></label><label><span>Legal Name *</span><input value={form.legalName} onChange={(event) => setForm((value) => ({ ...value, legalName: event.target.value }))} required /></label><label><span>Display Name</span><input value={form.displayName} onChange={(event) => setForm((value) => ({ ...value, displayName: event.target.value }))} /></label><label><span>Country *</span><input value={form.countryCode} onChange={(event) => setForm((value) => ({ ...value, countryCode: event.target.value.toUpperCase() }))} maxLength={2} required /></label><label><span>City</span><input value={form.city} onChange={(event) => setForm((value) => ({ ...value, city: event.target.value }))} /></label><label><span>Primary Admin Email</span><input type="email" value={form.adminEmail} onChange={(event) => setForm((value) => ({ ...value, adminEmail: event.target.value }))} /></label><button type="submit">Create organization</button></form>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real organizations</caption><thead><tr><th>Organization</th><th>Kind</th><th>Location</th><th>Contact</th><th>Verification</th><th>Initial Admin</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{organizations.map((org) => <tr key={org.id} className="role-record-row"><th scope="row"><strong>{org.profile.displayName || org.legalName}</strong><span>{org.legalName}</span><small>{org.profile.websiteUrl ?? 'No website'}</small></th><td>{org.kind}</td><td>{[org.profile.city, org.profile.stateOrProvince, org.profile.countryCode, org.profile.postalCode].filter(Boolean).join(', ') || 'Not set'}</td><td>{org.profile.primaryContactEmail ?? 'Not set'}</td><td><StatusBadge label={org.verificationState} tone="info" /></td><td>{org.initialAdminInvitation?.email ?? 'Not invited'}</td><td>{new Date(org.updatedAt).toLocaleDateString()}</td><td><div className="role-record-actions"><button type="button" className="secondary" onClick={() => void edit(org)}>Edit details</button><button type="button" className="secondary" onClick={() => void onboarding(org.id)}>Onboarding</button>{org.verificationState === 'PENDING' ? <button type="button" onClick={() => void transition(org.id, 'UNDER_REVIEW')}>Begin review</button> : null}{org.verificationState === 'UNDER_REVIEW' ? <><button type="button" onClick={() => void transition(org.id, 'VERIFIED')}>Verify</button><button type="button" className="secondary" onClick={() => void transition(org.id, 'REJECTED')}>Reject</button></> : null}{org.verificationState === 'VERIFIED' ? <button type="button" className="secondary" onClick={() => setSuspending(org)}>Suspend…</button> : null}<button type="button" className="secondary" onClick={() => void invite(org.id)}>Invite admin</button></div></td></tr>)}</tbody></table></div>
    <EmployerAccessRequestsSection organizations={organizations} />
    {/* GROWTH-04: colleges growth reports as signed, linked here to the college operations created. */}
    <GrowthHandoffsSection organizations={organizations} />
    <EmployerTermsSection />
    {/* INST-18: college data-processing terms and the college exit runbook. */}
    <InstitutionDataTermsOperationsSection />
    <CollegeExitsSection organizations={organizations} />
    <section className="role-card role-wide"><h2>Operations boundary</h2><p>Student add/import/transfer controls are intentionally absent from Operations. Those workflows belong to Institution Administration.</p></section>
    {suspending ? <RequestApprovalDialog token={token} actionKey="ORGANIZATION_SUSPEND" payload={{ organizationId: suspending.id }}
      title={`Suspend ${suspending.profile.displayName || suspending.legalName}`}
      details={[['Organization', suspending.legalName], ['Kind', suspending.kind], ['Effect', 'Deactivates the organisation and pauses its published jobs.']]}
      onCancel={() => setSuspending(null)} onFiled={(message) => { setSuspending(null); setNotice(message); }} /> : null}
  </section>;
}

/**
 * Invitation tracking, kept on the Users screen under the OPS-05 account lookup.
 *
 * The unmasked user list that used to sit here is replaced by the account lookup
 * (support.tsx), which masks contacts and audits every read (Appendix 1 §5.5). Chasing
 * stuck organisation invitations is an onboarding job (OPS_ORG_MANAGE) and stays.
 */
export function OperationsInvitationTrackingPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [query, setQuery] = useState('');
  const [invitations, setInvitations] = useState<readonly OperationsInvitationDto[]>([]);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listOperationsInvitations(token, query, controller.signal)
      .then((result) => { setInvitations(result.invitations); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError('Unable to load invitation tracking.');
      });
    return () => controller.abort();
  }, [token, query]);
  if (!token) return null;
  if (forbiddenReference) return <section className="role-card role-wide"><h2>Invitation tracking</h2><p>Invitation tracking is for staff who manage organisations. Reference: {forbiddenReference}</p></section>;
  return <section className="role-card role-wide"><h2>Invitation tracking</h2>
    <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="✉️" tone="amber" value={invitations.filter((invitation) => invitation.state === 'PENDING').length} label="Pending invitations" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <label className="role-local-search"><span>Search invitations by email or organisation</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="person@example.test or organisation" /></label>
    <InvitationInventoryTable invitations={invitations} /></section>;
}

export function OperationsContentReadOnlyPage(): React.ReactElement {
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">READ_ONLY content operations</span><h1>Content Operations</h1><p>Career Readiness governance state and automation status are shown from protected Operations APIs. Content authoring is NOT YET AVAILABLE.</p></div></div><OperationsCareerReadinessPanel /><section className="role-card role-wide"><h2>Authoring boundary</h2><p>CMS-style editing, review submission and publication mutations are intentionally not simulated in Phase 2A.</p></section></section>;
}

export function OperationsTechnicalReadOnlyPage({ routeLabel }: { readonly routeLabel: string }): React.ReactElement {
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">READ_ONLY technical operations</span><h1>{routeLabel}</h1><p>Safe operational status only: API health is visible in the shell, and outbox/workflow/automation status is loaded through the existing Operations status endpoint. Secrets and n8n credentials are never displayed.</p></div></div><OperationsCareerReadinessPanel /><section className="role-card role-wide"><h2>Mutation boundary</h2><p>n8n remains inactive unless explicitly enabled outside this UI. Kill-switch, workflow activation and credential operations are not exposed as Phase 2A buttons.</p></section></section>;
}

/**
 * Audit and security event search.
 *
 * The endpoint behind this has existed and been unreachable: complete, role-gated,
 * keyset-paginated, and with no caller in the web app at all. Nothing new is
 * authorized here — `canSearchAuditEvents` already restricts it to the platform
 * roles, and a denial renders as a denial rather than an empty table, so an
 * unauthorized operator is not told "no events" when the truth is "not for you".
 */
export function OperationsAuditLogPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [draft, setDraft] = useState<AuditSearchFilters>({ action: '', outcome: '', correlationId: '', from: '', to: '' });
  const [applied, setApplied] = useState<AuditSearchFilters>({});
  const [events, setEvents] = useState<readonly AuditEventDto[]>([]);
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    searchAuditEvents(token, { ...applied, ...(cursor ? { cursor } : {}) }, controller.signal)
      .then((result) => { setEvents(result.events); setNextCursor(result.nextCursor); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to search audit events.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, applied, cursor]);

  if (!token) return <RestrictedApiState title="Audit Logs" message="Sign in with an authorized platform identity to search audit and security events." />;

  const apply = (event: React.FormEvent): void => {
    event.preventDefault();
    setCursors([]);
    setApplied({ ...draft });
  };

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">READ_ONLY security operations</span><h1>Audit Logs</h1>
      <p>Search the immutable audit and security record. There is no write path here — audit rows are never edited, so this search cannot become a way to change the evidence it exists to prove.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📜" tone="teal" value={events.length} label="Events on this page" />
      <V2Stat icon="✅" tone="blue" value={events.filter((event) => event.outcome === 'SUCCESS').length} label="Succeeded" />
      <V2Stat icon="⛔" tone="amber" value={events.filter((event) => event.outcome === 'DENIED').length} label="Denied" />
      <V2Stat icon="🏛️" tone="purple" value={new Set(events.map((event) => event.organizationId).filter(Boolean)).size} label="Organizations" />
    </div>
    <section className="role-card role-wide"><form className="role-management-form" onSubmit={apply}>
      <label><span>Action prefix</span><input value={draft.action ?? ''} onChange={(event) => setDraft({ ...draft, action: event.target.value })} placeholder="institution.roster_import" /></label>
      <label><span>Outcome</span><select value={draft.outcome ?? ''} onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}><option value="">Any</option><option value="SUCCESS">SUCCESS</option><option value="DENIED">DENIED</option></select></label>
      <label><span>Correlation ID</span><input value={draft.correlationId ?? ''} onChange={(event) => setDraft({ ...draft, correlationId: event.target.value })} placeholder="Exact match" /></label>
      <label><span>From</span><input type="date" value={draft.from ?? ''} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label><span>To</span><input type="date" value={draft.to ?? ''} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <button type="submit" className="pilot-btn">Search</button>
    </form></section>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide"><h2>Events</h2>
      {loading && !events.length ? <p>Searching…</p> : null}
      {!loading && !events.length && !error ? <p>No audit events match these filters.</p> : null}
      {events.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Occurred</th><th>Action</th><th>Outcome</th><th>Resource</th><th>Actor</th><th>Correlation</th></tr></thead>
        <tbody>{events.map((event) => <tr key={event.id}>
          <td>{new Date(event.occurredAt).toLocaleString()}</td>
          <td>{event.action}</td>
          <td><StatusBadge label={event.outcome} tone={event.outcome === 'DENIED' ? 'danger' : 'success'} /></td>
          <td>{event.resourceType} / {event.resourceId}</td>
          <td>{event.actorUserId}</td>
          <td>{event.correlationId}</td>
        </tr>)}</tbody></table></div> : null}
      <div className="role-actions">
        <button type="button" className="pilot-btn" disabled={!cursors.length || loading} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button>
        <button type="button" className="pilot-btn" disabled={!nextCursor || loading} onClick={() => { if (nextCursor) setCursors([...cursors, nextCursor]); }}>Next</button>
      </div>
    </section>
  </section>;
}

/**
 * Feature flags.
 *
 * A flag is a rollout and kill-switch control, never an entitlement — ADR-022 is
 * explicit that capability gating built before billing must not assume a billing
 * source of truth. The screen says so, because the first person to reach for a flag
 * to answer a commercial question will do it here.
 */
export function OperationsFeatureFlagsPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [flags, setFlags] = useState<readonly FeatureFlagDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reason, setReason] = useState('OPERATIONS_ROLLOUT');
  const [requesting, setRequesting] = useState<FeatureFlagDto | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    listFeatureFlags(token, controller.signal)
      .then((result) => { setFlags(result.flags); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load feature flags.')); });
    return () => controller.abort();
  }, [token]);

  if (!token) return <RestrictedApiState title="Feature Flags" message="Sign in with an authorized platform identity to manage feature flags." />;

  const toggle = async (flag: FeatureFlagDto): Promise<void> => {
    // OPS-02: the risky direction of a high-risk flag files an approval request instead.
    if (isHighRiskChange(flag)) { setRequesting(flag); return; }
    setBusy(flag.key);
    try {
      const result = await setFeatureFlagState(token, flag.key, !flag.enabled, reason);
      setFlags(result.flags);
      setError('');
    } catch (cause) {
      setError(formatApiError(cause, 'The flag could not be changed.'));
    } finally {
      setBusy('');
    }
  };

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Platform operations</span><h1>Feature Flags</h1>
      <p>Rollout and kill-switch control. A flag is never an entitlement — what a customer has paid for is a billing question, and billing does not exist yet (ADR-022). Access stays gated on role and membership.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🚩" tone="teal" value={flags.length} label="Flags defined" />
      <V2Stat icon="✅" tone="blue" value={flags.filter((flag) => flag.enabled).length} label="Enabled globally" />
      <V2Stat icon="🎯" tone="purple" value={flags.reduce((total, flag) => total + flag.overrides, 0)} label="Live overrides" />
      <V2Stat icon="💸" tone="amber" value={flags.filter((flag) => flag.cap).length} label="With a cap" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="role-card role-wide"><label className="role-local-search"><span>Reason code recorded with every change</span>
      <input value={reason} onChange={(event) => setReason(event.target.value.toUpperCase())} placeholder="OPERATIONS_ROLLOUT" /></label></section>
    <section className="role-card role-wide"><h2>Flags</h2>
      {!flags.length && !error ? <p>No feature flags are defined yet.</p> : null}
      {flags.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Key</th><th>Description</th><th>State</th><th>Cap</th><th>Overrides</th><th>Last changed</th><th>Action</th></tr></thead>
        <tbody>{flags.map((flag) => <tr key={flag.key}>
          <td>{flag.key}</td>
          <td>{flag.description}</td>
          <td><StatusBadge label={flag.enabled ? 'ENABLED' : 'OFF'} tone={flag.enabled ? 'success' : 'neutral'} />
            {flag.highRiskDirection ? <><br /><StatusBadge label={`High-risk to ${flag.highRiskDirection === 'ENABLE' ? 'enable' : 'disable'}`} tone="warning" /></> : null}</td>
          <td>{flag.cap ? `${flag.cap.value} ${flag.cap.kind} / ${flag.cap.window}` : 'None'}</td>
          <td>{flag.overrides}</td>
          <td>{flag.lastChangedAt ? new Date(flag.lastChangedAt).toLocaleString() : 'Never'}</td>
          <td><button type="button" className="pilot-btn" disabled={busy === flag.key || (!isHighRiskChange(flag) && !/^[A-Z0-9_:-]{3,64}$/.test(reason))} onClick={() => void toggle(flag)}>
            {busy === flag.key ? 'Saving…' : `${flag.enabled ? 'Disable' : 'Enable'}${isHighRiskChange(flag) ? '…' : ''}`}</button></td>
        </tr>)}</tbody></table></div> : null}
    </section>
    {requesting ? <RequestApprovalDialog token={token} actionKey="FEATURE_FLAG_HIGH_RISK_CHANGE" payload={{ key: requesting.key, enabled: !requesting.enabled }}
      title={`${requesting.enabled ? 'Disable' : 'Enable'} flag ${requesting.key}`}
      details={[['Flag', requesting.key], ['Change', requesting.enabled ? 'Switch off' : 'Switch on'], ['Description', requesting.description]]}
      onCancel={() => setRequesting(null)} onFiled={(message) => { setRequesting(null); setNotice(message); }} /> : null}
  </section>;
}

/** OPS-02: whether toggling this flag goes in its marked high-risk direction. */
function isHighRiskChange(flag: FeatureFlagDto): boolean {
  return (flag.highRiskDirection === 'ENABLE' && !flag.enabled) || (flag.highRiskDirection === 'DISABLE' && flag.enabled);
}

export function InvitationInventoryTable({ invitations }: { readonly invitations: readonly OperationsInvitationDto[] }): React.ReactElement {
  if (!invitations.length) return <p>No invitations match the current search.</p>;
  return <table className="role-record-table"><thead><tr><th>Recipient</th><th>Organization</th><th>Role</th><th>State</th><th>Delivery</th><th>Expires</th></tr></thead><tbody>{invitations.map((invite) => <tr key={invite.id}><td>{invite.recipientEmail}</td><td>{invite.organization?.legalName ?? 'No organization'}</td><td>{invite.role}</td><td>{invite.state}</td><td>{invite.delivery?.state ?? 'No command'}</td><td>{new Date(invite.expiresAt).toLocaleDateString()}</td></tr>)}</tbody></table>;
}
