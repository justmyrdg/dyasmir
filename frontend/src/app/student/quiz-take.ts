import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, input, OnDestroy, OnInit, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { DEVICE_HEADER, deviceHeader } from '../core/device';
import { errorMessage } from '../core/errors';
import type { AttemptView } from '../core/models';
import { ServerClock } from '../core/server-clock';
import { formatDuration, formatManila } from '../core/time';
import { COUNTED, enterFullscreen, ExamGuard, leaveFullscreen, newEvent, type GuardEvent } from './exam-guard';

interface PendingStore {
  answers: Record<string, string>;
  currentIndex?: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';

const DEBOUNCE_MS = 1000;
const RETRY_MS = 5000;
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

@Component({
  selector: 'app-quiz-take',
  imports: [RouterLink],
  template: `
    @if (loadError()) {
      <div class="alert-error mb-4">{{ loadError() }}</div>
      <a routerLink="/student" class="btn-secondary">Back to my quizzes</a>
    } @else if (!attempt()) {
      <p class="text-slate-500">Loading quiz…</p>
    } @else {
      <!-- Header: title, timer, save indicator -->
      <div class="card sticky top-14 z-10 mb-4 p-4">
        <div class="flex flex-wrap items-center gap-4">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-medium tracking-wide text-indigo-600 uppercase">{{ attempt()!.quiz.subject }}</div>
            <h1 class="truncate text-lg font-semibold">{{ attempt()!.quiz.title }}</h1>
          </div>
          <div class="text-right text-xs" aria-live="polite">
            @switch (indicator()) {
              @case ('saving') {
                <span class="inline-flex items-center gap-1.5 text-slate-500"><span class="h-2 w-2 animate-pulse rounded-full bg-amber-400"></span>Saving…</span>
              }
              @case ('saved') {
                <span class="inline-flex items-center gap-1.5 text-emerald-700"><span class="h-2 w-2 rounded-full bg-emerald-500"></span>Saved</span>
              }
              @case ('offline') {
                <span class="inline-flex items-center gap-1.5 font-medium text-rose-700"><span class="h-2 w-2 rounded-full bg-rose-500"></span>Offline, will save when reconnected</span>
              }
              @case ('error') {
                <span class="inline-flex items-center gap-1.5 text-rose-700"><span class="h-2 w-2 rounded-full bg-rose-500"></span>Not saved, retrying…</span>
              }
              @default {
                <span class="text-slate-400">All answers are saved automatically</span>
              }
            }
          </div>
          @if (security()?.enabled) {
            <span
              class="badge"
              [class]="violations() > 0 ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'"
              title="Leaving the exam, screenshot keys and copy/paste attempts are recorded"
            >
              🔒 Monitored
              @if (violations() > 0) {
                · left {{ violations() }}{{ security()!.maxViolations ? ' of ' + security()!.maxViolations : '' }}
              }
            </span>
          }
          <div
            class="rounded-lg px-3 py-1.5 font-mono text-xl font-semibold tabular-nums"
            [class]="remainingMs() <= 60_000 ? 'bg-rose-100 text-rose-700' : remainingMs() <= 300_000 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-800'"
            title="Time left (ends {{ fmt(attempt()!.deadline) }})"
          >
            {{ timeLeft() }}
          </div>
        </div>
        <div class="mt-3">
          <div class="mb-1 flex justify-between text-xs text-slate-500">
            <span>{{ answeredCount() }} of {{ questions().length }} answered</span>
            <span>Question {{ index() + 1 }} of {{ questions().length }}</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-slate-100">
            <div class="h-full rounded-full bg-indigo-500 transition-all" [style.width.%]="progress()"></div>
          </div>
        </div>
      </div>

      @if (error()) {
        <div class="alert-error mb-4">{{ error() }}</div>
      }

      <div class="grid gap-4 lg:grid-cols-[1fr_260px]">
        <!-- Question -->
        @for (q of currentAsList(); track q.id) {
          <section class="card p-6" [class.select-none]="security()?.enabled">
            <div class="mb-3 flex items-center justify-between text-sm text-slate-500">
              <span class="font-medium text-slate-700">Question {{ index() + 1 }}</span>
              <span>{{ q.points }} {{ q.points === 1 ? 'point' : 'points' }} · {{ q.type === 'multiple_choice' ? 'Multiple choice' : 'Identification' }}</span>
            </div>
            <p class="mb-5 text-base leading-relaxed whitespace-pre-wrap">{{ q.text }}</p>

            @if (q.type === 'multiple_choice') {
              <div class="space-y-2" role="radiogroup">
                @for (c of q.choices; track c.id; let i = $index) {
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition"
                    [class]="answers()[q.id] === '' + c.id ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-slate-200 hover:bg-slate-50'"
                  >
                    <input
                      type="radio"
                      class="mt-1 accent-indigo-600"
                      [name]="'q' + q.id"
                      [value]="'' + c.id"
                      [checked]="answers()[q.id] === '' + c.id"
                      [disabled]="locked()"
                      (change)="answer(q.id, '' + c.id)"
                    />
                    <span class="font-semibold text-slate-500">{{ letters[i] }}.</span>
                    <span class="whitespace-pre-wrap">{{ c.text }}</span>
                  </label>
                }
              </div>
              @if (answers()[q.id]) {
                <button class="btn-ghost btn-sm mt-3" [disabled]="locked()" (click)="answer(q.id, '')">Clear answer</button>
              }
            } @else {
              <label class="label" [for]="'ans' + q.id">Your answer</label>
              <input
                [id]="'ans' + q.id"
                class="input text-base"
                maxlength="500"
                autocomplete="off"
                spellcheck="false"
                placeholder="Type your answer"
                [value]="answers()[q.id] ?? ''"
                [disabled]="locked()"
                (input)="answer(q.id, $any($event.target).value)"
              />
              <p class="mt-1 text-xs text-slate-500">Capitalization and extra spaces don't matter.</p>
            }

            <div class="mt-8 flex items-center justify-between">
              <button class="btn-secondary" [disabled]="index() === 0" (click)="goTo(index() - 1)">← Previous</button>
              @if (index() < questions().length - 1) {
                <button class="btn-primary" (click)="goTo(index() + 1)">Next →</button>
              } @else {
                <button class="btn-primary" [disabled]="locked()" (click)="openConfirm()">Review & submit</button>
              }
            </div>
          </section>
        }

        <!-- Navigator -->
        <aside class="card h-fit p-4">
          <h2 class="mb-3 text-sm font-semibold">Questions</h2>
          <div class="grid grid-cols-5 gap-1.5">
            @for (q of questions(); track q.id; let i = $index) {
              <button
                class="h-9 rounded-md border text-sm font-medium"
                [class]="
                  i === index()
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : isAnswered(q.id)
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                "
                [attr.aria-label]="'Go to question ' + (i + 1) + (isAnswered(q.id) ? ', answered' : ', not answered')"
                (click)="goTo(i)"
              >
                {{ i + 1 }}
              </button>
            }
          </div>
          <div class="mt-3 flex gap-3 text-xs text-slate-500">
            <span class="inline-flex items-center gap-1"><span class="h-3 w-3 rounded border border-emerald-300 bg-emerald-50"></span>Answered</span>
            <span class="inline-flex items-center gap-1"><span class="h-3 w-3 rounded border border-slate-200"></span>Not answered</span>
          </div>
          <button class="btn-primary mt-4 w-full" [disabled]="locked()" (click)="openConfirm()">Submit quiz</button>
        </aside>
      </div>

      <!-- Confirm submit -->
      @if (confirmOpen()) {
        <div class="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div class="card w-full max-w-md p-6">
            <h2 class="mb-2 text-lg font-semibold">Submit your quiz?</h2>
            @if (unanswered().length > 0) {
              <div class="alert-error mb-3">
                You have <strong>{{ unanswered().length }}</strong> unanswered
                {{ unanswered().length === 1 ? 'item' : 'items' }}: {{ unanswered().join(', ') }}.
              </div>
            } @else {
              <p class="mb-3 text-sm text-slate-600">All {{ questions().length }} items are answered.</p>
            }
            <p class="mb-5 text-sm text-slate-600">After submitting you can no longer change your answers.</p>
            <div class="flex justify-end gap-2">
              <button class="btn-secondary" (click)="confirmOpen.set(false)">Keep answering</button>
              <button class="btn-primary" [disabled]="submitting()" (click)="submit()">{{ submitting() ? 'Submitting…' : 'Submit now' }}</button>
            </div>
          </div>
        </div>
      }

      <!-- Exam security: start gate -->
      @if (gateOpen()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-squid/95 p-4" role="dialog" aria-modal="true">
          <div class="card w-full max-w-lg p-6">
            <h2 class="mb-1 text-xl font-bold">This exam is monitored</h2>
            <p class="mb-4 text-sm text-slate-500">{{ attempt()!.quiz.title }}</p>
            <ul class="mb-4 list-disc space-y-1.5 pl-5 text-sm text-slate-700">
              <li>The exam opens in <strong>full screen</strong>. Stay on this page until you submit.</li>
              <li>
                <strong>Leaving the exam is recorded</strong> with the time: switching tabs or apps, Alt+Tab, minimizing,
                leaving full screen, the Print Screen key, and reloading, closing or leaving this page and opening it again.
              </li>
              <li>Copy, paste, right-click and printing are turned off.</li>
              @if (security()!.maxViolations > 0) {
                <li class="font-semibold text-rose-700">
                  If you leave the exam {{ security()!.maxViolations }} {{ security()!.maxViolations === 1 ? 'time' : 'times' }}, it is submitted automatically.
                </li>
              }
            </ul>
            @if (violations() > 0) {
              <div class="alert-error mb-4">Already recorded: you left the exam {{ violations() }} {{ violations() === 1 ? 'time' : 'times' }}.</div>
            }
            <p class="mb-4 text-sm text-slate-600">The timer is already running: <strong class="font-mono">{{ timeLeft() }}</strong> left.</p>
            <button type="button" class="btn-primary w-full py-2" (click)="startSecureExam()">Start exam in full screen</button>
          </div>
        </div>
      }

      <!-- Exam security: left full screen -->
      @if (fullscreenLost() && !gateOpen()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-squid/95 p-4" role="alertdialog" aria-modal="true">
          <div class="card w-full max-w-md p-6 text-center">
            <h2 class="mb-2 text-lg font-bold text-rose-700">You left full screen</h2>
            <p class="mb-4 text-sm text-slate-600">This was recorded. Return to full screen to continue your exam.</p>
            @if (leftUntilSubmit() !== null) {
              <p class="mb-4 text-sm font-semibold text-rose-700">{{ leftUntilSubmit() }} more before your exam is submitted automatically.</p>
            }
            <button type="button" class="btn-primary w-full py-2" (click)="returnToFullscreen()">Return to full screen</button>
          </div>
        </div>
      }

      <!-- Exam security: came back after leaving -->
      @if (awayWarning(); as w) {
        <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink/50 p-4" role="alertdialog" aria-modal="true">
          <div class="card w-full max-w-md p-6">
            <h2 class="mb-2 text-lg font-bold text-rose-700">You left the exam</h2>
            <p class="mb-3 text-sm text-slate-700">
              You were away for {{ w.seconds }} {{ w.seconds === 1 ? 'second' : 'seconds' }}. This has been recorded and your teacher will see it
              (left {{ violations() }}{{ security()?.maxViolations ? ' of ' + security()!.maxViolations : '' }} {{ violations() === 1 ? 'time' : 'times' }}).
            </p>
            @if (leftUntilSubmit() !== null) {
              <p class="mb-4 text-sm font-semibold text-rose-700">
                Leave {{ leftUntilSubmit() }} more {{ leftUntilSubmit() === 1 ? 'time' : 'times' }} and your exam is submitted automatically.
              </p>
            }
            <button type="button" class="btn-primary w-full" (click)="awayWarning.set(null)">Back to the exam</button>
          </div>
        </div>
      }

      @if (notice()) {
        <div class="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-5 py-2 text-sm font-medium text-white shadow-lg" role="status">
          🔒 {{ notice() }}
        </div>
      }

      <!-- Time is up -->
      @if (timeUp()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="alertdialog" aria-modal="true">
          <div class="card w-full max-w-sm p-6 text-center">
            <h2 class="mb-2 text-lg font-semibold">Time is up</h2>
            <p class="text-sm text-slate-600">{{ timeUpMessage() }}</p>
          </div>
        </div>
      }
    }
  `,
})
export class QuizTake implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly clock = inject(ServerClock);

  /** Route param :id */
  readonly id = input.required<string>();

  protected readonly letters = LETTERS;
  protected readonly fmt = formatManila;
  protected readonly attempt = signal<AttemptView | null>(null);
  protected readonly answers = signal<Record<string, string>>({});
  protected readonly index = signal(0);
  protected readonly saveState = signal<SaveState>('idle');
  protected readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  protected readonly pendingCount = signal(0);
  protected readonly confirmOpen = signal(false);
  protected readonly submitting = signal(false);
  protected readonly timeUp = signal(false);
  protected readonly timeUpMessage = signal('Submitting your saved answers…');
  protected readonly error = signal('');
  protected readonly loadError = signal('');

  // Exam security
  protected readonly security = computed(() => this.attempt()?.security ?? null);
  protected readonly violations = signal(0);
  protected readonly gateOpen = signal(false);
  protected readonly fullscreenLost = signal(false);
  protected readonly awayWarning = signal<{ seconds: number } | null>(null);
  protected readonly notice = signal('');
  protected readonly leftUntilSubmit = computed(() => {
    const s = this.security();
    return s && s.maxViolations > 0 ? Math.max(0, s.maxViolations - this.violations()) : null;
  });

  protected readonly questions = computed(() => this.attempt()?.questions ?? []);
  protected readonly currentAsList = computed(() => {
    const q = this.questions()[this.index()];
    return q ? [q] : [];
  });
  protected readonly answeredCount = computed(() => this.questions().filter((q) => this.isAnswered(q.id)).length);
  protected readonly progress = computed(() => (this.questions().length ? (this.answeredCount() / this.questions().length) * 100 : 0));
  protected readonly unanswered = computed(() =>
    this.questions()
      .map((q, i) => (this.isAnswered(q.id) ? 0 : i + 1))
      .filter((n) => n > 0),
  );
  protected readonly remainingMs = computed(() => {
    const a = this.attempt();
    return a ? this.clock.msUntil(a.deadline) : Infinity;
  });
  protected readonly timeLeft = computed(() => formatDuration(this.remainingMs()));
  protected readonly locked = computed(() => this.timeUp() || this.submitting());
  protected readonly indicator = computed<SaveState>(() => {
    if (!this.online() && this.pendingCount() > 0) return 'offline';
    if (this.saveState() === 'offline' && this.pendingCount() > 0) return 'offline';
    return this.saveState();
  });

  private pending: PendingStore = { answers: {} };
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | null = null;
  private flushAgain = false;
  private submitWhenOnline = false;
  private destroyed = false;
  private guard: ExamGuard | null = null;
  private usedFullscreen = false;
  private events: GuardEvent[] = [];
  private eventsInFlight = false;
  private eventsRetry: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onOnline = () => {
    this.online.set(true);
    if (this.submitWhenOnline) void this.submit();
    else void this.flush();
    void this.flushEvents();
  };
  private readonly onOffline = () => this.online.set(false);
  /** Last-chance save when the tab is closed or hidden (the localStorage queue covers it if this fails). */
  private readonly onPageHide = () => {
    this.beaconSave();
    this.beaconEvents(true);
  };
  /** During a monitored exam, ask before a reload or tab close: opening the page again counts as leaving it. */
  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!this.guard || this.locked()) return;
    e.preventDefault();
    e.returnValue = true; // browsers that ignore preventDefault() here (Chrome/Edge before 119)
  };

  constructor() {
    effect(() => {
      if (this.attempt() && this.remainingMs() <= 0 && !this.timeUp()) untracked(() => void this.onTimeUp());
    });
  }

  ngOnInit() {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    void this.load();
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.guard?.stop(); // before leaving full screen, so it isn't recorded
    leaveFullscreen();
    clearTimeout(this.eventsRetry);
    clearTimeout(this.noticeTimer);
    this.beaconEvents(false);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    if (this.hasPending()) this.beaconSave();
  }

  protected isAnswered(questionId: number): boolean {
    return (this.answers()[questionId] ?? '').trim() !== '';
  }

  // ------------------------------------------------------------------ load / resume

  private get storageKey() {
    return `qp:attempt:${this.id()}:pending`;
  }

  private async load() {
    try {
      const a = await firstValueFrom(this.http.get<AttemptView>(`/api/attempts/${this.id()}`));
      this.clock.sync(a.serverNow);
      if (a.status === 'submitted') {
        this.clearPending();
        await this.router.navigate(['/student/attempts', a.id, 'result'], { replaceUrl: true });
        return;
      }
      // Anything typed while offline (or in the last second before a reload) wins over the server copy.
      this.pending = this.readPending();
      this.answers.set({ ...a.answers, ...this.pending.answers });
      const idx = this.pending.currentIndex ?? a.currentIndex;
      this.index.set(Math.max(0, Math.min(idx, a.questions.length - 1)));
      this.attempt.set(a);
      if (a.security?.enabled) {
        this.violations.set(a.security.violations);
        this.events = this.readEvents();
        this.queueEvent(newEvent('page_opened'));
        this.gateOpen.set(true);
      }
      this.saveState.set(this.hasPending() ? 'saving' : 'idle');
      if (this.hasPending()) void this.flush();
    } catch (err) {
      this.loadError.set(errorMessage(err, 'Could not load this quiz.'));
    }
  }

  // ------------------------------------------------------------------ answering / navigation

  protected answer(questionId: number, value: string) {
    if (this.locked()) return;
    this.answers.update((m) => ({ ...m, [questionId]: value }));
    this.pending.answers[String(questionId)] = value;
    this.writePending();
    this.saveState.set('saving');
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  protected goTo(i: number) {
    if (i < 0 || i >= this.questions().length || i === this.index()) return;
    this.index.set(i);
    this.pending.currentIndex = i;
    this.writePending();
    void this.flush();
  }

  // ------------------------------------------------------------------ autosave queue

  private hasPending(): boolean {
    return Object.keys(this.pending.answers).length > 0 || this.pending.currentIndex !== undefined;
  }

  private readPending(): PendingStore {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const parsed = raw ? (JSON.parse(raw) as PendingStore) : null;
      if (parsed && typeof parsed.answers === 'object') return { answers: parsed.answers ?? {}, currentIndex: parsed.currentIndex };
    } catch {
      /* storage unavailable or corrupt */
    }
    return { answers: {} };
  }

  private writePending() {
    this.pendingCount.set(Object.keys(this.pending.answers).length + (this.pending.currentIndex !== undefined ? 1 : 0));
    try {
      if (this.hasPending()) localStorage.setItem(this.storageKey, JSON.stringify(this.pending));
      else localStorage.removeItem(this.storageKey);
    } catch {
      /* private mode / quota: the in-memory queue still works */
    }
  }

  private clearPending() {
    this.pending = { answers: {} };
    this.writePending();
  }

  private flush(): Promise<void> {
    clearTimeout(this.debounceTimer);
    if (this.flushPromise) {
      this.flushAgain = true;
      return this.flushPromise;
    }
    this.flushPromise = this.sendPending().finally(() => {
      this.flushPromise = null;
      if (this.flushAgain && !this.destroyed) {
        this.flushAgain = false;
        void this.flush();
      }
    });
    return this.flushPromise;
  }

  private async sendPending(): Promise<void> {
    if (!this.hasPending()) {
      if (this.saveState() === 'saving') this.saveState.set('saved');
      return;
    }
    if (!navigator.onLine) {
      this.online.set(false);
      this.saveState.set('offline');
      return; // the 'online' event will flush
    }
    const snapshot: PendingStore = { answers: { ...this.pending.answers }, currentIndex: this.pending.currentIndex };
    this.saveState.set('saving');
    try {
      const res = await firstValueFrom(
        this.http.post<{ serverNow: string; deadline: string }>(`/api/attempts/${this.id()}/save`, {
          answers: Object.entries(snapshot.answers).map(([questionId, answer]) => ({ questionId: Number(questionId), answer })),
          ...(snapshot.currentIndex !== undefined ? { currentIndex: snapshot.currentIndex } : {}),
        }),
      );
      this.clock.sync(res.serverNow);
      this.attempt.update((a) => (a ? { ...a, deadline: res.deadline } : a)); // picks up a deadline extension
      // Drop only what was sent and hasn't changed since.
      for (const [k, v] of Object.entries(snapshot.answers)) if (this.pending.answers[k] === v) delete this.pending.answers[k];
      if (this.pending.currentIndex === snapshot.currentIndex) delete this.pending.currentIndex;
      this.writePending();
      this.online.set(true);
      this.saveState.set(this.hasPending() ? 'saving' : 'saved');
      this.error.set('');
    } catch (err) {
      this.handleSaveError(err);
    }
  }

  private handleSaveError(err: unknown) {
    const status = err instanceof HttpErrorResponse ? err.status : 0;
    if (status === 0 || status >= 500) {
      this.saveState.set(status === 0 ? 'offline' : 'error');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => void this.flush(), RETRY_MS);
      return;
    }
    if (status === 409) {
      // Time is up or already submitted: the server has the final state.
      this.clearPending();
      void this.router.navigate(['/student/attempts', this.id(), 'result'], { replaceUrl: true });
      return;
    }
    if (status === 401) return; // interceptor already sent the user to login; the queue stays in localStorage
    // 400/404: the queued data is invalid and would fail forever.
    this.clearPending();
    this.saveState.set('error');
    this.error.set(errorMessage(err));
  }

  private beaconSave() {
    if (!this.hasPending() || !this.attempt()) return;
    const token = this.auth.accessToken();
    if (!token) return;
    try {
      void fetch(`/api/attempts/${this.id()}/save`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, [DEVICE_HEADER]: deviceHeader() },
        body: JSON.stringify({
          answers: Object.entries(this.pending.answers).map(([questionId, answer]) => ({ questionId: Number(questionId), answer })),
          ...(this.pending.currentIndex !== undefined ? { currentIndex: this.pending.currentIndex } : {}),
        }),
      }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ submit

  protected openConfirm() {
    void this.flush();
    this.confirmOpen.set(true);
  }

  private async flushAll() {
    for (let i = 0; i < 5 && (this.hasPending() || this.flushPromise); i++) {
      await (this.flushPromise ?? this.flush());
      if (!navigator.onLine) return;
    }
  }

  protected async submit() {
    if (this.submitting()) return;
    this.submitting.set(true);
    this.error.set('');
    try {
      await this.flushAll();
      await firstValueFrom(this.http.post(`/api/attempts/${this.id()}/submit`, {}));
      this.submitWhenOnline = false;
      this.clearPending();
      this.confirmOpen.set(false);
      await this.router.navigate(['/student/attempts', this.id(), 'result'], { replaceUrl: true });
    } catch (err) {
      const offline = !(err instanceof HttpErrorResponse) || err.status === 0;
      if (offline) {
        this.submitWhenOnline = true;
        const msg = "You're offline. Your quiz will be submitted as soon as you're back online.";
        this.error.set(msg);
        this.timeUpMessage.set(msg + ' If you stay offline, your saved answers are submitted automatically when time runs out.');
      } else {
        this.error.set(errorMessage(err));
      }
      this.submitting.set(false);
    }
  }

  // ------------------------------------------------------------------ exam security

  protected async startSecureExam() {
    this.usedFullscreen = await enterFullscreen();
    this.gateOpen.set(false);
    this.fullscreenLost.set(false);
    if (this.guard) return;
    this.guard = new ExamGuard({
      record: (e) => this.queueEvent(e),
      blocked: (message) => this.showNotice(message),
      returned: (ms) => {
        if (!this.locked()) this.awayWarning.set({ seconds: Math.max(1, Math.round(ms / 1000)) });
      },
      fullscreenLost: () => {
        if (this.usedFullscreen && !this.locked()) this.fullscreenLost.set(true);
      },
    });
    this.guard.start();
  }

  protected async returnToFullscreen() {
    this.usedFullscreen = await enterFullscreen();
    this.fullscreenLost.set(false);
  }

  private showNotice(message: string) {
    this.notice.set(message);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(''), 3500);
  }

  private get eventsKey() {
    return `qp:attempt:${this.id()}:events`;
  }

  private readEvents(): GuardEvent[] {
    try {
      const v = JSON.parse(localStorage.getItem(this.eventsKey) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private writeEvents() {
    try {
      if (this.events.length) localStorage.setItem(this.eventsKey, JSON.stringify(this.events.slice(-300)));
      else localStorage.removeItem(this.eventsKey);
    } catch {
      /* storage unavailable */
    }
  }

  /** Events are queued (and kept in localStorage) until the server confirms them; resending is safe (ids). */
  private queueEvent(e: GuardEvent) {
    if (COUNTED.includes(e.type)) this.violations.update((v) => v + 1); // shown at once; the server count replaces it
    this.events.push(e);
    this.writeEvents();
    void this.flushEvents();
  }

  private async flushEvents(): Promise<void> {
    if (this.eventsInFlight || !this.events.length || !navigator.onLine) return;
    this.eventsInFlight = true;
    const batch = this.events.slice(0, 50);
    let again = false;
    try {
      const res = await firstValueFrom(
        this.http.post<{ status: string; autoSubmitted: boolean; violations?: number }>(`/api/attempts/${this.id()}/events`, { events: batch }),
      );
      const sent = new Set(batch.map((e) => e.id));
      this.events = this.events.filter((e) => !sent.has(e.id));
      this.writeEvents();
      if (res.violations !== undefined) {
        this.violations.set(res.violations + this.events.filter((e) => COUNTED.includes(e.type)).length);
      }
      if (res.status === 'submitted') {
        this.events = [];
        this.writeEvents();
        this.clearPending();
        await this.router.navigate(['/student/attempts', this.id(), 'result'], {
          replaceUrl: true,
          queryParams: res.autoSubmitted ? { auto: 1 } : {},
        });
        return;
      }
      again = this.events.length > 0;
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 0 || status >= 500) {
        clearTimeout(this.eventsRetry);
        this.eventsRetry = setTimeout(() => void this.flushEvents(), RETRY_MS);
      } else if (status !== 401) {
        const bad = new Set(batch.map((e) => e.id)); // rejected batch would fail forever
        this.events = this.events.filter((e) => !bad.has(e.id));
        this.writeEvents();
        again = this.events.length > 0;
      }
    } finally {
      this.eventsInFlight = false;
    }
    if (again && !this.destroyed) void this.flushEvents();
  }

  /** On tab close/reload: send what is queued plus "page_closed" (kept in localStorage too; ids prevent doubles). */
  private beaconEvents(closing: boolean) {
    if (!this.security()?.enabled || !this.attempt() || this.submitting()) return;
    if (closing) {
      this.events.push(newEvent('page_closed'));
      this.writeEvents();
    }
    const token = this.auth.accessToken();
    if (!this.events.length || !token) return;
    try {
      void fetch(`/api/attempts/${this.id()}/events`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, [DEVICE_HEADER]: deviceHeader() },
        body: JSON.stringify({ events: this.events.slice(0, 50) }),
      }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private async onTimeUp() {
    this.timeUp.set(true);
    this.confirmOpen.set(false);
    await this.submit();
  }
}
