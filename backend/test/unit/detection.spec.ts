import { report } from '../../src/security/detect-cli';
import { Alert, detect, parseSecurityLog, RULES } from '../../src/security/detection';
import { SecurityEvent, SecurityEventFields, SecurityEventName } from '../../src/security/security-events';

const START = Date.parse('2026-11-13T15:00:00Z');
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();
const event = (name: SecurityEventName, seconds: number, fields: Partial<SecurityEventFields> = {}): SecurityEvent => ({
  log: 'security',
  time: at(seconds),
  event: name,
  ip: '203.0.113.7',
  ...fields,
});
const failures = (count: number, fields: Partial<SecurityEventFields> = {}, every = 10) =>
  Array.from({ length: count }, (_, i) => event('auth.login_failed', i * every, { account: 'aaaaaaaaaaaa', ...fields }));
const rules = (alerts: Alert[]) => alerts.map((alert) => alert.rule);

describe('detection rules', () => {
  it('raises nothing for a typo or an expired session', () => {
    const normal = [
      ...failures(2),
      event('auth.login_succeeded', 30, { account: 'aaaaaaaaaaaa', userId: 'u1', role: 'SELLER' }),
      ...Array.from({ length: 10 }, (_, i) => event('auth.token_rejected', 60 + i, { reason: 'expired', method: 'GET', path: '/api/pieces' })),
      event('authz.denied', 90, { userId: 'u1', role: 'SELLER', method: 'GET', path: '/api/audit' }),
      event('upload.rejected', 120, { userId: 'u2', role: 'ADMIN', reason: 'too_large' }),
    ];
    expect(detect(normal)).toEqual([]);
  });

  it('DET-01: five failed logins on one account, and the lockout that follows, are one alert', () => {
    expect(detect(failures(4))).toEqual([]);
    const alerts = detect([...failures(5), event('auth.login_locked', 60, { account: 'aaaaaaaaaaaa' })]);
    expect(rules(alerts)).toEqual(['DET-01']);
    expect(alerts[0]).toMatchObject({ severity: 'medium', events: 6, finding: 'ESC-11', detail: 'login_failed (5); login_locked' });
  });

  it('DET-02: one address failing on five accounts is spraying, which the per-account lockout never sees', () => {
    const spray = Array.from({ length: 5 }, (_, i) => event('auth.login_failed', i, { account: `acct${i}` }));
    const alerts = detect(spray);
    expect(rules(alerts)).toEqual(['DET-02']);
    expect(alerts[0].key).toBe('ip 203.0.113.7');
    // The same five failures from five addresses are not one sprayer.
    expect(detect(spray.map((e, i) => ({ ...e, ip: `198.51.100.${i}` })))).toEqual([]);
  });

  it('DET-03: a login accepted after three failures on the same account', () => {
    const success = event('auth.login_succeeded', 40, { account: 'aaaaaaaaaaaa', userId: 'u1', role: 'ADMIN' });
    expect(rules(detect([...failures(3), success]))).toEqual(['DET-03']);
    // Failures from 20 minutes before do not count.
    expect(detect([...failures(3, {}, 1), { ...success, time: at(20 * 60) }])).toEqual([]);
  });

  it('DET-04: one forged or unsigned token is enough', () => {
    const forged = event('auth.token_rejected', 0, { reason: 'bad_signature', method: 'GET', path: '/api/reports/margins' });
    const unsigned = event('auth.token_rejected', 5, { reason: 'bad_algorithm', method: 'GET', path: '/api/reports/margins' });
    const alerts = detect([forged, unsigned]);
    expect(rules(alerts)).toEqual(['DET-04']);
    expect(alerts[0]).toMatchObject({ severity: 'high', events: 2, finding: 'ESC-01', detail: 'bad_signature on GET /api/reports/margins; bad_algorithm on GET /api/reports/margins' });
  });

  it('DET-05: three admin actions refused to one user within ten minutes', () => {
    const denied = (seconds: number) => event('authz.denied', seconds, { userId: 'u1', role: 'SELLER', method: 'GET', path: '/api/audit' });
    expect(rules(detect([denied(0), denied(30), denied(60)]))).toEqual(['DET-05']);
    expect(detect([denied(0), denied(400), denied(800)])).toEqual([]);
  });

  it('DET-06: content that is not an image, uploaded as a photo', () => {
    const alerts = detect([event('upload.rejected', 0, { userId: 'u2', role: 'ADMIN', reason: 'not_an_image', method: 'PUT', path: '/api/pieces/3/photo' })]);
    expect(rules(alerts)).toEqual(['DET-06']);
    expect(alerts[0].key).toBe('user u2 (ADMIN)');
  });

  it('DET-07: six different private routes without a token, not one route called often', () => {
    const missing = (seconds: number, path: string) => event('auth.token_rejected', seconds, { reason: 'missing', method: 'GET', path });
    const sweep = ['/api/auth/me', '/api/pieces', '/api/lots', '/api/invoices', '/api/expenses', '/api/audit'].map((path, i) => missing(i, path));
    expect(rules(detect(sweep))).toEqual(['DET-07']);
    expect(detect(Array.from({ length: 10 }, (_, i) => missing(i, '/api/auth/me')))).toEqual([]);
  });

  it('keeps one alert per attack, and opens a new one after a quiet window', () => {
    const first = failures(20, {}, 30); // ten minutes of guessing
    const later = failures(5).map((e) => ({ ...e, time: at(2 * 3600 + Date.parse(e.time) / 1000 - START / 1000) }));
    const alerts = detect([...later, ...first]); // unsorted input
    expect(alerts.map((alert) => [alert.rule, alert.events])).toEqual([
      ['DET-01', 20],
      ['DET-01', 5],
    ]);
  });

  it('orders alerts by severity, then time', () => {
    const alerts = detect([
      ...failures(5, { account: 'bbbbbbbbbbbb' }),
      event('auth.token_rejected', 100, { reason: 'bad_signature', method: 'GET', path: '/api/audit' }),
    ]);
    expect(alerts.map((alert) => alert.severity)).toEqual(['high', 'medium']);
  });

  it('reads security events out of a mixed log and prints a report', () => {
    const log = [
      '[Nest] 1  - 11/13/2026, 3:00:00 PM     LOG [Bootstrap] Yamesi API listening on port 3000',
      `backend-1  | ${JSON.stringify(event('auth.token_rejected', 0, { reason: 'bad_signature', method: 'GET', path: '/api/audit' }))}`,
      '{"log":"security","time":"2026-11-13T15:00:01Z","event":"auth.login_fa', // cut off mid-write
      JSON.stringify({ log: 'other', time: at(2), event: 'x' }),
    ].join('\n');
    const events = parseSecurityLog(log);
    expect(events).toHaveLength(1);

    const text = report(events.length, detect(events));
    expect(text).toContain(`1 security events, 1 alerts (${RULES.length} rules)`);
    expect(text).toContain('HIGH   DET-04  Forged or tampered access token');
    expect(text).toContain('watches ESC-01');
  });
});
