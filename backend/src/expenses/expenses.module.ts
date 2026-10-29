import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { assertDayOpen, businessDate, DATE_PATTERN, lockDayShared } from '../common/business-day';
import { MAX_IMAGE_BYTES, requireImage } from '../common/image-upload';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { FILE_STORAGE, FileStorage } from '../storage/storage.module';

const createExpenseSchema = z
  .object({
    category: z.enum(['TRANSPORTE', 'ASEO', 'PAPELERIA', 'MANTENIMIENTO', 'OTRO']),
    description: z.string().trim().min(3).max(200),
    amount: z.coerce.number().int().positive().max(5_000_000),
  })
  .strict();

type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

interface ExpenseRow {
  id: number;
  business_date: string;
  category: string;
  description: string;
  amount: number;
  receipt_key: string | null;
  created_by_name: string;
  created_at: Date;
}

/** Petty cash ("caja menor"): each expense with an optional photo of its receipt. */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(input: CreateExpenseInput, receipt: Express.Multer.File | undefined, actor: AuthUser) {
    const date = businessDate(this.config.BUSINESS_TIMEZONE);
    let receiptKey: string | null = null;

    if (receipt) {
      const type = requireImage(receipt);
      receiptKey = `receipts/${date}/${randomUUID()}.${type.extension}`;
      await this.storage.put(receiptKey, receipt.buffer, type.contentType);
    }

    const id = await this.db.transaction(async (client) => {
      await lockDayShared(client, date);
      await assertDayOpen(client, date);

      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO expenses (business_date, category, description, amount, receipt_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [date, input.category, input.description, input.amount, receiptKey, actor.id],
      );

      await this.audit.record(client, {
        actorId: actor.id,
        action: 'EXPENSE_CREATED',
        entity: 'expense',
        entityId: rows[0].id,
        data: { ...input, hasReceipt: Boolean(receiptKey) },
      });
      return rows[0].id;
    });

    return (await this.query('WHERE e.id = $1', [id]))[0];
  }

  list(date?: string) {
    return this.query('WHERE e.business_date = $1 ORDER BY e.id DESC', [date ?? businessDate(this.config.BUSINESS_TIMEZONE)]);
  }

  private async query(where: string, params: unknown[]) {
    const { rows } = await this.db.query<ExpenseRow>(
      `SELECT e.id, to_char(e.business_date, 'YYYY-MM-DD') AS business_date, e.category, e.description,
              e.amount, e.receipt_key, u.name AS created_by_name, e.created_at
       FROM expenses e JOIN users u ON u.id = e.created_by
       ${where}`,
      params,
    );

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        businessDate: row.business_date,
        category: row.category,
        description: row.description,
        amount: row.amount,
        receiptUrl: row.receipt_key ? await this.storage.signedUrl(row.receipt_key) : null,
        createdBy: row.created_by_name,
        createdAt: row.created_at,
      })),
    );
  }
}

@Controller('expenses')
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('receipt', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  create(
    @Body(new ZodValidationPipe(createExpenseSchema)) body: CreateExpenseInput,
    @UploadedFile() receipt: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.expenses.create(body, receipt, user);
  }

  @Get()
  list(@Query(new ZodValidationPipe(z.object({ date: z.string().regex(DATE_PATTERN).optional() }))) query: { date?: string }) {
    return this.expenses.list(query.date);
  }
}

@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
