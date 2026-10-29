import { Module } from '@nestjs/common';
import { AssistantModule } from './assistant/assistant.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ClosingsModule } from './closings/closings.module';
import { CoreModule } from './database/core.module';
import { ExpensesModule } from './expenses/expenses.module';
import { HealthController } from './health/health.controller';
import { InvoicesModule } from './invoices/invoices.module';
import { LotsModule } from './lots/lots.module';
import { PiecesModule } from './pieces/pieces.module';
import { ReportsModule } from './reports/reports.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    CoreModule,
    StorageModule,
    AuditModule,
    AuthModule,
    LotsModule,
    PiecesModule,
    InvoicesModule,
    ExpensesModule,
    ClosingsModule,
    ReportsModule,
    AssistantModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
