# Public demo deployment

A public, free demo of Yamesi Core with synthetic data. It is a demonstration, not a production environment:
the documented production design (AWS with Terraform, in [OpsCircuit](https://github.com/vzuliani97/opscircuit))
was never applied, and nothing here stands in for it.

## Architecture

```text
Browser ──HTTPS──> Netlify (frontend/, static build, CDN, security headers)
   │
   └──HTTPS──> Render free web service (backend/Dockerfile, production stage)
                   │
                   └──TLS──> Neon free PostgreSQL (data and, for the demo, the files)
```

| Part | Where | Notes |
|---|---|---|
| Frontend | Netlify, site `yamesi` (https://yamesi.netlify.app) | Built from `frontend/` by `netlify.toml`; calls the API at `VITE_API_BASE_URL` |
| API | Render, web service `yamesi-api-demo` | The existing production image; listens on Render's `PORT`; health check `/health` |
| Database | Neon, its own project and a database named for the demo | Direct (non-pooled) connection string: migrations take a session advisory lock |
| Files (photos, receipts, invoice PDFs) | The same Neon database, table `stored_files` | `STORAGE_DRIVER=postgres`: the free plan has no S3-compatible store without a card. Links are HMAC-signed and expire after 300 s, like S3 presigned URLs. Local and AWS keep S3 |

Not deployed: the local AI assistant (Ollama), RustFS, OpsCircuit and the AWS Terraform.

## Free-plan limits (checked 2026-11-04)

- **Netlify Free:** 300 credits a month, with no card. A production deploy costs 15 credits, so `netlify.toml`
  rebuilds only when `frontend/` or the file itself changes. When the credits run out, the site pauses until
  the next month; nothing is charged.
- **Render Free:** no card. The service spins down after 15 minutes without traffic, and the next request
  wakes it in about a minute. That is why the frontend shows a start-up screen. Free services share 750
  instance-hours a month per workspace; a sleeping service uses none. The filesystem is ephemeral, so no state
  lives on it.
- **Neon Free:** no card. 100 CU-hours of compute and 1 GB of storage per project; compute suspends after
  5 minutes idle and resumes on the next query. Over the limit the project is suspended, not billed.

No keep-alive pings are configured. A cold start is the accepted cost of a free demo.

## Demo mode and its safeguards

| Setting | Effect |
|---|---|
| `PUBLIC_DEMO=true` | `CORS_ORIGIN` must be one exact `https` origin; the assistant must be off; requests are limited per client address (`RATE_LIMIT_PER_MINUTE`, 240 by default, bounded memory); the API refuses to start unless the connected database's name equals `DEMO_DATABASE_CONFIRMATION` |
| `DEMO_RESET_ON_BOOT=true` | Allowed only with `PUBLIC_DEMO=true`. On every boot, which on Render means every wake-up and every deploy, one transaction empties the business tables and the files, then the seed reloads the synthetic users, gold lots and the authorized catalog with its photos. There is no HTTP endpoint that resets anything |
| `SEED_DEMO_DATA=true` | Loads the demo data into an empty database, as in local runs |

Unchanged from local and production: JWT (HS256, placeholder secrets refused), roles, the login lockout, upload
checks and metadata stripping, the 2 MB limit, idempotent invoices, and helmet's headers on the API.

**Threats considered:**
- abuse of a public endpoint: rate limit and login lockout;
- a wrong `DATABASE_URL` that would wipe a real base: the database-name confirmation;
- leaked file links: they expire in 5 minutes and are signed per key;
- cross-origin misuse: exact CORS and a CSP limited to the API origin;
- leftover state from visitors: reset on boot;
- secrets in the repository: none, because all of them live in the providers' dashboards.

## Provider settings (names only; values live in each dashboard)

**Render (`yamesi-api-demo`):**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_DEMO` | `true` |
| `SEED_DEMO_DATA` | `true` |
| `DEMO_RESET_ON_BOOT` | `true` |
| `DEMO_DATABASE_CONFIRMATION` | The demo database name |
| `ASSISTANT_ENABLED` | `false` |
| `BUSINESS_TIMEZONE` | `America/Bogota` |
| `TRUST_PROXY` | `1` |
| `STORAGE_DRIVER` | `postgres` |
| `PUBLIC_API_URL` | The API's own HTTPS address |
| `CORS_ORIGIN` | The Netlify site's HTTPS origin |

Secrets: `DATABASE_URL`, `JWT_SECRET` and `DEMO_PASSWORD`. Generate the JWT secret with `openssl rand -hex 32`; the demo password is shown to visitors and is used nowhere else.

**Netlify (`yamesi`):** `VITE_DEMO_PASSWORD` (the same public demo password). `VITE_PUBLIC_DEMO` and
`VITE_API_BASE_URL` are in `netlify.toml`.

## Deploy, roll back, remove

- **Deploy:** a push to `main` deploys both sides. Netlify builds when `frontend/` changes; Render rebuilds the
  image from `backend/Dockerfile`.
- **Roll back:**
  - Netlify: Deploys → pick a previous deploy → "Publish deploy".
  - Render: Events → a previous deploy → "Rollback".
  - The database needs no rollback, because the next boot restores the demo data.
- **Remove everything:**
  1. Netlify: Site configuration → Delete site.
  2. Render: the service → Settings → Delete web service.
  3. Neon: Project settings → Delete project.
  4. GitHub: Settings → Applications → revoke Netlify's and Render's access to this repository, if no other site uses it.
- **Local run is unchanged:** `make up` still uses Docker Compose, RustFS and the defaults (`PUBLIC_DEMO` off).
