import { randomUUID } from 'node:crypto';
import { computeCufe } from '../../src/invoices/cufe';
import { dianDateTime } from '../../src/invoices/invoices.service';
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

  describe('Colombian sales invoice', () => {
    const colombianSale = (pieceIds: number[], key: string, overrides: Record<string, unknown> = {}) =>
      ctx
        .http()
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({
          customerName: 'María Fernanda Ríos',
          customerDocumentType: 'CC',
          customerDocument: '1020304050',
          customerEmail: 'Maria.Rios@Example.com',
          customerPhone: '+57 300 123 4567',
          customerAddress: 'Calle 10 # 43-12, Medellín',
          paymentMethod: 'CARD',
          paymentReference: 'VOUCHER-0099',
          pieceIds,
          ...overrides,
        });

    it('discriminates 19% VAT per line, stores the buyer and issues a CUFE that matches the DIAN formula', async () => {
      const ring = await createPiece(ctx.pool, adminId, lotId, { price: 1_190_000, goldMg: 3_000, laborCost: 100_000 });
      const chain = await createPiece(ctx.pool, adminId, lotId, { price: 1_650_000, goldMg: 5_000, laborCost: 100_000 });

      const response = await colombianSale([ring, chain], randomUUID());

      expect(response.status).toBe(201);
      const data = response.body.data;
      expect(data).toMatchObject({
        fullNumber: 'FV-000001',
        customerDocumentType: 'CC',
        customerDocument: '1020304050',
        customerEmail: 'maria.rios@example.com',
        paymentMethod: 'CARD',
        paymentReference: 'VOUCHER-0099',
        subtotal: 1_000_000 + 1_386_555,
        vatTotal: 190_000 + 263_445,
        total: 2_840_000,
      });
      expect(data.items).toEqual([
        expect.objectContaining({ taxBase: 1_000_000, vat: 190_000, price: 1_190_000, vatRate: 19 }),
        expect.objectContaining({ taxBase: 1_386_555, vat: 263_445, price: 1_650_000, vatRate: 19 }),
      ]);

      // Recompute the CUFE from what was stored: same inputs, same SHA-384, as a DIAN validator would.
      const { rows } = await ctx.pool.query('SELECT issued_at, cufe FROM invoices WHERE id = $1', [data.id]);
      const { date, time } = dianDateTime(rows[0].issued_at, 'America/Bogota');
      expect(rows[0].cufe).toBe(
        computeCufe({
          numFac: 'FV1', fecFac: date, horFac: time, valFac: '2386555.00', valImp1: '453445.00', valImp2: '0.00',
          valImp3: '0.00', valTot: '2840000.00', nitOfe: '000000000', numAdq: '1020304050',
          clTec: 'clave-tecnica-de-demostracion', tipoAmbiente: '2',
        }),
      );
      expect(time).toMatch(/^\d{2}:\d{2}:\d{2}-05:00$/);

      const pdf = await ctx.http().get(`/api/invoices/${data.id}/pdf`).set('Authorization', `Bearer ${token}`).buffer(true).parse(binaryParser);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-disposition']).toContain('factura-FV-000001.pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });

    it('uses the final-consumer id 222222222222 in the CUFE when no document is given', async () => {
      const piece = await createPiece(ctx.pool, adminId, lotId, { price: 500_000, goldMg: 1_000, laborCost: 50_000 });

      const response = await colombianSale([piece], randomUUID(), {
        customerDocumentType: undefined, customerDocument: undefined, paymentMethod: 'CASH', paymentReference: undefined,
      });

      expect(response.status).toBe(201);
      const { rows } = await ctx.pool.query('SELECT issued_at, cufe FROM invoices WHERE id = $1', [response.body.data.id]);
      const { date, time } = dianDateTime(rows[0].issued_at, 'America/Bogota');
      const expected = computeCufe({
        numFac: 'FV1', fecFac: date, horFac: time, valFac: '420168.00', valImp1: '79832.00', valImp2: '0.00', valImp3: '0.00',
        valTot: '500000.00', nitOfe: '000000000', numAdq: '222222222222', clTec: 'clave-tecnica-de-demostracion', tipoAmbiente: '2',
      });
      expect(rows[0].cufe).toBe(expected);
    });

    it('is idempotent with every invoice field: a replay returns the same invoice and CUFE; changed data is rejected', async () => {
      const piece = await createPiece(ctx.pool, adminId, lotId, { price: 1_000_000, goldMg: 2_000, laborCost: 50_000 });
      const key = randomUUID();

      const first = await colombianSale([piece], key);
      const replay = await colombianSale([piece], key);
      const otherEmail = await colombianSale([piece], key, { customerEmail: 'otra@example.com' });

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body.meta.replayed).toBe(true);
      expect(replay.body.data).toMatchObject({ id: first.body.data.id, fullNumber: 'FV-000001', cufe: first.body.data.cufe });
      expect(otherEmail.status).toBe(409);
      expect(otherEmail.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM invoices');
      expect(rows[0].n).toBe(1);
    });

    it('validates buyer and payment data', async () => {
      const piece = await createPiece(ctx.pool, adminId, lotId, { price: 1_000_000, goldMg: 2_000, laborCost: 50_000 });

      const noType = await colombianSale([piece], randomUUID(), { customerDocumentType: undefined });
      const badEmail = await colombianSale([piece], randomUUID(), { customerEmail: 'no-es-un-correo' });
      const cashWithReference = await colombianSale([piece], randomUUID(), { paymentMethod: 'CASH' });

      expect([noType.status, badEmail.status, cashWithReference.status]).toEqual([400, 400, 400]);
    });

    it('refuses to number outside the authorized DIAN range, without consuming a number or a piece', async () => {
      const piece = await createPiece(ctx.pool, adminId, lotId, { price: 1_000_000, goldMg: 2_000, laborCost: 50_000 });
      await ctx.pool.query('UPDATE invoice_counter SET last_number = 100000');

      const response = await colombianSale([piece], randomUUID());

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('NUMBERING_RANGE_EXHAUSTED');
      const counter = await ctx.pool.query('SELECT last_number FROM invoice_counter');
      const status = await ctx.pool.query('SELECT status FROM pieces WHERE id = $1', [piece]);
      expect(counter.rows[0].last_number).toBe(100000);
      expect(status.rows[0].status).toBe('IN_STOCK');
    });
  });
});
