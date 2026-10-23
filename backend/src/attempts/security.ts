/**
 * Exam-security events sent by the quiz screen when the quiz has secure mode on.
 * A browser cannot see every screenshot or a second device; these are what it can notice.
 */
export const EVENT_TYPES = [
  'left_page', // switched tab/app, Alt+Tab, minimized, snipping tool took focus (sent after 1 s away)
  'returned', // came back (with how long they were away)
  'screenshot_key', // Print Screen / Cmd+Shift+3/4/5
  'fullscreen_exit', // left full screen
  'print_attempt', // Ctrl+P or the browser's print
  'copy_attempt', // blocked
  'cut_attempt', // blocked
  'paste_attempt', // blocked
  'right_click', // blocked
  'split_screen', // window much smaller than the screen
  'page_closed', // tab closed or reloaded
  'page_opened', // quiz page opened again
  'reopened', // the teacher reopened the attempt for revision (server only)
] as const;

export type AttemptEventType = (typeof EVENT_TYPES)[number];

/** What the quiz screen may send (not "reopened", which only the server writes). */
export const STUDENT_EVENT_TYPES = EVENT_TYPES.filter((t) => t !== 'reopened');

/** Events that count toward the quiz's "submit automatically after N times" limit. */
export const COUNTED_EVENT_TYPES: AttemptEventType[] = ['left_page', 'screenshot_key', 'fullscreen_exit', 'print_attempt'];

/** A locked-out student's request to reopen the exam (same list as reopen_requests_status_check). */
export type ReopenRequestStatus = 'pending' | 'approved' | 'declined';

/** Stop storing events for an attempt past this many (a stuck client cannot flood the table). */
export const MAX_EVENTS_PER_ATTEMPT = 2000;
