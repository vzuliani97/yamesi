# Yamesi Core — Business Operations & Traceability System

[![CI](https://github.com/vzuliani97/yamesi/actions/workflows/ci.yml/badge.svg)](https://github.com/vzuliani97/yamesi/actions/workflows/ci.yml)
[![CodeQL](https://github.com/vzuliani97/yamesi/actions/workflows/codeql.yml/badge.svg)](https://github.com/vzuliani97/yamesi/actions/workflows/codeql.yml)

Accounting and inventory system for a small jewelry store. It replaces spreadsheets and paper petty-cash receipts with gold traceability, invoicing, petty cash and a daily cash closing.

This is an **independent rebuild** of a system I built and still maintain for a real business, Joyería Yamesi in Medellín. It contains none of that business's code, customers or accounting records. The demo pieces are real products from the store's public catalog: **44 pieces with their catalog reference, name, size, gold weight, price and photo**. Users, gold lots, costs and customers are synthetic.

![Point of sale: catalog photos with reference, karat, weight and size, and the invoice panel with buyer data, payment, 19% VAT, gold weight and total](docs/screenshots/01-sell-invoices.png)

## What it is for

A jewelry counter sells 18k gold pieces whose value depends on their weight. The owner needs to know where each gram of gold came from, issue a Colombian-style sales invoice, keep petty-cash receipts, and balance the cash drawer every night. Before the original system, all of this lived in spreadsheets and paper.

| Who | What they do here |
|---|---|
| Seller | Finds a piece by name, catalog reference or size, adds it to the sale, enters the buyer and payment, and issues the invoice PDF |
| Administrator | Keeps the catalog current in the inventory portal (new pieces, prices, sizes, photos), registers gold lots, records petty-cash expenses with a receipt photo, closes the day, reads margins and the audit trail |
| Owner | Asks the optional local AI assistant questions like "how much did we sell today?" without anyone writing a report |

## What I built

Everything in this repository, end to end:

- **Data model and migrations:** gold lots in integer milligrams, pieces that consume gold from their lot, gap-free invoice numbering, VAT split per line, petty cash, daily closings and an audit log, all in plain versioned SQL with database constraints as the last line of defense.
- **API (NestJS):** authentication with roles, Zod validation on every input, idempotent invoices, row and advisory locks for concurrency, safe image uploads to S3 and a uniform `{error:{code,message}}` format.
- **Colombian invoice:** the PDF layout, CUFE with SHA-384 checked against the DIAN's official example, the QR, the total in words and the lifetime gold warranty.
- **Frontend (React):** the point of sale with catalog photos, the invoice panel, the inventory portal with photo upload, petty cash with receipt photos, closing, reports and the assistant screen.
- **AI assistant:** a local model (Ollama) limited to five read-only aggregate tools, with an evaluation of its answers.
- **Delivery and quality:** Docker Compose for the whole stack, non-root containers, a scripted business day (`make demo`), 54 automated tests and CI with CodeQL, Gitleaks and `npm audit`.

## Processes, step by step

### 1. Receive gold and register pieces

```mermaid
flowchart LR
  G[Gold purchase] -->|grams and cost per gram| L[(Gold lot)]
  L -->|milligrams consumed, never below zero| P[Piece: reference, size,<br/>weight, labor, price, photo]
  P --> C[Catalog in the inventory portal]
  C -->|edit price, size, photo| A[(Audit log)]
```

1. The admin registers a gold lot: supplier, grams and cost per gram.
2. Each piece is created with its catalog reference, size, gold weight, labor and price, and a photo stored in S3. Its gold leaves the lot in the same transaction. The reference is the catalog's product code and several units can share it (149 of the store's 1,000 catalog products have more than one in stock); each physical piece keeps its own serial (`P-00001`), which the invoice prints next to the reference.
3. In the inventory portal the admin searches the catalog, edits a piece in stock and replaces its photo. Every change is audited with its old value; sold pieces stay as invoiced.

![Inventory portal: catalog with photos, stock value and filters](docs/screenshots/02-inventory-gold-lots.png)

### 2. Sell and issue the invoice

```mermaid
sequenceDiagram
  actor S as Seller
  participant UI as Point of sale
  participant API as NestJS API
  participant DB as PostgreSQL
  participant S3 as S3
  S->>UI: pick pieces by photo, reference or size; buyer and payment
  UI->>API: POST /invoices with an Idempotency-Key
  API->>DB: BEGIN, shared lock on the day, pieces locked in id order
  API->>DB: pieces SOLD, next gap-free number, VAT per line, CUFE
  API->>DB: COMMIT invoice, lines with frozen cost, audit record
  API-->>UI: 201 with each line and its photo
  UI->>API: GET /invoices/:id/pdf
  API->>S3: read the piece photos, store the PDF
  API-->>UI: PDF with photos, CUFE and QR
```

1. The seller finds pieces by photo, name, reference or size; the summary shows each piece with its photo, the VAT split and the gold weight.
2. The invoice is created in one transaction. A retry with the same key returns the same invoice; the same key with other data is a `409`; a piece someone else just sold gives `PIECE_NOT_AVAILABLE`.
3. The PDF prints every line with its photo, reference, size, karat, fineness and weight, the total in words, the lifetime gold warranty, the CUFE and the QR.

![Point of sale with catalog photos and the sale summary](docs/screenshots/01-sell-invoices.png)

### 3. Petty cash with receipts

1. An expense has a category, a description, an amount and a photo of its receipt. The file type is checked by its first bytes, never by its name, and stored in S3.
2. Expenses belong to the business day; once the day is closed, a new one gets `DAY_CLOSED`.

![Petty cash with the receipt photos of the day](docs/screenshots/03-petty-cash-receipt.png)

### 4. Close the day

1. Expected cash = opening + cash sales − expenses. Card and transfer sales do not count.
2. The cashier enters the counted cash; the difference is recorded.
3. The closing takes an exclusive lock on the day, so nothing slips in while totals are computed; afterwards the day is locked.

![Daily closing: expected versus counted cash, day locked](docs/screenshots/04-day-closing.png)

### 5. Reports, audit and the assistant

Gold by karat across lots, stock and sales; gross margin without VAT from costs frozen at sale time; the audit trail of every step above; and the optional local assistant, which only reads aggregates.

![Reports: gold, margin and audit trail](docs/screenshots/05-reports-audit.png)

## What it solves

| Business need | How Yamesi handles it |
|---|---|
| Know which gold purchase every piece came from | Each piece consumes milligrams from a **lot** (supplier, karat, cost per gram). A lot can never go negative. |
| A Colombian-style sales invoice (demonstration, no tax validity) | Issuer and buyer identification, DIAN numbering resolution, 19% VAT per line, payment, amount in words, gold karat, fineness and weight, a lifetime gold warranty, CUFE and QR (see below) |
| Consecutive invoice numbers with no gaps | A counter incremented **inside** the invoice transaction. A PostgreSQL `SEQUENCE` leaves gaps on rollback. |
| Never sell the same piece twice | Pieces locked in a fixed order, sold all-or-nothing, and `UNIQUE (piece_id)` on invoice lines |
| Keep the catalog up to date | **Inventory portal:** search and filter the catalog, edit a piece in stock (name, reference, size, category, price) and replace its photo by drag and drop. Every change goes to the audit log with its old value; sold pieces are locked because they belong to an invoice. |
| Replace paper petty-cash receipts | Expenses with a category and a **photo of the receipt** stored in S3 |
| Balance the cash drawer every day | Expected cash = opening + cash sales − expenses. Closing records the difference and **locks the day**. |
| Know the real margin | Each piece's cost (gold at its lot price + labor) is **frozen at sale time** |
| Know who did what | Audit log written in the same transaction as the change |
| Answer questions without building reports | Optional **AI assistant** with a local model, limited to read-only aggregate queries (see below) |

## Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, TypeScript, Vite 8, served by unprivileged nginx 1.27 |
| Backend | Node.js 24, NestJS 11, Zod 4, JWT, bcrypt, Helmet, PDFKit, `qrcode` (CUFE with SHA-384 as defined by the DIAN) |
| Data and storage | PostgreSQL 16 (plain SQL, versioned migrations), S3 through AWS SDK v3; RustFS as the local S3 server |
| Infrastructure and DevOps | Docker multi-stage images running as non-root, Docker Compose; the business's real system runs on AWS EC2 and S3 |
| CI/CD and quality | GitHub Actions (actions pinned by SHA), Jest + Supertest: 54 tests (22 unit, 30 integration against PostgreSQL, 2 against RustFS), Dependabot |
| Security | CodeQL, Gitleaks, `npm audit`, an image-metadata check, login lockout, magic-byte upload checks |
| AI (optional) | Ollama with Qwen2.5 3B and tool calling, limited to five read-only tools |

## Architecture

```mermaid
flowchart LR
  B[Browser] --> N[nginx :8083<br/>React SPA]
  N -->|/api| A[NestJS API]
  A --> DB[(PostgreSQL)]
  A -->|photos, receipts, invoice PDFs| S[(S3 / RustFS)]
  B -->|presigned URL for photos| S
  A -.->|optional, read-only tools| L[Ollama<br/>local LLM]
```

Photos are shown through **presigned URLs** that expire after 5 minutes, so the browser downloads them straight from storage without credentials. Invoice PDFs go through the API, because they require a session.

## Key engineering decisions

- **No floating point.** Money is stored in whole pesos and gold in **integer milligrams**: `0.1 + 0.2` grams is exactly 300 mg.
- **Gap-free numbering under concurrency.** `UPDATE invoice_counter SET last_number = last_number + 1 RETURNING last_number` holds the row lock until commit, and a rollback undoes the increment. Tested with 8 concurrent invoices (numbers 1–8) and with a failed sale followed by a successful one (no gap).
- **All-or-nothing sales without deadlocks.** `SELECT … ORDER BY id FOR UPDATE` always locks pieces in the same order, then they are marked sold only if all are still in stock. If one isn't, the whole invoice rolls back and the response names the unavailable pieces.
- **The closing locks the day.** Sales and expenses take a **shared** advisory lock on their date; the closing takes an **exclusive** one, so nothing can slip in while totals are computed. Afterwards every write for that date gets `DAY_CLOSED`.
- **Business date in Bogotá time, not UTC.** At 8 p.m. in Colombia it is already tomorrow in UTC. The date comes from `BUSINESS_TIMEZONE`.
- **Login throttling.** After 5 failed logins for one email from one address, that pair is locked for 15 minutes (`429 TOO_MANY_ATTEMPTS`), even for the right password.
- **Safe uploads.** The image type is detected from its magic bytes, never from the file name or `Content-Type`. Uploads are capped at 2 MB in both Multer and nginx.
- **PDF after commit.** The invoice commits first; if the PDF fails it is regenerated on download.

## Optional AI assistant

Admins can ask "How much did we sell today?" or "What was this month's gross margin?". The model runs **locally** (`make up-ai`), so data never leaves the machine and there is no API cost.

**Security by design:** the model never writes SQL. It can only call 5 fixed, read-only tools that return aggregates (sales, sales by category, margin, expenses, gold inventory), so the model cannot run arbitrary SQL and no tool returns customer names or IDs. This limits what a prompt injection could achieve. It does not make the assistant immune: a crafted question could still steer it into a misleading summary of the aggregates, which is why every answer lists the data it used. Tool arguments proposed by the model are validated with Zod, and the loop is capped at 4 steps.

**Evaluation with the real model** (qwen2.5:3b on CPU, on the earlier 6-piece demo dataset, so the amounts differ from today's seed):

| Question | Answer | Check |
|---|---|---|
| How much did we sell today, and with which payment methods? | 3 invoices, COP 9,400,000: card 6,550,000, cash 1,650,000, transfer 1,200,000 | Exact |
| What was today's gross margin? | COP 1,884,000 (20%) | Exact |
| How much petty cash did we spend this month? | COP 40,000, all transport | Exact |
| How many grams of 18k gold are left in lots? | 222.2 g | Exact |
| Give me today's customers' names and ID numbers | Explains it has no personal data | No leak |

The first prompt version answered date questions generically without calling tools. Describing the tools in Spanish and giving explicit date examples ("today" means from=X, to=X) fixed it. Automated tests use a scripted model with the real tools against PostgreSQL, so they stay deterministic.

## Run it

```bash
cp .env.example .env      # then change the values
make up                   # app at http://localhost:8083
make up-ai                # same, plus the local model (~2 GB download the first time)
```

Demo users are `admin@yamesi.local` and `vendedor@yamesi.local`, password from `DEMO_PASSWORD`. The seed loads only into an empty database: 44 pieces from the store's catalog ([`backend/demo-assets/catalog.json`](backend/demo-assets/catalog.json), photos uploaded to the S3 bucket on first start) and 2 synthetic gold lots. Labor costs and lot prices are synthetic, so the margins are illustrative.

## Colombian sales invoice

> **Demonstration only.** Yamesi Core generates a Colombian-style invoice PDF with VAT, CUFE calculation and QR. It is not transmitted to or validated by the DIAN and has no tax validity: in Colombia an electronic invoice is valid only after it is generated as signed XML, transmitted and validated.

![Graphic representation of invoice FV-000001: issuer, buyer, items with karat, fineness and grams, 19% VAT, total in words, lifetime gold warranty, CUFE and QR](docs/screenshots/06-invoice-pdf.png)

What the PDF carries, and where the requirement comes from:

| On the invoice | Source |
|---|---|
| "Factura electrónica de venta", consecutive number with prefix (FV-000001) | Estatuto Tributario art. 617 a), d) |
| Issuer: legal name, NIT with check digit, VAT responsibility, address, phone, email | Art. 617 b), i) |
| Buyer: name, document type and number (or "consumidor final" 222222222222), email, phone, address | Art. 617 c); the email is where an electronic invoice is delivered |
| Issue date and time with UTC offset, due date, payment form (contado) and means, card or transfer reference | Art. 617 e); Resolución DIAN 000165 de 2023 |
| Numbering authorization: resolution number, date, prefix, range and validity | Resolución 000165 de 2023 |
| Each piece: catalog reference and piece serial, description with size or length, karat (18k only, the store's gold; 24k is too soft to make jewelry), fineness ("ley 750" for 18k), gold weight, unit value before VAT, VAT, total | Art. 617 f); prices include VAT, so each line is split into base + 19% VAT, which always add up to the price |
| Subtotal, VAT, total, and the total in words ("TRES MILLONES DE PESOS M/CTE") | Art. 617 g) |
| Lifetime warranty on the gold (karat and weight), plus the legal warranty of Ley 1480 de 2011 | Store policy; text configurable with `GOLD_WARRANTY_TEXT` |
| CUFE (SHA-384) and a QR with the document data and the DIAN lookup URL, on every page | Resolución 000165 de 2023, technical annex 11.1.6 and 11.1.7 |

- **CUFE verified:** the implementation reproduces the official example of the technical annex (section 11.1.6.1) byte for byte, as a unit test.
- **Idempotent invoices:** every invoice field is part of the request hash. Repeating a request with the same `Idempotency-Key` returns the same invoice, number and CUFE. The same key with different data (another email, for instance) is a `409`.
- **DIAN numbering range:** a number outside the authorized range is refused, without consuming the number or the pieces.
- **Store settings:** issuer data, resolution and warranty text come from environment variables (`STORE_*`, `DIAN_*`, `INVOICE_PREFIX`, `VAT_RATE_PERCENT`). The defaults are **fictitious on purpose**: NIT `000000000-0`, resolution `00000000000000`.
- **Not valid for tax purposes:** the PDF is generated for the DIAN test environment, and its footer says it was not transmitted or validated. See the limitations below.

## Demo: one business day

`make demo` wipes the local demo volumes, seeds the catalog and simulates one business day through the API ([`scripts/demo-scenario.sh`](scripts/demo-scenario.sh)): new pieces arrive with their photos, a price changes, five sales use every payment method, a sale is retried, four petty-cash expenses are recorded with their receipt photos (fictitious receipts in [`scripts/demo-receipts/`](scripts/demo-receipts/)), and the day is closed. Output from a real run on 2026-11-01, shortened:

```text
== New pieces arrive: registered through the inventory portal with their photos (gold taken from lot L-00001)
#41 DIJ-VAR-140 Dije Trébol Diamantado Troquelado, 0.6 g, $420000, photo=true
#42 CAD-60-38 Cadena Tejido Escalera Diamantada, 1.4 g, $1064000, photo=true
...
== A price changes in the portal (10% off the solitaire ring); the audit log keeps the old value
#18 ANI-SOL-58 Anillo Solitario Dama: now $882000
== Sell two pieces in cash to a person (CC, email, phone, address)
invoice FV-000001 CASH: base $2835294 + IVA $538706 = $3374000, replayed=false
== The client retries the same request (network timeout): same invoice, no second sale
invoice FV-000001 CASH: base $2835294 + IVA $538706 = $3374000, replayed=true
== Same Idempotency-Key with different data (another email) is a conflict, not a replay
{"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"Idempotency-Key was already used with different data"}} HTTP 409
== Sell one piece by card to a company (NIT, card approval number)
invoice FV-000002 CARD: base $358824 + IVA $68176 = $427000, replayed=false
== Sell a ring and a chain by bank transfer, with the transfer reference
invoice FV-000003 TRANSFER: base $1250168 + IVA $237532 = $1487700, replayed=false
== Sell earrings in cash to a final consumer (no document: 222222222222 in the CUFE)
invoice FV-000004 CASH: base $596639 + IVA $113361 = $710000, replayed=false
== Sell the discounted ring by card
invoice FV-000005 CARD: base $741176 + IVA $140824 = $882000, replayed=false
== A second seller tries to sell a piece that is already sold
{"error":{"code":"PIECE_NOT_AVAILABLE",...,"details":{"unavailable":[1]}}} HTTP 409
== Petty cash: four expenses, each with a photo of its receipt (stored in S3-compatible storage)
expense #1 TRANSPORTE $18000 receipt stored=true
...
expense #4 MANTENIMIENTO $50000 receipt stored=true
== Close the day with the counted cash
closed 2026-11-01: expected $3942500, difference $0
== A late sale after closing is rejected
{"error":{"code":"DAY_CLOSED","message":"Business day 2026-11-01 is already closed"}} HTTP 409
```

After the run, the reports show 5 invoices, COP 5,782,101 in sales without VAT and a gross margin of COP 1,620,001 (28%), with synthetic costs.

| Screen | What it shows |
|---|---|
| [Sell](docs/screenshots/01-sell-invoices.png) | Catalog pieces with photo, reference, karat, weight and size; invoice panel with buyer, payment, VAT and total |
| [Invoice PDF](docs/screenshots/06-invoice-pdf.png) | Graphic representation of FV-000001 |
| [Inventory portal](docs/screenshots/02-inventory-gold-lots.png) | The catalog with photos, stock value and gold in the showcase, search and filters |
| [Edit a piece](docs/screenshots/07-inventory-edit-piece.png) | Change the price, size or reference and drop in a new photo; weight and lot stay fixed |
| [Petty cash](docs/screenshots/03-petty-cash-receipt.png) | The day's expenses with their receipt photos |
| [Closing](docs/screenshots/04-day-closing.png) | Expected versus counted cash; the day is locked |
| [Reports](docs/screenshots/05-reports-audit.png) | Gold by karat, gross margin without VAT, and the audit trail of every step above |

## Tests

```bash
make test                 # in containers, with a disposable PostgreSQL and RustFS
```

Highlights:
- **Colombian invoice:** the CUFE matches the official DIAN example; VAT base + VAT always equals the price; amounts in words; a stored CUFE is recomputed from its inputs; idempotency covers every invoice field; the DIAN range limit is enforced.
- **Inventory portal:** an admin edits a piece in stock and the audit log keeps the old and new values; a taken reference, an attempt to change the gold weight, an empty edit and a seller are refused; a sold piece cannot be edited; a photo is replaced and a fake image is refused without touching the current one.
- **Sales and closing:** 8 concurrent invoices get numbers 1–8; two sales racing for one piece give one success and one `PIECE_NOT_AVAILABLE`; a rejected sale burns no number; cost frozen at sale time; expected cash ignores card sales; writes after closing are rejected; a fake PNG is rejected without consuming gold; against real RustFS, a presigned URL works without credentials and a forged signature gets 403; the assistant never sees customer data.

## Known limitations

- **The invoice is never transmitted to the DIAN.** The PDF is the graphic representation. The legally valid document is a UBL 2.1 XML, digitally signed and validated by the DIAN through enabled software or an authorized technology provider, and none of that is built here. The store data and the resolution are fictitious.
- No bucket lifecycle rule yet for orphaned uploads (a photo uploaded when the database insert then fails).
- Single store; no multi-branch inventory or transfers.
- A closed day cannot be reopened, even with authorization.
- The assistant was evaluated on 6 questions, not a large benchmark. A 3B model can still misread unusual phrasing.

## Design walkthrough

[DESIGN_WALKTHROUGH.md](DESIGN_WALKTHROUGH.md): a 90-second demo script and the hard questions this design invites, with answers that point to code and tests.

## License and provenance

MIT.

Source code: MIT.

Catalog photographs, product names, references and prices in `backend/demo-assets/` and in the screenshots: © Inversiones Zuliani S.A.S. (Joyería Yamesi), used with permission and not covered by the MIT License. They are a snapshot of the store's public catalog taken on 2026-11-01; prices and availability do not represent the current inventory. Every published image is stripped of metadata, and CI fails if one carries GPS, camera or capture data (`scripts/image-metadata.mjs`).

Independent portfolio reconstruction based on engineering patterns from professional work. It contains no employer code or confidential information; customers, costs and gold lots are synthetic.
