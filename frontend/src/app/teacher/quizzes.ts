import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../core/errors';
import type { QuizSummary } from '../core/models';
import { formatManila } from '../core/time';
import { readFileText, TeacherApi } from './teacher-api';

@Component({
  selector: 'app-quizzes',
  imports: [RouterLink],
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Quizzes</h1>
        <p class="text-sm text-slate-500">Create quizzes, then assign them to sections with their own start and due times.</p>
      </div>
      <div class="flex gap-2">
        <label class="btn-secondary" [class.opacity-50]="busy()">
          Import quiz JSON
          <input type="file" accept=".json,application/json" class="hidden" (change)="importJson($event)" [disabled]="busy()" />
        </label>
        <a routerLink="/teacher/quizzes/new" class="btn-primary">New quiz</a>
      </div>
    </div>

    @if (message()) {
      <div class="alert-success mb-4">{{ message() }}</div>
    }
    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }

    <div class="space-y-3">
      @for (q of quizzes(); track q.id) {
        <div class="card flex flex-wrap items-center gap-4 p-4">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-medium tracking-wide text-indigo-600 uppercase">{{ q.subject.name }}</div>
            <a [routerLink]="['/teacher/quizzes', q.id]" class="font-semibold hover:underline">{{ q.title }}</a>
            <div class="text-sm text-slate-500">
              {{ q.questionCount }} questions · {{ q.totalPoints }} points · {{ q.timeLimitMinutes }} min
              @if (q.itemsPerStudent) { · {{ q.itemsPerStudent }} random items per student }
              @if (q.shuffleQuestions) { · shuffled }
              @if (q.showResultsToStudents) { · feedback shown }
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">
              @for (a of q.assignments; track a.id) {
                <span class="badge bg-slate-100 text-slate-700" [title]="'Start ' + fmt(a.startAt) + ' · Due ' + fmt(a.dueAt)">
                  {{ a.section }} · due {{ fmt(a.dueAt) }}
                </span>
              } @empty {
                <span class="text-xs text-slate-400">Not assigned to any section yet</span>
              }
            </div>
          </div>
          <div class="flex gap-2">
            <a class="btn-secondary btn-sm" [routerLink]="['/teacher/quizzes', q.id]">Edit</a>
            <a class="btn-primary btn-sm" [routerLink]="['/teacher/quizzes', q.id, 'assign']">Assign</a>
            <a class="btn-ghost btn-sm" routerLink="/teacher/results" [queryParams]="{ quizId: q.id }">Results</a>
            @if (q.assignments.length === 0) {
              <button class="btn-ghost btn-sm text-rose-600" (click)="remove(q)">Delete</button>
            }
          </div>
        </div>
      } @empty {
        <div class="card p-8 text-center text-slate-500">{{ loading() ? 'Loading…' : 'No quizzes yet. Create one or import a JSON file.' }}</div>
      }
    </div>
  `,
})
export class QuizzesPage implements OnInit {
  private readonly api = inject(TeacherApi);
  protected readonly quizzes = signal<QuizSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly fmt = formatManila;

  ngOnInit() {
    void this.load();
  }

  private async load() {
    try {
      this.quizzes.set(await this.api.get<QuizSummary[]>('/api/teacher/quizzes'));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async importJson(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set('');
    this.message.set('');
    this.busy.set(true);
    try {
      let data: unknown;
      try {
        data = JSON.parse((await readFileText(file)).replace(/^﻿/, ''));
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const res = await this.api.post<{ created: { title: string; questions: number; totalPoints: number }[] }>('/api/teacher/quizzes/import', { data });
      this.message.set(`Imported: ${res.created.map((c) => `${c.title} (${c.questions} questions, ${c.totalPoints} pts)`).join('; ')}`);
      await this.load();
    } catch (err) {
      this.error.set(err instanceof Error && !('status' in err) ? err.message : errorMessage(err));
    } finally {
      this.busy.set(false);
      input.value = '';
    }
  }

  protected async remove(q: QuizSummary) {
    if (!confirm(`Delete "${q.title}"? This cannot be undone.`)) return;
    try {
      await this.api.delete(`/api/teacher/quizzes/${q.id}`);
      await this.load();
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
