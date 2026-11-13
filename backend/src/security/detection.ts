import { SecurityEvent, SecurityEventName } from './security-events';

/**
 * Detection rules over the security events. Each rule names the attack it looks for (MITRE ATT&CK where a
 * technique fits, otherwise OWASP or CWE) and the finding of the penetration test it watches, so an attack on a
 * control that was fixed is still seen, not only blocked.
 */
export type Severity = 'low' | 'medium' | 'high';

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  reference: string;
  /** Finding of the penetration test (applied-cybersecurity) whose attack this rule watches, if any. */
  finding?: string;
}

export interface Alert {
  rule: string;
  title: string;
  severity: Severity;
  reference: string;
  finding?: string;
  /** What the events were grouped by: an address, an address and account, or a user. */
  key: string;
  first: string;
  last: string;
  events: number;
  /** Distinct values behind the alert: accounts, paths or reasons, with how often each appeared. */
  detail: string;
}

interface ThresholdRule extends Rule {
  events: SecurityEventName[];
  where?: (event: SecurityEvent) => boolean;
  groupBy: (event: SecurityEvent) => string;
  windowMs: number;
  /** Events needed inside the window; with `distinct`, distinct values needed instead. */
  threshold: number;
  distinct?: (event: SecurityEvent) => string;
  /** The field summarized in Alert.detail. */
  describe: (event: SecurityEvent) => string;
}

const MINUTE = 60_000;
const byAddress = (event: SecurityEvent) => `ip ${event.ip}`;
const byAccount = (event: SecurityEvent) => `ip ${event.ip}, account ${event.account}`;
const byUser = (event: SecurityEvent) => `user ${event.userId} (${event.role})`;

export const THRESHOLD_RULES: ThresholdRule[] = [
  {
    id: 'DET-01',
    title: 'Password guessing against one account',
    severity: 'medium',
    reference: 'ATT&CK T1110.001 Password Guessing',
    finding: 'ESC-11',
    // Five failures is where the lockout starts; the alert says someone reached it.
    events: ['auth.login_failed', 'auth.login_locked'],
    groupBy: byAccount,
    windowMs: 15 * MINUTE,
    threshold: 5,
    describe: (event) => event.event.replace('auth.', ''),
  },
  {
    id: 'DET-02',
    title: 'Password spraying: one address, many accounts',
    severity: 'high',
    reference: 'ATT&CK T1110.003 Password Spraying',
    // The lockout counts per email and address, so one password tried once on many accounts never trips it.
    events: ['auth.login_failed'],
    groupBy: byAddress,
    windowMs: 15 * MINUTE,
    threshold: 5,
    distinct: (event) => event.account ?? '',
    describe: (event) => `account ${event.account}`,
  },
  {
    id: 'DET-04',
    title: 'Forged or tampered access token',
    severity: 'high',
    reference: 'ATT&CK T1606 Forge Web Credentials',
    finding: 'ESC-01',
    // A real client never sends a bad signature, so one is enough. Expected false positive: after the JWT secret
    // is rotated, every token still open was signed with the old one.
    events: ['auth.token_rejected'],
    where: (event) => event.reason === 'bad_signature' || event.reason === 'bad_algorithm',
    groupBy: byAddress,
    windowMs: 60 * MINUTE,
    threshold: 1,
    describe: (event) => `${event.reason} on ${event.method} ${event.path}`,
  },
  {
    id: 'DET-05',
    title: 'Role probing: repeated attempts at admin actions',
    severity: 'medium',
    reference: 'OWASP API5:2023 Broken Function Level Authorization',
    finding: 'ESC-05',
    events: ['authz.denied'],
    groupBy: byUser,
    windowMs: 10 * MINUTE,
    threshold: 3,
    describe: (event) => `${event.method} ${event.path}`,
  },
  {
    id: 'DET-06',
    title: 'Disguised file uploaded as a photo',
    severity: 'medium',
    reference: 'CWE-434 Unrestricted Upload; ATT&CK T1505.003 Web Shell (attempt)',
    finding: 'ESC-06',
    // The app's own screens only offer image files, so content that is not an image was crafted.
    events: ['upload.rejected'],
    where: (event) => event.reason === 'not_an_image',
    groupBy: (event) => (event.userId ? byUser(event) : byAddress(event)),
    windowMs: 60 * MINUTE,
    threshold: 1,
    describe: (event) => `${event.reason} on ${event.method} ${event.path}`,
  },
  {
    id: 'DET-07',
    title: 'Sweep of private routes without a token',
    severity: 'low',
    reference: 'ATT&CK T1595.003 Wordlist Scanning',
    // Logged out, the web app calls no private route; an expired session shows as "expired", not "missing".
    events: ['auth.token_rejected'],
    where: (event) => event.reason === 'missing',
    groupBy: byAddress,
    windowMs: 5 * MINUTE,
    threshold: 6,
    distinct: (event) => `${event.method} ${event.path}`,
    describe: (event) => `${event.method} ${event.path}`,
  },
];

export const SEQUENCE_RULE: Rule = {
  id: 'DET-03',
  title: 'Successful login after repeated failures',
  severity: 'high',
  reference: 'ATT&CK T1110 Brute Force',
  finding: 'ESC-11',
};
const SEQUENCE_FAILURES = 3;
const SEQUENCE_WINDOW_MS = 15 * MINUTE;

export const RULES: Rule[] = [...THRESHOLD_RULES, SEQUENCE_RULE].sort((a, b) => a.id.localeCompare(b.id));

/** Alerts raised by the events, ordered by severity, then time. Events need not be sorted. */
export function detect(input: SecurityEvent[]): Alert[] {
  const events = input.filter((event) => !Number.isNaN(Date.parse(event.time))).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const alerts = [...THRESHOLD_RULES.flatMap((rule) => applyThreshold(rule, events)), ...applySequence(events)];
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.first.localeCompare(b.first) || a.rule.localeCompare(b.rule));
}

function applyThreshold(rule: ThresholdRule, events: SecurityEvent[]): Alert[] {
  const groups = new Map<string, SecurityEvent[]>();
  for (const event of events) {
    if (!rule.events.includes(event.event) || (rule.where && !rule.where(event))) continue;
    const key = rule.groupBy(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  const alerts: Alert[] = [];
  for (const [key, group] of groups) {
    let window: SecurityEvent[] = [];
    let open: { alert: Alert; members: SecurityEvent[] } | undefined;
    for (const event of group) {
      const at = Date.parse(event.time);
      window = [...window.filter((earlier) => at - Date.parse(earlier.time) < rule.windowMs), event];

      // An alert stays open while events keep coming within one window of the last one: one attack, one alert.
      if (open && at - Date.parse(open.alert.last) < rule.windowMs) {
        open.members.push(event);
        open.alert.last = event.time;
        open.alert.events += 1;
        open.alert.detail = summarize(open.members, rule.describe);
        continue;
      }
      open = undefined;

      const reached = rule.distinct ? new Set(window.map(rule.distinct)).size : window.length;
      if (reached >= rule.threshold) {
        const members = [...window];
        const alert: Alert = {
          ...pick(rule),
          key,
          first: members[0].time,
          last: event.time,
          events: members.length,
          detail: summarize(members, rule.describe),
        };
        alerts.push(alert);
        open = { alert, members };
      }
    }
  }
  return alerts;
}

/** DET-03: a login accepted for an account and address that failed at least 3 times in the 15 minutes before. */
function applySequence(events: SecurityEvent[]): Alert[] {
  const failures = new Map<string, number[]>();
  const alerts: Alert[] = [];
  for (const event of events) {
    const key = byAccount(event);
    const at = Date.parse(event.time);
    if (event.event === 'auth.login_failed') {
      failures.set(key, [...(failures.get(key) ?? []), at]);
    } else if (event.event === 'auth.login_succeeded') {
      const recent = (failures.get(key) ?? []).filter((failedAt) => at - failedAt < SEQUENCE_WINDOW_MS);
      if (recent.length >= SEQUENCE_FAILURES) {
        alerts.push({
          ...pick(SEQUENCE_RULE),
          key,
          first: new Date(recent[0]).toISOString(),
          last: event.time,
          events: recent.length + 1,
          detail: `${recent.length} failures, then a login as user ${event.userId} (${event.role})`,
        });
      }
      failures.delete(key);
    }
  }
  return alerts;
}

function pick(rule: Rule): Pick<Alert, 'rule' | 'title' | 'severity' | 'reference' | 'finding'> {
  return { rule: rule.id, title: rule.title, severity: rule.severity, reference: rule.reference, ...(rule.finding ? { finding: rule.finding } : {}) };
}

function summarize(events: SecurityEvent[], describe: (event: SecurityEvent) => string): string {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(describe(event), (counts.get(describe(event)) ?? 0) + 1);
  return [...counts].map(([value, count]) => (count > 1 ? `${value} (${count})` : value)).join('; ');
}

/** Security events found in log text: one JSON object per line, other lines ignored. */
export function parseSecurityLog(text: string): SecurityEvent[] {
  const events: SecurityEvent[] = [];
  for (const line of text.split('\n')) {
    const start = line.indexOf('{"log":"security"');
    if (start === -1) continue;
    try {
      const event = JSON.parse(line.slice(start)) as SecurityEvent;
      if (event.log === 'security' && typeof event.event === 'string' && typeof event.time === 'string') events.push(event);
    } catch {
      // A line cut off mid-write is skipped, not fatal.
    }
  }
  return events;
}
