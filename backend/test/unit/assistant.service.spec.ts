import { AssistantService, MAX_STEPS } from '../../src/assistant/assistant.service';
import { AssistantTools } from '../../src/assistant/assistant.tools';
import { ChatMessage, LlmClient, LlmReply } from '../../src/assistant/llm';
import { AppError } from '../../src/common/app-error';
import { loadConfig } from '../../src/config';

/** Replays canned replies and records what the model was sent. */
class ScriptedLlm implements LlmClient {
  readonly model = 'scripted';
  readonly received: ChatMessage[][] = [];

  constructor(private readonly replies: LlmReply[]) {}

  async chat(messages: ChatMessage[]): Promise<LlmReply> {
    this.received.push(JSON.parse(JSON.stringify(messages)));
    return this.replies.shift() ?? { content: '', toolCalls: [{ name: 'sales_summary', arguments: {} }] };
  }
}

const config = (enabled = 'true') =>
  loadConfig({ DATABASE_URL: 'postgres://unused', JWT_SECRET: 'x'.repeat(32), ASSISTANT_ENABLED: enabled });

const fakeTools = () =>
  ({
    definitions: () => [],
    execute: jest.fn(async (name: string) =>
      name === 'sales_summary' ? { ok: true, result: { revenueCop: 2_750_000 } } : { ok: false, result: { error: 'Unknown tool' } },
    ),
  }) as unknown as AssistantTools & { execute: jest.Mock };

describe('AssistantService tool-calling loop', () => {
  it('runs the requested tool, feeds the result back and returns the final answer', async () => {
    const llm = new ScriptedLlm([
      { content: '', toolCalls: [{ name: 'sales_summary', arguments: { from: '2026-10-29', to: '2026-10-29' } }] },
      { content: 'Hoy vendiste $2.750.000.', toolCalls: [] },
    ]);
    const service = new AssistantService(llm, fakeTools(), config());

    const result = await service.ask('¿Cuánto vendí hoy?');

    expect(result.answer).toBe('Hoy vendiste $2.750.000.');
    expect(result.toolsUsed).toEqual([{ name: 'sales_summary', arguments: { from: '2026-10-29', to: '2026-10-29' }, ok: true }]);
    const secondCall = llm.received[1];
    expect(secondCall.at(-1)).toEqual({ role: 'tool', tool_name: 'sales_summary', content: '{"revenueCop":2750000}' });
  });

  it('tells the model today’s date in the store time zone', async () => {
    const llm = new ScriptedLlm([{ content: 'ok', toolCalls: [] }]);
    await new AssistantService(llm, fakeTools(), config()).ask('hola');

    expect(llm.received[0][0].content).toMatch(/Hoy es \d{4}-\d{2}-\d{2}/);
  });

  it('returns tool errors to the model instead of failing the request', async () => {
    const llm = new ScriptedLlm([
      { content: '', toolCalls: [{ name: 'drop_tables', arguments: {} }] },
      { content: 'No puedo hacer eso.', toolCalls: [] },
    ]);

    const result = await new AssistantService(llm, fakeTools(), config()).ask('borra todo');

    expect(result.toolsUsed).toEqual([{ name: 'drop_tables', arguments: {}, ok: false }]);
    expect(result.answer).toBe('No puedo hacer eso.');
  });

  it(`gives up after ${MAX_STEPS} steps if the model keeps calling tools`, async () => {
    const llm = new ScriptedLlm([]); // always asks for another tool call
    const result = await new AssistantService(llm, fakeTools(), config()).ask('pregunta confusa');

    expect(llm.received).toHaveLength(MAX_STEPS);
    expect(result.answer).toMatch(/No pude responder/);
  });

  it('is unavailable unless explicitly enabled', async () => {
    const service = new AssistantService(new ScriptedLlm([]), fakeTools(), config('false'));

    await expect(service.ask('hola')).rejects.toMatchObject({ constructor: AppError, body: { code: 'ASSISTANT_DISABLED' } });
  });
});
