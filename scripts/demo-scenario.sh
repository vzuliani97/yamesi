#!/bin/sh
# One business day, driven through the public API with the store's catalog:
# new pieces arrive with their photos, a price changes, five sales with every payment method,
# a retried sale, four petty-cash expenses with receipt photos, the closing, and a late sale rejected.
# Run it on a fresh database (`make demo` does the reset first). Requires curl and jq.
set -eu
cd "$(dirname "$0")/.."

api=${API_URL:-http://localhost:8083/api}
password=$(sed -n 's/^DEMO_PASSWORD=//p' .env)
catalog=backend/demo-assets/catalog.json

step() { printf '\n== %s\n' "$1"; }
invoice_line='"invoice \(.data.fullNumber) \(.data.paymentMethod): base $\(.data.subtotal) + IVA $\(.data.vatTotal) = $\(.data.total), replayed=\(.meta.replayed)"'

# sell <idempotency-key> <json body> [extra curl options]
sell() {
  key=$1 body=$2
  shift 2
  curl -sS -X POST "$api/invoices" -H "$auth" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -d "$body" "$@"
}

step "Log in as the synthetic admin"
token=$(curl -sS -X POST "$api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@yamesi.local\",\"password\":\"$password\"}" | jq -r .accessToken)
auth="Authorization: Bearer $token"

step "Pieces in stock, from the store's catalog (reference, gold weight, price; traceable to their gold lot)"
curl -sS "$api/pieces?status=IN_STOCK" -H "$auth" |
  jq -r '"\(length) pieces; the first five:", (sort_by(.id)[:5][] | "#\(.id) \(.reference) \(.name)\(if .size then " · " + .size else "" end), \(.karat)k \(.grams) g, lot \(.lotCode), $\(.price)")'

step "New pieces arrive: registered through the inventory portal with their photos (gold taken from lot L-00001)"
jq -c '.[] | select(.arrivesDuringDemo)' "$catalog" | while read -r piece; do
  field() { printf '%s' "$piece" | jq -r "$1"; }
  curl -sS -X POST "$api/pieces" -H "$auth" \
    -F "name=$(field .name)" -F "reference=$(field .reference)" -F "size=$(field '.size // ""')" \
    -F "category=$(field .category)" -F lotId=1 -F "grams=$(field .grams)" \
    -F "laborCost=$(field .laborCost)" -F "price=$(field .price)" \
    -F "image=@backend/demo-assets/pieces/$(field .photo);type=image/jpeg" |
    jq -r '"#\(.id) \(.reference) \(.name), \(.grams) g, $\(.price), photo=\(.imageUrl != null)"'
done

step "A price changes in the portal (10% off the solitaire ring); the audit log keeps the old value"
curl -sS -X PATCH "$api/pieces/18" -H "$auth" -H 'Content-Type: application/json' -d '{"price":882000}' |
  jq -r '"#\(.id) \(.reference) \(.name): now $\(.price)"'

step "Sell two pieces in cash to a person (CC, email, phone, address)"
sale1='{"customerName":"Cliente de Prueba Uno","customerDocumentType":"CC","customerDocument":"1000001","customerEmail":"cliente.uno@example.com","customerPhone":"+57 300 000 0001","customerAddress":"Calle de prueba 1, Medellín","paymentMethod":"CASH","pieceIds":[1,3]}'
sell demo-sale-0001 "$sale1" | jq -r "$invoice_line"

step "The client retries the same request (network timeout): same invoice, no second sale"
sell demo-sale-0001 "$sale1" | jq -r "$invoice_line"

step "Same Idempotency-Key with different data (another email) is a conflict, not a replay"
sell demo-sale-0001 "$(printf '%s' "$sale1" | jq -c '.customerEmail = "otro@example.com"')" -w ' HTTP %{http_code}\n'

step "Sell one piece by card to a company (NIT, card approval number)"
sell demo-sale-0002 '{"customerName":"Comercializadora de Prueba S.A.S.","customerDocumentType":"NIT","customerDocument":"900000001-0","customerEmail":"compras@example.com","paymentMethod":"CARD","paymentReference":"APROB-123456","pieceIds":[5]}' |
  jq -r "$invoice_line"

step "Sell a ring and a chain by bank transfer, with the transfer reference"
sell demo-sale-0003 '{"customerName":"Cliente de Prueba Dos","customerDocumentType":"CC","customerDocument":"1000002","customerEmail":"cliente.dos@example.com","customerPhone":"+57 300 000 0002","paymentMethod":"TRANSFER","paymentReference":"TRF-20261101-77","pieceIds":[6,8]}' |
  jq -r "$invoice_line"

step "Sell earrings in cash to a final consumer (no document: 222222222222 in the CUFE)"
sell demo-sale-0004 '{"customerName":"Consumidor final","paymentMethod":"CASH","pieceIds":[11]}' | jq -r "$invoice_line"

step "Sell the discounted ring by card"
sell demo-sale-0005 '{"customerName":"Cliente de Prueba Tres","customerDocumentType":"CE","customerDocument":"700003","customerEmail":"cliente.tres@example.com","paymentMethod":"CARD","paymentReference":"APROB-654321","pieceIds":[18]}' |
  jq -r "$invoice_line"

step "A second seller tries to sell a piece that is already sold"
sell demo-sale-0006 '{"customerName":"Cliente de Prueba Cuatro","paymentMethod":"CASH","pieceIds":[1]}' -w ' HTTP %{http_code}\n'

step "Petty cash: four expenses, each with a photo of its receipt (stored in S3-compatible storage)"
for expense in \
  'TRANSPORTE|Taxi al banco, ida y regreso|18000|taxi' \
  'ASEO|Productos de aseo para la vitrina|30000|aseo' \
  'OTRO|Estuches y bolsas de regalo|43500|papeleria' \
  'MANTENIMIENTO|Bisagra y limpieza de vitrina|50000|mantenimiento'; do
  IFS='|' read -r category description amount photo <<END
$expense
END
  curl -sS -X POST "$api/expenses" -H "$auth" -F "category=$category" -F "description=$description" -F "amount=$amount" \
    -F "receipt=@scripts/demo-receipts/$photo.jpg;type=image/jpeg" |
    jq -r '"expense #\(.id // .data.id) \(.category // .data.category) $\(.amount // .data.amount) receipt stored=\((.receiptUrl // .data.receiptUrl // .receiptKey // .data.receiptKey) != null)"'
done

step "Close the day with the counted cash"
expected=$(curl -sS "$api/closings/today" -H "$auth" | jq -r .expectedCash)
curl -sS -X POST "$api/closings" -H "$auth" -H 'Content-Type: application/json' \
  -d "{\"countedCash\":$expected,\"notes\":\"Cierre de demostración\"}" | jq -r '"closed \(.date // .data.date): expected $\(.expectedCash // .data.expectedCash), difference $\(.difference // .data.difference // 0)"'

step "A late sale after closing is rejected"
sell demo-sale-0007 '{"customerName":"Cliente Tardío","paymentMethod":"CASH","pieceIds":[2]}' -w ' HTTP %{http_code}\n'

step "Audit trail (newest first)"
curl -sS "$api/audit" -H "$auth" | jq -r '.[] | "\(.createdAt // .at) \(.actor // .userEmail // .user) \(.action) \(.entity // "") \(.entityId // "")"' | head -12
