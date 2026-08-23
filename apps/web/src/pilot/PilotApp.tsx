import { useState } from 'react';
import { Bell, BookOpen, Briefcase, Building2, ClipboardCheck, FileText, GraduationCap, Home, MapPinned, MessageSquare, Route, Search, User, Wrench } from 'lucide-react';
import './pilot.css';
import { pilotPersona } from './pilotData.js';
import { PilotAssessments, PilotDashboard, PilotLearn, PilotOpportunities, PilotProfile, PilotRoadmap } from './pilotPages.js';

/**
 * The pilot shell shown to demo identities: sample-fidelity presentation over the
 * curated dataset. Navigation is internal state rather than URL routing so the pilot
 * can never interfere with the real application's path handling.
 */

type PilotPage =
  | 'dashboard' | 'roadmap' | 'learn' | 'assessments' | 'opportunities' | 'profile'
  | 'practice' | 'company-prep' | 'career-tools' | 'scholarships' | 'resume';

const TIER_ONE: readonly { readonly key: PilotPage; readonly label: string; readonly icon: typeof Home }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'roadmap', label: 'My Roadmap', icon: Route },
  { key: 'learn', label: 'Learn', icon: BookOpen },
  { key: 'assessments', label: 'Assessments', icon: ClipboardCheck },
  { key: 'opportunities', label: 'Opportunities', icon: Briefcase },
  { key: 'profile', label: 'Profile', icon: User },
];

const TIER_TWO: readonly { readonly key: PilotPage; readonly label: string; readonly icon: typeof Home }[] = [
  { key: 'practice', label: 'Practice', icon: Wrench },
  { key: 'company-prep', label: 'Company Prep', icon: Building2 },
  { key: 'career-tools', label: 'Career Tools', icon: MapPinned },
  { key: 'scholarships', label: 'Scholarships', icon: GraduationCap },
  { key: 'resume', label: 'Resume Builder', icon: FileText },
];

const TIER_TWO_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TIER_TWO.map((item) => [item.key, item.label]));

export function PilotApp({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState<PilotPage>('dashboard');

  return <div className="pilot">
    <aside className="pilot-sidebar" aria-label="Pilot navigation">
      <div className="pilot-brand">
        <span className="pilot-brand-mark">8</span>
        <span><strong>ONE</strong><small>LEARN | PREPARE | BUILD | GROW</small></span>
      </div>
      {TIER_ONE.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.key} type="button" className={`pilot-nav-item ${page === item.key ? 'active' : ''}`}
            aria-current={page === item.key ? 'page' : undefined} onClick={() => setPage(item.key)}>
            <Icon size={17} /> {item.label}
          </button>
        );
      })}
      {TIER_TWO.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.key} type="button" className={`pilot-nav-item ${page === item.key ? 'active' : ''}`}
            aria-current={page === item.key ? 'page' : undefined} onClick={() => setPage(item.key)}>
            <Icon size={17} /> {item.label}<small>Soon</small>
          </button>
        );
      })}
      <div className="pilot-side-note">
        <strong>Keep going, {pilotPersona.firstName}!</strong>
        <p>You&apos;re doing great this week.</p>
        <button type="button" className="pilot-btn soft small">View Tips</button>
      </div>
    </aside>

    <div className="pilot-main">
      <header className="pilot-topbar">
        <div className="pilot-search"><Search size={15} /> Search for courses, tests, roles…</div>
        <div className="pilot-topbar-actions">
          <span className="pilot-sample-chip" title={`Signed in as ${email}`}>Sample data</span>
          <button type="button" className="pilot-icon-button" aria-label="Messages"><MessageSquare size={16} /></button>
          <button type="button" className="pilot-icon-button" aria-label="Notifications"><Bell size={16} /><span className="pilot-dot">3</span></button>
          <div className="pilot-user">
            <span className="pilot-avatar">{pilotPersona.initials}</span>
            <span><strong>{pilotPersona.name}</strong><small>{pilotPersona.programme}</small></span>
          </div>
          <button type="button" className="pilot-signout" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {page === 'dashboard' ? <PilotDashboard /> : null}
      {page === 'roadmap' ? <PilotRoadmap /> : null}
      {page === 'learn' ? <PilotLearn /> : null}
      {page === 'assessments' ? <PilotAssessments /> : null}
      {page === 'opportunities' ? <PilotOpportunities /> : null}
      {page === 'profile' ? <PilotProfile /> : null}
      {TIER_TWO_LABELS[page] ? (
        <div className="pilot-page"><div className="pilot-content"><section className="pilot-card pilot-coming">
          <div>
            <span className="pilot-tile blue" style={{ width: 52, height: 52, margin: '0 auto' }}><Wrench size={22} /></span>
            <h2>{TIER_TWO_LABELS[page]} is coming to the pilot</h2>
            <p>This module is in build. The screens you can open on the left show the full experience with sample data.</p>
          </div>
        </section></div></div>
      ) : null}
    </div>
  </div>;
}
