/**
 * The pilot dataset: one persona, one coherent story.
 *
 * Every number here is fiction shown only to pilot identities, and every number is
 * defined once so the story agrees with itself across screens — a streak that reads
 * 7 on one page and 17 on another is how a demo announces it is fake. Companies are
 * fictional by decision; monogram marks stand in for logos so no real brand is
 * implied.
 */

export const pilotPersona = {
  name: 'Arjun Reddy',
  firstName: 'Arjun',
  initials: 'AR',
  programme: 'B.Tech CSE | 2027',
  institution: 'Vellore Institute of Technology, Chennai',
  location: 'Chennai, India',
  email: 'arjun.demo@one.example',
  phone: '+91 98XXX XX210',
  careerGoal: 'Software Engineer',
  profileComplete: 85,
} as const;

/** Canonical figures every page derives from. */
export const pilotCanon = {
  readiness: 72,
  readinessLabel: 'Nearly Job Ready',
  streakDays: 7,
  points: 2500,
  coursesCompleted: 15,
  testsAttempted: 24,
  averageScore: 68,
  practiceHours: 120,
  weeklyGoalHours: 5,
  weeklyDoneHours: 3.2,
  applications: { applied: 12, shortlisted: 4, interviews: 2, offers: 1, saved: 3 },
  roadmap: { progress: 37, tasksDone: 46, tasksTotal: 124, milestones: 6, monthsToGoal: 6.5 },
} as const;

export interface PilotCompany {
  readonly mark: string;
  readonly name: string;
  readonly tone: 'blue' | 'indigo' | 'teal' | 'amber' | 'rose' | 'green' | 'slate';
}

export const pilotCompanies: readonly PilotCompany[] = [
  { mark: 'ZV', name: 'Zenvia Labs', tone: 'indigo' },
  { mark: 'KX', name: 'Kortex Systems', tone: 'blue' },
  { mark: 'BR', name: 'BlueRiver Analytics', tone: 'teal' },
  { mark: 'ND', name: 'Nimbus Digital', tone: 'rose' },
  { mark: 'OT', name: 'Orbitech Solutions', tone: 'amber' },
  { mark: 'VD', name: 'Veridian Tech', tone: 'green' },
];

export const pilotScores = [
  { label: 'Aptitude', value: 78, band: 'Good', tone: 'green' },
  { label: 'Technical', value: 74, band: 'Good', tone: 'blue' },
  { label: 'Communication', value: 61, band: 'Average', tone: 'amber' },
  { label: 'Interview', value: 66, band: 'Average', tone: 'purple' },
  { label: 'Resume', value: 80, band: 'Good', tone: 'green' },
] as const;

export const pilotTodayPlan = [
  { title: 'Quantitative Aptitude – Ratio', minutes: 20, done: true },
  { title: 'SQL Basics – Lesson 4', minutes: 30, done: true },
  { title: 'Verbal Ability – Practice Set', minutes: 20, done: false },
  { title: 'Mock Test – Zenvia Pattern', minutes: 45, done: false },
] as const;

export const pilotUpcoming = [
  { title: 'Aptitude Mock Test', when: 'Tomorrow, 10:00 AM' },
  { title: 'Communication Assessment', when: '20 May, 03:00 PM' },
] as const;

export const pilotWeekProgress = [38, 46, 44, 58, 52, 66, 72] as const;

export const pilotRecommendedCourses = [
  { title: 'Operating Systems Basics', lessons: 12, tone: 'teal' },
  { title: 'Placement Interview Guide', lessons: 8, tone: 'indigo' },
  { title: 'DBMS – SQL Practice', lessons: 15, tone: 'amber' },
  { title: 'Excel for Professionals', lessons: 10, tone: 'green' },
] as const;

export const pilotRecentActivity = [
  { title: 'Completed lesson · Process Management', when: 'Today, 08:45 AM', tone: 'green' },
  { title: 'Attempted Mock Test · NQT Pattern 1 — 82/100', when: 'Today, 08:05 AM', tone: 'blue' },
  { title: 'Updated resume · Software Engineer Resume', when: 'Yesterday', tone: 'indigo' },
  { title: 'Earned badge · Aptitude Achiever', when: '2 days ago', tone: 'amber' },
] as const;

export const pilotBadges = [
  { label: 'Aptitude Achiever', tone: 'amber' },
  { label: 'Consistent Learner', tone: 'blue' },
  { label: 'Mock Test Master', tone: 'green' },
  { label: 'Quick Learner', tone: 'purple' },
] as const;

// --- Roadmap -----------------------------------------------------------------

export const pilotRoadmapPhases = [
  { label: 'Foundation', done: 2, total: 8, active: true },
  { label: 'Core Skills', done: 1, total: 7, active: false },
  { label: 'Specialization', done: 0, total: 6, active: false },
  { label: 'Practice & Projects', done: 0, total: 6, active: false },
  { label: 'Career Ready', done: 0, total: 5, active: false },
] as const;

export interface PilotRoadmapStep {
  readonly title: string;
  readonly detail: string;
  readonly status: 'completed' | 'current' | 'locked';
  readonly score?: number;
  readonly progress?: number;
}

export const pilotRoadmapSteps: readonly PilotRoadmapStep[] = [
  { title: 'Programming Fundamentals', detail: 'Variables, Data Types, Operators, Control Flow', status: 'completed', score: 85 },
  { title: 'Data Structures Basics', detail: 'Arrays, Strings, Linked Lists, Stacks, Queues', status: 'completed', score: 78 },
  { title: 'Object Oriented Programming', detail: 'Classes, Objects, Inheritance, Polymorphism', status: 'current', progress: 60 },
  { title: 'Database Fundamentals', detail: 'SQL Basics, Joins, Normalization', status: 'locked' },
  { title: 'Web Fundamentals', detail: 'HTML, CSS, JavaScript Basics', status: 'locked' },
  { title: 'Problem Solving with C', detail: 'Logic Building, Flowcharts, Pseudocode', status: 'locked' },
  { title: 'Computer Networks Basics', detail: 'OSI Model, TCP/IP, IP Addressing', status: 'locked' },
  { title: 'Operating Systems Basics', detail: 'Processes, Threads, Scheduling, Memory', status: 'locked' },
];

export const pilotMilestones = [
  { title: 'Complete Core Skills', target: 'Target: 15 Jul 2026', progress: 20 },
  { title: 'Finish DSA Fundamentals', target: 'Target: 10 Aug 2026', progress: 40 },
  { title: 'Build 2 Projects', target: 'Target: 15 Sep 2026', progress: 0 },
] as const;

export const pilotRoadmapTips = [
  'Study consistently for at least 1–2 hours daily',
  'Focus on one concept at a time',
  'Take regular assessments to track progress',
  'Build projects to reinforce your learning',
] as const;

// --- Learn -------------------------------------------------------------------

export const pilotContinueLearning = {
  course: 'Data Structures and Algorithms in Python',
  lesson: 'Arrays and Strings',
  progress: 65,
  minutesLeft: 25,
} as const;

export const pilotPopularCourses = [
  { title: 'C Programming for Beginners', rating: 4.6, learners: '2.1K', level: 'Beginner', progress: 80, tone: 'indigo' },
  { title: 'Python for Data Science', rating: 4.7, learners: '3.8K', level: 'Intermediate', progress: 45, tone: 'teal' },
  { title: 'SQL for Data Analysis', rating: 4.5, learners: '1.6K', level: 'Intermediate', progress: 30, tone: 'amber' },
  { title: 'Web Development Bootcamp', rating: 4.6, learners: '2.9K', level: 'Beginner', progress: 60, tone: 'blue' },
  { title: 'Aptitude Mastery', rating: 4.4, learners: '3.2K', level: 'Beginner', progress: 75, tone: 'rose' },
] as const;

export const pilotLearningPaths = [
  { title: 'Software Developer Career Path', detail: 'Master coding, DSA, system design and become job ready.', courses: 18, hours: 120, progress: 40 },
  { title: 'Data Analyst Career Path', detail: 'Learn SQL, Python, Excel, visualization and more.', courses: 12, hours: 80, progress: 35 },
  { title: 'Cyber Security Career Path', detail: 'Learn security fundamentals and industry tools.', courses: 14, hours: 95, progress: 20 },
  { title: 'Marketing Career Path', detail: 'Build skills in digital marketing, SEO and analytics.', courses: 10, hours: 90, progress: 20 },
] as const;

export const pilotLeftOff = [
  { title: 'Python Functions and Modules', course: 'Python for Data Science', watched: '2 days ago', progress: 45 },
  { title: 'Arrays and Strings', course: 'Data Structures and Algorithms in Python', watched: '3 days ago', progress: 65 },
  { title: 'Joins in SQL', course: 'SQL for Data Analysis', watched: '5 days ago', progress: 30 },
] as const;

export const pilotLearningProgress = { completed: 32, inProgress: 18, notStarted: 14 } as const;

export const pilotLearnRecommended = [
  { title: 'System Design Basics', level: 'Intermediate', rating: 4.6 },
  { title: 'Excel for Data Analysis', level: 'Beginner', rating: 4.5 },
  { title: 'DSA in Java', level: 'Intermediate', rating: 4.7 },
  { title: 'Communication Skills', level: 'Beginner', rating: 4.4 },
] as const;

// --- Assessments -------------------------------------------------------------

export const pilotRecommendedTests = [
  { title: 'Data Structures Mock Test', difficulty: 'Medium', questions: 60, minutes: 60, cohort: '72% scored > 60%', tone: 'indigo' },
  { title: 'Aptitude Full Test', difficulty: 'Easy', questions: 50, minutes: 45, cohort: '65% scored > 60%', tone: 'green' },
  { title: 'SQL Mock Test', difficulty: 'Medium', questions: 45, minutes: 45, cohort: '68% scored > 60%', tone: 'blue' },
  { title: 'Reasoning Test', difficulty: 'Easy', questions: 40, minutes: 40, cohort: '70% scored > 60%', tone: 'rose' },
  { title: 'Python Programming Test', difficulty: 'Hard', questions: 30, minutes: 60, cohort: '55% scored > 60%', tone: 'amber' },
] as const;

export const pilotTestCategories = [
  { label: 'Programming', count: 24 }, { label: 'Aptitude', count: 18 },
  { label: 'Data Structures', count: 16 }, { label: 'Databases', count: 12 },
  { label: 'Web Development', count: 14 }, { label: 'Operating Systems', count: 10 },
  { label: 'Computer Networks', count: 8 }, { label: 'Reasoning', count: 15 },
  { label: 'Verbal Ability', count: 9 }, { label: 'Core Engineering', count: 20 },
] as const;

export const pilotRecentTests = [
  { title: 'Data Structures Mock Test', when: 'Attempted 2 days ago', score: 76 },
  { title: 'Aptitude Full Test', when: 'Attempted 4 days ago', score: 64 },
  { title: 'SQL Mock Test', when: 'Attempted 6 days ago', score: 58 },
  { title: 'Python Programming Test', when: 'Attempted last week', score: 82 },
  { title: 'Reasoning Test', when: 'Attempted last week', score: 68 },
] as const;

export const pilotScoreDistribution = { high: 8, medium: 10, low: 6 } as const;

export const pilotStrengths = [
  { label: 'Python', value: 82 }, { label: 'DBMS', value: 76 }, { label: 'SQL', value: 72 },
] as const;

export const pilotImprovements = [
  { label: 'Operating Systems', value: 38 }, { label: 'Computer Networks', value: 42 }, { label: 'Verbal Ability', value: 45 },
] as const;

export const pilotUpcomingTests = [
  { date: 'MAY 14', title: 'Company Aptitude Test', by: 'Zenvia Labs', detail: '60 Qs · 60 mins · Medium' },
  { date: 'MAY 16', title: 'Coding Challenge', by: 'Kortex Systems', detail: '2 questions · 90 mins · Hard' },
  { date: 'MAY 18', title: 'DBMS Mock Test', by: 'ONE', detail: '50 Qs · 60 mins · Medium' },
  { date: 'MAY 20', title: 'Full Length Mock Test', by: 'All topics', detail: '100 Qs · 120 mins · Mixed' },
] as const;

// --- Opportunities -----------------------------------------------------------

export interface PilotOpportunity {
  readonly company: PilotCompany;
  readonly role: string;
  readonly location: string;
  readonly type: string;
  readonly experience: string;
  readonly match: number;
  readonly matchBand: 'High Match' | 'Medium Match' | 'Good Match';
  readonly posted: string;
}

export const pilotOpportunities: readonly PilotOpportunity[] = [
  { company: pilotCompanies[0]!, role: 'Software Engineer', location: 'Bengaluru, India', type: 'Full-time', experience: '0–2 yrs', match: 98, matchBand: 'High Match', posted: 'Posted 2d ago' },
  { company: pilotCompanies[1]!, role: 'SDE Intern', location: 'Hyderabad, India', type: 'Internship', experience: '2027 Batch', match: 85, matchBand: 'Medium Match', posted: 'Posted 1d ago' },
  { company: pilotCompanies[2]!, role: 'Software Engineer', location: 'Multiple locations', type: 'Full-time', experience: '0–1 yrs', match: 92, matchBand: 'High Match', posted: 'Posted 3d ago' },
  { company: pilotCompanies[3]!, role: 'System Engineer', location: 'Pune, India', type: 'Full-time', experience: '0–2 yrs', match: 80, matchBand: 'Medium Match', posted: 'Posted 4d ago' },
  { company: pilotCompanies[4]!, role: 'Project Engineer', location: 'Chennai, India', type: 'Full-time', experience: '0–1 yrs', match: 75, matchBand: 'Good Match', posted: 'Posted 5d ago' },
];

export const pilotSavedOpportunities = [
  { company: pilotCompanies[5]!, role: 'Associate Software Engineer', location: 'Bengaluru, India' },
  { company: pilotCompanies[2]!, role: 'Software Developer', location: 'Remote' },
  { company: pilotCompanies[1]!, role: 'Backend Developer', location: 'Bengaluru, India' },
] as const;

export const pilotDrives = [
  { date: 'MAY 22', title: 'Zenvia Ninja Hiring', company: 'Zenvia Labs', mode: 'Online' },
  { date: 'MAY 24', title: 'Kortex Campus Drive', company: 'Kortex Systems', mode: 'Bengaluru' },
  { date: 'JUN 05', title: 'Veridian Engage', company: 'Veridian Tech', mode: 'Hyderabad' },
] as const;

export const pilotOpportunityCategories = [
  { label: 'Software Development', count: 128 }, { label: 'Data Science', count: 86 },
  { label: 'Product Management', count: 42 }, { label: 'Design', count: 31 },
  { label: 'Marketing', count: 27 }, { label: 'Finance', count: 18 },
] as const;

// --- Profile -----------------------------------------------------------------

export const pilotProfileChecklist = [
  { label: 'Basic Information', state: 'done' },
  { label: 'Education Details', state: 'done' },
  { label: 'Skills', state: 'done' },
  { label: 'Work Experience / Internships', state: 'done' },
  { label: 'Projects', state: 'done' },
  { label: 'Achievements', state: 'progress' },
  { label: 'Preferences', state: 'todo' },
] as const;

export const pilotSkills = [
  { label: 'Data Structures', value: 85, tone: 'green' },
  { label: 'Python', value: 90, tone: 'amber' },
  { label: 'Problem Solving', value: 80, tone: 'blue' },
  { label: 'Java', value: 70, tone: 'indigo' },
  { label: 'DBMS', value: 75, tone: 'purple' },
  { label: 'SQL', value: 65, tone: 'rose' },
] as const;

export const pilotAchievements = [
  { title: 'National Hackathon 2026', detail: 'Finalist · National level', when: 'Oct 2026', tone: 'amber' },
  { title: 'Coding Contest', detail: 'Rank 120 among 5000+', when: 'Sep 2026', tone: 'indigo' },
  { title: 'Database Certification', detail: 'Topper · Online cohort', when: 'Aug 2026', tone: 'rose' },
  { title: 'College Topper', detail: '6th semester · CGPA 9.45', when: 'Jun 2026', tone: 'green' },
] as const;

export const pilotDemandSkills = [
  { label: 'Python', value: 92, tone: 'green' },
  { label: 'SQL', value: 84, tone: 'blue' },
  { label: 'Data Structures', value: 88, tone: 'purple' },
  { label: 'System Design', value: 76, tone: 'amber' },
  { label: 'Problem Solving', value: 90, tone: 'indigo' },
] as const;

export const pilotProfileTips = [
  { title: 'Add more projects', detail: 'Showcase your work' },
  { title: 'Get certified', detail: 'Add industry-recognized certs' },
  { title: 'Improve skills', detail: 'Take advanced courses' },
  { title: 'Update preferences', detail: 'Get better job matches' },
] as const;
