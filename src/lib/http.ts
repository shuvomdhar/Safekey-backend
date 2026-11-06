export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') =>
  new ApiError(400, code, message);

export const unauthorized = (message = 'Please sign in to continue.') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const notFound = (message = 'We could not find that resource.') =>
  new ApiError(404, 'NOT_FOUND', message);

export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);
