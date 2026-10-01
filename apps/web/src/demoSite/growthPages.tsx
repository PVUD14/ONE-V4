/**
 * Demo-site Growth portal: AI8HT's partnerships field staff (ADR-040). Shows the
 * intended day of a partnerships executive - leads from colleges and employers, field
 * visits, territory coverage, quarterly targets and an indicative commission statement.
 *
 * Fictional, demo-site only, and further ahead than the real application: in the real
 * Growth portal these modules are not built yet (see docs/marketing/demo-script.md).
 */
import { useState } from 'react';
import { BadgeIndianRupee, Briefcase, CalendarDays, GraduationCap, MapPin, Plus, Target, TrendingUp, Users } from 'lucide-react';
import { Spark } from '../pilot/pilotComponents.js';
import { OverlayForm, useOverlay } from '../pilot/pilotOverlay.js';
import { Funnel, KpiRow, PageHead, wired } from './demoKit.js';

export const growthPersona = {
  name: 'Vikram Shetty',
  initials: 'VS',
  role: 'Partnerships Executive · South zone',
  email: 'vikram.growth@one.example',
} as const;

const LEAD_STAGES = ['New', 'Contacted', 'Demo booked', 'Proposal sent', 'Won'] as const;
type LeadStage = typeof LEAD_STAGES[number];

interface Lead {
  readonly name: string;
  readonly kind: 'College' | 'Employer';
  readonly city: string;
  readonly contact: string;
  readonly stage: LeadStage;
  readonly next: string;
}

const LEADS: readonly Lead[] = [
  { name: 'Greenfield Polytechnic College', kind: 'College', city: 'Salem', contact: 'Principal', stage: 'Proposal sent', next: 'Follow-up call Thursday' },
  { name: 'Coastal Engineering College', kind: 'College', city: 'Puducherry', contact: 'Placement head', stage: 'Won', next: 'Hand over to Operations' },
  { name: 'Sunrise Arts & Science College', kind: 'College', city: 'Madurai', contact: 'Dean, Academics', stage: 'Demo booked', next: 'Campus demo 24 May, 11:00 AM' },
  { name: 'Brightpath Fintech', kind: 'Employer', city: 'Chennai', contact: 'Talent acquisition', stage: 'Contacted', next: 'Send employer deck' },
  { name: 'Meridian Health Systems', kind: 'Employer', city: 'Coimbatore', contact: 'HR head', stage: 'New', next: 'First call' },
  { name: 'Valley Institute of Management', kind: 'College', city: 'Tiruchirappalli', contact: 'Director', stage: 'Contacted', next: 'Book a demo' },
];

const STAGE_TONE: Readonly<Record<LeadStage, string>> = {
  New: 'slate', Contacted: 'blue', 'Demo booked': 'purple', 'Proposal sent': 'amber', Won: 'green',
};

const VISITS = [
  { when: 'Today, 11:00 AM', place: 'Greenfield Polytechnic College, Salem', purpose: 'Proposal walkthrough with the principal', status: 'Planned' },
  { when: 'Today, 03:30 PM', place: 'Brightpath Fintech, Chennai', purpose: 'Introduce campus hiring on ONE', status: 'Planned' },
  { when: '24 May, 11:00 AM', place: 'Sunrise Arts & Science College, Madurai', purpose: 'Live demo for faculty and placement cell', status: 'Planned' },
  { when: 'Yesterday', place: 'Coastal Engineering College, Puducherry', purpose: 'Agreement signed', status: 'Logged' },
  { when: '2 days ago', place: 'Valley Institute of Management, Tiruchirappalli', purpose: 'First meeting with the director', status: 'Logged' },
] as const;

const TERRITORY = [
  { district: 'Chennai', colleges: 38, onOne: 1, visited: 14 },
  { district: 'Coimbatore', colleges: 29, onOne: 1, visited: 9 },
  { district: 'Tiruchirappalli', colleges: 21, onOne: 1, visited: 7 },
  { district: 'Madurai', colleges: 24, onOne: 0, visited: 5 },
  { district: 'Salem', colleges: 17, onOne: 0, visited: 4 },
  { district: 'Puducherry', colleges: 12, onOne: 1, visited: 3 },
] as const;

const COMMISSION = [
  { deal: 'Coastal Engineering College', signed: '30 May', basis: 'New college · annual plan', amount: '₹ 18,000', status: 'Awaiting approval' },
  { deal: 'Hillcrest University', signed: '12 Apr', basis: 'New college · annual plan', amount: '₹ 24,000', status: 'Paid' },
  { deal: 'Veridian Tech', signed: '19 Mar', basis: 'New employer · campus hiring', amount: '₹ 6,000', status: 'Paid' },
] as const;

export function GrowthHome({ onNavigate }: { readonly onNavigate: (key: string) => void }): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Good morning, Vikram" detail="Your pipeline, today's visits and how the quarter is tracking." />
      <KpiRow items={[
        ['Open Leads', LEADS.filter((lead) => lead.stage !== 'Won').length, 'blue', Users],
        ['Visits This Week', 6, 'purple', CalendarDays],
        ['Colleges Signed (Q2)', '4 of 6', 'green', GraduationCap],
        ['Employers Signed (Q2)', '2 of 3', 'indigo', Briefcase],
      ]} />
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Pipeline</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('leads'))}>Open Leads</button></div>
          <Funnel rows={LEAD_STAGES.map((stage) => ({ label: stage, value: LEADS.filter((lead) => LEAD_STAGES.indexOf(lead.stage) >= LEAD_STAGES.indexOf(stage)).length }))} />
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Today</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('visits'))}>All Visits</button></div>
          <div className="pilot-list">
            {VISITS.filter((visit) => visit.when.startsWith('Today')).map((visit) => (
              <div key={visit.place} className="pilot-list-row">
                <span className="pilot-tile purple"><MapPin size={16} /></span>
                <div className="grow"><strong>{visit.place}</strong><small>{visit.when} · {visit.purpose}</small></div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Signed This Year</h2><span className="pilot-chip green">+2 this month</span></div>
        <Spark points={[0, 1, 1, 2, 3, 4, 6]} tone="green" />
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Commission</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('commission'))}>Statement</button></div>
        <div className="pilot-stat"><span className="pilot-tile green"><BadgeIndianRupee size={17} /></span><div><b>₹ 18,000</b><small>Awaiting approval · sample figures</small></div></div>
      </section>
    </aside>
  </div>;
}

export function GrowthLeads(): React.ReactElement {
  const overlay = useOverlay();
  const [added, setAdded] = useState<readonly Lead[]>([]);
  const [stages, setStages] = useState<Readonly<Record<string, LeadStage>>>({});
  const rows = [...added, ...LEADS];
  const stageOf = (lead: Lead): LeadStage => stages[lead.name] ?? lead.stage;
  const advance = (lead: Lead): void => {
    const index = LEAD_STAGES.indexOf(stageOf(lead));
    const next = LEAD_STAGES[Math.min(index + 1, LEAD_STAGES.length - 1)] ?? 'Won';
    setStages((previous) => ({ ...previous, [lead.name]: next }));
    overlay.toast(next === 'Won' ? `${lead.name} won - handed to Operations for onboarding (sample).` : `${lead.name} moved to ${next} (sample).`);
  };
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Leads" detail="Colleges and employers you are bringing onto ONE. A won college goes to Operations for onboarding.">
        <button type="button" className="pilot-btn" onClick={wired(() => overlay.openModal({
          title: 'Add Lead', subtitle: 'A college or employer to approach', body: <OverlayForm
            fields={[
              { label: 'Name', name: 'name', placeholder: 'e.g. Lotus College of Engineering' },
              { label: 'Type', name: 'kind', type: 'select', value: 'College', options: ['College', 'Employer'] },
              { label: 'City', name: 'city', value: 'Chennai' },
              { label: 'Contact role', name: 'contact', value: 'Placement head' },
            ]}
            submitLabel="Add Lead" success="Lead added to your pipeline (sample)."
            onSubmit={(values) => setAdded((previous) => [{ name: values['name'] || 'Lotus College of Engineering', kind: values['kind'] === 'Employer' ? 'Employer' : 'College', city: values['city'] || 'Chennai', contact: values['contact'] || 'Placement head', stage: 'New', next: 'First call' }, ...previous])} />,
        }))}><Plus size={15} /> Add Lead</button>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Lead</th><th>Type</th><th>City</th><th>Stage</th><th>Next step</th><th></th></tr></thead>
          <tbody>
            {rows.map((lead) => {
              const stage = stageOf(lead);
              return <tr key={lead.name}>
                <td><strong>{lead.name}</strong><small style={{ display: 'block', color: 'var(--p-muted)' }}>{lead.contact}</small></td>
                <td><span className={`pilot-chip ${lead.kind === 'College' ? 'indigo' : 'teal'}`}>{lead.kind}</span></td>
                <td>{lead.city}</td>
                <td><span className={`pilot-chip ${STAGE_TONE[stage]}`}>{stage}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{stage === 'Won' ? 'Hand over to Operations' : lead.next}</small></td>
                <td><button type="button" className="pilot-btn small" disabled={stage === 'Won'} onClick={wired(() => advance(lead))}>{stage === 'Won' ? 'Won' : 'Advance'}</button></td>
              </tr>;
            })}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function GrowthVisits(): React.ReactElement {
  const overlay = useOverlay();
  const [logged, setLogged] = useState<ReadonlySet<string>>(new Set());
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Field Visits" detail="Plan visits, then log what happened so the next person knows where things stand." />
      <section className="pilot-card">
        <div className="pilot-list">
          {VISITS.map((visit) => {
            const done = visit.status === 'Logged' || logged.has(visit.place);
            return <div key={visit.place} className="pilot-list-row">
              <span className={`pilot-tile ${done ? 'green' : 'purple'}`}><MapPin size={16} /></span>
              <div className="grow"><strong>{visit.place}</strong><small>{visit.when} · {visit.purpose}</small></div>
              <span className={`pilot-chip ${done ? 'green' : 'blue'}`}>{done ? 'Logged' : 'Planned'}</span>
              {done ? null : <button type="button" className="pilot-btn ghost small" onClick={wired(() => overlay.openModal({
                title: 'Log Visit', subtitle: visit.place, body: <OverlayForm
                  fields={[
                    { label: 'Who you met', value: 'Principal and placement head' },
                    { label: 'Outcome', type: 'select', value: 'Interested - send proposal', options: ['Interested - send proposal', 'Wants a campus demo', 'Not now - revisit next term', 'Signed'] },
                    { label: 'Notes', type: 'textarea', placeholder: 'What was agreed and the next step' },
                  ]}
                  submitLabel="Save Visit" success="Visit logged (sample)."
                  onSubmit={() => setLogged((previous) => new Set(previous).add(visit.place))} />,
              }))}>Log Visit</button>}
            </div>;
          })}
        </div>
      </section>
    </div>
  </div>;
}

export function GrowthTerritory(): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Territory" detail="South zone: colleges per district, how many you have visited and how many are on ONE." />
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>District</th><th>Colleges</th><th>Visited</th><th>On ONE</th><th>Coverage</th></tr></thead>
          <tbody>
            {TERRITORY.map((row) => (
              <tr key={row.district}>
                <td><div className="pilot-person"><span className="pilot-tile indigo" style={{ width: 30, height: 30 }}><MapPin size={13} /></span><strong>{row.district}</strong></div></td>
                <td>{row.colleges}</td>
                <td>{row.visited}</td>
                <td>{row.onOne}</td>
                <td style={{ minWidth: 160 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="pilot-bar thin purple" style={{ flex: 1 }}><i style={{ width: `${(row.visited / row.colleges) * 100}%` }} /></div>
                    <small>{row.visited} of {row.colleges} visited</small>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function GrowthTargets(): React.ReactElement {
  const targets = [
    { label: 'New colleges signed', done: 4, target: 6, tone: 'green' },
    { label: 'New employers signed', done: 2, target: 3, tone: 'indigo' },
    { label: 'Field visits', done: 41, target: 50, tone: 'purple' },
    { label: 'Campus demos given', done: 7, target: 10, tone: 'amber' },
  ] as const;
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Targets" detail="Quarter 2 (April - June). Targets are set by your zone lead." />
      <section className="pilot-card">
        {targets.map((row) => (
          <div key={row.label} className="pilot-skill">
            <header><b>{row.label}</b><span>{row.done} of {row.target}</span></header>
            <div className={`pilot-bar ${row.tone}`}><i style={{ width: `${(row.done / row.target) * 100}%` }} /></div>
          </div>
        ))}
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Zone Leaderboard</h2>
        <div className="pilot-list">
          {[['Vikram Shetty', '6 signed'], ['Divya Rao', '5 signed'], ['Imran Sheikh', '3 signed']].map(([name, detail], index) => (
            <div key={name} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <span className={`pilot-tile ${index === 0 ? 'green' : 'blue'}`} style={{ width: 30, height: 30 }}>{index === 0 ? <TrendingUp size={13} /> : <Target size={13} />}</span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{name}</strong><small>{detail}</small></div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}

export function GrowthCommission(): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Commission" detail="Indicative statement for signed deals. Every payout is approved by finance before it is paid." />
      <div className="pilot-banner blue"><BadgeIndianRupee size={17} /> Sample figures for the demo only - not a real commission plan.</div>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Deal</th><th>Signed</th><th>Basis</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {COMMISSION.map((row) => (
              <tr key={row.deal}>
                <td><strong>{row.deal}</strong></td>
                <td>{row.signed}</td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{row.basis}</small></td>
                <td><b>{row.amount}</b></td>
                <td><span className={`pilot-chip ${row.status === 'Paid' ? 'green' : 'amber'}`}>{row.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}
