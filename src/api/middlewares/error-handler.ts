import type { ErrorRequestHandler, RequestHandler } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ZodError } from 'zod';
import { AppError } from '@common/errors/index.js';
import { fail } from '@common/utils/api-response.js';
import { logger } from '@infra/logger/index.js';
import { isProduction } from '@config/env.js';

/** 404 handler for unmatched routes. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(StatusCodes.NOT_FOUND)
    .json(fail('NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
};

/** Global error handler — must be registered last. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res
      .status(StatusCodes.UNPROCESSABLE_ENTITY)
      .json(fail('VALIDATION_ERROR', 'Validation failed', err.flatten()));
    return;
  }

  if (err instanceof AppError) {
    if (!err.isOperational) logger.error({ err }, 'Non-operational error');
    res.status(err.statusCode).json(fail(err.code, err.message, err.details));
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res
    .status(StatusCodes.INTERNAL_SERVER_ERROR)
    .json(
      fail(
        'INTERNAL_ERROR',
        isProduction ? 'Something went wrong' : String((err as Error)?.message ?? err),
      ),
    );
};
