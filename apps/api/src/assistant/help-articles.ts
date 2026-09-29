/**
 * The ONE Assistant help corpus. The assistant answers ONLY from these articles:
 * they are the boundary of what it may claim about the product. Keep each article
 * truthful to shipped behavior — a wrong sentence here becomes a confident wrong
 * answer in front of a user.
 */
export type AssistantPersona = 'student' | 'institution' | 'employer';

export interface HelpArticle {
  readonly id: string;
  readonly personas: readonly (AssistantPersona | 'all')[];
  readonly title: string;
  readonly keywords: readonly string[];
  readonly body: string;
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'signing-in',
    personas: ['all'],
    title: 'Signing in and choosing a workspace',
    keywords: ['login', 'sign in', 'password', 'workspace', 'account', 'locked'],
    body: 'Sign in at one.ai8ht.pro with the email and password issued to you. After signing in you land in the workspace that matches your role: students in the student portal, institution staff in the institution portal, employers in the employer portal. If your password does not work or your account is locked, contact your placement cell (students) or the ONE operator who issued your account — the assistant cannot reset passwords.',
  },
  {
    id: 'navigation',
    personas: ['all'],
    title: 'Finding your way around',
    keywords: ['sidebar', 'menu', 'navigate', 'topbar', 'where', 'find'],
    body: 'The left sidebar lists every section of your workspace; the top bar shows your account, the Messages icon and the Notifications bell. The bell shows a count only when something actually needs your attention. Messages will hold conversations with your placement cell and recruiters once messaging launches; today it is an empty inbox by design.',
  },
  {
    id: 'notifications',
    personas: ['all'],
    title: 'Notifications',
    keywords: ['notification', 'bell', 'alert', 'badge', 'unread'],
    body: 'For students, notifications are derived from real account state: assessments assigned and still open, attempts in progress, and freshly published results. For institution staff, the bell summarises published assessments, completed attempts and questions awaiting review. Institution faculty and department heads can set email reminders and quiet hours under Settings; ONE does not send staff reminder emails yet.',
  },
  {
    id: 'privacy-data',
    personas: ['all'],
    title: 'Your data and privacy',
    keywords: ['privacy', 'data', 'download', 'export', 'delete', 'consent', 'dpdp'],
    body: 'Students can download a copy of their personal data from Settings; the export is currently a machine-readable JSON bundle. Sharing your profile with anyone is always your explicit choice. Internal readiness signals are advisory guidance for you and your institution only — they are never shown to employers and never made public.',
  },
  {
    id: 'getting-help',
    personas: ['all'],
    title: 'Getting more help',
    keywords: ['support', 'help', 'contact', 'bug', 'issue', 'problem', 'report'],
    body: 'If something looks broken or you are stuck beyond what this assistant can answer, report it to your placement cell (students) or to the ONE support contact your organisation was given. Include what you clicked, what you expected, and what happened instead — a screenshot helps.',
  },
  {
    id: 'student-profile',
    personas: ['student'],
    title: 'Your profile',
    keywords: ['profile', 'edit', 'skills', 'projects', 'education', 'photo', 'update'],
    body: 'Your profile is your living record: education, skills, projects and certifications. Keep it current — it is what your placement cell works from and what employers see when you choose to share it. Update it from the Profile section of your workspace.',
  },
  {
    id: 'public-profile-qr',
    personas: ['student'],
    title: 'Public profile and QR sharing',
    keywords: ['public', 'qr', 'share', 'link', 'recruiter', 'scan'],
    body: 'You can present a public view of your profile and share it with a QR code that a recruiter scans from your screen. Sharing is consent-based: nothing is public unless you choose to share it, and internal readiness scores are never part of the public view.',
  },
  {
    id: 'taking-assessments',
    personas: ['student'],
    title: 'Taking an assessment',
    keywords: ['assessment', 'exam', 'test', 'start', 'attempt', 'timer', 'resume', 'save'],
    body: 'Assessments are taken on a laptop or desktop only - phone screens and app switching do not mix with timed, proctored attempts. Open Assessments in your workspace to see what is assigned to you, with each assessment’s window and your attempts used. Start an attempt to get your paper; every attempt runs on its own countdown clock (the assessment’s duration), which is separate from the window in which you may start. Answers save automatically as you go, and if you lose connection you can resume the same attempt with the remaining time. Submit before the clock runs out; when it reaches zero the attempt submits itself.',
  },
  {
    id: 'assessment-rules',
    personas: ['student'],
    title: 'Assessment rules: attempts, focus and marking',
    keywords: ['attempts', 'tab', 'switch', 'focus', 'warning', 'negative', 'marking', 'auto', 'submit', 'result'],
    body: 'Each assessment allows a fixed number of attempts. Leaving the exam tab or window is recorded: you get warnings, and repeated focus loss auto-submits the attempt, so stay on the exam screen. Some questions carry negative marking, shown with the question. Results appear in the same Assessments section once published, with your score and percentage.',
  },
  {
    id: 'assessment-troubleshooting',
    personas: ['student'],
    title: 'Why can’t I start my assessment?',
    keywords: ['cannot', 'start', 'unable', 'window', 'closed', 'opens', 'soon', 'expired', 'exhausted'],
    body: 'If an assessment shows Opens soon, its window has not started yet. Window closed means the start window has passed. Completed with no attempts left means you used your allowance. In all three cases only your institution can help: staff can reopen the window, add attempts, or change the per-attempt duration. Ask your placement cell — the assistant cannot change assessment windows. Also note assessments are laptop-only: on a phone you will see the assignment but the start button is replaced with a laptop-only notice.',
  },
  {
    id: 'employer-screening-tests',
    personas: ['student'],
    title: 'Screening tests from employers',
    keywords: ['screening', 'employer', 'screening test', 'invited', 'recruiter test', 'phone'],
    body: 'An employer can send you a screening test once your application reaches its Assessment stage; you are told in your notifications, and it appears under Assessments (and Screening tests in the app, where you can take it). Before you start you see what it covers: how many questions, their formats, the marks, and the minutes you will have. It is one sitting; the timer runs on ONE’s server from the moment you begin and does not pause, and if the test’s window closes first you get less time. No camera, microphone or screen capture is used. Your result goes only to that employer, for that application, while you share it with them; it is not part of your academic record or learning evidence and never changes your readiness.',
  },
  {
    id: 'learning-lessons',
    personas: ['student'],
    title: 'Learning and lesson completion',
    keywords: ['learning', 'lesson', 'complete', 'prerequisite', 'locked', 'module'],
    body: 'Learning modules contain lessons that may build on each other: a lesson with prerequisites can only be completed after the lessons it depends on are completed. If Complete Lesson reports that prerequisites are not met, finish the earlier lessons in the module first, in order. Completed lessons feed your readiness evidence automatically.',
  },
  {
    id: 'career-readiness',
    personas: ['student'],
    title: 'Career readiness guidance',
    keywords: ['readiness', 'career', 'score', 'roadmap', 'gap', 'next', 'step'],
    body: 'Career readiness turns your completed lessons and assessments into private, advisory guidance: where you stand and what to do next. It is coaching, not a ranking — employers never see it, and it never appears on your public profile. Treat it as your personal roadmap.',
  },
  {
    id: 'question-bank',
    personas: ['institution'],
    title: 'The governed question bank',
    keywords: ['question', 'bank', 'author', 'draft', 'review', 'approve', 'reject', 'archive', 'subject'],
    body: 'Questions live in subjects and follow a governed lifecycle: DRAFT, then UNDER REVIEW, then APPROVED or REJECTED, with ARCHIVED at end of life. Only approved questions can enter an exam. Authoring supports objective types including single and multiple choice, true/false, numeric and fill-in-the-blank (write the blank as five underscores), each with marks and optional negative marking. Senior staff approve; authors send for review.',
  },
  {
    id: 'exam-build-publish',
    personas: ['institution'],
    title: 'Building, publishing and assigning an exam',
    keywords: ['exam', 'create', 'build', 'section', 'pool', 'publish', 'assign', 'students', 'marks'],
    body: 'An exam takes a title, window (start and end), per-attempt duration, attempts allowed and a section whose question pool you pick from approved questions; section marks must reconcile with the pool you selected. Publishing re-validates the pool against the live bank, so an archived question blocks publish with a named error. After publishing, assign students from your roster — each assigned student sees the exam in their own portal within the window. Every attempt gets a uniquely shuffled paper, seeded per attempt.',
  },
  {
    id: 'exam-reopen-results',
    personas: ['institution'],
    title: 'Reopening exams and reading results',
    keywords: ['reopen', 'extend', 'duration', 'window', 'attempts', 'results', 'not', 'attempted', 'csv', 'average'],
    body: 'Reopen/Extend on a published exam asks three things: extra WINDOW minutes (how much longer students may start), extra ATTEMPTS, and optionally a new per-attempt DURATION. The window and the duration are different clocks — extending the window does not lengthen each attempt. The results view lists every scored attempt, the class average, and by name the students who never attempted, so follow-up is direct. Completed data can be exported.',
  },
  {
    id: 'institution-operations',
    personas: ['institution'],
    title: 'Roster, drives and interventions',
    keywords: ['roster', 'batch', 'department', 'drive', 'intervention', 'analytics', 'placement'],
    body: 'The institution portal carries your student roster by department and batch, campus drives, skill interventions and analytics. Employers ask to run a role as a campus drive; it reaches your students only after your placement office approves it (the placement officer decides on the Dashboard, an administrator under Placement), and your one-offer-per-student policy, set under Settings or on the placement officer Dashboard, applies to applications through your drives. Assessments are assigned against active roster students. Readiness analytics are aggregate and advisory — they inform your placement work and are never exposed to employers at student level.',
  },
  {
    id: 'employer-roles-drives',
    personas: ['employer'],
    title: 'Roles and campus drives',
    keywords: ['role', 'post', 'job', 'drive', 'campus', 'pipeline', 'applications', 'shortlist', 'offer'],
    body: 'Post roles from the employer portal. To run a campus drive, open the role under Opportunity Detail and ask a college for one: the role reaches the students of that college only after its placement office approves, and the placement rules of the college apply to applications through the drive. Applications, shortlists and offers are tracked per role so the pipeline stays in one view.',
  },
  {
    id: 'employer-candidates',
    personas: ['employer'],
    title: 'Meeting candidates',
    keywords: ['candidate', 'profile', 'verified', 'qr', 'readiness', 'score', 'screen'],
    body: 'You meet candidates through profiles they have consented to share — current skills, projects and certifications, opened from a link or a QR code the student presents. ONE does not expose internal readiness scores to employers by design: candidates are evaluated on real evidence, and your own assessments, not on an opaque platform ranking.',
  },
  {
    id: 'employer-screening-assessments',
    personas: ['employer'],
    title: 'Screening tests for applicants',
    keywords: ['assessment', 'screening', 'test', 'question bank', 'invite', 'window', 'results'],
    body: 'Under Assessments you write questions into your own bank (someone other than the author approves each one), build a test from approved questions, publish it and send it to applicants who are in the Assessment stage, with a window of up to 30 days. Each candidate gets the test’s full length unless the window closes first, and ONE’s server keeps the time. Results are listed in the order candidates were sent the test, never ranked by score, and each candidate’s answers question by question appear in Candidate Detail — only while they share their application with you. Rejecting or archiving a question and closing a test ask for a reason. Your bank is yours alone: you cannot see a college’s question bank, and it cannot see yours.',
  },
  {
    id: 'mobile-app',
    personas: ['all'],
    title: 'The ONE mobile app',
    keywords: ['app', 'mobile', 'android', 'phone', 'theme', 'install', 'sign in'],
    body: 'The Android app signs in with the same email and password as the web. Students see their dashboard, assessments and results, learning, jobs and notifications; institution and employer staff see live monitoring dashboards; operations accounts see a view-only overview. College exams are never taken in the app - a laptop is required; screening tests an employer sends can be taken on the phone. Pick your look from six themes via the palette icon at the top of any screen. Demo accounts work only in the web pilot, not the app.',
  },
  {
    id: 'help-faq',
    personas: ['all'],
    title: 'Where to find help',
    keywords: ['help', 'faq', 'guide', 'how'],
    body: 'The Help & FAQ section lists answers for your role, and the ONE Assistant (the sparkle button) answers questions conversationally from the same guide. If neither resolves it, report the issue to your placement cell or the ONE support contact with what you clicked and what happened.',
  },
];
