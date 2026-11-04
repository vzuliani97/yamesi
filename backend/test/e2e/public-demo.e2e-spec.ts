import { loadConfig } from '../../src/config';
import { assertDemoDatabase, resetDemoData } from '../../src/database/demo-reset';
import { FilesController, PostgresFileStorage } from '../../src/storage/storage.module';
import { createLot, createPiece, createTestApp, createUser, resetDatabase, TestContext, TINY_PNG } from './helpers';
import { DatabaseService } from '../../src/database/database.service';

describe('Public demo safeguards', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    await ctx.pool.query('TRUNCATE stored_files');
  });

  it('refuses a database whose name is not the confirmed demo database', async () => {
    const { rows } = await ctx.pool.query<{ name: string }>('SELECT current_database() AS name');
    await expect(assertDemoDatabase(ctx.pool, 'yamesi_demo_other')).rejects.toThrow(/Refusing to start/);
    await expect(assertDemoDatabase(ctx.pool, undefined)).rejects.toThrow(/Refusing to start/);
    await expect(assertDemoDatabase(ctx.pool, rows[0].name)).resolves.toBeUndefined();
  });

  it('empties every business table and the invoice counter, keeping the schema', async () => {
    const adminId = await createUser(ctx.pool, 'admin@test.local', 'ADMIN');
    await createPiece(ctx.pool, adminId, await createLot(ctx.pool, adminId));
    await ctx.pool.query('UPDATE invoice_counter SET last_number = 7');
    await ctx.pool.query(`INSERT INTO stored_files (key, content_type, body) VALUES ('pieces/x.png', 'image/png', $1)`, [TINY_PNG]);

    await resetDemoData(ctx.pool);

    const count = async (table: string) => Number((await ctx.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    expect([await count('users'), await count('pieces'), await count('gold_lots'), await count('stored_files')]).toEqual([0, 0, 0, 0]);
    expect((await ctx.pool.query('SELECT last_number FROM invoice_counter')).rows[0].last_number).toBe(0);
    expect(await count('schema_migrations')).toBeGreaterThan(0);
  });

  describe('files kept in PostgreSQL', () => {
    const config = loadConfig({
      ...process.env,
      STORAGE_DRIVER: 'postgres',
      PUBLIC_API_URL: 'https://api.example.com',
    });
    let storage: PostgresFileStorage;
    let controller: FilesController;
    const response = () => ({ setHeader: jest.fn() });

    beforeEach(() => {
      storage = new PostgresFileStorage(ctx.app.get(DatabaseService), config);
      controller = new FilesController(storage);
    });

    it('serves a stored file through a signed link, with headers for a cross-origin image', async () => {
      await storage.put('pieces/a.png', TINY_PNG, 'image/png');
      const link = new URL(await storage.signedUrl('pieces/a.png'));
      expect(link.origin).toBe('https://api.example.com');
      expect(link.pathname).toBe('/api/files/pieces%2Fa.png');

      const res = response();
      const file = await controller.download('pieces/a.png', link.searchParams.get('expires')!, link.searchParams.get('signature')!, res as never);
      expect(file.getStream().read()).toEqual(TINY_PNG);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
      expect(res.setHeader).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'cross-origin');
    });

    it('refuses a changed key, a changed signature and an expired link', async () => {
      await storage.put('pieces/a.png', TINY_PNG, 'image/png');
      await storage.put('receipts/b.png', TINY_PNG, 'image/png');
      const link = new URL(await storage.signedUrl('pieces/a.png'));
      const expires = link.searchParams.get('expires')!;
      const signature = link.searchParams.get('signature')!;

      await expect(controller.download('receipts/b.png', expires, signature, response() as never)).rejects.toMatchObject({ status: 403 });
      await expect(controller.download('pieces/a.png', expires, signature.replace(/^./, signature[0] === 'a' ? 'b' : 'a'), response() as never)).rejects.toMatchObject({ status: 403 });
      expect(storage.isValid('pieces/a.png', expires, signature, Number(expires) + 1)).toBe(false);
    });
  });
});
