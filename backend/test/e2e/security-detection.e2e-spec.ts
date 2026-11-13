import { JwtService } from '@nestjs/jwt';
import { detect, parseSecurityLog } from '../../src/security/detection';
import { accountId } from '../../src/security/security-events';
import { createTestApp, createUser, login, PASSWORD, resetDatabase, TestContext } from './helpers';

// The attacks of the penetration test, run through the real HTTP stack: each is refused, logged as a security
// event, and raises the alert of its detection rule.
describe('Security events and detection', () => {
  const securityLog: string[] = [];
  let ctx: TestContext;
  let admin: string;
  let seller: string;

  beforeAll(async () => {
    ctx = await createTestApp({ securityLog });
    await resetDatabase(ctx.pool);
    await createUser(ctx.pool, 'admin@test.local', 'ADMIN');
    await createUser(ctx.pool, 'vendedor@test.local', 'SELLER');
    // Signed in before the lockout test locks the admin account from this address.
    admin = await login(ctx, 'admin@test.local');
    seller = await login(ctx, 'vendedor@test.local');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(() => {
    securityLog.length = 0;
  });

  const events = () => parseSecurityLog(securityLog.join('\n'));

  it('logs failed logins by pseudonymous account, never the email or the password', async () => {
    const guessed = 'Correct-Horse-Guess-1';
    for (let i = 0; i < 5; i += 1) {
      await ctx.http().post('/api/auth/login').send({ email: 'admin@test.local', password: guessed }).expect(401);
    }
    await ctx.http().post('/api/auth/login').send({ email: 'admin@test.local', password: PASSWORD }).expect(429);

    expect(events().map((event) => event.event)).toEqual([...Array(5).fill('auth.login_failed'), 'auth.login_locked']);
    expect(events()[0]).toMatchObject({ account: accountId('admin@test.local'), ip: expect.any(String) });
    expect(securityLog.join('\n')).not.toMatch(/admin@test\.local|Correct-Horse|correct-horse/);
    expect(detect(events()).map((alert) => alert.rule)).toEqual(['DET-01']);
  });

  it('records why a token was refused, while the client gets the same 401', async () => {
    const forged = new JwtService({ secret: 'replace-with-output-of-openssl-rand-hex-32' }).sign({ sub: 'x', role: 'ADMIN' });
    const forgedAnswer = await ctx.http().get('/api/reports/margins').set('Authorization', `Bearer ${forged}`).expect(401);
    const expired = new JwtService({ secret: process.env.JWT_SECRET }).sign({ sub: 'x', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) - 60 });
    const expiredAnswer = await ctx.http().get('/api/reports/margins').set('Authorization', `Bearer ${expired}`).expect(401);

    expect(forgedAnswer.body).toEqual(expiredAnswer.body);
    expect(events().map((event) => [event.event, event.reason, event.path])).toEqual([
      ['auth.token_rejected', 'bad_signature', '/api/reports/margins'],
      ['auth.token_rejected', 'expired', '/api/reports/margins'],
    ]);
    expect(detect(events()).map((alert) => [alert.rule, alert.events])).toEqual([['DET-04', 1]]);
  });

  it('records a seller on admin routes, and a script uploaded as a photo', async () => {
    for (const path of ['/api/reports/margins', '/api/audit', '/api/reports/gold-inventory']) {
      await ctx.http().get(path).set('Authorization', `Bearer ${seller}`).expect(403);
    }
    await ctx
      .http()
      .put('/api/pieces/1/photo')
      .set('Authorization', `Bearer ${admin}`)
      .attach('image', Buffer.from('<?php system($_GET["c"]); ?> padding to twelve bytes'), { filename: 'shell.jpg', contentType: 'image/jpeg' })
      .expect(400);

    const denied = events().filter((event) => event.event === 'authz.denied');
    expect(denied).toHaveLength(3);
    expect(denied[0]).toMatchObject({ role: 'SELLER', method: 'GET', path: '/api/reports/margins' });
    expect(events().find((event) => event.event === 'upload.rejected')).toMatchObject({ reason: 'not_an_image', role: 'ADMIN', path: '/api/pieces/1/photo' });
    expect(detect(events()).map((alert) => alert.rule).sort()).toEqual(['DET-05', 'DET-06']);
  });
});
