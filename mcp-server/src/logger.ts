import pino from 'pino';
import type { Logger } from 'pino';
import type { Settings } from './config.js';

export function createLogger(settings: Settings): Logger {
  return pino({
    level: settings.logLevel,
    redact: {
      paths: [
        'settings.http.authToken',
        'settings.pg.password',
        'settings.vllm.apiKey',
        'settings.openai.apiKey',
        '*.password',
        '*.apiKey',
        '*.authToken',
      ],
      censor: '[REDACTED]',
    },
  });
}
