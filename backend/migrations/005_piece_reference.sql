-- The store's own catalog code (for example AN-DAM-172) and the ring size or chain length.
-- Both are printed on the invoice line, so the customer can match the piece to the catalog.
ALTER TABLE pieces
  ADD COLUMN reference VARCHAR(24) CONSTRAINT pieces_reference_key UNIQUE,
  ADD COLUMN size VARCHAR(24);
