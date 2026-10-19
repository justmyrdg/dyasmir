import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { errorCode } from './errors';

const withToken = (req: HttpRequest<unknown>, token: string | null) =>
  token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

/**
 * Adds the access token to API calls; on 401 refreshes once and retries. A 403 PASSWORD_CHANGE_REQUIRED sends the
 * student to choose their own password.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/')) return next(req);
  const auth = inject(AuthService);

  return next(withToken(req, auth.accessToken())).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 403 && errorCode(err) === 'PASSWORD_CHANGE_REQUIRED') {
        auth.passwordChangeRequired();
        return throwError(() => err);
      }
      if (!(err instanceof HttpErrorResponse) || err.status !== 401) return throwError(() => err);
      return auth.refresh().pipe(
        switchMap((token) => {
          if (!token) {
            auth.sessionExpired();
            return throwError(() => err);
          }
          return next(withToken(req, token));
        }),
      );
    }),
  );
};
