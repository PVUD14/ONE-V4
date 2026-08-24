import { pilotCompanies } from './pilotData.js';

/** Datasets behind the non-overview tabs, so every tab shows real sample content. */

// --- Learn ---------------------------------------------------------------------

export const tabMyLearning = [
  { title: 'Data Structures in C', detail: 'Arrays and Strings · 66% complete', progress: 66 },
  { title: 'Python for Data Science', detail: 'Functions and Modules · 45% complete', progress: 45 },
  { title: 'SQL for Data Analysis', detail: 'Joins in SQL · 30% complete', progress: 30 },
  { title: 'Aptitude Mastery', detail: 'Ratio and Proportion · 75% complete', progress: 75 },
] as const;

export const tabBookmarks = [
  { title: 'System Design Basics', detail: 'Intermediate · 4.6 rating' },
  { title: 'Excel for Data Analysis', detail: 'Beginner · 4.5 rating' },
  { title: 'DSA in Java', detail: 'Intermediate · 4.7 rating' },
] as const;

export const tabCertificates = [
  { title: 'C Programming for Beginners', detail: 'Completed 12 Apr 2026 · Score 85%', id: 'ONE-CERT-2026-0141' },
  { title: 'Communication Skills Foundation', detail: 'Completed 28 Mar 2026 · Score 78%', id: 'ONE-CERT-2026-0098' },
  { title: 'Networking Fundamentals', detail: 'Completed 2 days ago · Score 82%', id: 'ONE-CERT-2026-0177' },
] as const;

// --- Assessments -----------------------------------------------------------------

export const tabAllTests = [
  { title: 'Quantitative Aptitude – Set A', kind: 'Aptitude', questions: 30, minutes: 45, difficulty: 'Easy' },
  { title: 'Logical Reasoning – Set B', kind: 'Aptitude', questions: 25, minutes: 40, difficulty: 'Medium' },
  { title: 'Verbal Ability – Standard', kind: 'Verbal', questions: 30, minutes: 35, difficulty: 'Easy' },
  { title: 'C Programming Basics', kind: 'Technical', questions: 25, minutes: 45, difficulty: 'Easy' },
  { title: 'DSA Fundamentals', kind: 'Technical', questions: 30, minutes: 60, difficulty: 'Medium' },
  { title: 'SQL Queries Practice', kind: 'Technical', questions: 20, minutes: 40, difficulty: 'Medium' },
  { title: 'NQT Pattern Full Mock', kind: 'Mock', questions: 90, minutes: 180, difficulty: 'Hard' },
  { title: 'Zenvia Pattern Mock', kind: 'Mock', questions: 75, minutes: 150, difficulty: 'Hard' },
] as const;

export const tabPastAttempts = [
  { title: 'Mock Test – NQT Pattern 1', when: 'Today, 08:05 AM', score: 82 },
  { title: 'Communication Assessment', when: 'Yesterday', score: 61 },
  { title: 'DSA Fundamentals', when: '3 days ago', score: 74 },
  { title: 'Logical Reasoning – Set A', when: '5 days ago', score: 68 },
  { title: 'Verbal Ability – Standard', when: '1 week ago', score: 58 },
  { title: 'SQL Queries Practice', when: '2 weeks ago', score: 71 },
] as const;

export const tabScoreTrend = [52, 58, 55, 64, 61, 68, 74, 82] as const;

// --- Practice --------------------------------------------------------------------

export const tabProblemSets: Readonly<Record<string, readonly { readonly title: string; readonly detail: string; readonly meta: string }[]>> = {
  Coding: [
    { title: 'Arrays: Easy Problems', detail: '20 problems · 12 solved', meta: 'Easy' },
    { title: 'Strings and Two Pointers', detail: '16 problems · 6 solved', meta: 'Medium' },
    { title: 'Recursion Basics', detail: '10 problems · not started', meta: 'Easy' },
    { title: 'Dynamic Programming Starter', detail: '14 problems · 3 solved', meta: 'Hard' },
  ],
  Problems: [
    { title: 'Problem of the Day', detail: 'Rotate a matrix in place', meta: 'Medium' },
    { title: 'Top Interview 75', detail: 'Curated list · 28 solved', meta: 'Mixed' },
    { title: 'Company-tagged: Zenvia Labs', detail: '24 problems from past drives', meta: 'Mixed' },
    { title: 'Weekly Challenge Set', detail: '5 problems · resets Monday', meta: 'Medium' },
  ],
  Projects: [
    { title: 'Placement Portal Mini-Project', detail: 'Web · in progress · 75%', meta: 'Web' },
    { title: 'Expense Tracker CLI', detail: 'C programming · completed', meta: 'CLI' },
    { title: 'Weather Dashboard', detail: 'API integration · not started', meta: 'Web' },
  ],
  'System Design': [
    { title: 'Scaling Basics', detail: 'Load balancing, caching · 30%', meta: 'Module' },
    { title: 'Design a URL Shortener', detail: 'Guided walkthrough', meta: 'Case' },
    { title: 'Design a Chat System', detail: 'Guided walkthrough', meta: 'Case' },
  ],
  Contests: [
    { title: 'CodeSprint 92', detail: '24 May · 6:00 PM – 9:00 PM', meta: 'Register' },
    { title: 'Weekly Contest 358', detail: '28 May · 7:30 PM – 10:30 PM', meta: 'Register' },
    { title: 'Mega Contest 61', detail: '1 Jun · 11:00 AM – 2:00 PM', meta: 'Register' },
    { title: 'CodeSprint 91', detail: 'Finished · rank 214 of 1,842', meta: 'Results' },
  ],
  'Interview Prep': [
    { title: 'HR Interview Question Bank', detail: '60 questions with model answers', meta: 'HR' },
    { title: 'Technical Interview: DSA', detail: '45 questions · 12 practised', meta: 'Technical' },
    { title: 'Mock Interview Recordings', detail: '2 sessions with feedback', meta: 'Review' },
  ],
};

// --- Company Prep -----------------------------------------------------------------

export const tabPrepQuestionSets = [
  { title: 'Zenvia Labs — Coding Round Set', detail: '24 questions from past drives' },
  { title: 'Kortex Systems — Aptitude Pattern', detail: '30 questions · 45 minutes' },
  { title: 'BlueRiver — Case & SQL Round', detail: '12 case prompts, 18 SQL tasks' },
  { title: 'General HR Round Bank', detail: '60 questions with model answers' },
] as const;

export const tabAptitudeSets = [
  { title: 'Zenvia Pattern Aptitude Mock', detail: '45 min · adaptive difficulty' },
  { title: 'Kortex Pattern Aptitude Mock', detail: '40 min · quantitative heavy' },
  { title: 'General NQT Pattern', detail: '60 min · full syllabus' },
] as const;

export const tabMockInterviews = [
  { title: 'Technical Mock — DSA focus', detail: 'Completed 14 May · feedback available', done: true },
  { title: 'HR Mock Interview', detail: 'Completed 8 May · feedback available', done: true },
  { title: 'Technical Mock — Zenvia panel style', detail: 'Book a slot this week', done: false },
] as const;

export const tabSavedResources = [
  { title: 'Zenvia Labs - Interview Guide', detail: 'Saved 3 days ago' },
  { title: 'Kortex - Coding Questions', detail: 'Saved 1 week ago' },
  { title: 'Resume checklist for SOC roles', detail: 'Saved 2 weeks ago' },
] as const;

// --- Career tools grouped by tab ---------------------------------------------------

export const tabToolGroups: Readonly<Record<string, readonly string[]>> = {
  'Resume & Docs': ['Resume Builder', 'Cover Letter Builder', 'Portfolio Builder'],
  'Skill Tools': ['Skill Gap Analyzer', 'Interview Question Bank'],
  Planning: ['Career Roadmap Planner', 'Goal Tracker'],
  'Career Insights': ['Salary Explorer', 'Placement Predictor'],
  'Job Search': ['Interview Question Bank', 'Salary Explorer', 'Resume Builder'],
};

// --- Profile ------------------------------------------------------------------------

export const tabEducation = [
  { title: 'B.Tech Computer Science Engineering', detail: 'Vellore Institute of Technology, Chennai · 2023 – 2027 · CGPA 8.2' },
  { title: 'Higher Secondary (Class XII)', detail: 'Narayana Junior College, Hyderabad · 2023 · 94.2%' },
  { title: 'Secondary (Class X)', detail: 'Kendriya Vidyalaya, Hyderabad · 2021 · 92.8%' },
] as const;

export const tabProjects = [
  { title: 'Placement Portal Mini-Project', detail: 'React + Node.js · team of 3 · college hackathon runner-up' },
  { title: 'Expense Tracker CLI', detail: 'C · file-backed storage, monthly summaries' },
] as const;

export const tabInternships = [
  { title: 'Web Development Intern — Nimbus Digital', detail: 'May – Jul 2025 · built internal dashboard components' },
] as const;

export const tabCertificateRecords = [
  { title: 'C Programming for Beginners', detail: 'ONE-CERT-2026-0141 · Apr 2026' },
  { title: 'Communication Skills Foundation', detail: 'ONE-CERT-2026-0098 · Mar 2026' },
  { title: 'Networking Fundamentals', detail: 'ONE-CERT-2026-0177 · May 2026' },
] as const;

// --- Resume builder -----------------------------------------------------------------

export const tabResumeExamples = [
  { title: 'Software Engineer — fresher example', detail: 'Strong projects section, ATS-friendly layout' },
  { title: 'Data Analyst — fresher example', detail: 'Leads with SQL and visualization work' },
  { title: 'SDE Intern — example', detail: 'Coursework and hackathons up front' },
] as const;

// --- Scholarship / opportunity helpers -----------------------------------------------

export const tabCategoryRoles: Readonly<Record<string, readonly string[]>> = {
  'Software Development': ['Software Engineer · Zenvia Labs', 'Backend Developer · Kortex Systems', 'Associate Software Engineer · Veridian Tech'],
  'Data Science': ['Data Analyst · BlueRiver Analytics', 'ML Intern · Nimbus Digital'],
  'Product Management': ['APM Program · Zenvia Labs'],
  Design: ['UI/UX Intern · Nimbus Digital'],
  Marketing: ['Digital Marketing Trainee · Orbitech Solutions'],
  Finance: ['Finance Analyst Trainee · Veridian Tech'],
};

export const employerNotifications = [
  ['Priya Sharma confirmed Technical Round 2 for tomorrow 10:30 AM', '1h ago'],
  ['Application volume up 32% since the VIT drive was announced', 'Today'],
  ['Offer to Sana Sheikh expires 1 Jun - consider a follow-up', 'Yesterday'],
] as const;

export const employerMessages = [
  ['VIT Chennai Placement Cell', 'Confirming logistics for the 22 May drive - can we lock the panel list?'],
  ['Leena Kapoor (Hiring Manager)', 'Shortlist for Graduate SE looks strong. Advance the top 5 to assessment.'],
] as const;

export const institutionNotifications = [
  ['57 students are flagged for intervention this term', 'Today'],
  ['Zenvia Labs drive registrations close Friday - 154 of 186 registered', 'Today'],
  ['Aptitude Mock Test opens tomorrow at 10:00 AM for 412 students', 'Yesterday'],
] as const;

export const institutionMessages = [
  ['Zenvia Labs — Rohan Iyer', 'Sharing the eligibility criteria for the 22 May drive.'],
  ['Dean, Academics', 'Please include department readiness in the accreditation pack.'],
] as const;

export const studentNotifications = [
  ['Aptitude Mock Test opens tomorrow at 10:00 AM', '2h ago'],
  ['Your application moved to Shortlisted at Zenvia Labs', 'Yesterday'],
  ['New course recommended: Operating Systems Basics', '2 days ago'],
] as const;

export const studentMessages = [
  ['Placement Cell', 'Reminder: registrations for the Kortex drive close Friday.'],
  ['Mentor - Kavya', 'Great progress on the SQL module. Try the practice set next.'],
] as const;

export const remainingGoalCompanies = pilotCompanies.slice(4).map((company) => company.name);
