/**
 * The public profile: the one screen in ONE rendered for somebody who is not signed in.
 *
 * Decision in docs/architecture/ADR-031-public-profile-share-links.md.
 *
 * Built from the pilot design system and wrapped in `.pilot`, exactly as the pilot-parity
 * pages are. `pilot.css` and `styles.css` are frozen and no new stylesheet may be added,
 * so everything here is an existing pilot class plus layout-only inline styles on plain
 * elements -- the same pattern pilotParity/student.tsx already uses.
 *
 * The route above already decided what may be published, so this file's job is
 * presentation and honesty: a verified record and a self-reported one must never look
 * alike, the reason an item cannot be confirmed is stated in words, and the summary is a
 * count of confirmed facts rather than a rating of the person.
 */
import React, { useEffect, useState } from 'react';
import { readPublicProfile, type PublicProfileDto } from './api.js';
import { BrandLogo } from './brand.js';
import * as dates from './dates.js';

const COVERS: Readonly<Record<string, string>> = {
  MIDNIGHT: 'linear-gradient(112deg,#16233a 0%,#1f3a6b 52%,#24306b 100%)',
  TEAL: 'linear-gradient(112deg,#08343a 0%,#0b6669 55%,#12897a 100%)',
  VIOLET: 'linear-gradient(112deg,#241a3f 0%,#4a2d7a 55%,#7d4fc2 100%)',
  EMBER: 'linear-gradient(112deg,#3a1f0b 0%,#7a3b16 55%,#c07a2d 100%)',
};

function initials(name: string | null): string {
  if (!name) return 'ONE';
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'ONE';
}

function year(iso: string | null): string | null {
  return iso ? String(new Date(iso).getFullYear()) : null;
}

/** A date in words, or null when none is recorded (the date is then left out). */
function formatDate(iso: string | null): string | null {
  return iso ? dates.formatDate(iso) : null;
}

/** "Completed 3 Jun 2026", or just "Completed" when the date is not recorded. */
function withDate(prefix: string, iso: string | null): string {
  const day = formatDate(iso);
  return day ? `${prefix} ${day}` : prefix;
}

const muted = { color: 'var(--p-muted)', fontSize: 12.5 } as const;

export function PublicProfilePage({ token }: { readonly token: string }): React.ReactElement {
  // Three separate literal variants rather than a union inside one: a discriminant that is
  // itself a union does not narrow, and the ready branch would keep losing its profile.
  type ViewState =
    | { readonly phase: 'loading' }
    | { readonly phase: 'gone' }
    | { readonly phase: 'ready'; readonly profile: PublicProfileDto };
  const [state, setState] = useState<ViewState>({ phase: 'loading' });

  useEffect(() => {
    document.title = 'Verified profile | ONE by AI8HT';
    const abort = new AbortController();
    readPublicProfile(token, abort.signal)
      .then((response) => setState({ phase: 'ready', profile: response.profile }))
      // Unknown, expired and revoked are indistinguishable by design, so the page says the
      // one true thing it knows: this link is not live.
      .catch(() => { if (!abort.signal.aborted) setState({ phase: 'gone' }); });
    return () => abort.abort();
  }, [token]);

  if (state.phase === 'loading') {
    return <div className="pilot pilot-embed"><div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
      <div className="pilot-content"><p role="status" style={muted}>Loading…</p></div>
    </div></div>;
  }

  if (state.phase === 'gone') {
    return <div className="pilot pilot-embed"><div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
      <div className="pilot-content">
        <section className="pilot-card" style={{ maxWidth: 560 }}>
          <BrandLogo height={40} />
          <h2 style={{ marginTop: 14 }}>This profile link is no longer live</h2>
          <p style={muted}>
            The person who shared it may have switched it off, or it may have expired.
            If somebody sent you this, ask them for a new link.
          </p>
        </section>
      </div>
    </div></div>;
  }

  const { profile } = state;

  return <div className="pilot pilot-embed"><div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">

      {/* Brand band. The ONE logo is the brand on every surface, including this one. */}
      <div style={{ background: '#0b0d10', borderRadius: '12px 12px 0 0', padding: '13px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <BrandLogo height={30} surface="dark" />
        <span style={{ color: '#99a2b0', fontSize: 11.5 }}>Verified career profile</span>
      </div>

      <section className="pilot-card" style={{ borderRadius: '0 0 12px 12px', padding: 0, overflow: 'hidden' }}>
        <div style={{ height: 104, background: COVERS[profile.coverKey] ?? COVERS.MIDNIGHT, position: 'relative' }}>
          {profile.institutionName
            ? <span style={{ position: 'absolute', right: 18, bottom: 12, color: '#c9d6ea', fontSize: 12 }}>
              Evidence confirmed by <b style={{ color: '#fff' }}>{profile.institutionName}</b>
            </span>
            : null}
        </div>
        <div style={{ display: 'flex', gap: 18, padding: '0 20px 16px' }}>
          <div style={{
            position: 'relative', zIndex: 1, width: 96, height: 96, marginTop: -40, flex: 'none',
            borderRadius: 22, border: '4px solid #fff', overflow: 'hidden', background: 'linear-gradient(150deg,#1f55e5,#4438ca)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 30, fontWeight: 700,
          }}>
            {profile.photoUrl ? <img src={profile.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(profile.name)}
          </div>
          <div style={{ flex: 1, paddingTop: 12 }}>
            <h1 style={{ margin: 0, fontSize: 25, letterSpacing: '-.015em' }}>{profile.name ?? profile.headline ?? 'Verified profile'}</h1>
            {profile.headline ? <p style={{ margin: '3px 0 8px', fontSize: 14 }}>{profile.headline}</p> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, ...muted }}>
              {profile.city ? <span>{profile.city}</span> : null}
              {profile.institutionName ? <span>{profile.institutionName}</span> : null}
              {profile.targetCareer ? <span>Target role: {profile.targetCareer}</span> : null}
              {profile.expectedGraduation ? <span>Graduating {year(profile.expectedGraduation)}</span> : null}
            </div>
          </div>
        </div>
        <div className="pilot-hero" style={{ borderRadius: 0, margin: 0 }}>
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <div className="pilot-stat"><span className="pilot-tile green">✓</span><div><b>{profile.verifiedCount}</b><small>Independently confirmed</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile blue">📝</span><div><b>{profile.assessments.length}</b><small>Assessments sat on ONE</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile teal">📚</span><div><b>{profile.learning.length}</b><small>Lessons completed</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile purple">🧩</span><div><b>{profile.skills.length}</b><small>Skills declared</small></div></div>
          </div>
        </div>
      </section>

      {profile.summary ? <section className="pilot-card">
        <div className="pilot-card-head"><h2>About</h2></div>
        <p style={{ margin: 0, lineHeight: 1.62 }}>{profile.summary}</p>
      </section> : null}

      {profile.education.length > 0 ? <section className="pilot-card">
        <div className="pilot-card-head">
          <h2>Education</h2>
          <span className="pilot-chip green">{profile.education.filter((entry) => entry.verified).length} verified</span>
        </div>
        {profile.education.map((entry, index) => <div className="pilot-list-row" key={`${entry.programmeName}-${index}`}>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 13.5 }}>{entry.programmeName}</strong>
            <small style={{ display: 'block', ...muted }}>
              {entry.institutionName ?? entry.declaredInstitutionName ?? 'Institution not stated'}
              {entry.startedOn ? ` · ${year(entry.startedOn)}` : ''}
              {entry.completedOn ? ` – ${year(entry.completedOn)}` : ''}
            </small>
            {/* The reason a record cannot be confirmed, said plainly rather than implied. */}
            {!entry.verified && entry.declaredInstitutionName
              ? <small style={{ display: 'block', ...muted }}>{entry.declaredInstitutionName} is not on ONE, so nobody can confirm this.</small>
              : null}
            {entry.terms.map((term) => <div key={term.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 12.8 }}>{term.label}{term.result ? ` · ${term.result}` : ''}</span>
              {term.verified
                ? <span className="pilot-chip green">{withDate('Confirmed', term.verifiedAt)}</span>
                : <span className="pilot-chip amber">Self-reported</span>}
            </div>)}
          </div>
          <span className={`pilot-chip ${entry.verified ? 'green' : 'amber'}`}>{entry.verified ? 'Verified' : 'Self-reported'}</span>
        </div>)}
      </section> : null}

      {profile.assessments.length > 0 ? <section className="pilot-card">
        <div className="pilot-card-head"><h2>Assessments sat on ONE</h2><span className="pilot-chip blue">Administered by us</span></div>
        {profile.assessments.map((entry, index) => <div className="pilot-list-row" key={`${entry.title}-${index}`}>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 13.5 }}>{entry.title}</strong>
            {formatDate(entry.takenAt) ? <small style={{ display: 'block', ...muted }}>{formatDate(entry.takenAt)}</small> : null}
          </div>
          <b style={{ fontSize: 16 }}>{entry.percentage}%</b>
        </div>)}
      </section> : null}

      {profile.learning.length > 0 ? <section className="pilot-card">
        <div className="pilot-card-head"><h2>Learning completed</h2><span className="pilot-chip slate">{profile.learning.length}</span></div>
        {profile.learning.map((entry, index) => <div className="pilot-list-row" key={`${entry.title}-${index}`}>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 13.5 }}>{entry.title}</strong>
            <small style={{ display: 'block', ...muted }}>{withDate('Completed', entry.completedAt)}</small>
          </div>
        </div>)}
      </section> : null}

      {profile.certificates.length > 0 ? <section className="pilot-card">
        <div className="pilot-card-head"><h2>Certificates</h2><span className="pilot-chip slate">Titles only</span></div>
        <p style={{ margin: '0 0 8px', ...muted }}>The files themselves stay private.</p>
        {profile.certificates.map((entry, index) => <div className="pilot-list-row" key={`${entry.title}-${index}`}>
          <div style={{ flex: 1 }}><strong style={{ fontSize: 13.5 }}>{entry.title}</strong></div>
          <span className="pilot-chip amber">Self-reported</span>
        </div>)}
      </section> : null}

      {profile.skills.length > 0 ? <section className="pilot-card">
        <div className="pilot-card-head"><h2>Skills</h2><span className="pilot-chip slate">Their own list</span></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {profile.skills.map((skill) => <span className="pilot-chip" key={skill}>{skill}</span>)}
        </div>
      </section> : null}

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>What is verified</h2></div>
        {/* A count of facts. Never a percentage, and never a rating of the person. */}
        <p style={{ margin: '0 0 8px', fontSize: 15 }}>
          <b>{profile.verifiedCount}</b> of {profile.totalClaimCount} {profile.totalClaimCount === 1 ? 'item' : 'items'} independently confirmed
        </p>
        <p style={{ margin: 0, ...muted }}>
          Anything marked <strong>verified</strong> was confirmed by the institution that issued it — not by
          this person, and not by ONE. Everything else is labelled as their own claim.
        </p>
      </section>

      {profile.portfolioUrl ? <section className="pilot-card">
        <div className="pilot-card-head"><h2>Portfolio</h2></div>
        <a href={profile.portfolioUrl} rel="noreferrer noopener nofollow" target="_blank">{profile.portfolioUrl}</a>
        <p style={{ margin: '8px 0 0', ...muted }}>Added by this person. ONE does not check what is behind it.</p>
      </section> : null}

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Deliberately not here</h2></div>
        <ul style={{ margin: 0, paddingLeft: 18, ...muted }}>
          <li>Readiness guidance — advisory, and never shown publicly or to an employer.</li>
          <li>Job applications and how they went.</li>
          <li>Feedback from employers.</li>
          <li>Uploaded files — certificates and transcripts stay private.</li>
          <li>No profile-strength score. ONE does not rate people out of a hundred.</li>
        </ul>
      </section>

      <p style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginTop: 4, ...muted }}>
        <span>Shared by {profile.name ?? 'this person'}, who can switch this link off at any time.</span>
        <span>{formatDate(profile.expiresAt) ? `Link expires ${formatDate(profile.expiresAt)} · ` : ''}&copy; AI8HT</span>
      </p>
    </div>
  </div></div>;
}
