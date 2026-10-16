import pino from 'pino';
import { env, isDev, isTest } from '../config/env';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.newPassword',
      '*.currentPassword',
      '*.email',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: false, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
