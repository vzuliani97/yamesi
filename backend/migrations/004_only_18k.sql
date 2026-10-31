-- The store works only with 18k gold (ley 750). NOT VALID keeps historical rows readable while enforcing new ones.
ALTER TABLE gold_lots DROP CONSTRAINT IF EXISTS gold_lots_karat_check;
ALTER TABLE gold_lots ADD CONSTRAINT gold_lots_karat_check CHECK (karat = 18) NOT VALID;
