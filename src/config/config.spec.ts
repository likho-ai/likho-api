import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_SESSION_SECRET, loadConfig } from './config.js';
import { withEnvFiles } from './env-files.js';

describe('config', () => {
  it('has defaults for the local stack', () => {
    const config = loadConfig({});
    expect(config.HTTP_PORT).toBe(4000);
    expect(config.DATABASE_URL).toContain('5433/likho_api');
    expect(config.CONSUMERS_ENABLED).toBe(true);
    expect(config.SESSION_SECRET).toBe(DEV_SESSION_SECRET);
  });

  it('reads the environment', () => {
    const config = loadConfig({ HTTP_PORT: '5000', CONSUMERS_ENABLED: 'false', SESSION_DAYS: '7' });
    expect(config.HTTP_PORT).toBe(5000);
    expect(config.CONSUMERS_ENABLED).toBe(false);
    expect(config.SESSION_DAYS).toBe(7);
  });

  it('refuses production without its own secret, and half a bootstrap admin', () => {
    expect(() => loadConfig({ LIKHO_ENV: 'production' })).toThrow('SESSION_SECRET');
    expect(() => loadConfig({ LIKHO_ENV: 'staging' })).toThrow('SESSION_SECRET');
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_EMAIL: 'a@b.co' })).toThrow('go together');
    expect(() => loadConfig({ HTTP_PORT: 'http' })).toThrow('HTTP_PORT');
  });
});

describe('env files', () => {
  it('reads the files of the environment in order; the real environment wins', () => {
    const folder = mkdtempSync(join(tmpdir(), 'likho-env-'));
    writeFileSync(join(folder, '.env'), ['HTTP_PORT=1', 'LOG_LEVEL=debug # a comment', ''].join('\n'));
    writeFileSync(join(folder, '.env.local'), 'HTTP_PORT=2\n');
    writeFileSync(join(folder, '.env.staging'), ['HTTP_PORT=3', "SESSION_DAYS='33'", ''].join('\n'));
    writeFileSync(
      join(folder, '.env.staging.local'),
      ['HTTP_PORT=4', 'CONSUMER_GROUP="group-7"', 'SESSION_SECRET=a-staging-secret-value', ''].join('\n'),
    );
    writeFileSync(join(folder, '.env.production'), 'HTTP_PORT=5\n');

    const { env, read } = withEnvFiles({ LIKHO_ENV: 'staging', SESSION_DAYS: '99' }, folder);
    expect(read).toEqual(['.env', '.env.local', '.env.staging', '.env.staging.local']);
    const config = loadConfig(env);
    expect(config.HTTP_PORT).toBe(4);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.SESSION_DAYS).toBe(99);
    expect(config.CONSUMER_GROUP).toBe('group-7');
  });

  it('reads nothing when there are no files', () => {
    const folder = mkdtempSync(join(tmpdir(), 'likho-env-'));
    expect(withEnvFiles({ LIKHO_ENV: 'production' }, folder).read).toEqual([]);
  });
});
