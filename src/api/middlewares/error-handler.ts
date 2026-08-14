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

  // Multer rejects an over-sized upload by throwing, and without this it fell
  // through to the catch-all below as a 500 "INTERNAL_ERROR" — telling the
  // caller we broke, when in fact they sent a file we deliberately refuse.
  // 413 with the real reason is the honest answer, and it is what lets the
  // client show "that picture is too large" instead of "something went wrong".
  if ((err as { name?: string }).name === 'MulterError') {
    const code = (err as { code?: string }).code;
    const message =
      code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large — the maximum is 10MB'
        : ((err as Error).message ?? 'Upload rejected');
    res
      .status(
        code === 'LIMIT_FILE_SIZE' ? StatusCodes.REQUEST_TOO_LONG : StatusCodes.BAD_REQUEST,
      )
      .json(fail(code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_REJECTED', message));
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
