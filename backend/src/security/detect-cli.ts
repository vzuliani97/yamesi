import { readFileSync } from 'node:fs';
import { Alert, detect, parseSecurityLog, RULES } from './detection';

/**
 * Reads the API log on stdin and prints the alerts the detection rules raise:
 *   docker compose logs --no-log-prefix backend | docker compose exec -T backend node dist/security/detect-cli.js
 * `--json` prints the alerts as JSON instead of a report.
 */
function main(): void {
  const events = parseSecurityLog(readFileSync(0, 'utf8'));
  const alerts = detect(events);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(alerts, null, 2)}\n`);
    return;
  }
  process.stdout.write(report(events.length, alerts));
}

export function report(eventCount: number, alerts: Alert[]): string {
  const lines = [`${eventCount} security events, ${alerts.length} alerts (${RULES.length} rules)`, ''];
  for (const alert of alerts) {
    lines.push(`${alert.severity.toUpperCase().padEnd(6)} ${alert.rule}  ${alert.title}`);
    lines.push(`       ${alert.key} · ${alert.events} events · ${alert.first} → ${alert.last}`);
    lines.push(`       ${alert.reference}${alert.finding ? ` · watches ${alert.finding}` : ''}`);
    lines.push(`       ${alert.detail}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  main();
}
