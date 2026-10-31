-- Colombian sales invoice: buyer identification and contact, payment reference, VAT discriminated per line,
-- issue timestamp and the CUFE of the electronic invoice (test environment: nothing is sent to the DIAN).

ALTER TABLE invoices
  ADD COLUMN customer_document_type VARCHAR(3) CHECK (customer_document_type IN ('CC', 'CE', 'NIT', 'PP')),
  ADD COLUMN customer_email VARCHAR(120),
  ADD COLUMN customer_phone VARCHAR(20),
  ADD COLUMN customer_address VARCHAR(160),
  ADD COLUMN payment_reference VARCHAR(40),
  ADD COLUMN subtotal INTEGER,
  ADD COLUMN vat_total INTEGER,
  ADD COLUMN issued_at TIMESTAMPTZ,
  ADD COLUMN cufe CHAR(96);

ALTER TABLE invoice_items
  ADD COLUMN vat_rate SMALLINT,
  ADD COLUMN tax_base INTEGER,
  ADD COLUMN vat INTEGER;

-- Rows sold before this migration: prices already included 19% VAT.
UPDATE invoice_items SET vat_rate = 19, tax_base = ROUND(price * 100.0 / 119)::int, vat = price - ROUND(price * 100.0 / 119)::int;
UPDATE invoices i SET
  subtotal = s.tax_base,
  vat_total = s.vat,
  issued_at = i.created_at
FROM (SELECT invoice_id, SUM(tax_base)::int AS tax_base, SUM(vat)::int AS vat FROM invoice_items GROUP BY invoice_id) s
WHERE s.invoice_id = i.id;

ALTER TABLE invoice_items
  ALTER COLUMN vat_rate SET NOT NULL,
  ALTER COLUMN tax_base SET NOT NULL,
  ALTER COLUMN vat SET NOT NULL,
  ADD CONSTRAINT invoice_items_vat_split CHECK (tax_base + vat = price AND vat >= 0);

ALTER TABLE invoices
  ALTER COLUMN subtotal SET NOT NULL,
  ALTER COLUMN vat_total SET NOT NULL,
  ALTER COLUMN issued_at SET NOT NULL,
  ALTER COLUMN issued_at SET DEFAULT now(),
  ADD CONSTRAINT invoices_vat_split CHECK (subtotal + vat_total = total);
