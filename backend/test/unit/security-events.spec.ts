import { JwtService } from '@nestjs/jwt';
import { accountId, SecurityEvents, tokenRejection } from '../../src/security/security-events';

describe('security events', () => {
  it('writes one JSON line per event, with a pseudonymous account and no email', () => {
    const lines: string[] = [];
    new SecurityEvents((line) => lines.push(line)).record('auth.login_failed', { ip: '203.0.113.7', account: accountId('Vendedor@Yamesi.local ') });

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({ log: 'security', event: 'auth.login_failed', ip: '203.0.113.7', account: accountId('vendedor@yamesi.local') });
    expect(event.account).toMatch(/^[0-9a-f]{12}$/);
    expect(lines[0]).not.toContain('yamesi.local');
    expect(Number.isNaN(Date.parse(event.time))).toBe(false);
  });
});

describe('token rejection reasons', () => {
  const secret = 'a'.repeat(64);
  const jwt = new JwtService({ secret, verifyOptions: { algorithms: ['HS256'] } });
  const payload = { sub: 'u1', role: 'SELLER' };
  const reasonFor = async (token: string) => jwt.verifyAsync(token).then(() => 'accepted', tokenRejection);
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it('accepts a valid token', async () => {
    expect(await reasonFor(jwt.sign(payload))).toBe('accepted');
  });

  it('tells a forged signature from an expired token', async () => {
    expect(await reasonFor(new JwtService({ secret: 'b'.repeat(64) }).sign(payload))).toBe('bad_signature');
    expect(await reasonFor(jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }))).toBe('expired');
  });

  it('flags "alg: none" and other algorithms', async () => {
    expect(await reasonFor(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`)).toBe('bad_algorithm');
    expect(await reasonFor(jwt.sign(payload, { algorithm: 'HS512' }))).toBe('bad_algorithm');
  });

  it('flags tokens that do not parse', async () => {
    expect(await reasonFor('not-a-token')).toBe('malformed');
    expect(await reasonFor(`${b64({ alg: 'HS256' })}.%%%.sig`)).toBe('malformed');
  });

  it('turns a tampered payload into a bad signature', async () => {
    const [head, , signature] = jwt.sign(payload).split('.');
    expect(await reasonFor(`${head}.${b64({ ...payload, role: 'ADMIN' })}.${signature}`)).toBe('bad_signature');
  });
});
