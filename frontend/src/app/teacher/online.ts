import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { interval } from 'rxjs';
import { errorMessage } from '../core/errors';
import type { OnlineNow } from '../core/models';
import { formatManila } from '../core/time';
import { TeacherApi } from './teacher-api';

const REFRESH_MS = 15_000;

/** Who is signed in with the site open right now, per section, and which quiz each student is taking. */
@Component({
  selector: 'app-online',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Online now</h1>
        <p class="text-sm text-slate-500">
          Students who are signed in and had the site open in the last {{ windowMinutes() }} minutes. Updates every 15 seconds.
        </p>
      </div>
      <button class="btn-secondary" [disabled]="loading()" (click)="load()">{{ loading() ? 'Refreshing…' : 'Refresh' }}</button>
    </div>

    @if (error()) {
      <div class="alert-error mb-4">{{ error() }}</div>
    }

    @if (data(); as d) {
      <div class="mb-6 grid gap-4 sm:grid-cols-3">
        @for (s of d.sections; track s.section) {
          <button
            type="button"
            class="card p-4 text-left transition-colors hover:border-indigo-400"
            [class.!border-indigo-500]="section() === s.section"
            [class.bg-indigo-50]="section() === s.section"
            [attr.aria-pressed]="section() === s.section"
            (click)="section.set(section() === s.section ? null : s.section)"
          >
            <div class="text-xs font-medium tracking-wide text-slate-500 uppercase">{{ s.section }}</div>
            <div class="mt-1 text-2xl font-semibold">
              {{ s.online }} <span class="text-base font-normal text-slate-500">of {{ s.students }} online</span>
            </div>
          </button>
        }
      </div>

      <div class="card overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 pt-4 pb-3">
          <h2 class="text-lg font-bold">
            {{ section() ?? 'All sections' }} <span class="font-normal text-slate-500">({{ visible().length }})</span>
          </h2>
          @if (section()) {
            <button class="btn-ghost btn-sm" (click)="section.set(null)">Show all sections</button>
          }
          <div class="flex-1"></div>
          <input class="input w-64" placeholder="Search name or SR code" [ngModel]="search()" (ngModelChange)="search.set($event)" />
        </div>
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Section</th>
                <th>Doing</th>
                <th>Last active</th>
                <th>Signed in</th>
              </tr>
            </thead>
            <tbody>
              @for (s of visible(); track s.id) {
                <tr>
                  <td>
                    <div class="flex items-center gap-2">
                      <span class="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
                      {{ s.name }}
                    </div>
                    <div class="font-mono text-xs text-slate-500">{{ s.srCode }}</div>
                  </td>
                  <td class="whitespace-nowrap">{{ s.section }}</td>
                  <td>
                    @if (s.taking) {
                      <a class="badge bg-indigo-50 text-indigo-700 hover:underline" [routerLink]="['/teacher/attempts', s.taking.attemptId]">
                        Taking: {{ s.taking.title }}
                      </a>
                    } @else if (s.mustChangePassword) {
                      <span class="badge bg-amber-100 text-amber-800">Choosing a password</span>
                    } @else {
                      <span class="text-sm text-slate-500">Browsing</span>
                    }
                  </td>
                  <td class="text-sm whitespace-nowrap">{{ ago(s.seenSecondsAgo) }}</td>
                  <td class="text-sm whitespace-nowrap text-slate-500">{{ fmt(s.lastLoginAt) }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="5" class="py-8 text-center text-slate-500">No students online right now.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    } @else if (!error()) {
      <p class="text-slate-500">Loading…</p>
    }
  `,
})
export class OnlinePage implements OnInit {
  private readonly api = inject(TeacherApi);
  protected readonly data = signal<OnlineNow | null>(null);
  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly section = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly fmt = formatManila;

  protected readonly windowMinutes = computed(() => (this.data()?.onlineSeconds ?? 150) / 60);
  protected readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    return (this.data()?.students ?? []).filter(
      (s) => (!this.section() || s.section === this.section()) && (!q || s.name.toLowerCase().includes(q) || s.srCode.includes(q)),
    );
  });

  constructor() {
    interval(REFRESH_MS)
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(() => void this.load());
  }

  ngOnInit() {
    void this.load();
  }

  protected async load() {
    if (this.loading()) return;
    this.loading.set(true);
    try {
      this.data.set(await this.api.get<OnlineNow>('/api/teacher/online'));
      this.error.set('');
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not load who is online.'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Seconds are measured by the database clock, so this needs no local time. */
  protected ago(seconds: number) {
    if (seconds < 20) return 'Just now';
    if (seconds < 60) return `${seconds} s ago`;
    return `${Math.floor(seconds / 60)} min ago`;
  }
}
