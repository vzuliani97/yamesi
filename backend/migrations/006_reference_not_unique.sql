-- A catalog reference is a product code that can have several units in stock (149 of the store's
-- 1,000 catalog products do). Each physical piece keeps its own serial in sku (P-00001), which stays
-- unique, so the reference is indexed for search but no longer unique.
ALTER TABLE pieces DROP CONSTRAINT pieces_reference_key;
CREATE INDEX idx_pieces_reference ON pieces (reference);
