import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DATE_PATTERN } from '../common/business-day';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CreateInvoiceInput, InvoicesService } from './invoices.service';

const createInvoiceSchema = z
  .object({
    customerName: z.string().trim().min(2).max(120),
    customerDocument: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z-]{5,20}$/)
      .optional(),
    paymentMethod: z.enum(['CASH', 'CARD', 'TRANSFER']),
    pieceIds: z.array(z.number().int().positive()).min(1).max(20),
  })
  .strict();

const listQuerySchema = z.object({ date: z.string().regex(DATE_PATTERN).optional() });

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  async create(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceInput,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invoices.create(body, idempotencyKey, user);
    res.status(result.replayed ? 200 : 201);
    return { data: result.invoice, meta: { replayed: result.replayed } };
  }

  @Get()
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: { date?: string }) {
    return this.invoices.list(query.date);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.invoices.get(id);
  }

  @Get(':id/pdf')
  async pdf(@Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const { number, body } = await this.invoices.pdf(id);
    res
      .type('application/pdf')
      .setHeader('Content-Disposition', `inline; filename="factura-${String(number).padStart(6, '0')}.pdf"`)
      .send(body);
  }
}

@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
