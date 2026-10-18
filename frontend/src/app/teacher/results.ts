import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../core/errors';
import type { QuizSummary, ResultRow } from '../core/models';
import { formatManila } from '../core/time';
import { TeacherApi } from './teacher-api';

const STATUS: Record<ResultRow['status'], { label: string; cls: string }> = {
  not_started: { label: 'Not started', cls: 'bg-slate-100 text-slate-700' },
  in_progress: { label: 'In progress', cls: 'bg-amber-100 text-amber-800' },
  submitted: { label: 'Submitted', cls: 'bg-indigo-100 text-indigo-800' },
};

@Component({
  selector: 'app-results',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Results</h1>
        <p class="text-sm text-slate-500">Submitted times are Asia/Manila.</p>
      </div>
      <div class="flex gap-2">
        <button class="btn-secondary" [disabled]="busy()" (click)="export('csv')">Export CSV</button>
        <button class="btn-primary" [disabled]="busy()" (click)="export('xlsx')">Export Excel</button>
      </div>
    </div>

    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }

    <div class="card overflow-hidden">
      <div class="border-b border-slate-200 px-4 pt-4 pb-3">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-lg font-bold">Results <span class="font-normal text-slate-500">({{ rows().length }})</span></h2>
          <div class="flex flex-wrap gap-4 text-sm text-slate-600">
            <span><span class="font-semibold text-ink">{{ counts().submitted }}</span> submitted</span>
            <span><span class="font-semibold text-ink">{{ counts().in_progress }}</span> in progress</span>
            <span><span class="font-semibold text-ink">{{ counts().not_started }}</span> not started</span>
            @if (counts().average !== null) {
              <span>Average <span class="font-semibold text-ink">{{ counts().average }}%</span></span>
            }
          </div>
        </div>
    <div class="grid gap-3 md:grid-cols-4">
      <div>
        <label class="label">Section</label>
        <select class="input" [ngModel]="sectionId()" (ngModelChange)="sectionId.set($event); load()">
          <option [ngValue]="null">All sections</option>
          @for (s of api.sections(); track s.id) {
            <option [ngValue]="s.id">Section {{ s.name }}</option>
          }
        </select>
      </div>
      <div>
        <label class="label">Subject</label>
        <select class="input" [ngModel]="subjectId()" (ngModelChange)="subjectId.set($event); quizId.set(null); load()">
          <option [ngValue]="null">All subjects</option>
          @for (s of api.subjects(); track s.id) {
            <option [ngValue]="s.id">{{ s.name }}</option>
          }
        </select>
      </div>
      <div class="md:col-span-2">
        <label class="label">Quiz</label>
        <select class="input" [ngModel]="quizId()" (ngModelChange)="quizId.set($event); load()">
          <option [ngValue]="null">All quizzes</option>
          @for (q of quizOptions(); track q.id) {
            <option [ngValue]="q.id">{{ q.title }}</option>
          }
        </select>
      </div>
    </div>
      </div>

      <div class="overflow-x-auto">
      <table class="table">
        <thead>
          <tr>
            <th>SR code</th>
            <th>Name</th>
            <th>Section</th>
            <th>Quiz</th>
            <th>Status</th>
            <th class="text-right">Score</th>
            <th>Submitted</th>
            <th>Security</th>
            <th></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          @for (r of rows(); track r.studentId + '-' + r.quizId) {
            <tr>
              <td class="font-mono whitespace-nowrap">{{ r.srCode }}</td>
              <td>
                {{ r.name }}
                @if (!r.isActive) {
                  <span class="text-xs text-slate-400">(deactivated)</span>
                }
              </td>
              <td>{{ r.section }}</td>
              <td>
                <div>{{ r.quiz }}</div>
                <div class="text-xs text-slate-500">{{ r.subject }}</div>
              </td>
              <td><span class="badge {{ status[r.status].cls }}">{{ status[r.status].label }}</span></td>
              <td class="text-right whitespace-nowrap tabular-nums">{{ r.score === null ? '—' : r.score + ' / ' + r.totalPoints }}</td>
              <td class="whitespace-nowrap text-slate-600">{{ r.submittedAt ? fmt(r.submittedAt) : '—' }}</td>
              <td class="whitespace-nowrap">
                @if (r.violations > 0) {
                  <span class="badge bg-rose-100 text-rose-800" [title]="r.flags + ' security events in total'">⚠ Left exam ×{{ r.violations }}</span>
                } @else if (r.flags > 0) {
                  <span class="badge bg-amber-100 text-amber-800" title="Blocked copy/paste or similar">{{ r.flags }} {{ r.flags === 1 ? 'flag' : 'flags' }}</span>
                } @else if (r.attemptId) {
                  <span class="text-xs text-slate-400">None</span>
                }
              </td>
              <td>
                @if (r.attemptId) {
                  <a class="btn-ghost btn-sm" [routerLink]="['/teacher/attempts', r.attemptId]">{{ r.status === 'submitted' ? 'Review / re-check' : 'View' }}</a>
                }
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="9" class="py-8 text-center text-slate-500">{{ loading() ? 'Loading…' : 'No results for these filters. Assign a quiz to a section first.' }}</td>
            </tr>
          }
        </tbody>
      </table>
      </div>
    </div>
  `,
})
export class ResultsPage implements OnInit {
  protected readonly api = inject(TeacherApi);
  /** Optional ?quizId= from the quizzes page. */
  readonly quizIdParam = input<string>(undefined, { alias: 'quizId' });

  protected readonly status = STATUS;
  protected readonly fmt = formatManila;
  protected readonly rows = signal<ResultRow[]>([]);
  protected readonly quizzes = signal<QuizSummary[]>([]);
  protected readonly sectionId = signal<number | null>(null);
  protected readonly subjectId = signal<number | null>(null);
  protected readonly quizId = signal<number | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly quizOptions = computed(() => {
    const sub = this.subjectId();
    return this.quizzes().filter((q) => !sub || q.subject.id === sub);
  });

  protected readonly counts = computed(() => {
    const rows = this.rows();
    const submitted = rows.filter((r) => r.status === 'submitted');
    const pct = submitted.flatMap((r) => (r.totalPoints ? [((r.score ?? 0) / r.totalPoints) * 100] : []));
    return {
      submitted: submitted.length,
      in_progress: rows.filter((r) => r.status === 'in_progress').length,
      not_started: rows.filter((r) => r.status === 'not_started').length,
      average: pct.length ? Math.round((pct.reduce((a, b) => a + b, 0) / pct.length) * 10) / 10 : null,
    };
  });

  async ngOnInit() {
    const fromQuery = Number(this.quizIdParam());
    if (Number.isInteger(fromQuery) && fromQuery > 0) this.quizId.set(fromQuery);
    try {
      await this.api.loadMeta();
      this.quizzes.set(await this.api.get<QuizSummary[]>('/api/teacher/quizzes'));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
    await this.load();
  }

  private filters() {
    return { sectionId: this.sectionId(), subjectId: this.subjectId(), quizId: this.quizId() };
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.rows.set(await this.api.get<ResultRow[]>('/api/teacher/results', this.filters()));
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async export(format: 'csv' | 'xlsx') {
    this.busy.set(true);
    try {
      await this.api.download('/api/teacher/results/export', { ...this.filters(), format }, `quiz-results.${format}`);
    } catch (err) {
      this.error.set(errorMessage(err, 'Export failed.'));
    } finally {
      this.busy.set(false);
    }
  }
}
