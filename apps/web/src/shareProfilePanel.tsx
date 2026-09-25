/**
 * The student's control over their public profile, and over their photo.
 *
 * Decision in docs/architecture/ADR-031-public-profile-share-links.md.
 *
 * Two things this screen is careful to say rather than merely do. The readiness band and
 * applications are shown as **locked**, not as switches turned off, because they are not
 * choices a student could make differently. And the raw link is shown exactly once, when
 * it is created, because only its digest is stored -- so the screen must be honest that
 * copying it now is the only chance.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  publishShareLink,
  readMyShareLink,
  removeProfilePhoto,
  revokeShareLinkRequest,
  updateShareSettings,
  uploadProfilePhoto,
  type CoverKey,
  type ShareLinkDto,
  type ShareSectionsDto,
} from './api.js';

const COVERS: readonly (readonly [CoverKey, string, string])[] = [
  ['MIDNIGHT', 'Midnight', 'linear-gradient(112deg,#16233a,#24306b)'],
  ['TEAL', 'Teal', 'linear-gradient(112deg,#0b6669,#12897a)'],
  ['VIOLET', 'Violet', 'linear-gradient(112deg,#4a2d7a,#7d4fc2)'],
  ['EMBER', 'Ember', 'linear-gradient(112deg,#7a3b16,#c07a2d)'],
];

const SECTIONS: readonly (readonly [keyof ShareSectionsDto, string, string])[] = [
  ['showPhoto', 'Show my photo', 'Off by default. People you apply to still see it.'],
  ['showHeadline', 'Headline and summary', 'The few lines you wrote about yourself'],
  ['showCity', 'My city', 'Nothing more precise than a city'],
  ['showInstitution', 'My institution', 'Where you study, and when you graduate'],
  ['showEducation', 'Academic record', 'Verified items keep their badge'],
  ['showSelfReported', 'Self-reported qualifications', 'Shown, clearly marked as unconfirmed'],
  ['showAssessments', 'Assessment results', 'Off by default. Scores from tests we administered.'],
  ['showLearning', 'Learning completed', 'Lessons and modules you finished here'],
  ['showCertificates', 'Certificate titles', 'Titles only — the files themselves stay private'],
  ['showSkills', 'Skills', 'The list you wrote yourself'],
  ['showPortfolio', 'Portfolio link', 'Shown with a note that we do not check it'],
];

function profileUrl(token: string): string {
  return `${window.location.origin}/p/${token}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

export function ShareProfilePanel(): React.ReactElement {
  const [link, setLink] = useState<ShareLinkDto | null>(null);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading…');
  const [busy, setBusy] = useState(false);

  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await readMyShareLink(token);
    setLink(response.link);
    setHasPhoto(response.hasPhoto);
    setStatus(message ?? '');
  };
  useEffect(() => { void reload().catch(() => setStatus('Your sharing settings could not be loaded.')); }, []);

  async function publish(): Promise<void> {
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true);
    try {
      const response = await publishShareLink(token);
      // The only moment this value exists outside the student's own browser.
      setFreshToken(response.link.token ?? null);
      await reload('Your profile is live. Copy the link now — it is not shown again.');
    } catch {
      setStatus('That link could not be created.');
    } finally { setBusy(false); }
  }

  async function change(patch: { sections?: Partial<ShareSectionsDto>; coverKey?: CoverKey; days?: number }): Promise<void> {
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true);
    try {
      await updateShareSettings(token, patch);
      await reload(patch.days ? 'Extended.' : 'Saved.');
    } catch {
      setStatus('That change could not be saved.');
    } finally { setBusy(false); }
  }

  async function revoke(): Promise<void> {
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true);
    try {
      await revokeShareLinkRequest(token);
      setFreshToken(null);
      await reload('Link switched off. It no longer works for anyone who had it.');
    } catch {
      setStatus('That link could not be switched off.');
    } finally { setBusy(false); }
  }

  async function choosePhoto(file: File): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return setStatus('Choose a JPEG or PNG.');
    if (file.size > 5 * 1024 * 1024) return setStatus('That photo is larger than 5 MB.');
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
      await uploadProfilePhoto(token, file.type, window.btoa(binary));
      await reload('Photo saved. It appears on the web and on your phone.');
    } catch {
      setStatus('That photo could not be saved. It is scanned before it is stored, so try again shortly.');
    } finally { setBusy(false); }
  }

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Your public profile</h2>
      <p>One link, yours to switch off. Nothing is shared until you turn it on, and what it shows is entirely your choice.</p>
      {status ? <p role="status">{status}</p> : null}

      {freshToken ? <p>
        <strong>{profileUrl(freshToken)}</strong><br />
        <span className="hiring-meta">Copy this now. We store only a fingerprint of it, so we cannot show it to you again — if you lose it, create a new link.</span>
      </p> : null}

      {link === null
        ? <button type="button" disabled={busy} onClick={() => { void publish(); }}>Create my public link</button>
        : <>
          <p className="hiring-meta">
            {link.expired
              ? 'This link has expired. Extend it to make it live again.'
              : `Live · expires ${formatDate(link.expiresAt)} (${daysLeft(link.expiresAt)} days)`}
            {link.lastViewedAt ? ` · last opened ${formatDate(link.lastViewedAt)}` : ' · not opened yet'}
          </p>
          <div className="hiring-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => { void change({ days: 90 }); }}>Extend 90 days</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { void publish(); }}>Replace with a new link</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { void revoke(); }}>Switch off</button>
          </div>
          <p className="hiring-meta">Switching off is immediate and applies to everyone who already has the link. A replacement is a different address; the old one never comes back.</p>
        </>}
    </section>

    <section className="card wide-card">
      <h2>Your photo</h2>
      <p>{hasPhoto ? 'Saved. It appears on the web and on your phone.' : 'No photo yet.'}</p>
      <label className="student-form-field">
        <span>Choose a photo</span>
        <input
          type="file"
          accept="image/png,image/jpeg"
          disabled={busy}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void choosePhoto(file); }}
        />
      </label>
      <p className="hiring-meta">JPEG or PNG, up to 5 MB. Scanned for malware before it is stored, and encrypted at rest.</p>
      {hasPhoto ? <button type="button" className="secondary" disabled={busy} onClick={() => {
        const token = getAccessToken();
        if (token) void removeProfilePhoto(token).then(() => reload('Photo removed.')).catch(() => setStatus('That photo could not be removed.'));
      }}>Remove photo</button> : null}
    </section>

    {link ? <>
      <section className="card wide-card">
        <h2>What your link shows</h2>
        <ul className="check-stack">
          {SECTIONS.map(([key, label, detail]) => <li key={key}>
            <label>
              <input
                type="checkbox"
                checked={link.sections[key]}
                disabled={busy}
                onChange={(event) => { void change({ sections: { [key]: event.target.checked } }); }}
              />
              {' '}<strong>{label}</strong> <span className="hiring-meta">{detail}</span>
            </label>
          </li>)}
        </ul>
      </section>

      <section className="card wide-card">
        <h2>Cover</h2>
        <div className="hiring-actions">
          {COVERS.map(([key, label, background]) => <button
            key={key}
            type="button"
            className={link.coverKey === key ? undefined : 'secondary'}
            disabled={busy}
            onClick={() => { void change({ coverKey: key }); }}
          >{label}</button>)}
        </div>
        <p className="hiring-meta">
          You cannot upload your own cover image. This page carries the AI8HT wordmark, and an uploaded
          image would need somebody checking it before it appeared there.
        </p>
      </section>

      <section className="card wide-card">
        <h2>Never shared, whatever you choose</h2>
        <ul className="check-stack">
          <li><strong>Readiness guidance</strong> <span className="hiring-meta">Advice for you. The database will not let it be made public.</span></li>
          <li><strong>Job applications and their outcomes</strong> <span className="hiring-meta">Yours alone.</span></li>
          <li><strong>Feedback employers gave you</strong> <span className="hiring-meta">Yours alone.</span></li>
          <li><strong>Your uploaded files</strong> <span className="hiring-meta">Certificate and transcript files never leave your account.</span></li>
          <li><strong>Your email address</strong> <span className="hiring-meta">Nobody gets it from the page.</span></li>
        </ul>
      </section>
    </> : null}
  </div>;
}
