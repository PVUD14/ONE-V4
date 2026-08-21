import careerIllustration from './assets/student-career-journey.svg';
import coachIllustration from './assets/student-coach-card.svg';
import learningIllustration from './assets/student-learning-path.svg';
import opportunityIllustration from './assets/student-opportunity-card.svg';

export const images = { careerIllustration, coachIllustration, learningIllustration, opportunityIllustration };

export const studentProfile = {
  name: 'Rahul Kumar',
  initials: 'RK',
  program: 'B.Tech CSE',
  graduationYear: '2027',
  targetRole: 'Cybersecurity Analyst',
  readiness: 68,
  pathwayProgress: 62,
  nextMilestone: 'Complete SIEM Assessment',
  institution: 'ONE Demo Institute',
  consentState: 'Employer visibility limited to saved/applied opportunities',
};

export const readinessCategories = [
  { label: 'Technical readiness', score: 72, blocker: 'Linux hardening lab needs verification' },
  { label: 'Aptitude readiness', score: 70, blocker: 'One timed reasoning reassessment recommended' },
  { label: 'Communication readiness', score: 58, blocker: 'Incident-triage story needs mock feedback' },
  { label: 'Resume/profile readiness', score: 80, blocker: 'Resume tailored for SOC roles' },
  { label: 'Interview readiness', score: 58, blocker: 'Mock interview not completed' },
  { label: 'Evidence completeness', score: 61, blocker: 'Two security artifacts need source labels' },
];

export const readinessTrend = [
  { date: 'Apr', score: 51 }, { date: 'May', score: 55 }, { date: 'Jun', score: 60 }, { date: 'Jul', score: 64 }, { date: 'Aug', score: 68 },
];

export const priorityActions = [
  { title: 'Complete profile evidence', detail: 'Add institution-verified academic record references.', status: 'Pending' },
  { title: 'Finish readiness assessment', detail: 'Communication module is ready to continue.', status: 'Due soon' },
  { title: 'Review matched opportunity', detail: 'SOC Analyst Intern role matches your networking and SIEM signals.', status: 'Review' },
  { title: 'Update skill evidence', detail: 'Link security lab outcomes to incident triage and stakeholder notes.', status: 'Draft' },
];

export const skills = [
  { name: 'Networking fundamentals', group: 'Technical', level: 82, requirement: 80, evidence: 'Strong', state: 'Assessment-verified', trend: '+8' },
  { name: 'Linux fundamentals', group: 'Technical', level: 74, requirement: 78, evidence: 'Medium', state: 'Self-declared', trend: '+5' },
  { name: 'Security fundamentals', group: 'Technical', level: 76, requirement: 82, evidence: 'Medium', state: 'Institution-verified', trend: '+6' },
  { name: 'SIEM investigation', group: 'Analytical', level: 68, requirement: 84, evidence: 'Medium', state: 'Assessment assigned', trend: '+11' },
  { name: 'Incident triage', group: 'Analytical', level: 63, requirement: 80, evidence: 'Weak', state: 'Claimed', trend: '+4' },
  { name: 'Python security automation', group: 'Technical', level: 63, requirement: 72, evidence: 'Medium', state: 'Course artifact', trend: '+7' },
  { name: 'Communication', group: 'Communication', level: 58, requirement: 74, evidence: 'Weak', state: 'Practice needed', trend: '+3' },
  { name: 'Aptitude', group: 'Aptitude', level: 70, requirement: 72, evidence: 'Strong', state: 'Assessment-verified', trend: '+2' },
];

export const learningCatalog = [
  { title: 'SIEM Investigation Sprint', type: 'Lab', level: 'Intermediate', duration: '4h 20m', linkedSkill: 'SIEM investigation', progress: 60, image: learningIllustration },
  { title: 'Linux Hardening Basics', type: 'Course', level: 'Beginner', duration: '3h 10m', linkedSkill: 'Linux fundamentals', progress: 35, image: opportunityIllustration },
  { title: 'Interview Narrative Practice', type: 'Coach path', level: 'Guided', duration: '2h', linkedSkill: 'Communication', progress: 0, image: coachIllustration },
  { title: 'Networking Fundamentals', type: 'Certificate', level: 'Intermediate', duration: '5h', linkedSkill: 'Networking fundamentals', progress: 100, image: careerIllustration },
];

export const careerStages = [
  { title: 'Explore target', state: 'Complete', detail: 'Cybersecurity Analyst selected as primary target.' },
  { title: 'Build evidence', state: 'Current', detail: 'Attach networking, Linux, and SIEM lab artifacts.' },
  { title: 'Apply with consented profile', state: 'Next', detail: 'Use verified snapshot for recommended roles.' },
  { title: 'Prepare interviews', state: 'Upcoming', detail: 'Practice incident triage and stakeholder communication.' },
];

export const assessments = [
  { title: 'SIEM Investigation Assessment', category: 'Technical', status: 'Scheduled', deadline: 'Aug 20', duration: '75 min', score: 'Not attempted', impact: '+7 readiness', action: 'Start assessment' },
  { title: 'Linux Hardening Lab', category: 'Practical lab', status: 'Continue', deadline: 'Aug 22', duration: '90 min', score: '40% complete', impact: '+5 readiness', action: 'Continue assessment' },
  { title: 'Networking Fundamentals', category: 'Technical', status: 'Completed', deadline: 'Completed Aug 10', duration: '60 min', score: '82%', impact: '+8 readiness', action: 'View result' },
  { title: 'Incident Communication Mock', category: 'Communication', status: 'Available', deadline: 'Recommended this week', duration: '30 min', score: 'Recommended', impact: '+4 readiness', action: 'Start practice' },
];

export const experiences = [
  { name: 'Security incident readiness dashboard', type: 'Project', state: 'Needs verification', competency: 'Incident triage, reporting', impact: '+5 readiness', evidence: 'Portfolio draft' },
  { name: 'Suspicious login investigation notebook', type: 'Work simulation', state: 'Evidence provided', competency: 'SIEM investigation', impact: '+6 readiness', evidence: 'Notebook linked' },
  { name: 'Home lab Linux hardening', type: 'Practical lab', state: 'Pending review', competency: 'Linux fundamentals', impact: '+4 readiness', evidence: 'Screenshots attached' },
  { name: 'Campus cyber awareness volunteer', type: 'Volunteering', state: 'Self-declared', competency: 'Communication', impact: '+2 readiness', evidence: 'Reflection note' },
  { name: 'Networking Fundamentals Certificate', type: 'Certification', state: 'Institution-verified', competency: 'Networking', impact: '+3 readiness', evidence: 'Certificate verified' },
];

export const opportunities = [
  { role: 'SOC Analyst Intern', employer: 'SecureTech Labs', type: 'Internship', location: 'Bengaluru', mode: 'Hybrid', fit: 86, status: 'Eligible', deadline: 'Aug 28', threshold: 65, skills: ['Networking', 'SIEM', 'Communication'], factors: ['Networking verified', 'SIEM in progress', 'Resume ready'], missing: ['Mock interview evidence'], logo: 'SL', color: 'blue', saved: false, recommended: true },
  { role: 'Cybersecurity Intern', employer: 'InfoSec Solutions', type: 'Internship', location: 'Remote', mode: 'Remote', fit: 78, status: 'Saved', deadline: 'Sep 02', threshold: 60, skills: ['Security fundamentals', 'Python'], factors: ['Python artifact', 'Security fundamentals verified'], missing: ['Portfolio source labels'], logo: 'IS', color: 'green', saved: true, recommended: false },
  { role: 'Security Operations Trainee', employer: 'Aster Mobility', type: 'Job', location: 'Pune', mode: 'On-site', fit: 72, status: 'Institution-recommended', deadline: 'Sep 05', threshold: 70, skills: ['Linux', 'Incident triage'], factors: ['Institution recommendation', 'Linux gap remains'], missing: ['Incident triage evidence'], logo: 'AM', color: 'amber', saved: false, recommended: true },
  { role: 'Incident Response Associate', employer: 'MarketWorks Security', type: 'Job', location: 'Mumbai', mode: 'Hybrid', fit: 68, status: 'Missing requirements', deadline: 'Sep 12', threshold: 75, skills: ['SIEM', 'Incident triage'], factors: ['Needs stronger incident evidence'], missing: ['Readiness below threshold', 'SIEM assessment incomplete'], logo: 'MS', color: 'purple', saved: false, recommended: false },
];

export const applications = [
  { employer: 'SecureTech Labs', role: 'SOC Analyst Intern', stage: 'Draft', date: 'Aug 17', next: 'Confirm resume version', deadline: 'Aug 18', documents: 'Resume draft ready', interview: 'Not scheduled', assessment: 'Not assigned', logo: 'SL' },
  { employer: 'InfoSec Solutions', role: 'Cybersecurity Intern', stage: 'Applied', date: 'Aug 14', next: 'Await recruiter review', deadline: 'Aug 29', documents: 'Resume submitted', interview: 'Pending', assessment: 'Screening pending', logo: 'IS' },
  { employer: 'Aster Mobility', role: 'Security Operations Trainee', stage: 'Interview', date: 'Aug 12', next: 'Prepare incident triage exercise', deadline: 'Aug 21', documents: 'Portfolio requested', interview: 'Technical round scheduled', assessment: 'Completed', logo: 'AM' },
  { employer: 'MarketWorks Security', role: 'Incident Response Associate', stage: 'Offer', date: 'Aug 08', next: 'Review terms snapshot', deadline: 'Aug 25', documents: 'Offer letter available', interview: 'Completed', assessment: 'Completed', logo: 'MS' },
];

export const interviews = [
  { employer: 'Aster Mobility', role: 'Security Operations Trainee', round: 'Technical round', format: 'Video', when: 'Aug 21, 2026 10:30 IST', prep: 'Review Linux hardening notes', access: 'Join link visible 30 minutes before start', feedback: 'Pending' },
  { employer: 'SecureTech Labs', role: 'SOC Analyst Intern', round: 'Mock screening', format: 'Counselor practice', when: 'Aug 19, 2026 16:00 IST', prep: 'Practice incident-triage story', access: 'Preview-only preparation session', feedback: 'Available after practice' },
];

export const documents = [
  { name: 'Cybersecurity analyst resume', kind: 'Resume', status: 'Draft', version: 'v3', updated: 'Aug 17', visibility: 'Student controlled', verification: 'Pending review' },
  { name: 'Security lab portfolio', kind: 'Portfolio', status: 'Evidence provided', version: 'v1', updated: 'Aug 15', visibility: 'Visible to saved/applied roles', verification: 'Source labels needed' },
  { name: 'Networking certificate', kind: 'Certificate', status: 'Institution verified', version: 'v1', updated: 'Aug 10', visibility: 'Shareable with consent', verification: 'Verified' },
  { name: 'Academic transcript', kind: 'Academic', status: 'Pending verification', version: 'v1', updated: 'Aug 09', visibility: 'Institution scoped', verification: 'Pending' },
  { name: 'Eligibility declaration', kind: 'Identity/eligibility', status: 'Not uploaded', version: '-', updated: '-', visibility: 'Private until required', verification: 'Missing' },
];

export const coachMessages = [
  { speaker: 'Coach preview', message: 'Your strongest signal is networking. The highest leverage gap is explaining incident triage clearly.' },
  { speaker: 'Rahul', message: 'What should I do before applying to the SOC Analyst Intern role?' },
  { speaker: 'Coach preview', message: 'Complete the SIEM assessment, attach the lab note, then tailor your resume summary to SOC monitoring and escalation.' },
];

export const activityTimeline = [
  { date: 'Today', title: 'Resume version marked ready for review', detail: 'Cybersecurity analyst resume v3' },
  { date: 'Aug 16', title: 'Networking fundamentals verified', detail: 'Assessment score added to readiness model' },
  { date: 'Aug 15', title: 'Security lab portfolio updated', detail: 'Evidence source labels still pending' },
];

