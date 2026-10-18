import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../core/errors';
import type { AttemptResult } from '../core/models';
import { formatManila } from '../core/time';

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
export class QuizResult implements OnInit {
  private readonly http = inject(HttpClient);
  readonly id = input.required<string>();
  /** ?auto=1 when the exam was submitted for leaving it too many times. */
  readonly auto = input<string>();

  protected readonly result = signal<AttemptResult | null>(null);
  protected readonly error = signal('');
  protected readonly fmt = formatManila;
  protected readonly percent = computed(() => {
    const r = this.result();
    return r && r.totalPoints ? Math.round((r.score / r.totalPoints) * 1000) / 10 : 0;
  });

  async ngOnInit() {
    try {
      this.result.set(await firstValueFrom(this.http.get<AttemptResult>(`/api/attempts/${this.id()}/result`)));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
