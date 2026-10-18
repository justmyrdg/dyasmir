import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { APP_NAME } from '../core/app-title';
import { AuthService } from '../core/auth.service';

interface Crumb {
  label: string;
  link?: string;
}

/** Console-style layout: dark top bar, side navigation (teacher), breadcrumbs, content. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="sticky top-0 z-30 bg-squid text-white shadow-[0_1px_0_0_#0f1b2a]">
      <div class="flex h-12 items-center gap-3 px-4">
        @if (isTeacher()) {
          <button
            type="button"
            class="grid h-8 w-8 place-items-center rounded-md hover:bg-white/10 lg:hidden"
            aria-label="Open navigation"
            (click)="navOpen.set(!navOpen())"
          >
            <svg viewBox="0 0 16 16" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4h12M2 8h12M2 12h12" /></svg>
          </button>
        }
        <a [routerLink]="home()" class="flex items-center gap-2.5 font-semibold tracking-tight">
          <span class="grid h-7 w-7 place-items-center rounded-md bg-orange text-sm font-bold text-ink">J</span>
          <span class="text-[15px]">{{ appName }}</span>
        </a>
        <div class="flex-1"></div>
        <div class="hidden text-right text-xs leading-tight sm:block">
          <div class="font-semibold">{{ auth.user()?.name }}</div>
          <div class="text-white/70">
            @if (auth.user()?.role === 'student') {
              {{ auth.user()?.srCode }} · {{ auth.user()?.sectionName }}
            } @else {
              Teacher
            }
          </div>
        </div>
        <button
          type="button"
          class="rounded-full border border-white/40 px-3 py-1 text-xs font-semibold text-white hover:border-white hover:bg-white/10"
          (click)="auth.logout()"
        >
          Sign out
        </button>
      </div>
    </header>

    <div class="flex">
      @if (isTeacher()) {
        <!-- Side navigation -->
        <nav
          class="fixed inset-y-0 top-12 left-0 z-20 w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white pb-6 transition-transform lg:sticky lg:h-[calc(100vh-3rem)] lg:translate-x-0"
          [class.-translate-x-full]="!navOpen()"
          aria-label="Teacher navigation"
        >
          <div class="border-b border-slate-200 px-6 py-4">
            <div class="text-lg font-bold text-ink">{{ appName }}</div>
            <div class="text-xs text-slate-500">Teacher console</div>
          </div>
          <ul class="mt-3 space-y-0.5 px-3">
            @for (link of teacherLinks; track link.path) {
              <li>
                <a
                  [routerLink]="link.path"
                  routerLinkActive="!font-bold !text-indigo-500 bg-indigo-50"
                  [routerLinkActiveOptions]="{ exact: link.exact }"
                  class="block rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:text-indigo-500"
                  (click)="navOpen.set(false)"
                  >{{ link.label }}</a
                >
              </li>
            }
          </ul>
          <div class="mx-6 my-4 border-t border-slate-200"></div>
          <div class="px-6 text-xs leading-relaxed text-slate-500">All times are shown in Asia/Manila.</div>
        </nav>
        @if (navOpen()) {
          <div class="fixed inset-0 top-12 z-10 bg-ink/40 lg:hidden" (click)="navOpen.set(false)"></div>
        }
      }

      <main class="min-w-0 flex-1 px-4 pt-4 pb-10 lg:px-8">
        <div class="mx-auto max-w-6xl">
          @if (crumbs().length > 1) {
            <nav class="mb-4 flex flex-wrap items-center gap-1.5 text-sm" aria-label="Breadcrumbs">
              @for (c of crumbs(); track $index; let last = $last) {
                @if (c.link && !last) {
                  <a [routerLink]="c.link" class="link font-normal">{{ c.label }}</a>
                  <svg viewBox="0 0 16 16" class="h-3 w-3 text-slate-400" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5" /></svg>
                } @else {
                  <span class="text-slate-500">{{ c.label }}</span>
                }
              }
            </nav>
          }
          <router-outlet />
        </div>
      </main>
    </div>
  `,
})
export class Shell {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly appName = APP_NAME;
  protected readonly navOpen = signal(false);
  protected readonly crumbs = signal<Crumb[]>([]);
  protected readonly isTeacher = computed(() => this.auth.user()?.role === 'teacher');
  protected readonly home = computed(() => this.auth.homeFor(this.auth.user()?.role));
  protected readonly teacherLinks = [
    { path: '/teacher', label: 'Dashboard', exact: true },
    { path: '/teacher/quizzes', label: 'Quizzes', exact: false },
    { path: '/teacher/results', label: 'Results', exact: false },
    { path: '/teacher/students', label: 'Students', exact: false },
  ];

  constructor() {
    this.crumbs.set(this.buildCrumbs());
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => this.crumbs.set(this.buildCrumbs()));
  }

  /** Home › (parent from route data) › current page title. */
  private buildCrumbs(): Crumb[] {
    let leaf: ActivatedRouteSnapshot = this.router.routerState.snapshot.root;
    while (leaf.firstChild) leaf = leaf.firstChild;
    const home: Crumb = { label: this.isTeacher() ? 'Dashboard' : 'My quizzes', link: this.home() };
    if (leaf.routeConfig?.path === '') return [{ label: home.label }];
    const parent = leaf.data['parent'] as Crumb | undefined;
    return [home, ...(parent ? [parent] : []), { label: leaf.title ?? '' }];
  }
}
