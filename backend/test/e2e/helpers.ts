import 'reflect-metadata';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { LLM_CLIENT, LlmClient } from '../../src/assistant/llm';
import { APP_CONFIG, AppConfig } from '../../src/config';
import { DatabaseService } from '../../src/database/database.service';
import { runMigrations } from '../../src/database/migrate';
import { configureApp } from '../../src/setup';
import { FILE_STORAGE, InMemoryFileStorage } from '../../src/storage/storage.module';

export const PASSWORD = 'correct-horse-battery';

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export interface TestContext {
  app: NestExpressApplication;
  pool: Pool;
  storage: InMemoryFileStorage;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(options: { llm?: LlmClient } = {}): Promise<TestContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.llm) {
    builder = builder.overrideProvider(LLM_CLIENT).useValue(options.llm);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, app.get<AppConfig>(APP_CONFIG));
  await app.listen(0, '127.0.0.1');

  const pool = app.get(DatabaseService).pool;
  await runMigrations(pool);

  return {
    app,
    pool,
    storage: app.get(FILE_STORAGE) as InMemoryFileStorage,
    http: () => request(app.getHttpServer()),
  };
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE audit_log, invoice_items, invoices, expenses, cash_closings, pieces, gold_lots, users
     RESTART IDENTITY CASCADE`,
  );
  await pool.query('UPDATE invoice_counter SET last_number = 0');
}

let cachedHash: string | undefined;

export async function createUser(pool: Pool, email: string, role: 'ADMIN' | 'SELLER'): Promise<string> {
  cachedHash ??= await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, email.split('@')[0], cachedHash, role],
  );
  return rows[0].id;
}

export async function login(ctx: TestContext, email: string): Promise<string> {
  const response = await ctx.http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return response.body.accessToken as string;
}

export async function createLot(
  pool: Pool,
  adminId: string,
  { karat = 18, grams = 100, costPerGram = 300_000 }: { karat?: number; grams?: number; costPerGram?: number } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO gold_lots (karat, supplier, total_mg, remaining_mg, cost_per_gram, purchased_on, created_by)
     VALUES ($1, 'Proveedor de prueba', $2, $2, $3, CURRENT_DATE, $4) RETURNING id`,
    [karat, Math.round(grams * 1000), costPerGram, adminId],
  );
  return rows[0].id;
}

/** Inserts a piece directly, consuming gold from its lot like the API does. */
export async function createPiece(
  pool: Pool,
  adminId: string,
  lotId: number,
  { price = 1_000_000, goldMg = 2_000, laborCost = 100_000 }: { price?: number; goldMg?: number; laborCost?: number } = {},
): Promise<number> {
  await pool.query('UPDATE gold_lots SET remaining_mg = remaining_mg - $1 WHERE id = $2', [goldMg, lotId]);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pieces (name, category, lot_id, gold_mg, labor_cost, price, created_by)
     VALUES ('Pieza de prueba', 'ANILLO', $1, $2, $3, $4, $5) RETURNING id`,
    [lotId, goldMg, laborCost, price, adminId],
  );
  return rows[0].id;
}

/** Supertest does not buffer binary bodies by default. */
export const binaryParser = (res: unknown, callback: (err: Error | null, body: Buffer) => void) => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};
