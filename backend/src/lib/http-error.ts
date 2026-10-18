export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, 'BAD_REQUEST', details);
export const unauthorized = (message = 'Not authenticated') => new HttpError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'Forbidden') => new HttpError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Not found') => new HttpError(404, message, 'NOT_FOUND');
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, message, code);
