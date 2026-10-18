import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { errorMessage } from '../core/errors';
import type { EditQuestion, QuizDetail } from '../core/models';
import { readFileText, TeacherApi } from './teacher-api';

interface EditorQuestion extends EditQuestion {
  /** Accepted answers edited as one per line. */
  answersText: string;
  key: number;
}

interface EditorModel {
  subjectId: number | null;
  title: string;
  timeLimitMinutes: number;
  shuffleQuestions: boolean;
  shuffleChoices: boolean;
  showResultsToStudents: boolean;
  secureMode: boolean;
  maxViolations: number;
  /** Blank (null) = every student gets every question. */
  itemsPerStudent: number | null;
  questions: EditorQuestion[];
}

let nextKey = 1;

function blankChoices() {
  return [0, 1, 2, 3].map((i) => ({ text: '', isCorrect: i === 0 }));
}

function toEditor(q: EditQuestion): EditorQuestion {
  return {
    ...q,
    choices: q.type === 'multiple_choice' ? (q.choices ?? blankChoices()).map((c) => ({ ...c })) : undefined,
    acceptedAnswers: q.acceptedAnswers,
    answersText: (q.acceptedAnswers ?? []).join('\n'),
    key: nextKey++,
  };
}

@Component({
  selector: 'app-quiz-editor',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <h1 class="text-2xl font-semibold">{{ isNew() ? 'New quiz' : 'Edit quiz' }}</h1>
      @if (!isNew()) {
        <a class="btn-secondary" [routerLink]="['/teacher/quizzes', id(), 'assign']">Assign to sections</a>
      }
    </div>

    @if (locked()) {
      <div class="alert-info mb-4">
        {{ attemptCount() }} student attempt(s) exist, so questions can't be added, removed or change type, and items per student can't change.
        You can still fix wording, points, the correct choice and accepted answers. Submitted attempts are re-graded when you save.
      </div>
    }
    @if (message()) {
      <div class="alert-success mb-4">{{ message() }}</div>
    }
    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }

    @if (model(); as m) {
      <div class="card mb-6 grid gap-4 p-5 md:grid-cols-6">
        <div class="md:col-span-4">
          <label class="label" for="title">Title</label>
          <input id="title" class="input" maxlength="200" [(ngModel)]="m.title" />
        </div>
        <div class="md:col-span-2">
          <label class="label" for="subject">Subject</label>
          <select id="subject" class="input" [(ngModel)]="m.subjectId" [disabled]="locked()">
            @for (s of api.subjects(); track s.id) {
              <option [ngValue]="s.id">{{ s.name }}</option>
            }
          </select>
        </div>
        <div class="md:col-span-3">
          <label class="label" for="limit">Time limit (minutes)</label>
          <input id="limit" type="number" min="1" max="1440" class="input" [(ngModel)]="m.timeLimitMinutes" />
        </div>
        <div class="md:col-span-3">
          <label class="label" for="items">Items per student</label>
          <input
            id="items"
            type="number"
            min="1"
            [max]="m.questions.length"
            class="input"
            placeholder="All"
            [(ngModel)]="m.itemsPerStudent"
            [disabled]="locked()"
          />
          <p class="mt-1 text-xs text-slate-500">
            @if (m.itemsPerStudent) {
              Each student gets {{ m.itemsPerStudent }} of the {{ m.questions.length }} questions, picked at random for them.
            } @else {
              Leave blank to give every student all {{ m.questions.length }} questions.
            }
          </p>
        </div>
        <div class="flex flex-col justify-end gap-2 text-sm md:col-span-6">
          <label class="flex items-center gap-2"><input type="checkbox" [(ngModel)]="m.shuffleQuestions" /> Shuffle question order for each student</label>
          <label class="flex items-center gap-2"><input type="checkbox" [(ngModel)]="m.shuffleChoices" /> Shuffle choice order for each student</label>
          <label class="flex items-center gap-2"><input type="checkbox" [(ngModel)]="m.showResultsToStudents" /> Show item-by-item feedback to students after they submit</label>
        </div>
        <div class="rounded-xl border-2 border-slate-200 p-4 md:col-span-6">
          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" class="mt-1" [(ngModel)]="m.secureMode" />
            <span>
              <span class="font-semibold">Exam security</span>
              <span class="block text-slate-500">
                Full screen; copy, paste, right-click and printing turned off; switching tabs or apps, Alt+Tab, leaving full screen and the
                Print Screen key are recorded with the time and shown to you in Results.
              </span>
            </span>
          </label>
          <label class="mt-3 flex flex-wrap items-center gap-2 pl-6 text-sm" [class.opacity-50]="!m.secureMode">
            Submit the exam automatically after the student leaves it
            <input type="number" min="0" max="100" class="input w-20" [(ngModel)]="m.maxViolations" [disabled]="!m.secureMode" />
            times <span class="text-slate-500">(0 = only record, never submit)</span>
          </label>
        </div>
      </div>

      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold">
          Questions
          <span class="text-sm font-normal text-slate-500"
            >({{ m.questions.length }} items · {{ total() }} points{{ m.itemsPerStudent ? ' · each student gets ' + m.itemsPerStudent : '' }})</span
          >
        </h2>
        @if (!locked()) {
          <div class="flex flex-wrap gap-2">
            <label class="btn-secondary btn-sm">
              Import questions (JSON)
              <input type="file" accept=".json,application/json" class="hidden" (change)="importQuestions($event)" />
            </label>
            <button class="btn-secondary btn-sm" (click)="addQuestion('multiple_choice')">+ Multiple choice</button>
            <button class="btn-secondary btn-sm" (click)="addQuestion('identification')">+ Identification</button>
          </div>
        }
      </div>

      <div class="space-y-4">
        @for (q of m.questions; track q.key; let i = $index) {
          <div class="card p-5">
            <div class="mb-3 flex flex-wrap items-center gap-3">
              <span class="grid h-7 w-7 place-items-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">{{ i + 1 }}</span>
              <select class="input w-auto" [ngModel]="q.type" (ngModelChange)="setType(q, $event)" [disabled]="locked()">
                <option value="multiple_choice">Multiple choice</option>
                <option value="identification">Identification</option>
              </select>
              <label class="flex items-center gap-2 text-sm">
                Points <input type="number" min="1" max="100" class="input w-20" [(ngModel)]="q.points" />
              </label>
              <div class="ml-auto flex gap-1">
                <button class="btn-ghost btn-sm" [disabled]="i === 0" (click)="move(i, -1)" title="Move up">↑</button>
                <button class="btn-ghost btn-sm" [disabled]="i === m.questions.length - 1" (click)="move(i, 1)" title="Move down">↓</button>
                @if (!locked()) {
                  <button class="btn-ghost btn-sm text-rose-600" (click)="removeQuestion(i)">Remove</button>
                }
              </div>
            </div>
            <textarea class="input mb-3" rows="2" placeholder="Question text" [(ngModel)]="q.text"></textarea>

            @if (q.type === 'multiple_choice') {
              <div class="grid gap-2 md:grid-cols-2">
                @for (c of q.choices; track $index; let ci = $index) {
                  <label class="flex items-center gap-2 rounded-lg border p-2" [class]="c.isCorrect ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'">
                    <input type="radio" [name]="'correct' + q.key" [checked]="c.isCorrect" (change)="setCorrect(q, ci)" title="Mark as correct" />
                    <span class="w-5 text-sm font-semibold text-slate-500">{{ 'ABCD'[ci] }}</span>
                    <input class="input" [placeholder]="'Choice ' + 'ABCD'[ci]" [(ngModel)]="c.text" />
                  </label>
                }
              </div>
              <p class="mt-1 text-xs text-slate-500">Select the radio button of the correct choice.</p>
            } @else {
              <label class="label">Accepted answers (one per line; matching ignores case and extra spaces)</label>
              <textarea class="input" rows="2" placeholder="primary key&#10;PK" [(ngModel)]="q.answersText"></textarea>
            }
          </div>
        } @empty {
          <div class="card p-8 text-center text-slate-500">No questions yet. Add some or import a JSON file.</div>
        }
      </div>

      <div class="sticky bottom-0 mt-6 flex justify-end gap-2 border-t border-slate-200 bg-slate-50/95 py-4">
        <a routerLink="/teacher/quizzes" class="btn-secondary">Cancel</a>
        <button class="btn-primary" [disabled]="saving()" (click)="save()">{{ saving() ? 'Saving…' : 'Save quiz' }}</button>
      </div>
    } @else {
      <p class="text-slate-500">Loading…</p>
    }
  `,
})
export class QuizEditor implements OnInit {
  protected readonly api = inject(TeacherApi);
  private readonly router = inject(Router);

  /** Route param :id (absent for /quizzes/new) */
  readonly id = input<string>();

  protected readonly model = signal<EditorModel | null>(null);
  protected readonly locked = signal(false);
  protected readonly attemptCount = signal(0);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly isNew = computed(() => !this.id());
  /** Plain method (not computed) because points are edited in place through ngModel. */
  protected total(): number {
    return (this.model()?.questions ?? []).reduce((s, q) => s + (Number(q.points) || 0), 0);
  }

  async ngOnInit() {
    await this.api.loadMeta();
    if (this.isNew()) {
      this.model.set({
        subjectId: this.api.subjects()[0]?.id ?? null,
        title: '',
        timeLimitMinutes: 60,
        shuffleQuestions: true,
        shuffleChoices: true,
        showResultsToStudents: false,
        secureMode: true,
        maxViolations: 5,
        itemsPerStudent: null,
        questions: [],
      });
      return;
    }
    try {
      this.apply(await this.api.get<QuizDetail>(`/api/teacher/quizzes/${this.id()}`));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  private apply(q: QuizDetail) {
    this.locked.set(q.structureLocked);
    this.attemptCount.set(q.attemptCount);
    this.model.set({
      subjectId: q.subjectId,
      title: q.title,
      timeLimitMinutes: q.timeLimitMinutes,
      shuffleQuestions: q.shuffleQuestions,
      shuffleChoices: q.shuffleChoices,
      showResultsToStudents: q.showResultsToStudents,
      secureMode: q.secureMode,
      maxViolations: q.maxViolations,
      itemsPerStudent: q.itemsPerStudent,
      questions: q.questions.map(toEditor),
    });
  }

  private touch() {
    this.model.update((m) => (m ? { ...m, questions: [...m.questions] } : m));
  }

  protected addQuestion(type: EditQuestion['type']) {
    this.model()!.questions.push(
      toEditor({ type, text: '', points: 1, choices: type === 'multiple_choice' ? blankChoices() : undefined, acceptedAnswers: type === 'identification' ? [] : undefined }),
    );
    this.touch();
  }

  protected removeQuestion(i: number) {
    if (!confirm(`Remove question ${i + 1}?`)) return;
    this.model()!.questions.splice(i, 1);
    this.touch();
  }

  protected move(i: number, delta: number) {
    const qs = this.model()!.questions;
    const j = i + delta;
    [qs[i], qs[j]] = [qs[j], qs[i]];
    this.touch();
  }

  protected setType(q: EditorQuestion, type: EditQuestion['type']) {
    q.type = type;
    if (type === 'multiple_choice' && !q.choices) q.choices = blankChoices();
    this.touch();
  }

  protected setCorrect(q: EditorQuestion, index: number) {
    q.choices?.forEach((c, i) => (c.isCorrect = i === index));
    this.touch();
  }

  protected async importQuestions(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set('');
    this.message.set('');
    try {
      let data: unknown;
      try {
        data = JSON.parse((await readFileText(file)).replace(/^﻿/, ''));
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      // A whole-quiz file also works: take its questions.
      if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { quizzes?: unknown[] }).quizzes)) {
        data = (data as { quizzes: unknown[] }).quizzes[0];
      }
      const res = await this.api.post<{ questions: EditQuestion[] }>('/api/teacher/quizzes/parse-questions', { data });
      this.model()!.questions.push(...res.questions.map(toEditor));
      this.touch();
      this.message.set(`Added ${res.questions.length} question(s) from ${file.name}. Review them, then save.`);
    } catch (err) {
      this.error.set(err instanceof Error && !('status' in err) ? err.message : errorMessage(err));
    } finally {
      input.value = '';
    }
  }

  private validate(m: EditorModel): string | null {
    if (!m.title.trim()) return 'Give the quiz a title.';
    if (!m.subjectId) return 'Choose a subject.';
    if (!(Number(m.timeLimitMinutes) >= 1)) return 'Time limit must be at least 1 minute.';
    if (m.itemsPerStudent !== null) {
      const n = Number(m.itemsPerStudent);
      if (!Number.isInteger(n) || n < 1) return 'Items per student must be a whole number of at least 1, or blank for all questions.';
      if (n > m.questions.length) return `Items per student can't be more than the number of questions (${m.questions.length}).`;
    }
    for (const [i, q] of m.questions.entries()) {
      const n = i + 1;
      if (!q.text.trim()) return `Question ${n} has no text.`;
      if (!(Number(q.points) >= 1)) return `Question ${n} needs at least 1 point.`;
      if (q.type === 'multiple_choice') {
        if (q.choices!.some((c) => !c.text.trim())) return `Question ${n}: fill in all 4 choices.`;
        if (q.choices!.filter((c) => c.isCorrect).length !== 1) return `Question ${n}: mark exactly one correct choice.`;
      } else if (!q.answersText.split('\n').some((a) => a.trim())) {
        return `Question ${n}: add at least one accepted answer.`;
      }
    }
    return null;
  }

  protected async save() {
    const m = this.model();
    if (!m) return;
    this.error.set('');
    this.message.set('');
    const problem = this.validate(m);
    if (problem) {
      this.error.set(problem);
      return;
    }
    const body = {
      subjectId: m.subjectId,
      title: m.title.trim(),
      timeLimitMinutes: Number(m.timeLimitMinutes),
      shuffleQuestions: m.shuffleQuestions,
      shuffleChoices: m.shuffleChoices,
      showResultsToStudents: m.showResultsToStudents,
      secureMode: m.secureMode,
      maxViolations: Math.max(0, Math.min(100, Math.floor(Number(m.maxViolations) || 0))),
      itemsPerStudent: m.itemsPerStudent === null ? null : Number(m.itemsPerStudent),
      questions: m.questions.map((q) => ({
        ...(q.id ? { id: q.id } : {}),
        type: q.type,
        text: q.text.trim(),
        points: Number(q.points),
        ...(q.type === 'multiple_choice'
          ? { choices: q.choices!.map((c) => ({ ...(c.id ? { id: c.id } : {}), text: c.text.trim(), isCorrect: c.isCorrect })) }
          : { acceptedAnswers: q.answersText.split('\n').map((a) => a.trim()).filter(Boolean) }),
      })),
    };
    this.saving.set(true);
    try {
      if (this.isNew()) {
        const created = await this.api.post<QuizDetail>('/api/teacher/quizzes', body);
        await this.router.navigate(['/teacher/quizzes', created.id], { replaceUrl: true });
        this.apply(created);
        this.message.set('Quiz created. Next: assign it to sections.');
      } else {
        const updated = await this.api.put<QuizDetail>(`/api/teacher/quizzes/${this.id()}`, body);
        this.apply(updated);
        this.message.set(updated.regraded ? `Saved. Re-graded ${updated.regraded} submitted attempt(s).` : 'Saved.');
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      this.error.set(errorMessage(err));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      this.saving.set(false);
    }
  }
}
