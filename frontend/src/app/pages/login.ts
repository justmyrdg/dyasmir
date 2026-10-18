import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';
import { SR_CODE_REGEX } from '../core/sr-code';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="flex min-h-screen flex-col bg-slate-100">
      <div class="flex flex-1 items-start justify-center px-4 pt-14 pb-10 sm:pt-20">
        <div class="w-full max-w-md">
          <div class="mb-6 flex items-center justify-center gap-3">
            <span class="grid h-10 w-10 place-items-center rounded-lg bg-squid text-lg font-bold text-orange">J</span>
            <span class="text-2xl font-bold tracking-tight text-ink">JASthinkAboutIT</span>
          </div>

          <div class="card p-8">
            <h1 class="mb-5 text-2xl font-bold text-ink">Sign in</h1>

            @if (expired() && !error()) {
              <div class="alert-info mb-4">Your session ended. Please sign in again.</div>
            }
            @if (error()) {
              <div class="alert-error mb-4" role="alert">{{ error() }}</div>
            }

            <fieldset class="mb-5 space-y-2">
              <legend class="sr-only">Account type</legend>
              @for (opt of modes; track opt.value) {
                <label
                  class="flex cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 transition-colors"
                  [class]="mode() === opt.value ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-slate-400'"
                >
                  <input
                    type="radio"
                    name="mode"
                    class="mt-1 h-4 w-4 accent-indigo-600"
                    [checked]="mode() === opt.value"
                    (change)="setMode(opt.value)"
                  />
                  <span>
                    <span class="block text-sm font-semibold text-ink">{{ opt.label }}</span>
                    <span class="block text-xs text-slate-500">{{ opt.hint }}</span>
                  </span>
                </label>
              }
            </fieldset>

            <form (ngSubmit)="submit()" class="space-y-4" novalidate>
              @if (mode() === 'student') {
                <div>
                  <label class="label" for="sr">SR code</label>
                  <input
                    id="sr"
                    class="input"
                    name="srCode"
                    placeholder="23-12345"
                    autocomplete="username"
                    inputmode="numeric"
                    maxlength="8"
                    [ngModel]="srCode()"
                    (ngModelChange)="srCode.set($event)"
                    (blur)="srTouched.set(true)"
                  />
                  @if (srTouched() && srCode() && !srValid()) {
                    <p class="mt-1 text-xs font-medium text-rose-600">Use the format NN-NNNNN, for example 23-12345.</p>
                  }
                </div>
              } @else {
                <div>
                  <label class="label" for="email">Email address</label>
                  <input id="email" class="input" type="email" name="email" autocomplete="username" [ngModel]="email()" (ngModelChange)="email.set($event)" />
                </div>
              }
              <div>
                <label class="label" for="pw">Password</label>
                <input id="pw" class="input" type="password" name="password" autocomplete="current-password" [ngModel]="password()" (ngModelChange)="password.set($event)" />
              </div>
              <button type="submit" class="btn-primary w-full py-2" [disabled]="!canSubmit() || busy()">
                {{ busy() ? 'Signing in…' : 'Sign in' }}
              </button>
            </form>

            <div class="mt-6 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
              @if (mode() === 'student') {
                Accounts are created by your teacher. Forgot your password? Ask your teacher to reset it.
              } @else {
                Teacher accounts are created on the server with <code class="rounded bg-slate-100 px-1">npm run create-teacher</code>.
              }
            </div>
          </div>
        </div>
      </div>
      <footer class="bg-squid px-4 py-2.5 text-center text-xs text-white/70">JASthinkAboutIT · Online quizzes</footer>
    </div>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly returnUrl = input<string>();
  readonly expired = input<string>();

  protected readonly modes = [
    { value: 'student' as const, label: 'Student', hint: 'Sign in with your SR code' },
    { value: 'teacher' as const, label: 'Teacher', hint: 'Sign in with your email address' },
  ];
  protected readonly mode = signal<'student' | 'teacher'>('student');
  protected readonly srCode = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly srTouched = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly srValid = computed(() => SR_CODE_REGEX.test(this.srCode().trim()));
  protected readonly canSubmit = computed(() =>
    this.password().length > 0 && (this.mode() === 'student' ? this.srValid() : this.email().trim().length > 3),
  );

  protected setMode(m: 'student' | 'teacher') {
    this.mode.set(m);
    this.error.set('');
  }

  protected async submit() {
    this.srTouched.set(true);
    if (!this.canSubmit() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const user = await this.auth.login(
        this.mode() === 'student'
          ? { srCode: this.srCode().trim(), password: this.password() }
          : { email: this.email().trim().toLowerCase(), password: this.password() },
      );
      const target = this.returnUrl();
      const safe = target && target.startsWith(`/${user.role}`) ? target : this.auth.homeFor(user.role);
      await this.router.navigateByUrl(safe);
    } catch (err) {
      this.password.set('');
      this.error.set(
        err instanceof HttpErrorResponse && err.status === 401
          ? this.mode() === 'student'
            ? 'Wrong SR code or password.'
            : 'Wrong email or password.'
          : errorMessage(err),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
