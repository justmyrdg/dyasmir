import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';
import type { AttemptView, StudentAssignment, StudentQuizStatus } from '../core/models';
import { ServerClock } from '../core/server-clock';
import { formatDuration, formatManila } from '../core/time';

const STATUS: Record<StudentQuizStatus, { label: string; cls: string }> = {
  not_yet_open: { label: 'Not yet open', cls: 'bg-slate-100 text-slate-700' },
  open: { label: 'Open', cls: 'bg-emerald-100 text-emerald-800' },
  in_progress: { label: 'In progress', cls: 'bg-amber-100 text-amber-800' },
  closed: { label: 'Closed', cls: 'bg-rose-100 text-rose-800' },
  submitted: { label: 'Submitted', cls: 'bg-indigo-100 text-indigo-800' },
};

@Component({
  selector: 'app-student-dashboard',
  imports: [RouterLink],
  template: `
    <div class="mb-6">
      <h1 class="text-2xl font-semibold">Hi, {{ auth.user()?.name }}</h1>
      <p class="text-sm text-slate-500">Section {{ auth.user()?.sectionName }} · All times are Philippine time (Asia/Manila).</p>
    </div>

    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }

    @if (loading()) {
      <p class="text-slate-500">Loading your quizzes…</p>
    } @else if (items().length === 0) {
      <div class="card p-8 text-center text-slate-500">No quizzes have been assigned to your section yet.</div>
    } @else {
      <div class="grid gap-4 md:grid-cols-2">
        @for (q of items(); track q.assignmentId) {
          <div class="card flex flex-col p-5">
            <div class="mb-2 flex items-start justify-between gap-3">
              <div>
                <div class="text-xs font-medium tracking-wide text-indigo-600 uppercase">{{ q.subject }}</div>
                <h2 class="text-lg leading-snug font-semibold">{{ q.title }}</h2>
              </div>
              <span class="badge {{ status[q.status].cls }}">{{ status[q.status].label }}</span>
            </div>
            <div class="mb-4 text-sm text-slate-600">
              {{ q.questionCount }} items · @if (q.totalPoints !== null) { {{ q.totalPoints }} points · }{{ q.timeLimitMinutes }} min time limit
              @if (q.secureMode) {
                <span class="badge ml-1 bg-slate-100 text-slate-700" title="Full screen; leaving the exam and screenshot keys are recorded; copy/paste is off">
                  🔒 Monitored
                </span>
              }
            </div>

            <div class="mt-auto space-y-3 text-sm">
              @switch (q.status) {
                @case ('not_yet_open') {
                  <div>Opens {{ fmt(q.startAt) }}</div>
                  <div class="rounded-lg bg-slate-50 px-3 py-2 font-mono text-base">Opens in {{ countdown(q.startAt) }}</div>
                }
                @case ('open') {
                  <div>Due <span class="font-medium">{{ fmt(q.dueAt) }}</span><span class="ml-1 text-slate-500">({{ countdown(q.dueAt) }} left)</span></div>
                  <button class="btn-primary w-full" [disabled]="starting() === q.assignmentId" (click)="start(q)">
                    {{ starting() === q.assignmentId ? 'Starting…' : 'Start quiz' }}
                  </button>
                  <p class="text-xs text-slate-500">The {{ q.timeLimitMinutes }}-minute timer starts when you click Start and keeps running even if you close the page.</p>
                }
                @case ('in_progress') {
                  <div class="rounded-lg bg-amber-50 px-3 py-2 font-mono text-base text-amber-900">Time left {{ countdown(q.deadline!) }}</div>
                  <a class="btn-primary w-full" [routerLink]="['/student/attempts', q.attemptId]">Continue</a>
                }
                @case ('closed') {
                  <div class="text-slate-500">Closed {{ fmt(q.dueAt) }}. You did not take this quiz.</div>
                }
                @case ('submitted') {
                  <div class="flex items-center justify-between">
                    <span>Score <span class="text-lg font-semibold">{{ q.score }}</span> / {{ q.totalPoints }}</span>
                    <a class="btn-secondary btn-sm" [routerLink]="['/student/attempts', q.attemptId, 'result']">View result</a>
                  </div>
                  <div class="text-xs text-slate-500">Submitted {{ fmt(q.submittedAt) }}</div>
                }
              }
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class StudentDashboard implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly clock = inject(ServerClock);

  protected readonly status = STATUS;
  protected readonly items = signal<StudentAssignment[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly starting = signal<number | null>(null);
  protected readonly fmt = formatManila;

  /** When a countdown reaches zero the status changes on the server; reload to pick it up. */
  private readonly boundaryPassed = computed(() =>
    this.items().some((q) => {
      const t = q.status === 'not_yet_open' ? q.startAt : q.status === 'open' ? q.dueAt : q.status === 'in_progress' ? q.deadline : null;
      return t !== null && this.clock.msUntil(t) <= 0;
    }),
  );

  private lastReload = 0;

  constructor() {
    effect(() => {
      this.clock.now(); // re-check every tick
      if (this.boundaryPassed() && !this.loading() && Date.now() - this.lastReload > 3000) {
        this.lastReload = Date.now();
        void this.load(true);
      }
    });
  }

  ngOnInit() {
    void this.load();
  }

  protected countdown(iso: string): string {
    return formatDuration(this.clock.msUntil(iso));
  }

  private async load(quiet = false) {
    if (!quiet) this.loading.set(true);
    try {
      const res = await firstValueFrom(this.http.get<{ serverNow: string; items: StudentAssignment[] }>('/api/student/assignments'));
      this.clock.sync(res.serverNow);
      this.items.set(res.items);
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async start(q: StudentAssignment) {
    this.starting.set(q.assignmentId);
    this.error.set('');
    try {
      const attempt = await firstValueFrom(this.http.post<AttemptView>('/api/attempts/start', { assignmentId: q.assignmentId }));
      await this.router.navigate(['/student/attempts', attempt.id]);
    } catch (err) {
      this.error.set(errorMessage(err));
      void this.load(true);
    } finally {
      this.starting.set(null);
    }
  }
}
