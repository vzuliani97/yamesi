#!/usr/bin/env node
// Detection drill: two login attacks the per-account lockout does not stop, against the LOCAL stack only.
// Run the penetration test's attack suite first (applied-cybersecurity: make attack), then this, then `make detect`.
// Node's standard library only. Usage: node scripts/detection-drill.mjs [api base, default http://localhost:8083/api]
import { readFileSync } from 'node:fs';

const api = process.argv[2] ?? 'http://localhost:8083/api';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(api)) {
  console.error(`Refusing to run against ${api}: this drill is for the local stack only.`);
  process.exit(1);
}
const demoPassword = readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^DEMO_PASSWORD=(.*)$/m)?.[1];
if (!demoPassword) {
  console.error('DEMO_PASSWORD not found in .env: run make .env and make up first.');
  process.exit(1);
}

async function login(email, password) {
  const response = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  console.log(`  POST /auth/login ${email.padEnd(28)} -> ${response.status}`);
  return response.status;
}

console.log('1. Password spraying: one common password, once on each of five accounts (DET-02)');
for (const email of ['admin@yamesi.local', 'ventas@yamesi.local', 'gerencia@yamesi.local', 'contabilidad@yamesi.local', 'tesoreria@yamesi.local']) {
  await login(email, 'Yamesi2026!');
}

console.log('2. A password guessed on the fourth try: three wrong ones, then the right one (DET-03)');
for (const guess of ['yamesi123', 'Yamesi2025', 'joyeria2026']) {
  await login('vendedor@yamesi.local', guess);
}
const last = await login('vendedor@yamesi.local', demoPassword);
console.log(last === 200 ? 'Done. Now run: make detect' : `Unexpected ${last} on the last login.`);
