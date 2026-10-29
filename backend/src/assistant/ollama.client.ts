import { AppError } from '../common/app-error';
import { AppConfig } from '../config';
import { ChatMessage, LlmClient, LlmReply, ToolDefinition } from './llm';

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
  };
}

/** Talks to a local Ollama server: the model runs on our own machine, so business data never leaves it. */
export class OllamaClient implements LlmClient {
  readonly model: string;

  constructor(private readonly config: AppConfig) {
    this.model = config.OLLAMA_MODEL;
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LlmReply> {
    let response: Response;

    try {
      response = await fetch(`${this.config.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          stream: false,
          // Deterministic answers: the same question over the same data gives the same reply.
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(this.config.ASSISTANT_TIMEOUT_MS),
      });
    } catch {
      throw new AppError(503, 'ASSISTANT_UNAVAILABLE', 'The language model is not reachable');
    }

    if (!response.ok) {
      throw new AppError(503, 'ASSISTANT_UNAVAILABLE', `The language model answered HTTP ${response.status}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    return {
      content: data.message?.content?.trim() ?? '',
      toolCalls: (data.message?.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        arguments:
          typeof call.function.arguments === 'string' ? safeParse(call.function.arguments) : call.function.arguments,
      })),
    };
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
