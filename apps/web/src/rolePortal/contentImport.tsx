/**
 * ONE · Role portal — Operations Content Management: bulk import (OPS-09d).
 *
 * Lives under the existing Content Management label (Appendix 1 §4.2), below the lesson editor; no
 * navigation item is added. An operator with Content Edit chooses what the file holds (skills,
 * questions, lessons or lesson variants), picks a CSV or JSON file, previews it — the server runs
 * every row through the editors and reports each row's problems without writing anything — and
 * commits exactly what was previewed, with a reason code. Every imported row is a draft the
 * importer wrote, so the importer never reviews or publishes it; it continues in the editors above.
 *
 * The server decides everything. The report never shows a row's text (so never an answer key), only
 * its row number, key and problems. Missing counts read NA.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  commitContentImport,
  getContentImportPolicy,
  getProtectedAccessToken,
  previewContentImport,
} from '../api.js';
import type { ContentImportFormat, ContentImportKind, ContentImportPolicyDto, ContentImportReportDto, ContentImportUpload } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const kindNames: Readonly<Record<ContentImportKind, string>> = {
  SKILL: 'Skills (skill map)',
  QUESTION: 'Questions (question bank)',
  LESSON: 'Lessons',
  LESSON_VARIANT: 'Lesson variants (language, level or style)',
};

/** Plain words for the problems an operator can fix in the file; anything else shows its code. */
const issueWords: Readonly<Record<string, string>> = {
  IMPORT_FIELD_REQUIRED: 'A required field is empty',
  IMPORT_FIELD_UNKNOWN: 'This field is not part of the import',
  IMPORT_FIELD_NOT_TEXT: 'This field must be text',
  IMPORT_ROW_NOT_AN_OBJECT: 'This entry is not a row of fields',
  IMPORT_ROW_TOO_MANY_CELLS: 'This row has more cells than the header',
  IMPORT_KEY_DUPLICATE: 'The same key appears on more than one row',
  IMPORT_VARIANT_DUPLICATE: 'The same variant appears on more than one row',
  IMPORT_LICENCE_UNKNOWN: 'The licence is not one ONE accepts',
  IMPORT_OPTIONS_NOT_CONSECUTIVE: 'Options must be filled from option_a without gaps',
  IMPORT_CORRECT_OPTION_INVALID: 'The correct option must be a letter a to f',
  IMPORT_DIFFICULTY_UNKNOWN: 'The difficulty is not FOUNDATION, INTERMEDIATE or ADVANCED',
  IMPORT_MISCONCEPTION_UNKNOWN: 'No misconception has this code',
  IMPORT_MISCONCEPTION_WITHOUT_OPTION: 'A misconception names an empty option',
  IMPORT_RATIONALE_WITHOUT_MISCONCEPTION: 'A rationale has no misconception code',
  IMPORT_LEVEL_UNKNOWN: 'The level is not one ONE accepts',
  IMPORT_STYLE_UNKNOWN: 'The style is not one ONE accepts',
  IMPORT_LANGUAGE_UNKNOWN: 'The language is not one ONE accepts',
  IMPORT_BASE_LESSON_UNKNOWN: 'No lesson has this base key',
  IMPORT_ROW_REJECTED: 'The row could not be evaluated',
  SKILL_KEY_EXISTS: 'A skill with this key already exists',
  QUESTION_KEY_EXISTS: 'A question with this key already exists',
  LESSON_KEY_EXISTS: 'A lesson with this key already exists',
  SKILL_PREREQUISITE_CYCLE: 'The prerequisites form a cycle',
  LESSON_PREREQUISITE_CYCLE: 'The prerequisites form a cycle',
  SKILL_PREREQUISITE_UNKNOWN: 'A prerequisite is not a known skill',
  LESSON_PREREQUISITE_UNKNOWN: 'A prerequisite is not a known lesson',
  QUESTION_TOPIC_UNKNOWN: 'The skill key is not a known skill',
  LESSON_TOPIC_UNKNOWN: 'The skill key is not a known skill',
  QUESTION_MISCONCEPTION_UNKNOWN: 'The misconception belongs to another skill',
  LESSON_BASE_NOT_LIVE: 'The base lesson is not published yet',
  LESSON_VARIANT_EXISTS: 'This variant already exists',
};

const fileWords: Readonly<Record<string, string>> = {
  IMPORT_FILE_EMPTY: 'The file has no rows.',
  IMPORT_FILE_TOO_LARGE: 'The file is larger than the import allows.',
  IMPORT_TOO_MANY_ROWS: 'The file has more rows than one import allows. Split it.',
  IMPORT_JSON_INVALID: 'The file is not valid JSON.',
  IMPORT_JSON_NOT_A_LIST: 'A JSON file must be a list of rows.',
  IMPORT_CSV_UNTERMINATED_QUOTE: 'A quoted CSV field is never closed.',
  IMPORT_COLUMN_UNKNOWN: 'This column is not part of the import',
  IMPORT_COLUMN_DUPLICATE: 'This column appears twice',
  IMPORT_COLUMN_MISSING: 'A required column is missing',
  IMPORT_COLUMN_BLANK: 'A column has no name.',
};

function describeIssue(code: string, words: Readonly<Record<string, string>>): string {
  const [head, detail] = code.split(':');
  const text = head ? words[head] : undefined;
  if (!text) return code;
  return detail ? `${text}: ${detail}` : text;
}

function importError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    if (cause.code === 'IMPORT_STALE') return `The file or the content changed since the preview, so nothing was imported. It has been previewed again; check the report and commit again. Reference: ${cause.correlationId}`;
    if (cause.code === 'IMPORT_HAS_INVALID_ROWS') return `A row is no longer valid, so nothing was imported. It has been previewed again; fix the rows below. Reference: ${cause.correlationId}`;
    if (cause.code === 'IMPORT_FILE_INVALID') return `The file has a problem, so nothing was imported. Reference: ${cause.correlationId}`;
    if (cause.code === 'IMPORT_FILE_TOO_LARGE') return `The file is larger than the import allows. Split it. Reference: ${cause.correlationId}`;
  }
  return formatApiError(cause, fallback);
}

function formatOf(filename: string): ContentImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'CSV';
  if (lower.endsWith('.json')) return 'JSON';
  return null;
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsText(file);
  });
}

export function OperationsContentImportPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<ContentImportPolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [error, setError] = useState('');
  const [kind, setKind] = useState<ContentImportKind>('SKILL');
  const [format, setFormat] = useState<ContentImportFormat>('CSV');
  const [file, setFile] = useState<{ readonly filename: string; readonly content: string } | null>(null);
  const [report, setReport] = useState<ContentImportReportDto | null>(null);
  const [previewed, setPreviewed] = useState<ContentImportUpload | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getContentImportPolicy(token, controller.signal)
      .then((result) => {
        if (!result || !Array.isArray(result.kinds) || !Array.isArray(result.reasons)) { setError('Unable to load the import policy.'); return; }
        setPolicy(result);
        setForbiddenReference('');
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the import policy.'));
      });
    return () => controller.abort();
  }, [token]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content Management</span><h1>Bulk import</h1>
    <p>Import skills, questions, lessons or lesson variants from a CSV or JSON file. Every row goes through the same checks as the editors above and becomes a draft you wrote: nothing is published, and someone else reviews and publishes each one. Preview first — nothing is written until you commit, and a file with any problem is never imported.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="Bulk import is for staff who hold Content Edit. Your access has not changed; the rest of Content Management is unaffected."
        hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const fields = policy ? policy.kinds.find((entry) => entry.kind === kind) : undefined;
  const upload: ContentImportUpload | null = file ? { kind, format, filename: file.filename, content: file.content } : null;
  const current = Boolean(report && previewed && upload && previewed.kind === upload.kind && previewed.format === upload.format
    && previewed.content === upload.content && previewed.filename === upload.filename);
  const committable = Boolean(current && report && report.fileProblems.length === 0 && report.rowCount > 0 && report.counts.invalid === 0);

  const choose = async (picked: File | undefined): Promise<void> => {
    setNotice('');
    setError('');
    setReport(null);
    setPreviewed(null);
    if (!picked) { setFile(null); return; }
    try {
      const content = await readFileText(picked);
      const detected = formatOf(picked.name);
      if (detected) setFormat(detected);
      setFile({ filename: picked.name.slice(0, policy ? policy.limits.filename : 160), content });
    } catch {
      setFile(null);
      setError('The file could not be read.');
    }
  };

  const runPreview = async (input: ContentImportUpload): Promise<void> => {
    const result = await previewContentImport(token, input);
    setReport(result.preview);
    setPreviewed(input);
  };

  const preview = async (): Promise<void> => {
    if (!upload) return;
    if (policy && upload.content.length > policy.limits.characters) { setError(`The file is larger than ${policy.limits.characters.toLocaleString()} characters. Split it.`); return; }
    setBusy(true);
    setNotice('');
    try {
      await runPreview(upload);
      setError('');
    } catch (cause) {
      setError(importError(cause, 'The file could not be previewed.'));
    } finally { setBusy(false); }
  };

  const commit = async (reasonCode: string): Promise<void> => {
    if (!previewed || !report) return;
    try {
      const result = await commitContentImport(token, { ...previewed, previewDigest: report.digest, reasonCode });
      setConfirming(false);
      setNotice(`Imported ${result.import.created} ${result.import.created === 1 ? 'draft' : 'drafts'}. Open them in the editors above to finish, submit and review them. Reference: ${result.correlationId}`);
      setReport(null);
      setPreviewed(null);
      setFile(null);
    } catch (cause) {
      setConfirming(false);
      setError(importError(cause, 'The import could not be committed.'));
      if (cause instanceof ApiRequestError && (cause.code === 'IMPORT_STALE' || cause.code === 'IMPORT_HAS_INVALID_ROWS') && upload) {
        try { await runPreview(upload); } catch { /* the error above already says what to do */ }
      }
    }
  };

  return <section className="role-module role-module--dense" aria-label="Bulk import">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🧾" tone="teal" value={report ? report.rowCount : 'NA'} label="Rows in the file" />
      <V2Stat icon="✅" tone="blue" value={report ? report.counts.create : 'NA'} label="Ready to import as drafts" />
      <V2Stat icon="⚠️" tone="amber" value={report ? report.counts.invalid : 'NA'} label="Rows with problems" />
      <V2Stat icon="📏" tone="purple" value={policy ? policy.limits.rows : 'NA'} label="Rows allowed per file" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="role-card role-wide"><div className="role-section-title"><h2>File</h2></div>
      {!policy && !error ? <p>Loading the import policy…</p> : null}
      {policy ? <form className="role-actions" aria-label="Choose an import file" onSubmit={(event) => { event.preventDefault(); void preview(); }}>
        <label className="role-local-search"><span>What the file holds</span>
          <select aria-label="Import kind" value={kind} onChange={(event) => { setKind(event.target.value as ContentImportKind); setReport(null); setPreviewed(null); setNotice(''); }}>
            {policy.kinds.map((entry) => <option key={entry.kind} value={entry.kind}>{kindNames[entry.kind]}</option>)}
          </select></label>
        <label className="role-local-search"><span>Format</span>
          <select aria-label="Import format" value={format} onChange={(event) => { setFormat(event.target.value as ContentImportFormat); setReport(null); setPreviewed(null); }}>
            {policy.formats.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select></label>
        <label className="role-local-search"><span>File</span>
          <input type="file" aria-label="Import file" accept=".csv,.json,text/csv,application/json" onChange={(event) => void choose(event.target.files ? event.target.files[0] : undefined)} /></label>
        <button type="submit" className="pilot-btn" disabled={busy || !upload}>{busy ? 'Previewing…' : 'Preview'}</button>
      </form> : null}
      {fields ? <dl>
        <div><dt>Required fields</dt><dd>{fields.required.join(', ')}</dd></div>
        <div><dt>Optional fields</dt><dd>{fields.optional.length ? fields.optional.join(', ') : 'None'}</dd></div>
        <div><dt>Limits</dt><dd>{policy ? `${policy.limits.rows} rows and ${policy.limits.characters.toLocaleString()} characters per file. CSV has a header row; JSON is a list of rows with the same field names. Prerequisites are keys separated by semicolons. Any other column or field is refused.` : 'NA'}</dd></div>
      </dl> : null}
    </section>

    <section className="role-card role-wide" aria-label="Validation report"><div className="role-section-title"><h2>Validation report</h2>
      {committable ? <button type="button" className="pilot-btn" onClick={() => setConfirming(true)}>Import {report ? report.counts.create : 0} as drafts…</button> : null}</div>
      {!report ? <V2EmptyState icon="📄" title="No file previewed yet" note="Choose what the file holds, pick a CSV or JSON file and preview it. The preview checks every row and writes nothing." /> : null}
      {report && report.fileProblems.length ? <div role="alert"><p><strong>The file cannot be imported.</strong> Nothing was written.</p>
        <ul>{report.fileProblems.map((problem) => <li key={problem}>{describeIssue(problem, fileWords)}</li>)}</ul></div> : null}
      {report && !report.fileProblems.length && report.counts.invalid ? <p role="note">{report.counts.invalid} {report.counts.invalid === 1 ? 'row has' : 'rows have'} problems. Nothing can be imported until every row is fixed; nothing was written.</p> : null}
      {report && committable ? <p role="note">Every row is ready. Committing imports exactly this file as drafts; nothing is published.</p> : null}
      {report && report.rows.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Rows">
        <thead><tr><th>Row</th><th>Key</th><th>Result</th><th>Problems</th></tr></thead>
        <tbody>{report.rows.map((row) => <tr key={row.rowNumber}>
          <td>{row.rowNumber}</td>
          <td>{row.key || 'NA'}</td>
          <td><StatusBadge label={row.outcome === 'CREATE' ? 'Ready' : 'Problem'} tone={row.outcome === 'CREATE' ? 'success' : 'warning'} /></td>
          <td>{row.issues.length ? <ul>{row.issues.map((issue) => <li key={issue}>{describeIssue(issue, issueWords)}</li>)}</ul> : 'None'}</td>
        </tr>)}</tbody></table></div> : null}
    </section>

    {confirming && report && policy ? <CommitDialog count={report.counts.create} kind={report.kind} reasons={policy.reasons}
      onCancel={() => setConfirming(false)} onSubmit={commit} /> : null}
  </section>;
}

/** The confirm dialog for a commit: a reason code is required; no approval is needed for drafts. */
function CommitDialog({ count, kind, reasons, onCancel, onSubmit }: {
  readonly count: number; readonly kind: ContentImportKind; readonly reasons: readonly string[];
  readonly onCancel: () => void; readonly onSubmit: (reasonCode: string) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    await onSubmit(reasonCode);
    setBusy(false);
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="content-import-commit-title">
      <h2 id="content-import-commit-title">Import {count} {kindNames[kind].toLowerCase()} as drafts</h2>
      <dl>
        <div><dt>Approval</dt><dd>Not required: every row becomes a draft no student sees until someone else reviews it and it is published.</dd></div>
        <div><dt>Author</dt><dd>You. You will not be able to review or publish these drafts.</dd></div>
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select aria-label="Reason code" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Importing…' : 'Import as drafts'}</button>
        </div>
      </form>
    </section>
  </div>;
}
