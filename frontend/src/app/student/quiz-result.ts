import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/errors';
import type { AttemptResult, ReopenRequestState } from '../core/models';
import { ServerClock } from '../core/server-clock';
import { formatDuration, formatManila, formatManilaTime } from '../core/time';

/** How often a locked-out student's page checks whether the teacher reopened the exam. */
const POLL_MS = 10_000;

@Component({
  selector: 'app-quiz-result',
  template: `
    @if (error()) {
      <div class="alert-error">{{ error() }}</div>
    } @else if (result(); as r) {
      @if (r.security.autoSubmitted || auto()) {
        <div class="alert-error mb-4">
          Your exam was submitted automatically because you left the exam window
          {{ r.security.violations }} {{ r.security.violations === 1 ? 'time' : 'times' }}. Your teacher can see when this happened.
        </div>
      }
      @if (reopen(); as s) {
        @if (s.lockedOut) {
          <div class="card mb-4 p-5">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-lg font-semibold">Ask your teacher to reopen your exam</h2>
              @if (timeLeftMs() > 0) {
                <span class="badge bg-amber-100 font-mono text-amber-800" title="Ends {{ fmt(s.deadline) }}">{{ timeLeft() }} left</span>
              }
            </div>
            <p class="mb-4 text-sm text-slate-600">
              Your exam is locked. Nothing is recorded while it is locked, so you can leave this page to message your teacher.
              The timer keeps running: if your teacher reopens it, you continue with the time that is left, until {{ fmt(s.deadline) }}.
            </p>
            @if (reopenError()) {
              <div class="alert-error mb-3">{{ reopenError() }}</div>
            }
            @if (pendingSince(); as since) {
              <div class="alert-info">
                Request sent at {{ time(since) }}. Waiting for your teacher… Your exam opens here as soon as they reopen it.
              </div>
            } @else if (s.canRequest) {
              <label class="label" for="reopen-note">Message to your teacher (optional)</label>
              <textarea
                id="reopen-note"
                class="input mb-3"
                rows="2"
                maxlength="500"
                placeholder="What happened?"
                [value]="note()"
                (input)="note.set($any($event.target).value)"
              ></textarea>
              <button class="btn-primary" [disabled]="sending()" (click)="ask()">{{ sending() ? 'Sending…' : 'Request to reopen' }}</button>
            } @else if (timeLeftMs() <= 0) {
              <div class="alert-error">Your exam time is over, so it can't be reopened with time left. Message your teacher if you need help.</div>
            } @else if (s.request?.status === 'declined') {
              <div class="alert-error">Your teacher declined your request to reopen this exam.</div>
            }
          </div>
        }
      }
      <div class="card mb-6 p-6 text-center">
        <div class="text-xs font-medium tracking-wide text-indigo-600 uppercase">{{ r.quiz.subject }}</div>
        <h1 class="mb-4 text-xl font-semibold">{{ r.quiz.title }}</h1>
        <div class="text-5xl font-bold tabular-nums">{{ r.score }}<span class="text-2xl text-slate-400"> / {{ r.totalPoints }}</span></div>
        <div class="mt-1 text-slate-500">{{ percent() }}%</div>
        <div class="mt-4 text-xs text-slate-500">Submitted {{ fmt(r.submittedAt) }}</div>
      </div>

      @if (r.showDetails) {
        <h2 class="mb-3 font-semibold">Item feedback</h2>
        <div class="space-y-3">
          @for (it of r.items; track it.number) {
            <div class="card flex gap-4 p-4" [class.border-l-4]="true" [class.border-l-emerald-500]="it.isCorrect" [class.border-l-rose-500]="!it.isCorrect">
              <div class="w-8 shrink-0 text-center font-semibold text-slate-400">{{ it.number }}</div>
              <div class="min-w-0 flex-1">
                <p class="mb-2 whitespace-pre-wrap">{{ it.text }}</p>
                <p class="text-sm">
                  <span class="text-slate-500">Your answer:</span>
                  @if (it.yourAnswer) {
                    <span class="ml-1 font-medium">{{ it.yourAnswer }}</span>
                  } @else {
                    <span class="ml-1 text-slate-400 italic">No answer</span>
                  }
                </p>
              </div>
              <div class="shrink-0 text-right text-sm">
                <span class="badge" [class]="it.isCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'">
                  {{ it.isCorrect ? 'Correct' : 'Incorrect' }}
                </span>
                <div class="mt-1 text-slate-500">{{ it.pointsAwarded }} / {{ it.points }}</div>
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="alert-info">Your teacher has not released item-by-item feedback for this quiz.</div>
      }
    } @else {
      <p class="text-slate-500">Loading result…</p>
    }
  `,
})
export class QuizResult implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly clock = inject(ServerClock);
  readonly id = input.required<string>();
  /** ?auto=1 when the exam was submitted for leaving it too many times. */
  readonly auto = input<string>();

  protected readonly result = signal<AttemptResult | null>(null);
  protected readonly error = signal('');
  protected readonly fmt = formatManila;
  protected readonly time = formatManilaTime;
  protected readonly percent = computed(() => {
    const r = this.result();
    return r && r.totalPoints ? Math.round((r.score / r.totalPoints) * 1000) / 10 : 0;
  });

  // Locked out for leaving the exam: ask the teacher to reopen it.
  protected readonly reopen = signal<ReopenRequestState | null>(null);
  protected readonly note = signal('');
  protected readonly sending = signal(false);
  protected readonly reopenError = signal('');
  protected readonly timeLeftMs = computed(() => {
    const s = this.reopen();
    return s ? this.clock.msUntil(s.deadline) : 0;
  });
  protected readonly timeLeft = computed(() => formatDuration(this.timeLeftMs()));
  protected readonly pendingSince = computed(() => {
    const r = this.reopen()?.request;
    return r?.status === 'pending' ? r.createdAt : null;
  });
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  /** Back from messaging the teacher: check at once instead of waiting for the next poll. */
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && this.reopen()?.lockedOut) void this.refreshReopen();
  };

  async ngOnInit() {
    try {
      const r = await firstValueFrom(this.http.get<AttemptResult>(`/api/attempts/${this.id()}/result`));
      this.result.set(r);
      if (r.security.autoSubmitted || this.auto()) {
        document.addEventListener('visibilitychange', this.onVisible);
        await this.refreshReopen();
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    clearTimeout(this.pollTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private async refreshReopen() {
    clearTimeout(this.pollTimer);
    try {
      this.show(await firstValueFrom(this.http.get<ReopenRequestState>(`/api/attempts/${this.id()}/reopen-request`)));
    } catch {
      /* offline for a moment: the next poll tries again */
    }
    // Keep checking while locked out: the teacher may approve, or reopen it after a message on another app.
    if (!this.destroyed && this.reopen()?.lockedOut !== false) this.pollTimer = setTimeout(() => void this.refreshReopen(), POLL_MS);
  }

  private show(s: ReopenRequestState) {
    this.clock.sync(s.serverNow);
    this.reopen.set(s);
    if (s.attemptStatus === 'in_progress') void this.router.navigate(['/student/attempts', this.id()], { replaceUrl: true });
  }

  protected async ask() {
    this.sending.set(true);
    this.reopenError.set('');
    try {
      const body = this.note().trim() ? { message: this.note().trim() } : {};
      this.show(await firstValueFrom(this.http.post<ReopenRequestState>(`/api/attempts/${this.id()}/reopen-request`, body)));
    } catch (err) {
      this.reopenError.set(errorMessage(err));
      void this.refreshReopen();
    } finally {
      this.sending.set(false);
    }
  }
}
