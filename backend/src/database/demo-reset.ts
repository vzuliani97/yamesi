import { Pool } from 'pg';

/**
 * Refuses to go on unless the connected database is the one named in DEMO_DATABASE_CONFIRMATION. The public
 * demo wipes its data on every boot, so a wrong DATABASE_URL must stop the API instead of emptying a real base.
 */
export async function assertDemoDatabase(pool: Pool, expected: string | undefined): Promise<void> {
  const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
  if (!expected || rows[0].name !== expected) {
    throw new Error('Refusing to start: the connected database is not the one named in DEMO_DATABASE_CONFIRMATION');
  }
}

/** Empties every business table in one transaction, so the seed can load the synthetic data again. */
export async function resetDemoData(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE audit_log, invoice_items, invoices, expenses, cash_closings, pieces, gold_lots, users, stored_files
       RESTART IDENTITY CASCADE`,
    );
    await client.query('UPDATE invoice_counter SET last_number = 0');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
