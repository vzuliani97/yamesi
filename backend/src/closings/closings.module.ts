import { Body, Controller, Get, Inject, Injectable, Module, Param, Post, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError } from '../common/app-error';
import { businessDate, DATE_PATTERN, lockDayExclusive } from '../common/business-day';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';

const closeDaySchema = z
  .object({
    date: z.string().regex(DATE_PATTERN).optional(),
    countedCash: z.number().int().min(0).max(1_000_000_000),
    notes: z.string().trim().max(300).optional(),
  })
  .strict();

type CloseDayInput = z.infer<typeof closeDaySchema>;

export interface DaySummary {
  date: string;
  openingCash: number;
  salesByMethod: { CASH: number; CARD: number; TRANSFER: number };
  invoiceCount: number;
  expenses: number;
  expectedCash: number;
  closed: boolean;
  closing: { countedCash: number; difference: number; notes: string | null; closedAt: Date } | null;
}

type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class ClosingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  today(): string {
    return businessDate(this.config.BUSINESS_TIMEZONE);
  }

  /**
   * Expected cash in the drawer = opening cash + cash sales − petty cash expenses.
   * Card and transfer sales never touch the drawer. Opening cash is what was counted at the last closing.
   */
  async summary(date: string, client: Queryable = this.db.pool): Promise<DaySummary> {
    const [opening, sales, expenses, closing] = await Promise.all([
      client.query<{ counted_cash: number }>(
        'SELECT counted_cash FROM cash_closings WHERE business_date < $1 ORDER BY business_date DESC LIMIT 1',
        [date],
      ),
      client.query<{ payment_method: 'CASH' | 'CARD' | 'TRANSFER'; total: string; count: string }>(
        `SELECT payment_method, SUM(total) AS total, COUNT(*) AS count
         FROM invoices WHERE business_date = $1 GROUP BY payment_method`,
        [date],
      ),
      client.query<{ total: string }>('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE business_date = $1', [
        date,
      ]),
      client.query<{ counted_cash: number; difference: number; notes: string | null; closed_at: Date }>(
        'SELECT counted_cash, difference, notes, closed_at FROM cash_closings WHERE business_date = $1',
        [date],
      ),
    ]);

    const salesByMethod = { CASH: 0, CARD: 0, TRANSFER: 0 };
    let invoiceCount = 0;
    for (const row of sales.rows) {
      salesByMethod[row.payment_method] = Number(row.total);
      invoiceCount += Number(row.count);
    }

    const openingCash = opening.rows[0]?.counted_cash ?? 0;
    const expenseTotal = Number(expenses.rows[0].total);
    const closed = closing.rows[0];

    return {
      date,
      openingCash,
      salesByMethod,
      invoiceCount,
      expenses: expenseTotal,
      expectedCash: openingCash + salesByMethod.CASH - expenseTotal,
      closed: Boolean(closed),
      closing: closed
        ? { countedCash: closed.counted_cash, difference: closed.difference, notes: closed.notes, closedAt: closed.closed_at }
        : null,
    };
  }

  async close(input: CloseDayInput, actor: AuthUser): Promise<DaySummary> {
    const date = input.date ?? this.today();

    if (date > this.today()) {
      throw new AppError(400, 'FUTURE_DATE', 'A day in the future cannot be closed');
    }

    await this.db.transaction(async (client) => {
      // Waits for in-flight sales and expenses of this day, then blocks new ones until COMMIT.
      await lockDayExclusive(client, date);

      const summary = await this.summary(date, client);
      if (summary.closed) {
        throw new AppError(409, 'DAY_ALREADY_CLOSED', `Business day ${date} is already closed`);
      }

      const difference = input.countedCash - summary.expectedCash;
      await client.query(
        `INSERT INTO cash_closings (business_date, opening_cash, cash_sales, expenses, expected_cash, counted_cash,
                                   difference, notes, closed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          date,
          summary.openingCash,
          summary.salesByMethod.CASH,
          summary.expenses,
          summary.expectedCash,
          input.countedCash,
          difference,
          input.notes ?? null,
          actor.id,
        ],
      );

      await this.audit.record(client, {
        actorId: actor.id,
        action: 'DAY_CLOSED',
        entity: 'cash_closing',
        entityId: date,
        data: { expectedCash: summary.expectedCash, countedCash: input.countedCash, difference },
      });
    });

    return this.summary(date);
  }
}

@Controller('closings')
@UseGuards(JwtAuthGuard)
export class ClosingsController {
  constructor(private readonly closings: ClosingsService) {}

  @Get('today')
  today() {
    return this.closings.summary(this.closings.today());
  }

  @Get(':date')
  byDate(@Param('date', new ZodValidationPipe(z.string().regex(DATE_PATTERN))) date: string) {
    return this.closings.summary(date);
  }

  @Post()
  @Roles('ADMIN')
  close(@Body(new ZodValidationPipe(closeDaySchema)) body: CloseDayInput, @CurrentUser() user: AuthUser) {
    return this.closings.close(body, user);
  }
}

@Module({
  controllers: [ClosingsController],
  providers: [ClosingsService],
})
export class ClosingsModule {}
