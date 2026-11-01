#!/bin/sh
# One business day with synthetic data, driven through the public API:
# sell, retry a sale with the same Idempotency-Key, record a petty-cash receipt,
# close the day, then show that a late sale is rejected and that the audit log has every step.
# Run it on a fresh database (`make demo` does the reset first). Requires curl and jq.
set -eu
cd "$(dirname "$0")/.."

api=${API_URL:-http://localhost:8083/api}
password=$(sed -n 's/^DEMO_PASSWORD=//p' .env)
receipt=$(mktemp)
trap 'rm -f "$receipt"' EXIT

step() { printf '\n== %s\n' "$1"; }

step "Log in as the synthetic admin"
token=$(curl -sS -X POST "$api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@yamesi.local\",\"password\":\"$password\"}" | jq -r .accessToken)
auth="Authorization: Bearer $token"

step "Pieces in stock, from the store's catalog (reference, gold weight, price; traceable to their gold lot)"
curl -sS "$api/pieces?status=IN_STOCK" -H "$auth" |
  jq -r '"\(length) pieces; the first five:", (sort_by(.id)[:5][] | "#\(.id) \(.reference) \(.name)\(if .size then " · " + .size else "" end), \(.karat)k \(.grams) g, lot \(.lotCode), $\(.price)")'

step "Sell two pieces in cash to a person (CC, email, phone, address)"
curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-sale-0001' \
  -d '{"customerName":"Cliente de Prueba Uno","customerDocumentType":"CC","customerDocument":"1000001","customerEmail":"cliente.uno@example.com","customerPhone":"+57 300 000 0001","customerAddress":"Calle de prueba 1, Medellín","paymentMethod":"CASH","pieceIds":[1,3]}' |
  jq -r '"invoice \(.data.fullNumber): base $\(.data.subtotal) + IVA $\(.data.vatTotal) = $\(.data.total), replayed=\(.meta.replayed)"'

step "The client retries the same request (network timeout): same invoice, no second sale"
curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-sale-0001' \
  -d '{"customerName":"Cliente de Prueba Uno","customerDocumentType":"CC","customerDocument":"1000001","customerEmail":"cliente.uno@example.com","customerPhone":"+57 300 000 0001","customerAddress":"Calle de prueba 1, Medellín","paymentMethod":"CASH","pieceIds":[1,3]}' |
  jq -r '"invoice \(.data.fullNumber): base $\(.data.subtotal) + IVA $\(.data.vatTotal) = $\(.data.total), replayed=\(.meta.replayed)"'

step "Same Idempotency-Key with different data (another email) is a conflict, not a replay"
curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-sale-0001' \
  -d '{"customerName":"Cliente de Prueba Uno","customerDocumentType":"CC","customerDocument":"1000001","customerEmail":"otro@example.com","customerPhone":"+57 300 000 0001","customerAddress":"Calle de prueba 1, Medellín","paymentMethod":"CASH","pieceIds":[1,3]}' -w ' HTTP %{http_code}\n'

step "Sell one piece by card to a company (NIT, card approval number)"
curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-sale-0002' \
  -d '{"customerName":"Comercializadora de Prueba S.A.S.","customerDocumentType":"NIT","customerDocument":"900000001-0","customerEmail":"compras@example.com","paymentMethod":"CARD","paymentReference":"APROB-123456","pieceIds":[5]}' |
  jq -r '"invoice \(.data.fullNumber): base $\(.data.subtotal) + IVA $\(.data.vatTotal) = $\(.data.total), replayed=\(.meta.replayed)"'

step "A second seller tries to sell a piece that is already sold"
curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-sale-0003' \
  -d '{"customerName":"Cliente de Prueba Tres","paymentMethod":"CASH","pieceIds":[1]}' -w ' HTTP %{http_code}\n'

step "Petty cash: transport expense with a photo of the receipt (stored in S3-compatible storage)"
# A real 1x1 PNG: the API checks magic bytes, so a renamed text file would be rejected.
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' | base64 -d > "$receipt"
curl -sS -X POST "$api/expenses" -H "$auth" -F category=TRANSPORTE -F 'description=Taxi al banco (demo)' -F amount=18000 \
  -F "receipt=@$receipt;type=image/png" | jq -r '"expense #\(.id // .data.id) $\(.amount // .data.amount) receipt stored=\((.receiptUrl // .data.receiptUrl // .receiptKey // .data.receiptKey) != null)"'

step "Close the day with the counted cash"
expected=$(curl -sS "$api/closings/today" -H "$auth" | jq -r .expectedCash)
curl -sS -X POST "$api/closings" -H "$auth" -H 'Content-Type: application/json' \
  -d "{\"countedCash\":$expected,\"notes\":\"Cierre de demostración\"}" | jq -r '"closed \(.date // .data.date): expected $\(.expectedCash // .data.expectedCash), difference $\(.difference // .data.difference // 0)"'

step "A late sale after closing is rejected"
curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-sale-0004' \
  -d '{"customerName":"Cliente Tardío","paymentMethod":"CASH","pieceIds":[2]}' -w ' HTTP %{http_code}\n'

step "Audit trail (newest first)"
curl -sS "$api/audit" -H "$auth" | jq -r '.[] | "\(.createdAt // .at) \(.actor // .userEmail // .user) \(.action) \(.entity // "") \(.entityId // "")"' | head -10
