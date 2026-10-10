/**
 * ONE · The résumé generator on the web (RESUME-GEN).
 *
 * The builder (tick items from the student's own record, write their own summary and projects, pick a
 * template), the live preview the server resolves, the completeness checks (passed or not — never a number)
 * and the paper preview the Résumé Builder page shows in its Templates and Examples tabs. Every label comes
 * from the server: "Verified by <institution>" only where an institution verified the record, everything
 * else self-declared. Design: docs/architecture/student-resumes-table-design.md.
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from './icons/Icon.js';
import {
  ApiRequestError, createResume, downloadResumePdf, previewResume, saveResumeVersion,
  type ResumeCheckDto, type ResumeContentDto, type ResumeDraftDto, type ResumeSourcesDto, type ResumeTemplateDto, type ResumeTemplateKey,
} from './api.js';

/** A first draft from the student's own record: education, shown skills and certificates ticked; results and objective not. */
export function defaultResumeDraft(sources: ResumeSourcesDto, template: ResumeTemplateKey = 'CLASSIC'): ResumeDraftDto {
  return {
    title: 'My résumé',
    template,
    header: {
      fullName: sources.header.fullName, headline: sources.header.headline, phone: null, location: null, showEmail: true,
      links: sources.header.portfolioUrl ? [{ label: 'Portfolio', url: sources.header.portfolioUrl }] : [],
    },
    summary: sources.header.summary,
    qualificationIds: sources.qualifications.map((q) => q.id),
    termIds: [],
    skillTopicIds: sources.skills.map((s) => s.topicId),
    certificateIds: sources.certificates.map((c) => c.id),
    careerTargetIds: [],
    declaredSkills: [],
    projects: [],
    languages: [],
  };
}

export function verificationChip(label: string, verified: boolean): React.ReactElement {
  const tone = verified ? 'green' : label.includes('pending') ? 'amber' : 'slate';
  return <span className={`pilot-chip ${tone}`} style={{ whiteSpace: 'nowrap' }}>{label}</span>;
}

export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadVersion(token: string, resumeId: string, versionNumber: number): Promise<string> {
  try {
    const { blob, filename } = await downloadResumePdf(token, resumeId, versionNumber);
    await saveBlob(blob, filename);
    return 'PDF downloaded.';
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 429) return 'You have downloaded many PDFs in the last hour. Try again later.';
    return 'The PDF could not be prepared. Try again.';
  }
}

// --- Paper preview -----------------------------------------------------------

const PAPER: Record<ResumeTemplateKey, { readonly accent: string; readonly base: number; readonly centre: boolean; readonly band: boolean }> = {
  CLASSIC: { accent: '#111827', base: 12.5, centre: true, band: false },
  MODERN: { accent: '#1d4ed8', base: 12.5, centre: false, band: true },
  COMPACT: { accent: '#0f766e', base: 11.5, centre: false, band: false },
};

/** The résumé as the PDF lays it out, in HTML. `template` overrides the content's own (the Examples tab). */
export function ResumePaper({ content, template, compact = false }: { readonly content: ResumeContentDto; readonly template?: ResumeTemplateKey; readonly compact?: boolean }): React.ReactElement {
  const style = PAPER[template ?? content.template] ?? PAPER.CLASSIC;
  const size = compact ? style.base - 2.5 : style.base;
  const contact = [content.header.email, content.header.phone, content.header.location,
    ...content.header.links.map((link) => (link.label ? `${link.label}: ${link.url}` : link.url))].filter(Boolean).join('  ·  ');
  const heading = (text: string) => <h3 style={{
    margin: '14px 0 6px', fontSize: size + 1, fontWeight: 800, color: style.accent,
    textTransform: style.centre ? 'uppercase' : 'none', borderBottom: style.band ? 'none' : '1px solid #d1d5db', paddingBottom: style.band ? 0 : 3,
  }}>{text}</h3>;
  const muted = { color: '#4b5563', fontSize: size - 1.5 } as const;
  return <article aria-label="Résumé preview" style={{ background: '#fff', color: '#111827', border: '1px solid var(--p-line)', borderRadius: 10, overflow: 'hidden', fontSize: size, lineHeight: 1.45, boxShadow: '0 1px 2px rgba(15,23,42,.06)' }}>
    <header style={{ padding: compact ? '14px 16px 10px' : '22px 26px 14px', background: style.band ? '#1e3a8a' : 'transparent', color: style.band ? '#fff' : '#111827', textAlign: style.centre ? 'center' : 'left', borderBottom: style.centre ? '1px solid #9ca3af' : 'none' }}>
      <div style={{ fontSize: size + 9, fontWeight: 800 }}>{content.header.fullName ?? 'NA'}</div>
      {content.header.headline ? <div style={{ fontSize: size + 0.5, opacity: 0.9 }}>{content.header.headline}</div> : null}
      {contact ? <div style={{ fontSize: size - 1.5, marginTop: 4, color: style.band ? '#dbeafe' : '#4b5563', overflowWrap: 'anywhere' }}>{contact}</div> : null}
    </header>
    <div style={{ padding: compact ? '0 16px 14px' : '0 26px 20px' }}>
      {content.summary ? <>{heading('Summary')}<p style={{ margin: 0, whiteSpace: 'pre-line' }}>{content.summary}</p></> : null}
      {content.objective.length ? <>{heading('Career objective')}<p style={{ margin: 0 }}>{content.objective.join('  ·  ')}</p></> : null}
      {content.education.length ? <>{heading('Education')}{content.education.map((entry, index) => (
        <div key={`${entry.title}-${index}`} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{entry.title}</strong><span style={muted}>{entry.period ?? ''}</span></div>
          {entry.institution ? <div style={muted}>{entry.institution}</div> : null}
          <div style={{ fontSize: size - 2, color: entry.verified ? '#047857' : '#6b7280', fontWeight: entry.verified ? 700 : 500 }}>{[entry.status, entry.verification].filter(Boolean).join('  ·  ')}</div>
          {entry.results.map((line) => <div key={line.label} style={{ fontSize: size - 1.5, paddingLeft: 10, color: line.verified ? '#047857' : '#6b7280' }}>{line.label} — {line.result}  ·  {line.verification}</div>)}
        </div>
      ))}</> : null}
      {content.skills.shown.length || content.skills.declared.length ? <>{heading('Skills')}
        {content.skills.shown.map((skill) => <div key={skill.name}><strong style={{ fontWeight: 600 }}>{skill.name}</strong> <span style={{ ...muted, fontSize: size - 2 }}>{skill.basis}</span></div>)}
        {content.skills.declared.length ? <div style={{ marginTop: 4 }}>Self-declared skills: {content.skills.declared.join(', ')}</div> : null}
      </> : null}
      {content.projects.length ? <>{heading('Projects (self-declared)')}{content.projects.map((project, index) => (
        <div key={`${project.title}-${index}`} style={{ marginBottom: 6 }}>
          <strong style={{ fontWeight: 600 }}>{project.title}</strong>
          {project.url ? <div style={{ fontSize: size - 2, color: style.accent, overflowWrap: 'anywhere' }}>{project.url}</div> : null}
          {project.description ? <div style={{ whiteSpace: 'pre-line' }}>{project.description}</div> : null}
        </div>
      ))}</> : null}
      {content.certificates.length ? <>{heading('Certificates (self-declared)')}{content.certificates.map((certificate, index) => (
        <div key={`${certificate.title}-${index}`}><strong style={{ fontWeight: 600 }}>{certificate.title}</strong>{certificate.description ? <span style={muted}> — {certificate.description}</span> : null}</div>
      ))}</> : null}
      {content.languages.length ? <>{heading('Languages (self-declared)')}<div>{content.languages.join(', ')}</div></> : null}
      <p style={{ margin: '14px 0 0', paddingTop: 6, borderTop: '1px solid #e5e7eb', fontSize: size - 3, color: '#6b7280' }}>{content.legend} Generated {content.generatedOn}.</p>
    </div>
  </article>;
}

// --- Checks ------------------------------------------------------------------

export function ResumeChecksList({ checks }: { readonly checks: readonly ResumeCheckDto[] }): React.ReactElement {
  return <div className="pilot-list">
    {checks.map((check) => (
      <div key={check.key} className="pilot-list-row">
        <span className={`pilot-tile ${check.passed ? 'green' : 'amber'}`} style={{ width: 30, height: 30 }}>{check.passed ? <Icon name="check" size={16} /> : <Icon name="warning" size={16} />}</span>
        <div className="grow"><strong style={{ fontSize: 12.5 }}>{check.message}</strong><small>{check.passed ? 'Done' : 'Not yet'}</small></div>
      </div>
    ))}
  </div>;
}

// --- Builder -----------------------------------------------------------------

const splitList = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean);

const FIELD_MESSAGES: Record<string, string> = {
  title: 'Give the résumé a title.', 'header.phone': 'Check the phone number.', 'header.links': 'Links must start with https://.',
  projects: 'Each project needs a title; links must start with https://.', summary: 'The summary is too long.',
};

export function ResumeBuilder({ token, sources, templates, initial, resumeId, onSaved, onCancel }: {
  readonly token: string;
  readonly sources: ResumeSourcesDto;
  readonly templates: readonly ResumeTemplateDto[];
  readonly initial: ResumeDraftDto;
  readonly resumeId: string | null;
  readonly onSaved: (resumeId: string) => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<ResumeDraftDto>(initial);
  const [skillsText, setSkillsText] = useState(initial.declaredSkills.join(', '));
  const [languagesText, setLanguagesText] = useState(initial.languages.join(', '));
  const [preview, setPreview] = useState<{ readonly content: ResumeContentDto; readonly checks: readonly ResumeCheckDto[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** True when the server refused the draft itself, so saving it would be refused too. */
  const [invalid, setInvalid] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const effective = useMemo<ResumeDraftDto>(() => ({ ...draft, declaredSkills: splitList(skillsText), languages: splitList(languagesText) }), [draft, skillsText, languagesText]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      previewResume(token, effective, controller.signal)
        .then((result) => { setPreview(result); setProblem(null); setInvalid(false); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setInvalid(error instanceof ApiRequestError && error.status === 400);
          setProblem(error instanceof ApiRequestError && error.status === 400
            ? (FIELD_MESSAGES[error.field ?? ''] ?? 'Check the highlighted text: some of it cannot go on a résumé.')
            : 'The preview could not be updated. Your choices are kept.');
        });
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [token, effective]);

  const set = (patch: Partial<ResumeDraftDto>) => setDraft((current) => ({ ...current, ...patch }));
  const setHeader = (patch: Partial<ResumeDraftDto['header']>) => setDraft((current) => ({ ...current, header: { ...current.header, ...patch } }));
  const toggle = (key: 'qualificationIds' | 'termIds' | 'skillTopicIds' | 'certificateIds' | 'careerTargetIds', id: string) =>
    setDraft((current) => ({ ...current, [key]: current[key].includes(id) ? current[key].filter((value) => value !== id) : [...current[key], id] }));
  const empty = (value: string) => (value.trim() === '' ? null : value);

  async function save(): Promise<void> {
    setSaving(true); setStatus(null);
    try {
      const result = resumeId ? await saveResumeVersion(token, resumeId, effective) : await createResume(token, effective);
      setStatus(`Saved as version ${result.resume.latest?.versionNumber ?? 1}.`);
      onSaved(result.resume.id);
    } catch (error) {
      setStatus(error instanceof ApiRequestError && error.status === 429
        ? 'You have reached a limit (20 résumés, 50 versions each, or 30 saves an hour). Delete one or try again later.'
        : error instanceof ApiRequestError && error.status === 400 ? (FIELD_MESSAGES[error.field ?? ''] ?? 'Some text cannot go on a résumé. Check it and save again.')
          : 'The résumé could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const check = (checked: boolean, onChange: () => void, label: React.ReactNode, chip?: React.ReactNode) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ marginTop: 3 }} />
      <span style={{ flex: 1, fontSize: 12.5 }}>{label}</span>{chip}
    </label>
  );

  return <div className="pilot-two" style={{ alignItems: 'start' }}>
    <div>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>{resumeId ? 'New version' : 'New résumé'}</h2><span className="pilot-chip blue">From your ONE record</span></div>
        <label className="pilot-field"><span>Title (only you see it)</span><input value={draft.title} maxLength={120} onChange={(event) => set({ title: event.target.value })} /></label>
        <label className="pilot-field"><span>Template</span>
          <select value={draft.template} onChange={(event) => set({ template: event.target.value as ResumeTemplateKey })}>
            {templates.map((template) => <option key={template.key} value={template.key}>{template.name}</option>)}
          </select>
        </label>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Header</h2></div>
        <label className="pilot-field"><span>Name</span><input value={draft.header.fullName ?? ''} maxLength={160} onChange={(event) => setHeader({ fullName: empty(event.target.value) })} /></label>
        <label className="pilot-field"><span>Headline</span><input value={draft.header.headline ?? ''} maxLength={160} onChange={(event) => setHeader({ headline: empty(event.target.value) })} /></label>
        <label className="pilot-field"><span>Phone (optional)</span><input value={draft.header.phone ?? ''} maxLength={20} inputMode="tel" onChange={(event) => setHeader({ phone: empty(event.target.value) })} /></label>
        <label className="pilot-field"><span>City (optional)</span><input value={draft.header.location ?? ''} maxLength={80} onChange={(event) => setHeader({ location: empty(event.target.value) })} /></label>
        {check(draft.header.showEmail, () => setHeader({ showEmail: !draft.header.showEmail }), <>Show my email{sources.header.email ? ` (${sources.header.email})` : ''}</>)}
        {draft.header.links.map((link, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <label className="pilot-field" style={{ width: 110 }}><span>Link label</span><input value={link.label ?? ''} maxLength={60} onChange={(event) => setHeader({ links: draft.header.links.map((item, at) => (at === index ? { ...item, label: empty(event.target.value) } : item)) })} /></label>
            <label className="pilot-field" style={{ flex: 1 }}><span>https:// link</span><input value={link.url} maxLength={256} onChange={(event) => setHeader({ links: draft.header.links.map((item, at) => (at === index ? { ...item, url: event.target.value } : item)) })} /></label>
            <button type="button" className="pilot-btn ghost small" aria-label="Remove link" style={{ marginBottom: 11 }} onClick={() => setHeader({ links: draft.header.links.filter((_, at) => at !== index) })}><Icon name="trash" size={16} /></button>
          </div>
        ))}
        {draft.header.links.length < 5 ? <button type="button" className="pilot-btn ghost small" onClick={() => setHeader({ links: [...draft.header.links, { label: null, url: 'https://' }] })}><Icon name="plus" size={16} /> Add a link</button> : null}
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Summary</h2><span className="pilot-chip slate">Your words</span></div>
        <label className="pilot-field"><span>A few lines about you</span><textarea rows={4} maxLength={1200} value={draft.summary ?? ''} onChange={(event) => set({ summary: empty(event.target.value) })} /></label>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Education</h2><span className="pilot-chip slate">{sources.qualifications.length || 'NA'}</span></div>
        {sources.qualifications.length ? sources.qualifications.map((q) => <div key={q.id}>
          {check(draft.qualificationIds.includes(q.id), () => toggle('qualificationIds', q.id),
            <><strong>{q.title}</strong><br /><small style={{ color: 'var(--p-muted)' }}>{[q.institution, q.period].filter(Boolean).join(' · ')}</small></>, verificationChip(q.verification, q.verified))}
          {draft.qualificationIds.includes(q.id) ? q.terms.map((t) => <div key={t.id} style={{ paddingLeft: 24 }}>
            {check(draft.termIds.includes(t.id), () => toggle('termIds', t.id), <>{t.label} — {t.result}</>, verificationChip(t.verification, t.verified))}
          </div>) : null}
        </div>) : <p style={{ color: 'var(--p-muted)', margin: 0 }}>No academic records yet. Add them under Academic record; your college can verify them.</p>}
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Skills</h2></div>
        {sources.skills.length ? sources.skills.map((s) => <div key={s.topicId}>{check(draft.skillTopicIds.includes(s.topicId), () => toggle('skillTopicIds', s.topicId), <><strong>{s.name}</strong><br /><small style={{ color: 'var(--p-muted)' }}>{s.basis}</small></>)}</div>)
          : <p style={{ color: 'var(--p-muted)', margin: '0 0 8px' }}>No skills shown in graded work yet — NA. They appear here once your skill checks show them.</p>}
        <label className="pilot-field"><span>Self-declared skills (comma-separated)</span><input value={skillsText} onChange={(event) => setSkillsText(event.target.value)} /></label>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Projects</h2><span className="pilot-chip slate">Self-declared</span></div>
        {draft.projects.map((project, index) => (
          <div key={index} style={{ borderBottom: '1px solid var(--p-line)', marginBottom: 8 }}>
            <label className="pilot-field"><span>Project title</span><input value={project.title} maxLength={120} onChange={(event) => set({ projects: draft.projects.map((item, at) => (at === index ? { ...item, title: event.target.value } : item)) })} /></label>
            <label className="pilot-field"><span>https:// link (optional)</span><input value={project.url ?? ''} maxLength={256} onChange={(event) => set({ projects: draft.projects.map((item, at) => (at === index ? { ...item, url: empty(event.target.value) } : item)) })} /></label>
            <label className="pilot-field"><span>What you did</span><textarea rows={3} maxLength={800} value={project.description ?? ''} onChange={(event) => set({ projects: draft.projects.map((item, at) => (at === index ? { ...item, description: empty(event.target.value) } : item)) })} /></label>
            <button type="button" className="pilot-btn ghost small" style={{ marginBottom: 8 }} onClick={() => set({ projects: draft.projects.filter((_, at) => at !== index) })}><Icon name="trash" size={16} /> Remove project</button>
          </div>
        ))}
        {draft.projects.length < 10 ? <button type="button" className="pilot-btn ghost small" onClick={() => set({ projects: [...draft.projects, { title: '', description: null, url: null }] })}><Icon name="plus" size={16} /> Add a project</button> : null}
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Certificates, objective and languages</h2></div>
        {sources.certificates.length ? sources.certificates.map((c) => <div key={c.id}>{check(draft.certificateIds.includes(c.id), () => toggle('certificateIds', c.id), <strong>{c.title}</strong>, verificationChip(c.verification, false))}</div>)
          : <p style={{ color: 'var(--p-muted)', margin: '0 0 6px' }}>No certificate documents — NA.</p>}
        {sources.careerTargets.map((t) => <div key={t.id}>{check(draft.careerTargetIds.includes(t.id), () => toggle('careerTargetIds', t.id), <>Career objective: <strong>{t.roleTitle}</strong></>)}</div>)}
        <label className="pilot-field"><span>Languages you speak (comma-separated)</span><input value={languagesText} onChange={(event) => setLanguagesText(event.target.value)} /></label>
      </section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="pilot-btn" disabled={saving || invalid} onClick={() => void save()}>{saving ? 'Saving…' : resumeId ? 'Save new version' : 'Save résumé'}</button>
        <button type="button" className="pilot-btn ghost" onClick={onCancel}>Cancel</button>
        {status ? <span role="status" style={{ fontSize: 12.5 }}>{status}</span> : null}
      </div>
    </div>

    <div>
      {problem ? <p role="alert" style={{ color: 'var(--p-rose)', marginTop: 0 }}>{problem}</p> : null}
      {preview ? <>
        <ResumePaper content={preview.content} />
        <section className="pilot-card" style={{ marginTop: 14 }}>
          <div className="pilot-card-head"><h2>Resume checks</h2><span className="pilot-chip slate">Checklist</span></div>
          <ResumeChecksList checks={preview.checks} />
        </section>
      </> : <p style={{ color: 'var(--p-muted)' }}>Preparing the preview…</p>}
    </div>
  </div>;
}

