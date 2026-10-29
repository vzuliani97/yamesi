import { randomUUID } from 'node:crypto';
import {
  binaryParser,
  createLot,
  createPiece,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  TestContext,
} from './helpers';

describe('Invoicing', () => {
  let ctx: TestContext;
  let adminId: string;
  let token: string;
  let lotId: number;

  const invoice = (pieceIds: number[], options: { key?: string; paymentMethod?: string; customerName?: string } = {}) =>
    ctx
      .http()
      .post('/api/invoices')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({
        customerName: options.customerName ?? 'Cliente de prueba',
        paymentMethod: options.paymentMethod ?? 'CASH',
        pieceIds,
      });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    adminId = await createUser(ctx.pool, 'admin@test.local', 'ADMIN');
    await createUser(ctx.pool, 'vendedor@test.local', 'SELLER');
    token = await login(ctx, 'vendedor@test.local');
    lotId = await createLot(ctx.pool, adminId, { grams: 100, costPerGram: 300_000 });
  });

  it('sells pieces, freezes their cost and stores a PDF', async () => {
    const ring = await createPiece(ctx.pool, adminId, lotId, { price: 1_500_000, goldMg: 3_000, laborCost: 100_000 });
    const chain = await createPiece(ctx.pool, adminId, lotId, { price: 4_000_000, goldMg: 10_000, laborCost: 300_000 });

    const response = await invoice([ring, chain]);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ number: 1, total: 5_500_000, paymentMethod: 'CASH' });
    expect(response.body.data.items).toHaveLength(2);

    // Cost = grams × lot price per gram + labor: ring 3 g → 900.000 + 100.000; chain 10 g → 3.000.000 + 300.000.
    const { rows } = await ctx.pool.query('SELECT piece_id, cost FROM invoice_items ORDER BY piece_id');
    expect(rows).toEqual([
      { piece_id: ring, cost: 1_000_000 },
      { piece_id: chain, cost: 3_300_000 },
    ]);

    const pdf = await ctx
      .http()
      .get(`/api/invoices/${response.body.data.id}/pdf`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser);

    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect([...ctx.storage.objects.keys()].some((key) => key.endsWith('/000001.pdf'))).toBe(true);
  });

  it('numbers concurrent invoices without gaps or duplicates', async () => {
    const pieces = await Promise.all(Array.from({ length: 8 }, () => createPiece(ctx.pool, adminId, lotId)));

    const responses = await Promise.all(pieces.map((piece) => invoice([piece])));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(responses.map((r) => r.body.data.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('sells a piece only once when two sales race for it', async () => {
    const piece = await createPiece(ctx.pool, adminId, lotId);

    const [a, b] = await Promise.all([invoice([piece]), invoice([piece])]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe('PIECE_NOT_AVAILABLE');
  });

  it('rejects the whole sale if one piece is unavailable, without burning an invoice number', async () => {
    const sold = await createPiece(ctx.pool, adminId, lotId);
    const available = await createPiece(ctx.pool, adminId, lotId);
    await invoice([sold]).expect(201);

    const failed = await invoice([available, sold]);
    expect(failed.status).toBe(409);
    expect(failed.body.error.details).toEqual({ unavailable: [sold] });

    // The available piece was not left marked as sold, and the next number is 2: no gap.
    const next = await invoice([available]);
    expect(next.status).toBe(201);
    expect(next.body.data.number).toBe(2);
  });

  it('replays a retried request and rejects a reused key with different data', async () => {
    const piece = await createPiece(ctx.pool, adminId, lotId);
    const other = await createPiece(ctx.pool, adminId, lotId);
    const key = randomUUID();

    const [first, retry] = await Promise.all([invoice([piece], { key }), invoice([piece], { key })]);
    expect([first.status, retry.status].sort()).toEqual([200, 201]);
    expect(first.body.data.number).toBe(retry.body.data.number);

    const reused = await invoice([other], { key });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('records each sale in the audit log, readable only by admins', async () => {
    const piece = await createPiece(ctx.pool, adminId, lotId);
    await invoice([piece]).expect(201);

    await ctx.http().get('/api/audit').set('Authorization', `Bearer ${token}`).expect(403);

    const adminToken = await login(ctx, 'admin@test.local');
    const audit = await ctx.http().get('/api/audit').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(audit.body[0]).toMatchObject({ action: 'INVOICE_CREATED', entity: 'invoice', actor: 'vendedor' });
  });
});
