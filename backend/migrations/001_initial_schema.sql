-- Money: whole Colombian pesos (INTEGER). Gold weight: milligrams (INTEGER). No floating point anywhere.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(254) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('ADMIN', 'SELLER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A purchase of raw gold. Pieces are made from lots, which gives traceability from sale back to supplier.
CREATE TABLE gold_lots (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) GENERATED ALWAYS AS ('L-' || LPAD(id::text, 5, '0')) STORED,
  karat SMALLINT NOT NULL CHECK (karat IN (14, 18, 24)),
  supplier VARCHAR(120) NOT NULL,
  total_mg INTEGER NOT NULL CHECK (total_mg > 0),
  remaining_mg INTEGER NOT NULL,
  cost_per_gram INTEGER NOT NULL CHECK (cost_per_gram > 0),
  purchased_on DATE NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lots_remaining_range CHECK (remaining_mg >= 0 AND remaining_mg <= total_mg)
);

CREATE TABLE pieces (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(20) GENERATED ALWAYS AS ('P-' || LPAD(id::text, 5, '0')) STORED,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(16) NOT NULL CHECK (category IN ('ANILLO', 'CADENA', 'ARETES', 'PULSERA', 'DIJE', 'OTRO')),
  lot_id INTEGER NOT NULL REFERENCES gold_lots(id),
  gold_mg INTEGER NOT NULL CHECK (gold_mg > 0),
  labor_cost INTEGER NOT NULL CHECK (labor_cost >= 0),
  price INTEGER NOT NULL CHECK (price > 0),
  status VARCHAR(10) NOT NULL DEFAULT 'IN_STOCK' CHECK (status IN ('IN_STOCK', 'SOLD')),
  image_key VARCHAR(200),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pieces_status ON pieces (status);

-- Single-row counter for gap-free invoice numbers. A SEQUENCE would leave gaps on rollback.
CREATE TABLE invoice_counter (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_number INTEGER NOT NULL
);
INSERT INTO invoice_counter (last_number) VALUES (0);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number INTEGER NOT NULL UNIQUE,
  business_date DATE NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_document VARCHAR(20),
  payment_method VARCHAR(10) NOT NULL CHECK (payment_method IN ('CASH', 'CARD', 'TRANSFER')),
  total INTEGER NOT NULL CHECK (total > 0),
  pdf_key VARCHAR(200),
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  seller_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_date ON invoices (business_date);

CREATE TABLE invoice_items (
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  -- UNIQUE: the database itself guarantees a piece is never sold twice.
  piece_id INTEGER NOT NULL UNIQUE REFERENCES pieces(id),
  price INTEGER NOT NULL CHECK (price > 0),
  -- Cost frozen at sale time (gold at the lot's price per gram + labor), for margin reports.
  cost INTEGER NOT NULL CHECK (cost >= 0),
  PRIMARY KEY (invoice_id, piece_id)
);

-- Petty cash: replaces the paper vouchers. The photo of the receipt is optional.
CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  category VARCHAR(16) NOT NULL CHECK (category IN ('TRANSPORTE', 'ASEO', 'PAPELERIA', 'MANTENIMIENTO', 'OTRO')),
  description VARCHAR(200) NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  receipt_key VARCHAR(200),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_date ON expenses (business_date);

-- One row per closed day. Once it exists, that day's sales and expenses are locked.
CREATE TABLE cash_closings (
  business_date DATE PRIMARY KEY,
  opening_cash INTEGER NOT NULL,
  cash_sales INTEGER NOT NULL,
  expenses INTEGER NOT NULL,
  expected_cash INTEGER NOT NULL,
  counted_cash INTEGER NOT NULL CHECK (counted_cash >= 0),
  difference INTEGER NOT NULL,
  notes VARCHAR(300),
  closed_by UUID NOT NULL REFERENCES users(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id VARCHAR(60) NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
