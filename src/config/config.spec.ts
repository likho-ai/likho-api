import { DEV_SESSION_SECRET, loadConfig } from './config.js';

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
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_EMAIL: 'a@b.co' })).toThrow('go together');
    expect(() => loadConfig({ HTTP_PORT: 'http' })).toThrow('HTTP_PORT');
  });
});
