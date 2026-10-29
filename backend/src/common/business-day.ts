import { PoolClient } from 'pg';
import { AppError } from './app-error';

/** The store's calendar date (YYYY-MM-DD) in its own time zone. At 8 p.m. in Bogotá it is already tomorrow in UTC. */
export function businessDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dayLockKey = (date: string) => `business-day:${date}`;

/**
 * Sales and expenses take a SHARED lock on their day: many can run at the same time.
 * Closing the day takes an EXCLUSIVE lock: it waits for in-flight sales to finish
 * and blocks new ones until the closing is written, so nothing slips in mid-closing.
 */
export async function lockDayShared(client: PoolClient, date: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [dayLockKey(date)]);
}

export async function lockDayExclusive(client: PoolClient, date: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [dayLockKey(date)]);
}

export async function assertDayOpen(client: PoolClient, date: string): Promise<void> {
  const { rows } = await client.query('SELECT 1 FROM cash_closings WHERE business_date = $1', [date]);

  if (rows.length > 0) {
    throw new AppError(409, 'DAY_CLOSED', `Business day ${date} is already closed`);
  }
}

/** Grams with up to 3 decimals, as sent by the UI, to integer milligrams. */
export const gramsToMg = (grams: number) => Math.round(grams * 1000);
export const mgToGrams = (mg: number) => mg / 1000;
