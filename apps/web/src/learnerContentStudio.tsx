/**
 * Where learner content is written, reviewed and published.
 *
 * The storage, the lifecycle and the separation-of-duties rules have existed since
 * migration 0024; this is the desk that reaches them. Two of those rules are said on the
 * screen rather than left to be discovered as errors: approving needs a reviewer other
 * than the author, and publishing needs somebody other than the approver.
 *
 * The provenance columns are shown even though they are null for everything today. The
 * day a model writes a draft, whoever reviews it should see that it did — and a column
 * that only appears once it has a value is a column nobody notices.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  createLearnerContent,
  listLearnerContentQueue,
  transitionLearnerContent,
  type LearnerContentOperatorItemDto,
  type LearnerContentType,
} from './api.js';

const CONTENT_TYPES: readonly (readonly [LearnerContentType, string])[] = [
  ['PRACTICE', 'Practice'],
  ['COMPANY_PREP', 'Company Prep'],
  ['CAREER_TOOL', 'Career Tools'],
  ['SCHOLARSHIP', 'Scholarships'],
  ['RESUME_BUILDER', 'Resume Builder'],
];

/** What the lifecycle allows next, mirroring the domain package rather than guessing. */
const NEXT_STATES: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'],
  CHANGES_REQUESTED: ['IN_REVIEW', 'ARCHIVED'],
  APPROVED: ['CHANGES_REQUESTED', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

function messageFor(error: unknown, fallback: string): string {
  const code = (error as { code?: string })?.code;
  if (code === 'SEPARATION_OF_DUTIES') return 'Somebody else has to take that step — an author cannot approve their own work, and an approver cannot publish it.';
  if (code === 'INVALID_TRANSITION') return 'That is not a step this content can take from where it is.';
  if (code === 'INVALID_PROVENANCE') return 'Authored content cannot claim generated-content provenance.';
  if (code === 'INVALID_CONTENT') return 'Check the title, summary and body — something there is not acceptable.';
  return fallback;
}

export function LearnerContentStudio(): React.ReactElement {
  const [items, setItems] = useState<readonly LearnerContentOperatorItemDto[] | null>(null);
  const [filter, setFilter] = useState<LearnerContentType | ''>('');
  const [status, setStatus] = useState('Loading…');
  const [writing, setWriting] = useState(false);

  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listLearnerContentQueue(token, filter || undefined);
    setItems(response.items);
    setStatus(message ?? '');
  };
  useEffect(() => { void reload().catch(() => setStatus('The content queue could not be loaded. This screen needs a content operations role.')); }, [filter]);

  async function move(contentId: string, toState: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await transitionLearnerContent(token, contentId, toState);
      await reload(toState === 'PUBLISHED' ? 'Published. Students will see it on that page now.' : 'Moved.');
    } catch (error) {
      setStatus(messageFor(error, 'That step could not be taken.'));
    }
  }

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Learner content</h2>
      <p>Practice, Company Prep, Career Tools, Scholarships and Resume Builder read from here. Until something is published, those pages show NA — which is the truth, not a bug.</p>
      <p className="hiring-meta"><strong>Approving needs a reviewer other than the author, and publishing needs somebody other than the approver.</strong> The database enforces both.</p>
      <label className="student-form-field"><span>Page</span>
        <select value={filter} onChange={(event) => setFilter(event.target.value as LearnerContentType | '')}>
          <option value="">All pages</option>
          {CONTENT_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </label>
      {status ? <p role="status">{status}</p> : null}
      {writing
        ? <DraftForm onSaved={() => { setWriting(false); void reload('Draft saved. Send it for review when it is ready.'); }} onFail={(message) => setStatus(message)} onCancel={() => setWriting(false)} />
        : <button type="button" onClick={() => setWriting(true)}>Write something</button>}
    </section>

    {items && items.length === 0
      ? <section className="card wide-card"><p>Nothing is in the queue. Anything published already has left it.</p></section>
      : null}

    {items && items.length > 0 ? <section className="card wide-card">
      <div className="data-table-wrap"><table>
        <thead><tr><th>Title</th><th>Page</th><th>State</th><th>Source</th><th>Written by a model?</th><th>Next</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td>{item.title}{item.summary ? <><br /><span className="hiring-meta">{item.summary}</span></> : null}</td>
          <td>{CONTENT_TYPES.find(([code]) => code === item.contentType)?.[1] ?? item.contentType}</td>
          <td><span className={`hiring-state state-${item.reviewState.toLowerCase()}`}>{item.reviewState.replace(/_/g, ' ').toLowerCase()}</span></td>
          <td>{item.source.toLowerCase()}</td>
          <td>{item.generatorVersion
            ? <>{item.generatorVersion}<br /><span className="hiring-meta">prompt {item.promptVersion ?? 'NA'}</span></>
            : <span className="hiring-meta">No — written by a person</span>}</td>
          <td><div className="hiring-actions">
            {(NEXT_STATES[item.reviewState] ?? []).map((next) => <button
              key={next}
              type="button"
              className={next === 'PUBLISHED' ? undefined : 'secondary'}
              onClick={() => { void move(item.id, next); }}
            >{next.replace(/_/g, ' ').toLowerCase()}</button>)}
          </div></td>
        </tr>)}</tbody>
      </table></div>
    </section> : null}
  </div>;
}

function DraftForm({ onSaved, onFail, onCancel }: {
  readonly onSaved: () => void;
  readonly onFail: (message: string) => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const [contentType, setContentType] = useState<LearnerContentType>('PRACTICE');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return;
    setSaving(true);
    try {
      await createLearnerContent(token, {
        contentType, title,
        summary: summary.trim() || null,
        // The stored shape is free-form JSON; `body` is the key the learner pages render.
        content: { body: body.trim() },
      });
      onSaved();
    } catch (error) {
      onFail(messageFor(error, 'That draft could not be saved.'));
    } finally { setSaving(false); }
  }

  return <form className="student-form" onSubmit={(event) => { void submit(event); }}>
    <label className="student-form-field"><span>Which page</span>
      <select value={contentType} onChange={(event) => setContentType(event.target.value as LearnerContentType)}>
        {CONTENT_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
    </label>
    <label className="student-form-field"><span>Title</span>
      <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} required />
    </label>
    <label className="student-form-field"><span>Summary</span>
      <input value={summary} maxLength={1000} onChange={(event) => setSummary(event.target.value)} />
    </label>
    <label className="student-form-field"><span>Body</span>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} required />
    </label>
    <p className="hiring-meta">Saved as a draft. No student sees it until somebody else approves it and a third person publishes it.</p>
    <div className="hiring-actions">
      <button type="submit" disabled={saving || !title.trim() || !body.trim()}>Save draft</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
