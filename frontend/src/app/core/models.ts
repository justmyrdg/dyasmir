export type Role = 'teacher' | 'student';

export interface User {
  id: number;
  role: Role;
  name: string;
  srCode: string | null;
  email: string | null;
  sectionId: number | null;
  sectionName: string | null;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: User;
}

export interface Section {
  id: number;
  name: string;
}

export interface Subject {
  id: number;
  name: string;
}

// ---------- Student ----------

export type StudentQuizStatus = 'not_yet_open' | 'open' | 'in_progress' | 'closed' | 'submitted';

export interface StudentAssignment {
  assignmentId: number;
  quizId: number;
  title: string;
  subject: string;
  timeLimitMinutes: number;
  /** Null before starting when the student's random pick of items decides the total. */
  totalPoints: number | null;
  /** Items this student gets (or will get). */
  questionCount: number;
  /** Monitored exam (full screen, no copy/paste, leaving is recorded). */
  secureMode: boolean;
  maxViolations: number;
  startAt: string;
  dueAt: string;
  status: StudentQuizStatus;
  attemptId: number | null;
  deadline: string | null;
  score: number | null;
  submittedAt: string | null;
}

export interface AttemptQuestion {
  id: number;
  type: 'multiple_choice' | 'identification';
  text: string;
  points: number;
  choices: { id: number; text: string }[];
}

export interface AttemptView {
  id: number;
  assignmentId: number;
  status: 'in_progress' | 'submitted';
  quiz: { id: number; title: string; subject: string; timeLimitMinutes: number; totalPoints: number };
  startedAt: string;
  deadline: string;
  serverNow: string;
  questions: AttemptQuestion[];
  answers: Record<string, string>;
  currentIndex: number;
  security: { enabled: boolean; maxViolations: number; violations: number };
}

export interface AttemptResult {
  id: number;
  quiz: { id: number; title: string; subject: string; totalPoints: number };
  score: number;
  totalPoints: number;
  startedAt: string;
  submittedAt: string;
  showDetails: boolean;
  security: { enabled: boolean; violations: number; maxViolations: number; autoSubmitted: boolean };
  items: {
    number: number;
    type: string;
    text: string;
    points: number;
    yourAnswer: string | null;
    isCorrect: boolean;
    pointsAwarded: number;
  }[];
}

// ---------- Teacher ----------

export interface Student {
  id: number;
  srCode: string;
  name: string;
  sectionId: number;
  section: string;
  /** Subjects this student takes, each with the section it is taken in (irregular students differ per subject). */
  subjects: (Subject & { sectionId: number; section: string })[];
  isActive: boolean;
  createdAt: string;
  lockedUntil: string | null;
}

export interface QuizSummary {
  id: number;
  title: string;
  subject: Subject;
  timeLimitMinutes: number;
  totalPoints: number;
  questionCount: number;
  /** Each student gets this many of the questions, picked at random (null = all). */
  itemsPerStudent: number | null;
  shuffleQuestions: boolean;
  shuffleChoices: boolean;
  showResultsToStudents: boolean;
  createdAt: string;
  assignments: { id: number; sectionId: number; section: string; startAt: string; dueAt: string }[];
}

export interface EditChoice {
  id?: number;
  text: string;
  isCorrect: boolean;
}

export interface EditQuestion {
  id?: number;
  type: 'multiple_choice' | 'identification';
  text: string;
  points: number;
  choices?: EditChoice[];
  acceptedAnswers?: string[];
}

export interface QuizDetail {
  id: number;
  subjectId: number;
  title: string;
  timeLimitMinutes: number;
  shuffleQuestions: boolean;
  shuffleChoices: boolean;
  showResultsToStudents: boolean;
  secureMode: boolean;
  maxViolations: number;
  itemsPerStudent: number | null;
  totalPoints: number;
  attemptCount: number;
  structureLocked: boolean;
  questions: EditQuestion[];
  regraded?: number;
}

export type ScheduleState = 'scheduled' | 'open' | 'closed';

export interface AssignmentOverview {
  quiz: { id: number; title: string; subject: string; timeLimitMinutes: number };
  serverNow: string;
  sections: {
    sectionId: number;
    section: string;
    students: number;
    assignment: {
      id: number;
      startAt: string;
      dueAt: string;
      state: ScheduleState;
      submitted: number;
      inProgress: number;
    } | null;
  }[];
}

export interface Dashboard {
  serverNow: string;
  stats: {
    sectionId: number;
    section: string;
    subjectId: number;
    subject: string;
    /** Active students in the section. */
    sectionStudents: number;
    /** Active students in the section enrolled in this subject. */
    students: number;
    submitted: number;
    inProgress: number;
    averageScore: number | null;
    averagePercent: number | null;
  }[];
  upcoming: {
    assignmentId: number;
    quizId: number;
    title: string;
    subject: string;
    section: string;
    startAt: string;
    dueAt: string;
    state: 'scheduled' | 'open';
    students: number;
    submitted: number;
    inProgress: number;
  }[];
}

export interface ResultRow {
  studentId: number;
  srCode: string;
  name: string;
  section: string;
  quizId: number;
  quiz: string;
  subject: string;
  status: 'not_started' | 'in_progress' | 'submitted';
  score: number | null;
  /** What this student's quiz is out of (their own pick of items); null before starting if not known yet. */
  totalPoints: number | null;
  attemptId: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  isActive: boolean;
  /** All exam-security events recorded. */
  flags: number;
  /** Times the student left the exam (or pressed screenshot/print). */
  violations: number;
}

export interface AttemptDetail {
  id: number;
  status: 'in_progress' | 'submitted';
  score: number | null;
  totalPoints: number;
  startedAt: string;
  submittedAt: string | null;
  deadline: string;
  currentIndex: number;
  /** Set when the teacher reopened it for revision. */
  reopenedAt: string | null;
  extendedUntil: string | null;
  student: { srCode: string; name: string; section: string };
  quiz: { id: number; title: string };
  security: { enabled: boolean; maxViolations: number; violations: number; autoSubmitted: boolean };
  events: { id: number; type: string; counted: boolean; occurredAt: string; durationMs: number | null; detail: string | null }[];
  items: {
    number: number;
    questionId: number;
    type: string;
    text: string;
    points: number;
    answer: string | null;
    correctAnswer: string | null;
    isCorrect: boolean | null;
    pointsAwarded: number | null;
    /** What the automatic check decided. */
    autoCorrect: boolean | null;
    /** The teacher re-checked this item (their decision overrides the auto-check). */
    overridden: boolean;
    overriddenAt: string | null;
    savedAt: string | null;
  }[];
}
