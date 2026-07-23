import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { StatusCodes } from 'http-status-codes';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { apiRouter } from '@/api/routes/index.js';
import { errorHandler, notFoundHandler } from '@/api/middlewares/error-handler.js';
import { ok } from '@common/utils/api-response.js';

/**
 * Builds and configures the Express application.
 * Kept separate from the HTTP server so it can be imported directly in tests.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.cors.origins }));
  app.use(
    express.json({
      limit: '1mb',
      // Stash raw bytes so webhook handlers can verify HMAC signatures.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(pinoHttp({ logger }));

  // Liveness / readiness probe (unversioned, outside the API prefix).
  app.get('/health', (_req, res) => {
    res.status(StatusCodes.OK).json(ok({ status: 'healthy', uptime: process.uptime() }));
  });

  app.use(config.server.apiPrefix, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
