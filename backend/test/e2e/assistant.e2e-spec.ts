import { randomUUID } from 'node:crypto';
import { ChatMessage, LlmClient, LlmReply, ToolCall } from '../../src/assistant/llm';
import { businessDate } from '../../src/common/business-day';
import { createLot, createPiece, createTestApp, createUser, login, resetDatabase, TestContext } from './helpers';

/**
 * Stands in for the model: asks for one tool, then answers with the data the API handed back.
 * The tools themselves are the real ones, running real SQL.
 */
class OneToolLlm implements LlmClient {
  readonly model = 'test-double';
  call: ToolCall = { name: 'sales_summary', arguments: {} };

  async chat(messages: ChatMessage[]): Promise<LlmReply> {
    const last = messages.at(-1)!;
    if (last.role === 'tool') {
      return { content: `DATA ${last.content}`, toolCalls: [] };
    }
    return { content: '', toolCalls: [this.call] };
  }
}

describe('AI assistant over real business data', () => {
  const llm = new OneToolLlm();
  let ctx: TestContext;
  let adminToken: string;
  const today = () => businessDate('America/Bogota');

  const ask = (question: string, token = adminToken) =>
    ctx.http().post('/api/assistant/ask').set('Authorization', `Bearer ${token}`).send({ question });

  beforeAll(async () => {
    ctx = await createTestApp({ llm });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.pool);
    const adminId = await createUser(ctx.pool, 'admin@test.local', 'ADMIN');
    await createUser(ctx.pool, 'vendedor@test.local', 'SELLER');
    adminToken = await login(ctx, 'admin@test.local');
    const sellerToken = await login(ctx, 'vendedor@test.local');

    const lotId = await createLot(ctx.pool, adminId);
    const piece = await createPiece(ctx.pool, adminId, lotId, { price: 2_750_000 });
    await ctx
      .http()
      .post('/api/invoices')
      .set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ customerName: 'Cliente Confidencial', customerDocumentType: 'CC', customerDocument: '1020304050', paymentMethod: 'CARD', pieceIds: [piece] })
      .expect(201);
  });

  it('answers from the result of a real read-only query', async () => {
    llm.call = { name: 'sales_summary', arguments: { from: today(), to: today() } };

    const response = await ask('¿Cuánto vendimos hoy?');

    expect(response.status).toBe(200);
    expect(response.body.toolsUsed).toEqual([{ name: 'sales_summary', arguments: { from: today(), to: today() }, ok: true }]);
    expect(response.body.answer).toContain('"invoices":1');
    expect(response.body.answer).toContain('"revenueCop":2750000');
    expect(response.body.answer).toContain('"CARD":2750000');
  });

  it('never exposes customer names or documents to the model', async () => {
    llm.call = { name: 'sales_by_category', arguments: { from: today(), to: today() } };

    const response = await ask('¿Qué categorías se vendieron hoy?');

    expect(response.body.answer).toContain('"category":"ANILLO"');
    expect(response.body.answer).not.toContain('Confidencial');
    expect(response.body.answer).not.toContain('1020304050');
  });

  it('rejects invalid arguments proposed by the model', async () => {
    llm.call = { name: 'margins', arguments: { from: '2026-12-31', to: '2026-01-01' } };

    const response = await ask('Márgenes del año');

    expect(response.body.toolsUsed[0].ok).toBe(false);
    expect(response.body.answer).toContain('must not be after');
  });

  it('is only available to admins', async () => {
    const sellerToken = await login(ctx, 'vendedor@test.local');
    await ask('¿Cuánto vendimos?', sellerToken).expect(403);
  });
});
