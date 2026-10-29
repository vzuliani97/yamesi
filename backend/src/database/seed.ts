import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { AppConfig } from '../config';

/** Synthetic demo data. Runs only on an empty database, so it never touches real records. */
export async function seedDemoData(pool: Pool, config: AppConfig): Promise<void> {
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

    const { rows: lots } = await client.query<{ id: number; karat: number }>(
      `INSERT INTO gold_lots (karat, supplier, total_mg, remaining_mg, cost_per_gram, purchased_on, created_by) VALUES
         (18, 'Fundidora Andina (ficticia)', 250000, 250000, 320000, CURRENT_DATE - 20, $1),
         (24, 'Metales del Valle (ficticia)', 100000, 100000, 430000, CURRENT_DATE - 10, $1)
       RETURNING id, karat`,
      [adminId],
    );
    const lot18 = lots.find((lot) => lot.karat === 18)!.id;
    const lot24 = lots.find((lot) => lot.karat === 24)!.id;

    const pieces: Array<[string, string, number, number, number, number]> = [
      ['Anillo solitario', 'ANILLO', lot18, 3500, 180000, 1650000],
      ['Cadena tejido lazo 50 cm', 'CADENA', lot18, 12000, 350000, 5200000],
      ['Aretes argolla pequeña', 'ARETES', lot18, 2800, 150000, 1350000],
      ['Pulsera esclava', 'PULSERA', lot18, 9500, 300000, 4150000],
      ['Dije corazón', 'DIJE', lot24, 2000, 120000, 1200000],
      ['Anillo de compromiso', 'ANILLO', lot24, 4200, 250000, 2600000],
    ];

    for (const [name, category, lotId, goldMg, laborCost, price] of pieces) {
      await client.query('UPDATE gold_lots SET remaining_mg = remaining_mg - $1 WHERE id = $2', [goldMg, lotId]);
      await client.query(
        `INSERT INTO pieces (name, category, lot_id, gold_mg, labor_cost, price, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [name, category, lotId, goldMg, laborCost, price, adminId],
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
