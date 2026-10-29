// Defaults for running e2e tests locally against the throwaway database from `make test-db`.
// docker-compose overrides these when tests run in a container.
process.env.DATABASE_URL ??= 'postgres://yamesi:yamesi_test@localhost:55433/yamesi_test';
process.env.JWT_SECRET ??= 'e2e-test-secret-that-is-at-least-32-chars';
process.env.STORAGE_DRIVER ??= 'memory';
process.env.BUSINESS_TIMEZONE ??= 'America/Bogota';
process.env.ASSISTANT_ENABLED ??= 'true';
