import { createHash } from 'node:crypto';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Request } from 'express';

/**
 * Security events: one JSON line per attempt the API refuses or a login it accepts, written to stdout next to
 * the application log. They are the input of the detection rules in detection.ts, the way a SIEM would read them.
 */
export type SecurityEventName =
  | 'auth.login_failed'
  | 'auth.login_locked'
  | 'auth.login_succeeded'
  | 'auth.token_rejected'
  | 'authz.denied'
  | 'upload.rejected';

/** Why a bearer token was refused. The client always gets the same 401; only the log tells them apart. */
export type TokenRejection = 'missing' | 'malformed' | 'bad_signature' | 'bad_algorithm' | 'expired' | 'invalid';

export interface SecurityEvent {
  log: 'security';
  time: string;
  event: SecurityEventName;
  ip: string;
  method?: string;
  path?: string;
  /** Pseudonymous account: see accountId(). */
  account?: string;
  userId?: string;
  role?: string;
  reason?: string;
}

export type SecurityEventFields = Omit<SecurityEvent, 'log' | 'time' | 'event'>;

export const SECURITY_EVENT_SINK = Symbol('SECURITY_EVENT_SINK');
export type SecurityEventSink = (line: string) => void;

/**
 * The account a login named, as the first 12 hex characters of the SHA-256 of the lowercase email. Correlating
 * attempts against one account needs a stable id, but the email field of a failed login sometimes holds a
 * password typed in the wrong box, so the email itself is never written. Anyone who knows an email can compute
 * its id to check whether that account was targeted.
 */
export function accountId(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}

/** Address, method and path of a request. The query string is left out: it can carry search terms or ids. */
export function origin(request: Request): Pick<SecurityEvent, 'ip' | 'method' | 'path'> {
  return { ip: request.ip ?? 'unknown', method: request.method, path: request.originalUrl.split('?')[0] };
}

/** Classifies a jsonwebtoken verification error. */
export function tokenRejection(error: unknown): TokenRejection {
  const { name, message } = error instanceof Error ? error : { name: '', message: '' };
  if (name === 'TokenExpiredError') return 'expired';
  if (message === 'invalid signature') return 'bad_signature';
  // "alg: none" arrives without a signature; a token for another algorithm is refused by the HS256 pin.
  if (message === 'jwt signature is required' || message === 'invalid algorithm') return 'bad_algorithm';
  if (message === 'jwt malformed' || message === 'invalid token' || name === 'SyntaxError') return 'malformed';
  return 'invalid';
}

@Injectable()
export class SecurityEvents {
  constructor(@Inject(SECURITY_EVENT_SINK) private readonly sink: SecurityEventSink) {}

  record(event: SecurityEventName, fields: SecurityEventFields): void {
    const line: SecurityEvent = { log: 'security', time: new Date().toISOString(), event, ...fields };
    this.sink(JSON.stringify(line));
  }
}

@Global()
@Module({
  providers: [
    SecurityEvents,
    { provide: SECURITY_EVENT_SINK, useValue: ((line) => process.stdout.write(`${line}\n`)) satisfies SecurityEventSink },
  ],
  exports: [SecurityEvents],
})
export class SecurityModule {}
