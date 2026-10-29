export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ function: ToolCall }> }
  | { role: 'tool'; content: string; tool_name: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  };
}

export interface LlmReply {
  content: string;
  toolCalls: ToolCall[];
}

/** Port to the language model. Implemented by OllamaClient; replaced by a scripted fake in tests. */
export interface LlmClient {
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LlmReply>;
}
