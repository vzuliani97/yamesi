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

describe('public demo configuration', () => {
  const env = {
    DATABASE_URL: 'postgres://localhost/test',
    JWT_SECRET: 'a'.repeat(64),
    PUBLIC_DEMO: 'true',
    DEMO_DATABASE_CONFIRMATION: 'yamesi_demo',
    CORS_ORIGIN: 'https://yamesi-core-demo.netlify.app',
  };

  it('accepts an exact https origin and a named demo database', () => {
    expect(loadConfig(env).PUBLIC_DEMO).toBe(true);
  });

  it('requires the demo database name, an exact https origin and the assistant off', () => {
    expect(() => loadConfig({ ...env, DEMO_DATABASE_CONFIRMATION: undefined })).toThrow(/DEMO_DATABASE_CONFIRMATION/);
    expect(() => loadConfig({ ...env, CORS_ORIGIN: 'http://localhost:8083' })).toThrow(/CORS_ORIGIN/);
    expect(() => loadConfig({ ...env, CORS_ORIGIN: 'https://*.netlify.app' })).toThrow(/CORS_ORIGIN/);
    expect(() => loadConfig({ ...env, ASSISTANT_ENABLED: 'true' })).toThrow(/ASSISTANT_ENABLED/);
  });

  it('allows the boot reset only in demo mode', () => {
    expect(() => loadConfig({ DATABASE_URL: env.DATABASE_URL, JWT_SECRET: env.JWT_SECRET, DEMO_RESET_ON_BOOT: 'true' })).toThrow(/DEMO_RESET_ON_BOOT/);
    expect(loadConfig({ ...env, DEMO_RESET_ON_BOOT: 'true' }).DEMO_RESET_ON_BOOT).toBe(true);
  });

  it('needs the public API address to build file links from PostgreSQL', () => {
    expect(() => loadConfig({ ...env, STORAGE_DRIVER: 'postgres' })).toThrow(/PUBLIC_API_URL/);
    expect(loadConfig({ ...env, STORAGE_DRIVER: 'postgres', PUBLIC_API_URL: 'https://api.example.com' }).STORAGE_DRIVER).toBe('postgres');
  });
});
