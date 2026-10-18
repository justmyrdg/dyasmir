import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, firstValueFrom, map, Observable, of, shareReplay, tap } from 'rxjs';
import type { Role, Session, User } from './models';

/**
 * Access token lives only in memory. The refresh token is an httpOnly cookie the browser sends to
 * /api/auth/refresh, so a reload restores the session without exposing the token to scripts.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly token = signal<string | null>(null);
  readonly user = signal<User | null>(null);
  readonly isLoggedIn = computed(() => this.user() !== null);
  private refreshing$: Observable<string | null> | null = null;

  accessToken(): string | null {
    return this.token();
  }

  /** Runs once at startup: try to resume the session from the refresh cookie. */
  async init(): Promise<void> {
    await firstValueFrom(this.refresh());
  }

  async login(body: { srCode: string; password: string } | { email: string; password: string }): Promise<User> {
    const session = await firstValueFrom(this.http.post<Session>('/api/auth/login', body, { withCredentials: true }));
    this.apply(session);
    return session.user;
  }

  /** Single in-flight refresh shared by all callers. Emits the new token, or null if the session is gone. */
  refresh(): Observable<string | null> {
    if (!this.refreshing$) {
      this.refreshing$ = this.http.post<Session>('/api/auth/refresh', {}, { withCredentials: true }).pipe(
        tap((s) => this.apply(s)),
        map((s) => s.accessToken),
        catchError(() => {
          this.clear();
          return of(null);
        }),
        finalize(() => (this.refreshing$ = null)),
        shareReplay(1),
      );
    }
    return this.refreshing$;
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}, { withCredentials: true }));
    } catch {
      /* ignore */
    }
    this.clear();
    await this.router.navigateByUrl('/login');
  }

  /** Session ended underneath us (refresh failed): go to login, keeping where they were. */
  sessionExpired() {
    this.clear();
    const returnUrl = this.router.url.startsWith('/login') ? undefined : this.router.url;
    void this.router.navigate(['/login'], { queryParams: returnUrl ? { returnUrl, expired: 1 } : { expired: 1 } });
  }

  homeFor(role: Role | undefined): string {
    return role === 'teacher' ? '/teacher' : role === 'student' ? '/student' : '/login';
  }

  private apply(s: Session) {
    this.token.set(s.accessToken);
    this.user.set(s.user);
  }

  private clear() {
    this.token.set(null);
    this.user.set(null);
  }
}
