import { HttpErrorResponse } from '@angular/common/http';

export function errorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server. Check your internet connection.';
    const body = err.error as { message?: string; details?: unknown } | null;
    if (body?.message) {
      if (Array.isArray(body.details) && body.details.every((d) => typeof d === 'string')) {
        return `${body.message}: ${(body.details as string[]).join('; ')}`;
      }
      return body.message;
    }
  }
  return fallback;
}

export function errorCode(err: unknown): string | undefined {
  return err instanceof HttpErrorResponse ? (err.error as { code?: string } | null)?.code : undefined;
}

export function errorDetails<T>(err: unknown): T | undefined {
  return err instanceof HttpErrorResponse ? ((err.error as { details?: T } | null)?.details ?? undefined) : undefined;
}
