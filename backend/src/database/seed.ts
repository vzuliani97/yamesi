import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { AppConfig } from '../config';
import { gramsToMg } from '../common/business-day';
import { FileStorage } from '../storage/storage.module';

/** A piece from the store's public catalog: reference, name, size, gold weight, price and photo are real. */
interface CatalogPiece {
  reference: string;
  name: string;
  category: 'ANILLO' | 'CADENA' | 'ARETES' | 'PULSERA' | 'DIJE' | 'OTRO';
  size: string | null;
  grams: number;
  /** Synthetic: workmanship, plus the stones for the two gem rings. */
  laborCost: number;
  price: number;
  photo: string;
  /** Registered by `scripts/demo-scenario.sh` through the inventory API instead of the seed. */
  arrivesDuringDemo?: boolean;
}

// dist/database/seed.js and src/database/seed.ts are both two levels below the backend root.
const ASSETS = path.resolve(__dirname, '../../demo-assets');

/**
 * Demo data. Pieces come from the store's catalog; users, gold lots, costs and customers are synthetic.
 * Runs only on an empty database, so it never touches real records.
 */
export async function seedDemoData(pool: Pool, config: AppConfig, storage: FileStorage): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query('SELECT 1 FROM users LIMIT 1');
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return;
    }

    const passwordHash = await bcrypt.hash(config.DEMO_PASSWORD, 10);
    const { rows: users } = await client.query<{ id: string; role: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES
         ('admin@yamesi.local', 'Administración', $1, 'ADMIN'),
         ('vendedor@yamesi.local', 'Vendedor de mostrador', $1, 'SELLER')
       RETURNING id, role`,
      [passwordHash],
    );
    const adminId = users.find((user) => user.role === 'ADMIN')!.id;

    const { rows: lots } = await client.query<{ id: number; supplier: string }>(
      `INSERT INTO gold_lots (karat, supplier, total_mg, remaining_mg, cost_per_gram, purchased_on, created_by) VALUES
         (18, 'Fundidora Andina (ficticia)', 250000, 250000, 320000, CURRENT_DATE - 20, $1),
         (18, 'Metales del Valle (ficticia)', 100000, 100000, 335000, CURRENT_DATE - 10, $1)
       RETURNING id, supplier`,
      [adminId],
    );
    const [andina, valle] = lots.map((lot) => lot.id);

    const catalog = JSON.parse(await readFile(path.join(ASSETS, 'catalog.json'), 'utf8')) as CatalogPiece[];

    for (const [index, piece] of catalog.filter((entry) => !entry.arrivesDuringDemo).entries()) {
      // Every third piece comes from the second lot, so the reports show two lots in use.
      const lotId = index % 3 === 2 ? valle : andina;
      const goldMg = gramsToMg(piece.grams);
      const imageKey = `pieces/catalog/${piece.photo}`;
      await storage.put(imageKey, await readFile(path.join(ASSETS, 'pieces', piece.photo)), 'image/jpeg');

      await client.query('UPDATE gold_lots SET remaining_mg = remaining_mg - $1 WHERE id = $2', [goldMg, lotId]);
      await client.query(
        `INSERT INTO pieces (name, reference, size, category, lot_id, gold_mg, labor_cost, price, image_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [piece.name, piece.reference, piece.size, piece.category, lotId, goldMg, piece.laborCost, piece.price, imageKey, adminId],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
