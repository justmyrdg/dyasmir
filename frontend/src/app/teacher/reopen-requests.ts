import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../core/errors';
import type { ReopenRequests } from '../core/models';
import { ServerClock } from '../core/server-clock';
import { formatDuration, formatManila, formatManilaTime } from '../core/time';
import { TeacherApi } from './teacher-api';

type Request = ReopenRequests['items'][number];

/** How often the list refreshes while open. */
const REFRESH_MS = 15_000;

@Component({
  selector: 'app-reopen-requests',
  imports: [RouterLink],
  template: `
    <div class="mb-6">
      <h1 class="text-2xl font-semibold">Reopen requests</h1>
      <p class="text-sm text-slate-500">
        Students whose exam was submitted for leaving it too many times. Approving reopens it with the time they had left: the end time
        does not change, and their leave counter starts again.
      </p>
    </div>

    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }
    @if (message()) {
      <div class="alert-success mb-4">{{ message() }}</div>
    }

    @if (data(); as d) {
      @if (d.items.length === 0) {
        <div class="card p-6 text-center text-slate-500">No requests waiting. This page refreshes on its own.</div>
      } @else {
        <div class="card overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Quiz</th>
                <th>Asked</th>
                <th>Time left</th>
                <th></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (r of d.items; track r.id) {
                <tr>
                  <td>
                    <div class="font-medium">{{ r.student.name }}</div>
                    <div class="text-xs text-slate-500"><span class="font-mono">{{ r.student.srCode }}</span> · {{ r.student.section }}</div>
                  </td>
                  <td>{{ r.quiz.title }}</td>
                  <td class="max-w-xs">
                    <div class="text-xs whitespace-nowrap text-slate-500">{{ time(r.createdAt) }}</div>
                    @if (r.message) {
                      <div class="text-sm whitespace-pre-wrap">{{ r.message }}</div>
                    }
                  </td>
                  <td class="whitespace-nowrap">
                    @if (left(r) > 0) {
                      <span class="font-mono">{{ duration(left(r)) }}</span>
                      <div class="text-xs text-slate-500">until {{ fmt(r.deadline) }}</div>
                    } @else {
                      <span class="badge bg-rose-100 text-rose-800">Time is over</span>
                      <div class="text-xs text-slate-500">Give extra minutes from Review</div>
                    }
                  </td>
                  <td>
                    <div class="flex flex-wrap justify-end gap-2">
                      <button class="btn-primary btn-sm" [disabled]="busy() === r.id || left(r) <= 0" (click)="approve(r)">Approve</button>
                      <button class="btn-secondary btn-sm" [disabled]="busy() === r.id" (click)="decline(r)">Decline</button>
                      <a class="btn-ghost btn-sm" [routerLink]="['/teacher/attempts', r.attemptId]">Review</a>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    } @else if (!error()) {
      <p class="text-slate-500">Loading…</p>
    }
  `,
})
export class ReopenRequestsPage implements OnInit, OnDestroy {
  private readonly api = inject(TeacherApi);
  private readonly clock = inject(ServerClock);
  protected readonly data = signal<ReopenRequests | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly fmt = formatManila;
  protected readonly time = formatManilaTime;
  protected readonly duration = formatDuration;
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit() {
    void this.load();
    this.timer = setInterval(() => void this.load(), REFRESH_MS);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  protected left(r: Request) {
    return this.clock.msUntil(r.deadline);
  }

  private async load() {
    try {
      const d = await this.api.get<ReopenRequests>('/api/teacher/reopen-requests');
      this.clock.sync(d.serverNow);
      this.data.set(d);
      this.api.reopenRequestCount.set(d.items.length);
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected async approve(r: Request) {
    await this.answer(r, 'approve', `Reopened. ${r.student.name} can continue until ${this.fmt(r.deadline)}.`);
  }

  protected async decline(r: Request) {
    await this.answer(r, 'decline', `Declined ${r.student.name}'s request. You can still reopen the attempt from Review.`);
  }

  private async answer(r: Request, action: 'approve' | 'decline', done: string) {
    this.busy.set(r.id);
    this.message.set('');
    this.error.set('');
    try {
      await this.api.post(`/api/teacher/reopen-requests/${r.id}/${action}`, {});
      this.message.set(done);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(null);
      await this.load();
    }
  }
}
