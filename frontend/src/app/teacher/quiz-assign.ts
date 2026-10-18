import { Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../core/errors';
import type { AssignmentOverview, ScheduleState } from '../core/models';
import { ServerClock } from '../core/server-clock';
import { formatDuration, formatManila, fromManilaInput, toManilaInput } from '../core/time';
import { TeacherApi } from './teacher-api';

interface Row {
  sectionId: number;
  section: string;
  students: number;
  assignmentId: number | null;
  state: ScheduleState | null;
  submitted: number;
  inProgress: number;
  selected: boolean;
  startAt: string; // datetime-local, Manila
  dueAt: string;
  savedStart: string;
  savedDue: string;
}

const STATE: Record<ScheduleState, { label: string; cls: string }> = {
  scheduled: { label: 'Scheduled', cls: 'bg-slate-100 text-slate-700' },
  open: { label: 'Open', cls: 'bg-emerald-100 text-emerald-800' },
  closed: { label: 'Closed', cls: 'bg-rose-100 text-rose-800' },
};

@Component({
  selector: 'app-quiz-assign',
  imports: [FormsModule],
  template: `
    @if (overview(); as o) {
      <div class="mb-6">
        <div class="text-xs font-medium tracking-wide text-indigo-600 uppercase">{{ o.quiz.subject }}</div>
        <h1 class="text-2xl font-semibold">Assign: {{ o.quiz.title }}</h1>
        <p class="text-sm text-slate-500">
          Each section has its own window. Students can start between the start and due time; each gets {{ o.quiz.timeLimitMinutes }} {{ o.quiz.timeLimitMinutes === 1 ? 'minute' : 'minutes' }}, ending no later than the due time.
          All times are Asia/Manila.
        </p>
      </div>

      @if (message()) {
        <div class="alert-success mb-4">{{ message() }}</div>
      }
      @if (error()) {
        <div class="alert-error mb-4">{{ error() }}</div>
      }

      <div class="space-y-3">
        @for (r of rows(); track r.sectionId) {
          <div class="card p-4">
            <div class="flex flex-wrap items-center gap-4">
              <label class="flex w-48 items-center gap-2 font-semibold">
                @if (!r.assignmentId) {
                  <input type="checkbox" [(ngModel)]="r.selected" />
                }
                Section {{ r.section }}
              </label>
              <div>
                <label class="label text-xs">Start</label>
                <input type="datetime-local" class="input" [(ngModel)]="r.startAt" [disabled]="!r.selected && !r.assignmentId" />
              </div>
              <div>
                <label class="label text-xs">Due</label>
                <input type="datetime-local" class="input" [(ngModel)]="r.dueAt" [disabled]="!r.selected && !r.assignmentId" />
              </div>
              <div class="min-w-40 flex-1 text-sm">
                @if (r.state) {
                  <span class="badge {{ state[r.state].cls }}">{{ state[r.state].label }}</span>
                  <div class="mt-1 text-slate-600" title="Out of the students enrolled in this subject">
                    {{ r.submitted }} / {{ r.students }} submitted
                    @if (r.inProgress) {
                      · <span class="text-amber-600">{{ r.inProgress }} in progress</span>
                    }
                  </div>
                  @if (r.state === 'scheduled') {
                    <div class="text-xs text-slate-500">Opens in {{ until(r.savedStart) }}</div>
                  } @else if (r.state === 'open') {
                    <div class="text-xs text-slate-500">Closes in {{ until(r.savedDue) }}</div>
                  }
                } @else {
                  <span class="text-slate-400">Not assigned · {{ r.students }} enrolled in {{ o.quiz.subject }}</span>
                }
              </div>
              @if (r.assignmentId) {
                <div class="flex flex-wrap gap-1">
                  <button class="btn-ghost btn-sm" (click)="extend(r, 1)" title="Push the due time back by 1 day">+1 day</button>
                  <button class="btn-primary btn-sm" [disabled]="busy() || !changed(r)" (click)="update(r)">Save changes</button>
                  @if (r.submitted + r.inProgress === 0) {
                    <button class="btn-ghost btn-sm text-rose-600" (click)="remove(r)">Remove</button>
                  }
                </div>
              }
            </div>
          </div>
        }
      </div>

      <div class="mt-6 flex items-center justify-end gap-3">
        <button class="btn-secondary" (click)="copyFirst()">Copy first selected time to all selected</button>
        <button class="btn-primary" [disabled]="busy() || !anySelected()" (click)="assignSelected()">Assign to selected sections</button>
      </div>
    } @else if (error()) {
      <div class="alert-error">{{ error() }}</div>
    } @else {
      <p class="text-slate-500">Loading…</p>
    }
  `,
})
export class QuizAssign implements OnInit {
  private readonly api = inject(TeacherApi);
  private readonly clock = inject(ServerClock);
  readonly id = input.required<string>();

  protected readonly overview = signal<AssignmentOverview | null>(null);
  protected readonly rows = signal<Row[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly state = STATE;

  async ngOnInit() {
    try {
      this.apply(await this.api.get<AssignmentOverview>(`/api/teacher/quizzes/${this.id()}/assignments`));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  private apply(o: AssignmentOverview) {
    this.clock.sync(o.serverNow);
    this.overview.set(o);
    // Default window for new assignments: next full hour, one week long.
    const start = new Date(this.clock.now());
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const due = new Date(start.getTime() + 7 * 24 * 3600_000);
    this.rows.set(
      o.sections.map((s) => {
        const startAt = s.assignment ? toManilaInput(s.assignment.startAt) : toManilaInput(start);
        const dueAt = s.assignment ? toManilaInput(s.assignment.dueAt) : toManilaInput(due);
        return {
          sectionId: s.sectionId,
          section: s.section,
          students: s.students,
          assignmentId: s.assignment?.id ?? null,
          state: s.assignment?.state ?? null,
          submitted: s.assignment?.submitted ?? 0,
          inProgress: s.assignment?.inProgress ?? 0,
          selected: false,
          startAt,
          dueAt,
          savedStart: s.assignment ? s.assignment.startAt : '',
          savedDue: s.assignment ? s.assignment.dueAt : '',
        };
      }),
    );
  }

  protected anySelected() {
    return this.rows().some((r) => r.selected && !r.assignmentId);
  }

  protected changed(r: Row) {
    return toManilaInput(r.savedStart) !== r.startAt || toManilaInput(r.savedDue) !== r.dueAt;
  }

  protected until(iso: string) {
    return formatDuration(this.clock.msUntil(iso));
  }

  protected copyFirst() {
    const selected = this.rows().filter((r) => r.selected && !r.assignmentId);
    if (selected.length < 2) return;
    for (const r of selected.slice(1)) {
      r.startAt = selected[0].startAt;
      r.dueAt = selected[0].dueAt;
    }
  }

  protected extend(r: Row, days: number) {
    const due = new Date(fromManilaInput(r.dueAt));
    r.dueAt = toManilaInput(new Date(due.getTime() + days * 24 * 3600_000));
  }

  private check(r: Row): string | null {
    if (!r.startAt || !r.dueAt) return `Section ${r.section}: set both start and due times.`;
    if (new Date(fromManilaInput(r.dueAt)) <= new Date(fromManilaInput(r.startAt))) return `Section ${r.section}: due time must be after start time.`;
    return null;
  }

  private async run(fn: () => Promise<AssignmentOverview>, ok: string) {
    this.error.set('');
    this.message.set('');
    this.busy.set(true);
    try {
      this.apply(await fn());
      this.message.set(ok);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected assignSelected() {
    const selected = this.rows().filter((r) => r.selected && !r.assignmentId);
    const problem = selected.map((r) => this.check(r)).find(Boolean);
    if (problem) return this.error.set(problem);
    void this.run(
      () =>
        this.api.put<AssignmentOverview>(`/api/teacher/quizzes/${this.id()}/assignments`, {
          items: selected.map((r) => ({ sectionId: r.sectionId, startAt: fromManilaInput(r.startAt), dueAt: fromManilaInput(r.dueAt) })),
        }),
      `Assigned to section(s) ${selected.map((r) => r.section).join(', ')}.`,
    );
  }

  protected update(r: Row) {
    const problem = this.check(r);
    if (problem) return this.error.set(problem);
    void this.run(
      () => this.api.patch<AssignmentOverview>(`/api/teacher/assignments/${r.assignmentId}`, { startAt: fromManilaInput(r.startAt), dueAt: fromManilaInput(r.dueAt) }),
      `Section ${r.section} schedule updated: ${formatManila(fromManilaInput(r.startAt))} to ${formatManila(fromManilaInput(r.dueAt))}.`,
    );
  }

  protected remove(r: Row) {
    if (!confirm(`Remove this quiz from Section ${r.section}?`)) return;
    void this.run(() => this.api.delete<AssignmentOverview>(`/api/teacher/assignments/${r.assignmentId}`), `Removed from Section ${r.section}.`);
  }
}
