-- Jewelry is made from gold alloys: 24k (pure gold) is too soft to fabricate pieces, so new lots
-- accept only fabrication karats. NOT VALID keeps any historical rows readable while enforcing new ones.
ALTER TABLE gold_lots DROP CONSTRAINT IF EXISTS gold_lots_karat_check;
ALTER TABLE gold_lots ADD CONSTRAINT gold_lots_karat_check CHECK (karat IN (10, 14, 18)) NOT VALID;
