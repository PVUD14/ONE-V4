/**
 * Demo-site lecturer (faculty) portal: Prof. Suresh Raman at the fictional Lakeview
 * Institute of Technology. It shows what a lecturer does in ONE - see the students
 * they teach, run class assessments, verify student evidence and former students'
 * academic records, assign practice and post announcements.
 *
 * Fictional, demo-site only. The students are the same people the placement officer
 * and employer demos show (Arjun, Priya, Sneha...) and Kavitha is the graduate from the
 * graduate demo, so a presenter can follow one story across roles.
 */
import { useState } from 'react';
import { BookOpen, CheckCircle2, ClipboardCheck, FileCheck2, Megaphone, Plus, Send, ShieldCheck, Users } from 'lucide-react';
import { DetailRows, OverlayForm, PilotTabs, useOverlay } from '../pilot/pilotOverlay.js';
import { KpiRow, PageHead, Person, initialsOf, wired } from './demoKit.js';

export const lecturerPersona = {
  name: 'Prof. Suresh Raman',
  initials: 'SR',
  role: 'Associate Professor · CSE',
  college: 'Lakeview Institute of Technology',
  email: 'suresh.raman@lakeview.example',
} as const;

const CLASSES = [
  { code: 'CSE 3A', subject: 'Data Structures', students: 62, next: 'Today, 11:00 AM · Room B-204' },
  { code: 'CSE 3B', subject: 'Database Systems', students: 58, next: 'Tomorrow, 09:00 AM · Lab 3' },
  { code: 'CSE 4', subject: 'Final-year project mentoring', students: 12, next: 'Friday, 02:00 PM · Staff room' },
] as const;

const BAND_TONE: Readonly<Record<string, string>> = {
  'Ready for next step': 'green', Progressing: 'blue', Developing: 'amber', 'Not enough evidence': 'slate',
};

const MY_STUDENTS = [
  { name: 'Arjun Reddy', registration: 'LIT2027-0412', cls: 'CSE 3A', band: 'Progressing', lastTest: 'DS Unit Test 2 · 82%', attendance: '91%' },
  { name: 'Priya Sharma', registration: 'LIT2027-0388', cls: 'CSE 3A', band: 'Ready for next step', lastTest: 'DS Unit Test 2 · 88%', attendance: '96%' },
  { name: 'Fatima Khan', registration: 'LIT2027-0233', cls: 'CSE 3A', band: 'Ready for next step', lastTest: 'DS Unit Test 2 · 91%', attendance: '94%' },
  { name: 'Divya Krishnan', registration: 'LIT2027-0307', cls: 'CSE 3B', band: 'Developing', lastTest: 'SQL Lab Quiz 1 · 54%', attendance: '78%' },
  { name: 'Suresh Babu', registration: 'LIT2027-0688', cls: 'CSE 3B', band: 'Progressing', lastTest: 'SQL Lab Quiz 1 · 70%', attendance: '88%' },
  { name: 'Rohit Verma', registration: 'LIT2027-0590', cls: 'CSE 3B', band: 'Not enough evidence', lastTest: 'Not attempted', attendance: '64%' },
] as const;

interface ClassAssessment {
  readonly name: string;
  readonly cls: string;
  readonly when: string;
  readonly status: 'Completed' | 'Scheduled' | 'Draft';
  readonly result?: string;
}

const CLASS_ASSESSMENTS: readonly ClassAssessment[] = [
  { name: 'DS Unit Test 2 — Trees', cls: 'CSE 3A', when: '14 May', status: 'Completed', result: '58 of 62 attempted · class average 71%' },
  { name: 'SQL Lab Quiz 1 — Joins', cls: 'CSE 3B', when: '16 May', status: 'Completed', result: '51 of 58 attempted · class average 66%' },
  { name: 'SQL Lab Quiz 2 — Normalisation', cls: 'CSE 3B', when: '24 May, 09:00 AM', status: 'Scheduled' },
  { name: 'DS Mock — Graphs & Hashing', cls: 'CSE 3A', when: 'Not scheduled', status: 'Draft' },
];

interface VerificationItem {
  readonly id: string;
  readonly name: string;
  readonly relation: 'Current student' | 'Former student';
  readonly detail: string;
  readonly item: string;
  readonly submitted: string;
}

const EVIDENCE_QUEUE: readonly VerificationItem[] = [
  { id: 'e1', name: 'Arjun Reddy', relation: 'Current student', detail: 'CSE 3A · LIT2027-0412', item: 'Project: Placement Portal Mini-Project (React, Node.js)', submitted: '2 days ago' },
  { id: 'e2', name: 'Sneha Iyer', relation: 'Current student', detail: 'IT 3 · project mentee · LIT2027-0176', item: 'Certificate: SQL for Data Analysis (40 hours)', submitted: '3 days ago' },
  { id: 'e3', name: 'Suresh Babu', relation: 'Current student', detail: 'CSE 3B · LIT2027-0688', item: 'Hackathon: Smart Campus Challenge — participation', submitted: '5 days ago' },
];

const RECORD_QUEUE: readonly VerificationItem[] = [
  { id: 'r1', name: 'Kavitha Selvam', relation: 'Former student', detail: 'B.Tech IT · 2018 – 2022 · LIT2022-0187', item: 'Degree awarded and final CGPA 8.4', submitted: 'Today' },
  { id: 'r2', name: 'Lakshmi Priya', relation: 'Former student', detail: 'B.Tech IT · 2022 – 2026 · LIT2026-0341', item: 'Semester 1–8 marks', submitted: 'Yesterday' },
  { id: 'r3', name: 'Mohammed Irfan', relation: 'Former student', detail: 'B.Tech ECE · 2022 – 2026 · LIT2026-0455', item: 'Degree awarded', submitted: '4 days ago' },
];

const RESOURCES = [
  { title: 'Trees & Graphs practice set', kind: '40 questions', cls: 'CSE 3A', due: '22 May', done: 41, total: 62 },
  { title: 'SQL joins worksheet', kind: '25 questions', cls: 'CSE 3B', due: '20 May', done: 49, total: 58 },
  { title: 'Hashing — recorded lecture', kind: 'Video · 38 min', cls: 'CSE 3A', due: '25 May', done: 18, total: 62 },
] as const;

const ANNOUNCEMENTS = [
  { title: 'SQL Lab Quiz 2 moved to Lab 3', audience: 'CSE 3B', when: 'Today, 08:10 AM' },
  { title: 'Trees & Graphs practice set is live', audience: 'CSE 3A', when: 'Yesterday' },
  { title: 'Project review slots for next week', audience: 'CSE 4 project teams', when: '2 days ago' },
] as const;

export function LecturerDashboard({ onNavigate }: { readonly onNavigate: (key: string) => void }): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Good morning, Prof. Raman" detail="Your classes, the students who need you, and what is waiting for your review." />
      <KpiRow items={[
        ['Students I Teach', 132, 'blue', Users],
        ['Assessments This Month', 4, 'indigo', ClipboardCheck],
        ['Evidence to Review', EVIDENCE_QUEUE.length, 'amber', FileCheck2],
        ['Record Requests', RECORD_QUEUE.length, 'purple', ShieldCheck],
      ]} />
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>My Classes</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('students'))}>View Students</button></div>
        <div className="pilot-row cols-3">
          {CLASSES.map((entry) => (
            <div key={entry.code} className="pilot-cat">
              <span className="pilot-tile indigo"><BookOpen size={16} /></span>
              <div><strong>{entry.code} · {entry.subject}</strong><small>{entry.students} students · next {entry.next}</small></div>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Students Who Need Attention</h2><small style={{ color: 'var(--p-muted)' }}>From your classes</small></div>
        <div className="pilot-list">
          {MY_STUDENTS.filter((student) => student.band === 'Developing' || student.band === 'Not enough evidence').map((student) => (
            <div key={student.registration} className="pilot-list-row">
              <Person initials={initialsOf(student.name)} name={student.name} detail={`${student.cls} · ${student.lastTest} · attendance ${student.attendance}`} />
              <span className="grow" />
              <span className={`pilot-chip ${BAND_TONE[student.band] ?? 'slate'}`}>{student.band}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Waiting for You</h2><button type="button" className="pilot-link" onClick={wired(() => onNavigate('verification'))}>Open Queue</button></div>
        <div className="pilot-list">
          {[...EVIDENCE_QUEUE.slice(0, 2), ...RECORD_QUEUE.slice(0, 1)].map((entry) => (
            <div key={entry.id} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <span className={`pilot-tile ${entry.relation === 'Former student' ? 'purple' : 'amber'}`} style={{ width: 32, height: 32 }}><FileCheck2 size={14} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{entry.name}</strong><small>{entry.item}</small></div>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Latest Class Result</h2>
        <DetailRows rows={[['Assessment', 'DS Unit Test 2 — Trees'], ['Attempted', '58 of 62'], ['Class average', '71%'], ['Below 50%', '7 students']]} />
        <button type="button" className="pilot-btn soft small" style={{ marginTop: 12 }} onClick={wired(() => onNavigate('assessments'))}>See Assessments</button>
      </section>
    </aside>
  </div>;
}

export function LecturerStudents(): React.ReactElement {
  const overlay = useOverlay();
  const [cls, setCls] = useState<'All' | 'CSE 3A' | 'CSE 3B'>('All');
  const visible = cls === 'All' ? MY_STUDENTS : MY_STUDENTS.filter((student) => student.cls === cls);
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="My Students" detail="Only the students you teach. Readiness is shown as an advisory band, never as a score.">
        <label className="pilot-inline-filter">
          <span>Class</span>
          <select value={cls} onChange={(event) => setCls(event.target.value as typeof cls)} onClick={(event) => event.stopPropagation()}>
            <option>All</option><option>CSE 3A</option><option>CSE 3B</option>
          </select>
        </label>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Student</th><th>Class</th><th>Readiness Band</th><th>Latest Assessment</th><th>Attendance</th><th></th></tr></thead>
          <tbody>
            {visible.map((student) => (
              <tr key={student.registration}>
                <td><Person initials={initialsOf(student.name)} name={student.name} detail={student.registration} /></td>
                <td>{student.cls}</td>
                <td><span className={`pilot-chip ${BAND_TONE[student.band] ?? 'slate'}`}>{student.band}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{student.lastTest}</small></td>
                <td>{student.attendance}</td>
                <td><button type="button" className="pilot-btn ghost small" onClick={wired(() => overlay.openModal({
                  title: student.name, subtitle: `${student.registration} · ${student.cls}`, body: <div>
                    <DetailRows rows={[['Readiness band', student.band], ['Latest assessment', student.lastTest], ['Attendance', student.attendance], ['Placement cell contact', 'Prof. Meera Nair']]} />
                    <div className="pilot-modal-actions">
                      <button type="button" className="pilot-btn ghost" onClick={() => { overlay.closeModal(); overlay.toast(`Practice set assigned to ${student.name} (sample).`); }}>Assign Practice</button>
                      <button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); overlay.toast(`${student.name} flagged to the placement cell for support (sample).`); }}>Flag to Placement Cell</button>
                    </div>
                  </div>,
                }))}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function LecturerAssessments(): React.ReactElement {
  const overlay = useOverlay();
  const [created, setCreated] = useState<readonly ClassAssessment[]>([]);
  const create = (): void => overlay.openModal({
    title: 'Create Class Assessment', subtitle: 'Questions come from the reviewed question bank', body: <OverlayForm
      fields={[
        { label: 'Title', name: 'name', placeholder: 'e.g. DS Unit Test 3 — Hashing' },
        { label: 'Class', name: 'cls', type: 'select', value: 'CSE 3A', options: ['CSE 3A', 'CSE 3B'] },
        { label: 'Topic', name: 'topic', type: 'select', value: 'Hashing', options: ['Hashing', 'Graphs', 'SQL — Normalisation', 'Transactions'] },
        { label: 'Date', name: 'date', type: 'date', value: '2026-05-28' },
        { label: 'Questions', name: 'questions', type: 'select', value: '20', options: ['10', '20', '30'] },
      ]}
      submitLabel="Schedule Assessment"
      success="Assessment scheduled - students see it on their Assessments page (sample)."
      onSubmit={(values) => setCreated((previous) => [...previous, {
        name: values['name'] || `Class test — ${values['topic'] ?? 'Hashing'}`,
        cls: values['cls'] ?? 'CSE 3A', when: values['date'] ?? '2026-05-28', status: 'Scheduled',
      }])} />,
  });
  const rows = [...created, ...CLASS_ASSESSMENTS];
  return <div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Assessments" detail="Class tests you set. Results feed each student's skill picture and their advisory band.">
        <button type="button" className="pilot-btn" onClick={wired(create)}><Plus size={15} /> Create Assessment</button>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Assessment</th><th>Class</th><th>When</th><th>Status</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.name}-${row.cls}-${row.when}`}>
                <td><strong>{row.name}</strong></td>
                <td>{row.cls}</td>
                <td>{row.when}</td>
                <td><span className={`pilot-chip ${row.status === 'Completed' ? 'green' : row.status === 'Scheduled' ? 'blue' : 'slate'}`}>{row.status}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{row.result ?? '—'}</small></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>DS Unit Test 2 — By Topic</h2>
        {[['Binary trees', 78], ['Tree traversal', 74], ['BST operations', 66], ['Heaps', 58]].map(([topic, value]) => (
          <div key={topic as string} className="pilot-skill">
            <header><b>{topic as string}</b><span>{value as number}% correct</span></header>
            <div className={`pilot-bar thin ${(value as number) < 60 ? 'amber' : 'green'}`}><i style={{ width: `${value as number}%` }} /></div>
          </div>
        ))}
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>Heaps is the weakest topic - a practice set is a good next step.</small>
      </section>
    </aside>
  </div>;
}

export function LecturerVerification(): React.ReactElement {
  const overlay = useOverlay();
  const [tab, setTab] = useState(0);
  const [decided, setDecided] = useState<Readonly<Record<string, string>>>({});
  const decide = (entry: VerificationItem, decision: string): void => {
    setDecided((previous) => ({ ...previous, [entry.id]: decision }));
    overlay.toast(`${entry.name}: ${decision.toLowerCase()} (sample). The student is told and the record updates on their profile.`);
  };
  const open = (entry: VerificationItem): void => overlay.openModal({
    title: entry.name, subtitle: `${entry.relation} · ${entry.detail}`, body: <div>
      <DetailRows rows={[['Asks to verify', entry.item], ['Submitted', entry.submitted], ['Supporting file', entry.relation === 'Former student' ? 'degree-certificate.pdf' : 'project-report.pdf'], ['Check against', entry.relation === 'Former student' ? 'Archived marks register' : 'Your class records']]} />
      <p className="pilot-modal-text" style={{ marginTop: 12 }}>{entry.relation === 'Former student'
        ? 'Former students are served exactly like current ones: check the archived register, then verify or say what is missing. Every decision carries a reason.'
        : 'Verified evidence shows on the student profile with your name as the verifier. Students choose whether employers see it.'}</p>
      <div className="pilot-modal-actions">
        <button type="button" className="pilot-btn ghost" onClick={() => { overlay.closeModal(); decide(entry, 'Returned for more information'); }}>Ask for More</button>
        <button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); decide(entry, 'Verified'); }}>Verify</button>
      </div>
    </div>,
  });
  const queue = tab === 0 ? EVIDENCE_QUEUE : RECORD_QUEUE;
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Evidence & Verification" detail="Student evidence to confirm, and academic-record requests - including from students who have already graduated." />
      <PilotTabs labels={[`Student evidence (${EVIDENCE_QUEUE.length})`, `Academic record requests (${RECORD_QUEUE.length})`]} active={tab} onChange={setTab} />
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Student</th><th>Relationship</th><th>Asks to verify</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {queue.map((entry) => {
              const decision = decided[entry.id];
              return <tr key={entry.id}>
                <td><Person initials={initialsOf(entry.name)} name={entry.name} detail={entry.detail} /></td>
                <td><span className={`pilot-chip ${entry.relation === 'Former student' ? 'purple' : 'blue'}`}>{entry.relation}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{entry.item}</small></td>
                <td><small>{entry.submitted}</small></td>
                <td><span className={`pilot-chip ${decision === 'Verified' ? 'green' : decision ? 'amber' : 'slate'}`}>{decision ?? 'Waiting'}</span></td>
                <td><button type="button" className="pilot-btn ghost small" disabled={Boolean(decision)} onClick={wired(() => open(entry))}>{decision ? 'Done' : 'Review'}</button></td>
              </tr>;
            })}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function LecturerResources(): React.ReactElement {
  const overlay = useOverlay();
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Learning Resources" detail="Practice and material you assign to a class, with completion as students work through it.">
        <button type="button" className="pilot-btn" onClick={wired(() => overlay.openModal({
          title: 'Assign Practice', subtitle: 'Shows on each student’s Learn page', body: <OverlayForm
            fields={[
              { label: 'Resource', type: 'select', value: 'Heaps practice set (30 questions)', options: ['Heaps practice set (30 questions)', 'Transactions worksheet (20 questions)', 'Graph traversal — recorded lecture'] },
              { label: 'Class', type: 'select', value: 'CSE 3A', options: ['CSE 3A', 'CSE 3B'] },
              { label: 'Due', type: 'date', value: '2026-05-30' },
            ]}
            submitLabel="Assign" success="Assigned - students see it on their Learn page (sample)." />,
        }))}><Plus size={15} /> Assign Practice</button>
      </PageHead>
      <div className="pilot-row cols-3">
        {RESOURCES.map((resource) => (
          <section key={resource.title} className="pilot-card pilot-course-card">
            <span className="pilot-tile teal"><BookOpen size={17} /></span>
            <strong>{resource.title}</strong>
            <small>{resource.kind} · {resource.cls} · due {resource.due}</small>
            <div className="pilot-bar thin green"><i style={{ width: `${(resource.done / resource.total) * 100}%` }} /></div>
            <small>{resource.done} of {resource.total} students completed</small>
          </section>
        ))}
      </div>
    </div>
  </div>;
}

export function LecturerAnnouncements(): React.ReactElement {
  const overlay = useOverlay();
  const [posted, setPosted] = useState<readonly { readonly title: string; readonly audience: string; readonly when: string }[]>([]);
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <PageHead title="Announcements" detail="One message to a whole class. Students see it in ONE and in their notifications.">
        <button type="button" className="pilot-btn" onClick={wired(() => overlay.openModal({
          title: 'New Announcement', subtitle: 'Sent to every student in the class', body: <OverlayForm
            fields={[
              { label: 'Title', name: 'title', placeholder: 'e.g. Extra lab session on Saturday' },
              { label: 'Class', name: 'audience', type: 'select', value: 'CSE 3A', options: ['CSE 3A', 'CSE 3B', 'CSE 4 project teams'] },
              { label: 'Message', name: 'message', type: 'textarea', placeholder: 'What students need to know' },
            ]}
            submitLabel="Post Announcement" success="Announcement posted (sample)."
            onSubmit={(values) => setPosted((previous) => [{ title: values['title'] || 'Extra lab session on Saturday', audience: values['audience'] ?? 'CSE 3A', when: 'Just now' }, ...previous])} />,
        }))}><Megaphone size={15} /> New Announcement</button>
      </PageHead>
      <section className="pilot-card">
        <div className="pilot-list">
          {[...posted, ...ANNOUNCEMENTS].map((entry) => (
            <div key={`${entry.title}-${entry.when}`} className="pilot-list-row">
              <span className="pilot-tile blue"><Send size={16} /></span>
              <div className="grow"><strong>{entry.title}</strong><small>{entry.audience}</small></div>
              <small>{entry.when}</small>
              <CheckCircle2 size={15} color="#0d6b4f" />
            </div>
          ))}
        </div>
      </section>
    </div>
  </div>;
}
