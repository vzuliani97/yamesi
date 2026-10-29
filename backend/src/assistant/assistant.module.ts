import { Body, Controller, Get, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, AppConfig } from '../config';
import { AssistantService } from './assistant.service';
import { AssistantTools } from './assistant.tools';
import { LLM_CLIENT } from './llm';
import { OllamaClient } from './ollama.client';

const askSchema = z.object({ question: z.string().trim().min(3).max(500) }).strict();

@Controller('assistant')
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('status')
  status() {
    return this.assistant.status();
  }

  @Post('ask')
  @HttpCode(200)
  ask(@Body(new ZodValidationPipe(askSchema)) body: { question: string }) {
    return this.assistant.ask(body.question);
  }
}

@Module({
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantTools,
    { provide: LLM_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new OllamaClient(config) },
  ],
})
export class AssistantModule {}
