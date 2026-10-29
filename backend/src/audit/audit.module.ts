import { Controller, Get, Global, Injectable, Module, UseGuards } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DatabaseService } from '../database/database.service';

export interface AuditEntry {
  actorId: string;
  action: string;
  entity: string;
  entityId: string | number;
  data?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /** Written with the caller's transaction client: the change and its audit record commit or roll back together. */
  async record(client: PoolClient, entry: AuditEntry): Promise<void> {
    await client.query(
      'INSERT INTO audit_log (actor_id, action, entity, entity_id, data) VALUES ($1, $2, $3, $4, $5)',
      [entry.actorId, entry.action, entry.entity, String(entry.entityId), entry.data ? JSON.stringify(entry.data) : null],
    );
  }

  async list(limit = 100) {
    const { rows } = await this.db.query<{
      id: string;
      action: string;
      entity: string;
      entity_id: string;
      data: Record<string, unknown> | null;
      created_at: Date;
      actor_name: string;
    }>(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.data, a.created_at, u.name AS actor_name
       FROM audit_log a JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      data: row.data,
      actor: row.actor_name,
      createdAt: row.created_at,
    }));
  }
}

@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles('ADMIN')
  list() {
    return this.audit.list();
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
