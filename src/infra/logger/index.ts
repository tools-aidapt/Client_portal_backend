import { pino } from 'pino';
import { config, env } from '@config/index.js';

const isDev = config.env === 'development';

export const logger = pino({
  level: config.logger.level,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
  base: { env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
