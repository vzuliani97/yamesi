import { loadConfig } from '../../src/config';

describe('configuration', () => {
  const env = { DATABASE_URL: 'postgres://localhost/test', JWT_SECRET: 'a'.repeat(64) };

  it('accepts a real secret', () => {
    expect(loadConfig(env).JWT_SECRET).toBe('a'.repeat(64));
  });

  it('refuses the placeholder secrets published in .env.example', () => {
    expect(() => loadConfig({ ...env, JWT_SECRET: 'replace-with-output-of-openssl-rand-hex-32' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...env, S3_SECRET_KEY: 'replace-with-a-long-random-secret' })).toThrow(/S3_SECRET_KEY/);
  });
});
