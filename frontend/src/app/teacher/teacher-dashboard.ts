import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../core/errors';
import type { Dashboard } from '../core/models';
import { ServerClock } from '../core/server-clock';
import { formatDuration, formatManila } from '../core/time';
import { TeacherApi } from './teacher-api';

@Component({
  selector: 'app-teacher-dashboard',
  imports: [RouterLink],
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Dashboard</h1>
        <p class="text-sm text-slate-500">Times in Asia/Manila.</p>
      </div>
      <div class="flex gap-2">
        <a routerLink="/teacher/quizzes/new" class="btn-secondary">New quiz</a>
        <a routerLink="/teacher/results" class="btn-primary">View results</a>
      </div>
    </div>

    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }

    @if (data(); as d) {
      <div class="mb-8 grid gap-4 md:grid-cols-3">
        @for (sec of bySection(); track sec.section) {
          <div class="card p-5">
            <div class="mb-3 flex items-center justify-between">
              <h2 class="text-lg font-semibold">Section {{ sec.section }}</h2>
              <span class="text-sm text-slate-500">{{ sec.students }} {{ sec.students === 1 ? 'student' : 'students' }}</span>
            </div>
            <div class="space-y-3">
              @for (s of sec.rows; track s.subjectId) {
                <div class="rounded-lg bg-slate-50 p-3">
                  <div class="mb-2 flex items-baseline justify-between gap-2 text-sm">
                    <span class="font-medium">{{ s.subject }}</span>
                    <span class="text-xs whitespace-nowrap text-slate-500">{{ s.students }} enrolled</span>
                  </div>
                  <div class="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div class="text-xl font-semibold text-indigo-700">{{ s.submitted }}</div>
                      <div class="text-xs text-slate-500">Submitted</div>
                    </div>
                    <div>
                      <div class="text-xl font-semibold text-amber-600">{{ s.inProgress }}</div>
                      <div class="text-xs text-slate-500">In progress</div>
                    </div>
                    <div>
                      <div class="text-xl font-semibold text-emerald-700">{{ s.averagePercent === null ? '—' : s.averagePercent + '%' }}</div>
                      <div class="text-xs text-slate-500">Avg score{{ s.averageScore === null ? '' : ' (' + s.averageScore + ' pts)' }}</div>
                    </div>
                  </div>
                </div>
              }
            </div>
          </div>
        }
      </div>

      <h2 class="mb-3 text-lg font-semibold">Upcoming and open quizzes</h2>
      @if (d.upcoming.length === 0) {
        <div class="card p-6 text-center text-slate-500">Nothing scheduled. <a routerLink="/teacher/quizzes" class="text-indigo-600 underline">Assign a quiz</a></div>
      } @else {
        <div class="card overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Quiz</th>
                <th>Section</th>
                <th>Status</th>
                <th>Start</th>
                <th>Due</th>
                <th class="text-right">Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (u of d.upcoming; track u.assignmentId) {
                <tr>
                  <td>
                    <div class="font-medium">{{ u.title }}</div>
                    <div class="text-xs text-slate-500">{{ u.subject }}</div>
                  </td>
                  <td>{{ u.section }}</td>
                  <td>
                    @if (u.state === 'open') {
                      <span class="badge bg-emerald-100 text-emerald-800">Open · {{ left(u.dueAt) }} left</span>
                    } @else {
                      <span class="badge bg-slate-100 text-slate-700">Opens in {{ left(u.startAt) }}</span>
                    }
                  </td>
                  <td class="whitespace-nowrap">{{ fmt(u.startAt) }}</td>
                  <td class="whitespace-nowrap">{{ fmt(u.dueAt) }}</td>
                  <td class="text-right whitespace-nowrap">
                    {{ u.submitted }} / {{ u.students }}
                    @if (u.inProgress) {
                      <div class="text-xs text-amber-600">{{ u.inProgress }} in progress</div>
                    }
                  </td>
                  <td><a class="btn-ghost btn-sm" [routerLink]="['/teacher/quizzes', u.quizId, 'assign']">Schedule</a></td>
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
export class TeacherDashboard implements OnInit {
  private readonly api = inject(TeacherApi);
  private readonly clock = inject(ServerClock);
  protected readonly data = signal<Dashboard | null>(null);
  protected readonly error = signal('');
  protected readonly fmt = formatManila;

  protected readonly bySection = computed(() => {
    const groups = new Map<string, { section: string; students: number; rows: Dashboard['stats'] }>();
    for (const s of this.data()?.stats ?? []) {
      const g = groups.get(s.section) ?? { section: s.section, students: s.sectionStudents, rows: [] };
      g.rows.push(s);
      groups.set(s.section, g);
    }
    return [...groups.values()];
  });

  async ngOnInit() {
    try {
      const d = await this.api.get<Dashboard>('/api/teacher/dashboard');
      this.clock.sync(d.serverNow);
      this.data.set(d);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected left(iso: string) {
    return formatDuration(this.clock.msUntil(iso));
  }
}
