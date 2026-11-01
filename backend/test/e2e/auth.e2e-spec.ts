import { createTestApp, createUser, PASSWORD, resetDatabase, TestContext } from './helpers';

describe('Login', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    await createUser(ctx.pool, 'admin@test.local', 'ADMIN');
    await createUser(ctx.pool, 'vendedor@test.local', 'SELLER');
  });

  it('locks one email from one address after 5 failed logins, even for the right password', async () => {
    const attempt = (email: string, password: string) => ctx.http().post('/api/auth/login').send({ email, password });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt('vendedor@test.local', 'wrong-password')).status).toBe(401);
    }
    const locked = await attempt('vendedor@test.local', PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

    // Another account from the same address still signs in.
    expect((await attempt('admin@test.local', PASSWORD)).status).toBe(200);
  });
});
