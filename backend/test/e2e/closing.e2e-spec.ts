import { randomUUID } from 'node:crypto';
import { businessDate } from '../../src/common/business-day';
import { createLot, createPiece, createTestApp, createUser, login, resetDatabase, TestContext, TINY_PNG } from './helpers';

describe('Petty cash and daily cash closing', () => {
  let ctx: TestContext;
  let adminId: string;
  let adminToken: string;
  let sellerToken: string;
  let lotId: number;
  const today = () => businessDate('America/Bogota');

  const sell = (pieceId: number, paymentMethod: 'CASH' | 'CARD') =>
    ctx
      .http()
      .post('/api/invoices')
      .set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ customerName: 'Cliente', paymentMethod, pieceIds: [pieceId] });

  const expense = (amount: number, receipt?: Buffer) => {
    const req = ctx
      .http()
      .post('/api/expenses')
      .set('Authorization', `Bearer ${sellerToken}`)
      .field('category', 'TRANSPORTE')
      .field('description', 'Envío de mercancía')
      .field('amount', String(amount));
    return receipt ? req.attach('receipt', receipt, { filename: 'recibo.png', contentType: 'image/png' }) : req;
  };

  const close = (countedCash: number) =>
    ctx.http().post('/api/closings').set('Authorization', `Bearer ${adminToken}`).send({ countedCash });

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
    adminToken = await login(ctx, 'admin@test.local');
    sellerToken = await login(ctx, 'vendedor@test.local');
    lotId = await createLot(ctx.pool, adminId);
  });

  it('records petty cash expenses with a receipt photo', async () => {
    const response = await expense(35_000, TINY_PNG);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ amount: 35_000, businessDate: today(), category: 'TRANSPORTE' });
    expect(response.body.receiptUrl).toMatch(/^memory:\/\/receipts\//);
  });

  it('expects opening cash + cash sales − expenses, ignoring card sales', async () => {
    // Yesterday's closing left 200.000 in the drawer: today's opening cash.
    await ctx.pool.query(
      `INSERT INTO cash_closings (business_date, opening_cash, cash_sales, expenses, expected_cash, counted_cash, difference, closed_by)
       VALUES ($1::date - 1, 0, 0, 0, 200000, 200000, 0, $2)`,
      [today(), adminId],
    );
    await sell(await createPiece(ctx.pool, adminId, lotId, { price: 1_000_000 }), 'CASH').expect(201);
    await sell(await createPiece(ctx.pool, adminId, lotId, { price: 3_000_000 }), 'CARD').expect(201);
    await expense(50_000).expect(201);

    const summary = await ctx.http().get('/api/closings/today').set('Authorization', `Bearer ${sellerToken}`);
    expect(summary.body).toMatchObject({
      openingCash: 200_000,
      salesByMethod: { CASH: 1_000_000, CARD: 3_000_000, TRANSFER: 0 },
      invoiceCount: 2,
      expenses: 50_000,
      expectedCash: 1_150_000,
      closed: false,
    });

    // 10.000 pesos missing from the drawer.
    const closed = await close(1_140_000);
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ closed: true, closing: { countedCash: 1_140_000, difference: -10_000 } });
  });

  it('locks the day once closed', async () => {
    const piece = await createPiece(ctx.pool, adminId, lotId);
    await close(0).expect(201);

    const lateSale = await sell(piece, 'CASH');
    expect(lateSale.status).toBe(409);
    expect(lateSale.body.error.code).toBe('DAY_CLOSED');

    const lateExpense = await expense(10_000);
    expect(lateExpense.status).toBe(409);
    expect(lateExpense.body.error.code).toBe('DAY_CLOSED');

    const secondClose = await close(0);
    expect(secondClose.status).toBe(409);
    expect(secondClose.body.error.code).toBe('DAY_ALREADY_CLOSED');
  });

  it('only lets admins close the day', async () => {
    await ctx.http().post('/api/closings').set('Authorization', `Bearer ${sellerToken}`).send({ countedCash: 0 }).expect(403);
  });

  it('reports gross margin from the cost frozen at sale time', async () => {
    // 2 g at 300.000/g + 100.000 labor = 700.000 cost, sold for 1.000.000.
    await sell(await createPiece(ctx.pool, adminId, lotId, { price: 1_000_000, goldMg: 2_000, laborCost: 100_000 }), 'CASH').expect(201);
    // A later change to the lot price must not rewrite past margins.
    await ctx.pool.query('UPDATE gold_lots SET cost_per_gram = 999999 WHERE id = $1', [lotId]);

    const response = await ctx
      .http()
      .get(`/api/reports/margins?from=${today()}&to=${today()}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.body).toMatchObject({ invoices: 1, revenue: 1_000_000, cost: 700_000, grossMargin: 300_000, marginPercent: 30 });
  });
});
