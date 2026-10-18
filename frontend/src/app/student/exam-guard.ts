/**
 * Exam security for the quiz screen. Blocks copy/cut/paste, right-click, drag and print shortcuts, and reports:
 * leaving the page (tab switch, Alt+Tab, another app or a snipping tool taking focus), leaving full screen,
 * screenshot keys, print attempts and split screen.
 *
 * What a web page cannot see: a phone camera, a second device, or every OS-level screenshot tool.
 */
export type GuardEventType =
  | 'left_page'
  | 'returned'
  | 'screenshot_key'
  | 'fullscreen_exit'
  | 'print_attempt'
  | 'copy_attempt'
  | 'cut_attempt'
  | 'paste_attempt'
  | 'right_click'
  | 'split_screen'
  | 'page_closed'
  | 'page_opened';

export interface GuardEvent {
  /** Random id so a resent event is stored once on the server. */
  id: string;
  type: GuardEventType;
  clientTime: string;
  durationMs?: number;
  detail?: string;
}

/** Count toward the quiz's "submit automatically after N times" limit (same list as the server). */
export const COUNTED: GuardEventType[] = ['left_page', 'screenshot_key', 'fullscreen_exit', 'print_attempt'];

export interface GuardCallbacks {
  /** An event to send to the server. */
  record(e: GuardEvent): void;
  /** Something was blocked (show a short notice). */
  blocked(message: string): void;
  /** The student came back after being away long enough to be recorded. */
  returned(awayMs: number): void;
  /** Full screen was left (show the "return to full screen" overlay). */
  fullscreenLost(): void;
}

/** Shorter absences (e.g. the browser's own focus juggling) are ignored. */
const AWAY_THRESHOLD_MS = 1000;
/** One action can fire several signals (Print Screen opens the snipping tool, which takes focus): count it once. */
const MERGE_COUNTED_MS = 2000;

export class ExamGuard {
  private readonly cleanups: (() => void)[] = [];
  private awaySince: number | null = null;
  private awayReason = '';
  private awayTimer: ReturnType<typeof setTimeout> | undefined;
  private awayReported = false;
  private lastCountedAt = 0;
  private lastBlocked = new Map<string, number>();
  private splitReported = false;
  private running = false;

  constructor(private readonly cb: GuardCallbacks) {}

  start() {
    if (this.running) return;
    this.running = true;
    const on = <K extends string>(target: EventTarget, type: K, handler: (e: Event) => void, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler, options);
      this.cleanups.push(() => target.removeEventListener(type, handler, options));
    };

    // Leaving the page.
    on(window, 'blur', () => this.goAway('switched to another window or app'));
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.goAway('switched tab or minimized the browser');
      else this.comeBack();
    });
    on(window, 'focus', () => this.comeBack());

    // Full screen.
    on(document, 'fullscreenchange', () => {
      if (!document.fullscreenElement) {
        this.counted('fullscreen_exit', 'left full screen');
        this.cb.fullscreenLost();
      }
    });

    // Copy / paste / right-click / drag.
    for (const [type, event, label] of [
      ['copy', 'copy_attempt', 'Copying'],
      ['cut', 'cut_attempt', 'Cutting'],
      ['paste', 'paste_attempt', 'Pasting'],
    ] as const) {
      on(document, type, (e) => {
        e.preventDefault();
        this.blockedEvent(event, `${label} is turned off during this exam.`);
      }, { capture: true });
    }
    on(document, 'contextmenu', (e) => {
      e.preventDefault();
      this.blockedEvent('right_click', 'Right-click is turned off during this exam.');
    }, { capture: true });
    on(document, 'dragstart', (e) => e.preventDefault(), { capture: true });
    on(document, 'drop', (e) => e.preventDefault(), { capture: true });
    on(document, 'selectstart', (e) => {
      const t = e.target as HTMLElement | null;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) e.preventDefault();
    }, { capture: true });

    // Keys: screenshots, print, copy/paste shortcuts.
    const onKey = (ev: Event) => {
      const e = ev as KeyboardEvent;
      const key = e.key?.toLowerCase() ?? '';
      if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
        this.counted('screenshot_key', 'pressed Print Screen');
        void navigator.clipboard?.writeText?.('Screenshots are not allowed during this exam.').catch(() => undefined);
        return;
      }
      // Cmd+Shift+3/4/5 (macOS), Win+Shift+S (Windows snipping), when the browser gets to see them.
      if (e.shiftKey && e.metaKey && ['3', '4', '5', '6', 's'].includes(key)) {
        e.preventDefault();
        this.counted('screenshot_key', `pressed a screenshot shortcut (${e.key})`);
        return;
      }
      if (e.type !== 'keydown') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && key === 'p') {
        e.preventDefault();
        this.counted('print_attempt', 'tried to print (Ctrl+P)');
        this.cb.blocked('Printing is turned off during this exam.');
      } else if (mod && (key === 'c' || key === 'x' || key === 'v')) {
        e.preventDefault();
        const map = { c: ['copy_attempt', 'Copying'], x: ['cut_attempt', 'Cutting'], v: ['paste_attempt', 'Pasting'] } as const;
        const [type, label] = map[key];
        this.blockedEvent(type, `${label} is turned off during this exam.`);
      } else if (mod && ['a', 's', 'u'].includes(key)) {
        e.preventDefault();
      } else if (e.key === 'F12') {
        e.preventDefault();
      }
    };
    on(window, 'keydown', onKey, { capture: true });
    on(window, 'keyup', onKey, { capture: true });
    on(window, 'beforeprint', () => this.counted('print_attempt', 'opened print'));

    // Split screen / small window.
    const checkSize = () => {
      const small = window.innerWidth < screen.availWidth * 0.8 || window.innerHeight < screen.availHeight * 0.6;
      if (small && !this.splitReported) {
        this.splitReported = true;
        this.record('split_screen', { detail: `window ${window.innerWidth}×${window.innerHeight} on a ${screen.availWidth}×${screen.availHeight} screen` });
      } else if (!small) {
        this.splitReported = false;
      }
    };
    on(window, 'resize', checkSize);
    setTimeout(checkSize, 1500); // after entering full screen
  }

  stop() {
    this.running = false;
    clearTimeout(this.awayTimer);
    for (const c of this.cleanups.splice(0)) c();
  }

  private goAway(reason: string) {
    if (!this.running || this.awaySince !== null) return;
    this.awaySince = Date.now();
    this.awayReason = reason;
    this.awayReported = false;
    this.awayTimer = setTimeout(() => {
      this.awayReported = true;
      this.counted('left_page', this.awayReason);
    }, AWAY_THRESHOLD_MS);
  }

  private comeBack() {
    if (this.awaySince === null) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    clearTimeout(this.awayTimer);
    const awayMs = Date.now() - this.awaySince;
    this.awaySince = null;
    if (this.awayReported) {
      this.record('returned', { durationMs: awayMs });
      this.cb.returned(awayMs);
    }
  }

  private counted(type: GuardEventType, detail: string) {
    if (!this.running) return;
    const now = Date.now();
    if (now - this.lastCountedAt < MERGE_COUNTED_MS) return;
    this.lastCountedAt = now;
    this.record(type, { detail });
  }

  private blockedEvent(type: GuardEventType, message: string) {
    this.cb.blocked(message);
    const now = Date.now();
    if (now - (this.lastBlocked.get(type) ?? 0) < 3000) return; // don't flood the log
    this.lastBlocked.set(type, now);
    this.record(type, {});
  }

  private record(type: GuardEventType, extra: { durationMs?: number; detail?: string }) {
    if (!this.running) return;
    this.cb.record(newEvent(type, extra));
  }
}

export function newEvent(type: GuardEventType, extra: { durationMs?: number; detail?: string } = {}): GuardEvent {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return { id, type, clientTime: new Date().toISOString(), ...extra };
}

export async function enterFullscreen(): Promise<boolean> {
  try {
    if (document.fullscreenElement) return true;
    if (!document.documentElement.requestFullscreen) return false;
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return !!document.fullscreenElement;
  } catch {
    return false; // not allowed or not supported (e.g. iPhone Safari): continue without it
  }
}

export function leaveFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}
