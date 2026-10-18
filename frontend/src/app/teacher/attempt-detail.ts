import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { errorMessage } from '../core/errors';
import type { AttemptDetail } from '../core/models';
import { formatManila, formatManilaTime } from '../core/time';
import { TeacherApi } from './teacher-api';

type Item = AttemptDetail['items'][number];
type Decision = 'auto' | 'correct' | 'wrong';

@Component({
  selector: 'app-attempt-detail',
  template: `
    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }
    @if (message()) {
      <div class="alert-success mb-4">{{ message() }}</div>
    }
    @if (detail(); as d) {
      <div class="card mb-4 flex flex-wrap items-center gap-6 p-5">
        <div class="flex-1">
          <div class="text-sm text-slate-500">{{ d.quiz.title }}</div>
          <h1 class="text-xl font-semibold">{{ d.student.name }} <span class="font-mono text-base text-slate-500">{{ d.student.srCode }}</span></h1>
          <div class="text-sm text-slate-500">Section {{ d.student.section }}</div>
        </div>
        <div class="text-sm text-slate-600">
          <div>Started {{ fmt(d.startedAt) }}</div>
          <div>{{ d.status === 'submitted' ? 'Submitted ' + fmt(d.submittedAt) : 'Deadline ' + fmt(d.deadline) }}</div>
        </div>
        <div class="text-center">
          @if (d.status === 'submitted') {
            <div class="text-3xl font-bold tabular-nums">{{ d.score }}<span class="text-lg text-slate-400"> / {{ d.totalPoints }}</span></div>
            @if (recheckedCount() > 0) {
              <div class="text-xs text-indigo-700">{{ recheckedCount() }} item(s) re-checked by you</div>
            }
          } @else {
            <span class="badge bg-amber-100 text-amber-800">In progress (on question {{ d.currentIndex + 1 }})</span>
          }
        </div>
        <div class="flex flex-col items-end gap-2">
          @if (d.status === 'submitted') {
            <button class="btn-secondary btn-sm" (click)="reopenOpen.set(!reopenOpen())">Reopen for revision</button>
          }
          <button class="btn-danger btn-sm" (click)="reset(d)">Reset attempt</button>
        </div>
        @if (d.reopenedAt) {
          <div class="w-full text-sm text-indigo-800">
            Reopened by you {{ fmt(d.reopenedAt) }}
            @if (d.status === 'in_progress') {
              · the student can revise until <strong>{{ fmt(d.extendedUntil) }}</strong>
            }
          </div>
        }
      </div>

      @if (reopenOpen() && d.status === 'submitted') {
        <div class="card mb-4 p-5">
          <h2 class="mb-1 text-lg font-bold">Reopen for revision</h2>
          <p class="mb-3 text-sm text-slate-600">
            {{ d.student.name }} can open the quiz again with the same questions and their saved answers, change them and submit again.
            The score is recalculated on that submit, and the leave-the-exam counter starts from zero (you still see the earlier events below).
          </p>
          <div class="flex flex-wrap items-center gap-3 text-sm">
            <label class="flex items-center gap-2">
              Give
              <input type="number" min="1" max="600" class="input w-24" [value]="reopenMinutes()" (input)="reopenMinutes.set(+$any($event.target).value)" />
              minutes from now
            </label>
            <button class="btn-primary btn-sm" [disabled]="busy() || !(reopenMinutes() >= 1 && reopenMinutes() <= 600)" (click)="reopen(d)">
              {{ busy() ? 'Reopening…' : 'Reopen now' }}
            </button>
            <button class="btn-ghost btn-sm" (click)="reopenOpen.set(false)">Cancel</button>
          </div>
        </div>
      }

      @if (d.security.enabled || d.events.length) {
        <div class="card mb-4 overflow-hidden">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <h2 class="text-lg font-bold">
              Exam security
              <span class="font-normal text-slate-500">({{ d.events.length }} {{ d.events.length === 1 ? 'event' : 'events' }})</span>
            </h2>
            <div class="flex flex-wrap items-center gap-2 text-sm">
              @if (d.security.violations > 0) {
                <span class="badge bg-rose-100 text-rose-800">⚠ Left the exam {{ d.security.violations }}{{ d.security.maxViolations ? ' of ' + d.security.maxViolations : '' }} times</span>
              } @else {
                <span class="badge bg-emerald-100 text-emerald-800">Never left the exam</span>
              }
              @if (d.security.autoSubmitted) {
                <span class="badge bg-rose-600 text-white">Submitted automatically</span>
              }
            </div>
          </div>
          @if (d.events.length) {
            <ol class="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm">
              @for (e of d.events; track e.id) {
                <li class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-5 py-2" [class.bg-rose-50]="e.counted">
                  <span class="w-24 shrink-0 font-mono text-xs text-slate-500">{{ time(e.occurredAt) }}</span>
                  <span class="font-semibold" [class.text-rose-700]="e.counted">{{ label(e.type) }}</span>
                  @if (e.detail) {
                    <span class="text-slate-500">{{ e.detail }}</span>
                  }
                  @if (e.durationMs !== null) {
                    <span class="text-slate-500">away {{ seconds(e.durationMs) }}</span>
                  }
                </li>
              }
            </ol>
          } @else {
            <p class="px-5 py-4 text-sm text-slate-500">Nothing was recorded during this attempt.</p>
          }
        </div>
      }

      @if (d.status === 'submitted') {
        <div class="alert-info mb-4">
          <strong>Re-check:</strong> for any item, choose <em>Correct</em> to give the full points of that question or <em>Wrong</em> for 0.
          <em>Auto</em> goes back to the automatic check. Your decision is kept even if the quiz is re-graded later.
        </div>
      }

      <div class="space-y-3">
        @for (it of d.items; track it.questionId) {
          <div class="card p-4" [class.ring-2]="it.overridden" [class.ring-indigo-300]="it.overridden">
            <div class="flex flex-wrap items-start gap-4">
              <div class="w-8 shrink-0 pt-0.5 text-center font-semibold text-slate-400">{{ it.number }}</div>
              <div class="min-w-0 flex-1">
                <div class="mb-1 text-xs text-slate-500">
                  {{ it.type === 'multiple_choice' ? 'Multiple choice' : 'Identification' }} · {{ it.points }} {{ it.points === 1 ? 'point' : 'points' }}
                </div>
                <p class="mb-3 whitespace-pre-wrap">{{ it.text }}</p>
                <div class="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <div class="text-xs text-slate-500">Student answer</div>
                    @if (it.answer !== null) {
                      <div class="font-medium" [class]="it.isCorrect ? 'text-emerald-700' : it.isCorrect === false ? 'text-rose-700' : ''">{{ it.answer }}</div>
                    } @else {
                      <div class="text-slate-400 italic">No answer</div>
                    }
                  </div>
                  <div>
                    <div class="text-xs text-slate-500">Answer key</div>
                    <div class="text-slate-700">{{ it.correctAnswer }}</div>
                  </div>
                </div>
              </div>

              <div class="w-full shrink-0 text-right sm:w-56">
                <div class="mb-2 text-lg font-semibold tabular-nums">
                  {{ it.pointsAwarded === null ? '—' : it.pointsAwarded }}<span class="text-sm text-slate-400"> / {{ it.points }}</span>
                </div>
                @if (d.status === 'submitted') {
                  <div class="inline-flex overflow-hidden rounded-lg border border-slate-300 text-xs font-medium" role="group" [attr.aria-label]="'Re-check item ' + it.number">
                    @for (opt of options; track opt.value) {
                      <button
                        type="button"
                        class="px-3 py-1.5 transition"
                        [class]="decision(it) === opt.value ? opt.active : 'bg-white text-slate-600 hover:bg-slate-50'"
                        [disabled]="saving() === it.questionId"
                        (click)="recheck(it, opt.value)"
                      >
                        {{ opt.label }}
                      </button>
                    }
                  </div>
                  <div class="mt-1 text-xs text-slate-500">
                    Auto-check: {{ it.autoCorrect ? 'right' : 'wrong' }}
                    @if (it.overridden) {
                      · <span class="font-medium text-indigo-700">re-checked {{ fmt(it.overriddenAt) }}</span>
                    }
                  </div>
                }
              </div>
            </div>
          </div>
        }
      </div>
    } @else if (!error() && !message()) {
      <p class="text-slate-500">Loading…</p>
    }
  `,
})
export class AttemptDetailPage implements OnInit {
  private readonly api = inject(TeacherApi);
  readonly id = input.required<string>();

  protected readonly detail = signal<AttemptDetail | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly saving = signal<number | null>(null);
  protected readonly reopenOpen = signal(false);
  protected readonly reopenMinutes = signal(15);
  protected readonly busy = signal(false);
  protected readonly fmt = formatManila;
  protected readonly time = formatManilaTime;

  private static readonly LABELS: Record<string, string> = {
    left_page: 'Left the exam',
    returned: 'Came back',
    screenshot_key: 'Screenshot key',
    fullscreen_exit: 'Left full screen',
    print_attempt: 'Tried to print',
    copy_attempt: 'Tried to copy (blocked)',
    cut_attempt: 'Tried to cut (blocked)',
    paste_attempt: 'Tried to paste (blocked)',
    right_click: 'Right-click (blocked)',
    split_screen: 'Small / split-screen window',
    page_closed: 'Closed or reloaded the page',
    page_opened: 'Opened the exam page',
    reopened: 'Reopened for revision (teacher)',
  };

  protected label(type: string) {
    return AttemptDetailPage.LABELS[type] ?? type;
  }

  protected seconds(ms: number) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  }
  protected readonly recheckedCount = computed(() => this.detail()?.items.filter((i) => i.overridden).length ?? 0);

  protected readonly options: { value: Decision; label: string; active: string }[] = [
    { value: 'auto', label: 'Auto', active: 'bg-slate-700 text-white' },
    { value: 'correct', label: 'Correct', active: 'bg-emerald-600 text-white' },
    { value: 'wrong', label: 'Wrong', active: 'bg-rose-600 text-white' },
  ];

  async ngOnInit() {
    try {
      this.detail.set(await this.api.get<AttemptDetail>(`/api/teacher/attempts/${this.id()}`));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  protected decision(it: Item): Decision {
    if (!it.overridden) return 'auto';
    return it.isCorrect ? 'correct' : 'wrong';
  }

  protected async recheck(it: Item, value: Decision) {
    if (this.decision(it) === value) return;
    this.error.set('');
    this.message.set('');
    this.saving.set(it.questionId);
    try {
      const correct = value === 'auto' ? null : value === 'correct';
      const before = this.detail()!.score ?? 0;
      const updated = await this.api.put<AttemptDetail>(`/api/teacher/attempts/${this.id()}/items/${it.questionId}`, { correct });
      this.detail.set(updated);
      const what = value === 'auto' ? 'back to the auto-check' : value === 'correct' ? `correct (${it.points} pts)` : 'wrong (0 pts)';
      this.message.set(`Item ${it.number} set to ${what}. Score ${before} → ${updated.score} / ${updated.totalPoints}.`);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.saving.set(null);
    }
  }

  protected async reopen(d: AttemptDetail) {
    const minutes = Math.floor(this.reopenMinutes());
    this.error.set('');
    this.message.set('');
    this.busy.set(true);
    try {
      const updated = await this.api.post<AttemptDetail>(`/api/teacher/attempts/${d.id}/reopen`, { minutes });
      this.detail.set(updated);
      this.reopenOpen.set(false);
      this.message.set(
        `Reopened. ${d.student.name} can revise and submit again until ${this.fmt(updated.extendedUntil)} (Continue on their quiz list).`,
      );
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async reset(d: AttemptDetail) {
    if (!confirm(`Delete ${d.student.name}'s attempt? Their answers and score are removed and they can start again while the quiz is open.`)) return;
    try {
      await this.api.delete(`/api/teacher/attempts/${d.id}`);
      this.detail.set(null);
      this.message.set('Attempt deleted. The student can start again while the quiz is open.');
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
