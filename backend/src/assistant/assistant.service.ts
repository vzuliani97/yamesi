import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { businessDate } from '../common/business-day';
import { APP_CONFIG, AppConfig } from '../config';
import { AssistantTools } from './assistant.tools';
import { ChatMessage, LLM_CLIENT, LlmClient } from './llm';

export const MAX_STEPS = 4;

export interface AssistantAnswer {
  answer: string;
  /** What the answer is based on, so the user can check it. */
  toolsUsed: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean }>;
  model: string;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly tools: AssistantTools,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  status() {
    return { enabled: this.config.ASSISTANT_ENABLED, model: this.llm.model };
  }

  /**
   * Tool-calling loop: the model asks for data, we run the matching read-only query and hand back
   * the result, until it answers in text. Capped at MAX_STEPS so a confused model cannot loop forever.
   */
  async ask(question: string): Promise<AssistantAnswer> {
    if (!this.config.ASSISTANT_ENABLED) {
      throw new AppError(503, 'ASSISTANT_DISABLED', 'The assistant is not enabled on this server');
    }

    const today = businessDate(this.config.BUSINESS_TIMEZONE);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(today) },
      { role: 'user', content: question },
    ];
    const toolsUsed: AssistantAnswer['toolsUsed'] = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await this.llm.chat(messages, this.tools.definitions());

      if (reply.toolCalls.length === 0) {
        return { answer: reply.content || 'No encontré una respuesta.', toolsUsed, model: this.llm.model };
      }

      messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls.map((call) => ({ function: call })) });

      for (const call of reply.toolCalls) {
        const { ok, result } = await this.tools.execute(call.name, call.arguments);
        toolsUsed.push({ name: call.name, arguments: call.arguments, ok });
        messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(result) });
      }
    }

    this.logger.warn(`Assistant gave up after ${MAX_STEPS} steps: "${question}"`);
    return {
      answer: 'No pude responder esa pregunta con los datos disponibles. Intenta formularla de otra manera.',
      toolsUsed,
      model: this.llm.model,
    };
  }
}

function systemPrompt(today: string): string {
  const month = today.slice(0, 8) + '01';
  return [
    'Eres el asistente de una joyería. Respondes en español, de forma breve y concreta.',
    `Hoy es ${today} (zona horaria de Bogotá).`,
    'Tienes herramientas que consultan los datos reales del negocio. Para CUALQUIER pregunta sobre ventas,',
    'medios de pago, márgenes, ganancias, gastos o inventario de oro, LLAMA PRIMERO a la herramienta adecuada:',
    'nunca respondas cifras sin consultarla y nunca digas que no tienes acceso a los datos.',
    `Fechas en formato YYYY-MM-DD. "Hoy" es from=${today}, to=${today}. "Este mes" es from=${month}, to=${today}.`,
    'Montos en pesos colombianos (COP); oro en gramos.',
    'No tienes datos personales de clientes: si te los piden, explica que no están disponibles.',
  ].join('\n');
}
