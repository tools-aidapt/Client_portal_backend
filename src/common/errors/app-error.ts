import { StatusCodes } from 'http-status-codes';

/**
 * Base application error. All operational (expected) errors should extend this
 * so the global error handler can distinguish them from unexpected crashes.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number = StatusCodes.INTERNAL_SERVER_ERROR,
    code = 'INTERNAL_ERROR',
    details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, StatusCodes.BAD_REQUEST, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, StatusCodes.UNAUTHORIZED, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, StatusCodes.FORBIDDEN, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, StatusCodes.NOT_FOUND, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, StatusCodes.CONFLICT, 'CONFLICT', details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, StatusCodes.UNPROCESSABLE_ENTITY, 'VALIDATION_ERROR', details);
  }
}
