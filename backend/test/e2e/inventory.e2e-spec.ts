import { createLot, createPiece, createTestApp, createUser, login, resetDatabase, TestContext, TINY_PNG } from './helpers';

describe('Gold lots and pieces', () => {
  let ctx: TestContext;
  let adminId: string;
  let adminToken: string;
  let sellerToken: string;

  const createPieceRequest = (fields: Record<string, string | number>, image?: { body: Buffer; type: string }) => {
    const req = ctx.http().post('/api/pieces').set('Authorization', `Bearer ${adminToken}`);
    for (const [name, value] of Object.entries(fields)) {
      req.field(name, String(value));
    }
    if (image) {
      req.attach('image', image.body, { filename: 'foto.png', contentType: image.type });
    }
    return req;
  };

  const remainingMg = async (lotId: number) =>
    (await ctx.pool.query('SELECT remaining_mg FROM gold_lots WHERE id = $1', [lotId])).rows[0].remaining_mg;

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
  });

  it('registers a gold lot with milligram precision', async () => {
    const response = await ctx
      .http()
      .post('/api/lots')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ karat: 18, supplier: 'Fundidora', grams: 125.375, costPerGram: 320_000, purchasedOn: '2026-10-01' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ code: 'L-00001', totalGrams: 125.375, remainingGrams: 125.375 });
  });

  it('accepts only 18k gold: 24k and other karats are rejected', async () => {
    const lot = (karat: number) =>
      ctx
        .http()
        .post('/api/lots')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ karat, supplier: 'Fundidora', grams: 10, costPerGram: 320_000, purchasedOn: '2026-10-01' });

    expect([(await lot(24)).status, (await lot(14)).status, (await lot(10)).status]).toEqual([400, 400, 400]);
    expect((await lot(18)).status).toBe(201);
  });

  it('only lets admins register lots', async () => {
    await ctx
      .http()
      .post('/api/lots')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ karat: 18, supplier: 'Fundidora', grams: 10, costPerGram: 320_000, purchasedOn: '2026-10-01' })
      .expect(403);
  });

  it('creates a piece with a photo, catalog reference and size, and consumes gold from its lot', async () => {
    const lotId = await createLot(ctx.pool, adminId, { grams: 50 });
    const fields = { name: 'Anillo', category: 'ANILLO', lotId, grams: 3.25, laborCost: 120_000, price: 1_400_000 };

    const response = await createPieceRequest(
      { ...fields, reference: 'an-dam-172', size: 'Talla 7' },
      { body: TINY_PNG, type: 'image/png' },
    );

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ sku: 'P-00001', reference: 'AN-DAM-172', size: 'Talla 7', grams: 3.25, status: 'IN_STOCK', karat: 18 });
    expect(response.body.imageUrl).toMatch(/^memory:\/\/pieces\/.+\.png$/);
    expect(await remainingMg(lotId)).toBe(50_000 - 3_250);

    // A reference identifies one piece; the rejected request rolls back and leaves the lot untouched.
    const duplicate = await createPieceRequest({ ...fields, reference: 'AN-DAM-172' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('REFERENCE_TAKEN');
    expect(await remainingMg(lotId)).toBe(50_000 - 3_250);

    // Empty optional form fields mean "no reference", so pieces without one do not collide.
    const plain = await createPieceRequest({ ...fields, reference: '', size: '' });
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({ reference: null, size: null });
  });

  it('refuses to use more gold than the lot has left', async () => {
    const lotId = await createLot(ctx.pool, adminId, { grams: 5 });

    const response = await createPieceRequest({ name: 'Cadena', category: 'CADENA', lotId, grams: 8, laborCost: 0, price: 2_000_000 });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'INSUFFICIENT_GOLD', details: { remainingGrams: 5, requestedGrams: 8 } });
    expect(await remainingMg(lotId)).toBe(5_000);
  });

  it('rejects a file that claims to be an image but is not', async () => {
    const lotId = await createLot(ctx.pool, adminId, { grams: 50 });

    const response = await createPieceRequest(
      { name: 'Dije', category: 'DIJE', lotId, grams: 1, laborCost: 0, price: 500_000 },
      { body: Buffer.from('<script>alert(1)</script> padding padding'), type: 'image/png' },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_IMAGE');
    expect(await remainingMg(lotId)).toBe(50_000);
  });

  it('reports gold by karat across lots, stock and sales', async () => {
    const lot18 = await createLot(ctx.pool, adminId, { karat: 18, grams: 100, costPerGram: 300_000 });
    const lot18b = await createLot(ctx.pool, adminId, { karat: 18, grams: 20, costPerGram: 400_000 });
    await createPiece(ctx.pool, adminId, lot18, { goldMg: 10_000 });
    const sold = await createPiece(ctx.pool, adminId, lot18b, { goldMg: 5_000 });
    await ctx.pool.query("UPDATE pieces SET status = 'SOLD' WHERE id = $1", [sold]);

    const response = await ctx.http().get('/api/reports/gold-inventory').set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { karat: 18, gramsInLots: 105, gramsInStock: 10, gramsSold: 5, lotsValueAtCost: 33_000_000 },
    ]);
  });
});
