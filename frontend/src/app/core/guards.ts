import { inject } from '@angular/core';
import { CanActivateChildFn, CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import type { Role } from './models';

/** Route guard: logged in with the given role (the API enforces this too; this only keeps the UI tidy). */
export function roleGuard(role: Role): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const user = auth.user();
    if (!user) return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    if (user.role !== role) return router.createUrlTree([auth.homeFor(user.role)]);
    return true;
  };
}

/** Student pages: someone still on the teacher's temporary password goes to choose their own first. */
export const passwordChosen: CanActivateChildFn = (_route, state) => {
  const auth = inject(AuthService);
  if (!auth.user()?.mustChangePassword || state.url.startsWith('/student/password')) return true;
  return inject(Router).createUrlTree(['/student/password']);
};

export const homeRedirect: CanActivateFn = () => {
  const auth = inject(AuthService);
  return inject(Router).createUrlTree([auth.homeFor(auth.user()?.role)]);
};

export const guestOnly: CanActivateFn = () => {
  const auth = inject(AuthService);
  const user = auth.user();
  return user ? inject(Router).createUrlTree([auth.homeFor(user.role)]) : true;
};
