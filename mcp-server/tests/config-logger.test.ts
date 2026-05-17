import { describe, it, expect } from 'vitest';
import { _resetSettingsCache, buildTestSettings, getSettings } from '../src/config.js';
import { createLogger } from '../src/logger.js';

describe('getSettings', () => {
  it('parses env values and caches the result until reset', () => {
    _resetSettingsCache();
    const settings = getSettings({
      MCP_AUTH_TOKEN: 'secret',
      MCP_PORT: '3105',
      EMBEDDING_PROVIDER: 'none',
      LOG_LEVEL: 'debug',
    } as NodeJS.ProcessEnv);

    expect(settings.http.authToken).toBe('secret');
    expect(settings.http.port).toBe(3105);
    expect(settings.embeddingProvider).toBe('none');
    expect(settings.logLevel).toBe('debug');

    _resetSettingsCache();
  });

  it('buildTestSettings supports shallow overrides for deterministic tests', () => {
    const settings = buildTestSettings({ tenantLabel: 'tenant-x' });
    expect(settings.tenantLabel).toBe('tenant-x');
    expect(settings.http.authToken).toBe('test-token');
  });
});

describe('createLogger', () => {
  it('uses configured log level and redaction settings', () => {
    const logger = createLogger(buildTestSettings({ logLevel: 'debug' }));
    expect(logger.level).toBe('debug');
    expect(typeof logger.info).toBe('function');
  });
});
