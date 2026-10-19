import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';

/**
 * Students choose their own password here. Required right after signing in with the teacher's temporary password
 * (passwordChosen guard and the API's PASSWORD_CHANGE_REQUIRED), optional afterwards from the header link.
 */
@Component({
  selector: 'app-change-password',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="mx-auto max-w-md">
      <div class="card p-6">
        @if (forced()) {
          <h1 class="mb-1 text-2xl font-semibold">Choose your own password</h1>
          <p class="mb-5 text-sm text-slate-600">
            You signed in with the password your teacher gave you. Choose your own before you continue. Your teacher won't be able
            to see it.
          </p>
        } @else {
          <h1 class="mb-5 text-2xl font-semibold">Change password</h1>
        }

        @if (error()) {
          <div class="alert-error mb-4" role="alert">{{ error() }}</div>
        }

        <form (ngSubmit)="submit()" class="space-y-4" novalidate>
          <div>
            <label class="label" for="current">{{ forced() ? 'Password from your teacher' : 'Current password' }}</label>
            <input
              id="current"
              class="input"
              type="password"
              name="current"
              autocomplete="current-password"
              [ngModel]="current()"
              (ngModelChange)="current.set($event)"
            />
          </div>
          <div>
            <label class="label" for="new">New password</label>
            <input
              id="new"
              class="input"
              type="password"
              name="new"
              autocomplete="new-password"
              maxlength="72"
              [ngModel]="password()"
              (ngModelChange)="password.set($event)"
            />
            <ul class="mt-1.5 space-y-0.5 text-xs">
              @for (r of rules(); track r.text) {
                <li [class]="r.ok ? 'font-medium text-emerald-700' : 'text-slate-500'">{{ r.ok ? '✓' : '•' }} {{ r.text }}</li>
              }
            </ul>
          </div>
          <div>
            <label class="label" for="again">Type the new password again</label>
            <input
              id="again"
              class="input"
              type="password"
              name="again"
              autocomplete="new-password"
              maxlength="72"
              [ngModel]="again()"
              (ngModelChange)="again.set($event)"
            />
            @if (again() && again() !== password()) {
              <p class="mt-1 text-xs font-medium text-rose-600">The two passwords don't match.</p>
            }
          </div>
          <button type="submit" class="btn-primary w-full py-2" [disabled]="!canSubmit() || busy()">
            {{ busy() ? 'Saving…' : 'Save password' }}
          </button>
          @if (!forced()) {
            <a routerLink="/student" class="link block text-center text-sm">Cancel</a>
          }
        </form>

        <p class="mt-5 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
          Saving signs you out on your other devices. If you forget it, ask your teacher to reset it.
        </p>
      </div>
    </div>
  `,
})
export class ChangePassword {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly forced = computed(() => this.auth.user()?.mustChangePassword === true);
  protected readonly current = signal('');
  protected readonly password = signal('');
  protected readonly again = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  /** The same rules the server checks, shown as the student types. */
  protected readonly rules = computed(() => {
    const pw = this.password();
    const sr = this.auth.user()?.srCode ?? '';
    const hasSr = !!sr && (pw.includes(sr) || pw.includes(sr.replace('-', '')));
    return [
      { text: 'At least 8 characters', ok: pw.length >= 8 },
      { text: 'Not the same as the current one', ok: pw.length > 0 && pw !== this.current() },
      { text: 'Does not contain your SR code', ok: pw.length > 0 && !hasSr },
    ];
  });
  protected readonly canSubmit = computed(
    () => this.current().length > 0 && this.rules().every((r) => r.ok) && this.again() === this.password(),
  );

  protected async submit() {
    if (!this.canSubmit() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.changePassword(this.current(), this.password());
      await this.router.navigateByUrl('/student');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
