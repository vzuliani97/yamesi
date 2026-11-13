# Security events and detection

The [penetration test](https://github.com/vzuliani97/applied-cybersecurity) found 12 issues in NekoBet, Yamesi and
OpsCircuit, all fixed, and its attacks run in CI so a fix cannot quietly regress. A fix stops an attack but does not
tell anyone it happened. This is the other half: Yamesi logs every attempt it refuses as a security event, and seven
rules turn those events into alerts.

## What the API logs

One JSON line on stdout per event, next to the application log, so any log collector can ship it without a new
dependency.

| Event | When | Fields besides `time`, `ip` |
|---|---|---|
| `auth.login_failed` | Wrong email or password (401) | `account` |
| `auth.login_locked` | The 5-failure lockout answered 429 | `account` |
| `auth.login_succeeded` | A login was accepted | `account`, `userId`, `role` |
| `auth.token_rejected` | A private route refused the bearer token (401) | `method`, `path`, `reason` |
| `authz.denied` | A valid token whose role may not do this (403) | `method`, `path`, `userId`, `role` |
| `upload.rejected` | A photo or receipt refused (400 or 413) | `method`, `path`, `userId`, `role`, `reason` |

```json
{"log":"security","time":"2026-11-13T19:37:26.664Z","event":"auth.token_rejected","ip":"172.18.0.1","method":"GET","path":"/api/reports/margins","reason":"bad_signature"}
```

- **The client gets one answer, the log keeps the reason.** Every token problem returns the same 401, so a forger
  learns nothing. The log records which one it was: `missing`, `malformed`, `bad_signature`, `bad_algorithm`
  (`alg: none` or another algorithm than the pinned HS256) or `expired`. A unit test checks each reason against the
  real errors of the JWT library.
- **Accounts are pseudonymous.** `account` is the first 12 hex characters of the SHA-256 of the lowercase email.
  The email field of a failed login sometimes holds a password typed in the wrong box, so the email is never
  written. Anyone who knows an email can compute its id to check whether that account was targeted.
- **No query strings and no bodies.** Paths only: a query can carry search terms.

Code: [`backend/src/security/`](../backend/src/security). The events come from the JWT guard, the login service and
the exception filter.

## The rules

| Rule | Detects | Fires when | Reference | Watches | Severity |
|---|---|---|---|---|---|
| DET-01 | Password guessing | 5 failed or locked logins for one account from one address in 15 min | ATT&CK T1110.001 | ESC-11 | Medium |
| DET-02 | Password spraying | Failed logins on 5 different accounts from one address in 15 min | ATT&CK T1110.003 | (lockout gap) | High |
| DET-03 | A guess that worked | A login accepted after 3 or more failures for that account and address in 15 min | ATT&CK T1110 | ESC-11 | High |
| DET-04 | Forged or tampered token | One token with a bad signature, no signature or another algorithm | ATT&CK T1606 | ESC-01 | High |
| DET-05 | Role probing | 3 refused admin actions by one user in 10 min | OWASP API5:2023 | ESC-05 | Medium |
| DET-06 | Disguised upload | One file uploaded as a photo whose content is not an image | CWE-434, ATT&CK T1505.003 | ESC-06 | Medium |
| DET-07 | Route sweep | 6 different private routes without a token from one address in 5 min | ATT&CK T1595.003 | | Low |

One attack raises one alert: an alert stays open while events keep arriving within one window of the last one.

DET-02 covers a gap in a fix. The lockout of ESC-11 counts failures per email and address, so trying one common
password once on each of many accounts never trips it. The rule counts accounts per address instead.

Code: [`backend/src/security/detection.ts`](../backend/src/security/detection.ts). Tests: 11 unit tests for the rules,
6 for the events, and 3 integration tests that attack the HTTP stack and check the alert each attack raises.

## Run it

```bash
make .env && make up                          # the stack, on localhost only
(cd ../applied-cybersecurity && make attack)  # the penetration test's attacks
node scripts/detection-drill.mjs              # spraying, and a password guessed on the fourth try
make detect                                   # the rules over the API log
```

`scripts/detection-drill.mjs` refuses any target other than localhost.

## Drill, 2026-11-13

A real run against the stack, at commit `f40e888`: the 13 Yamesi attacks of the penetration test, then the drill
script, then `make detect`. Full output: [`detection-drill-2026-11-13.log`](security/detection-drill-2026-11-13.log);
the 40 events: [`detection-drill-2026-11-13.events.jsonl`](security/detection-drill-2026-11-13.events.jsonl).

| Attack | API answer | Events | Alert |
|---|---|---|---|
| 8 private routes without a token | 401 × 8 | `token_rejected` `missing` × 8 | DET-07 |
| A token with `alg: none` and the role changed to admin | 401 | `token_rejected` `bad_algorithm` | DET-04 |
| A real seller token with its role changed to admin | 401 | `token_rejected` `bad_signature` | DET-04 (same alert) |
| An admin token signed with the `.env.example` secret (ESC-01) | 401 | `token_rejected` `bad_signature` | DET-04 (same alert) |
| 5 wrong passwords, then the right one | 401 × 5, then 429 | `login_failed` × 5, `login_locked` | DET-01 |
| A seller on 7 admin actions | 403 × 7 | `authz.denied` × 7 | DET-05 |
| PHP, SVG, PDF and a JPEG-prefixed HTML file as a photo (ESC-06) | 400 × 4 | `upload.rejected` `not_an_image` × 4 | DET-06 |
| One password on 5 accounts, once each | 401 × 5, no lockout | `login_failed` × 5 | DET-02 |
| 3 wrong passwords, then the right one | 401 × 3, then 200 | `login_failed` × 3, `login_succeeded` | DET-03 |
| A photo of 2 MiB + 1 byte | 413 | `upload.rejected` `too_large` | None, by design: anyone can pick a photo that is too big |
| A phone photo with GPS (ESC-04) | 200, stored without GPS | None | None: a legitimate upload |
| A seller reading pieces and lots (ESC-05) | 200, without costs | None | None: the fix is in what the API sends |

Result: 40 events, 7 alerts, 3 high, 3 medium and 1 low. Each attack a rule covers raised that rule's alert, and the
13 attacks still failed against the new code.

Every request came from the Docker gateway, `172.18.0.1`, so the rules saw a single attacker. DET-02 therefore also
counted the account of the lockout test along with the sprayed ones. The unit tests check the rule on its own: five
sprayed accounts are enough, and five addresses that fail once each are not one sprayer.

## What it does not detect

- **A token signed with the real secret.** DET-04 sees forgeries made with a wrong key, such as ESC-01's published
  placeholder tried against a fixed install. Had the real secret leaked, a forged token would verify and look like any
  other. That is why ESC-01's fix prevents instead: the API refuses to start with the published secret. Checking a
  per-user token version on each request would close it; the risk register tracks it.
- **Slow or spread attacks.** Four guesses per account every 15 minutes, or spraying from many addresses, stay under
  the thresholds.
- **What the API does not refuse.** A seller reading what a seller may read, or a valid photo.
- **Anything in real time.** `make detect` reads the running container's log on demand. Nothing pages anyone, and the
  log goes when the container goes.

## False positives to expect

- **DET-04 after rotating `JWT_SECRET`.** Every session still open sends a token signed with the old key. Rotate at
  closing time, or expect one alert per open session.
- **DET-02 behind a shared address.** Several people mistyping their passwords from one office router look like one
  sprayer. With a few staff at one counter it is unlikely, but the threshold would need raising for a larger team.

## Toward production

The JSON lines need a log service that keeps them and evaluates the rules continuously: on AWS, CloudWatch Logs
metric filters with alarms; with Grafana, Loki alert rules. The thresholds and windows above carry over unchanged.
Neither is set up in this repository.
