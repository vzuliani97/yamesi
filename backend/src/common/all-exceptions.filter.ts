import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/auth.types';
import { origin, SecurityEvents } from '../security/security-events';
import { AppError } from './app-error';

const CODES_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
};

/** Every error leaves the API as { error: { code, message, details? } }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  constructor(private readonly security?: SecurityEvents) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    this.recordRejectedUpload(exception, host.switchToHttp().getRequest<Request>());

    if (exception instanceof AppError) {
      response.status(exception.getStatus()).json({ error: exception.body });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        error: { code: CODES_BY_STATUS[status] ?? 'HTTP_ERROR', message: exception.message },
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
    });
  }

  /** A photo or receipt refused for its content or size: the upload code throws, this records it. */
  private recordRejectedUpload(exception: unknown, request: Request): void {
    if (!this.security || !(exception instanceof HttpException)) return;
    const notAnImage = exception instanceof AppError && exception.body.code === 'INVALID_IMAGE';
    // Only file uploads: a JSON body over its own limit is not a photo.
    const tooLarge = exception.getStatus() === 413 && Boolean(request.is('multipart/form-data'));
    if (!notAnImage && !tooLarge) return;

    const user = (request as Partial<AuthenticatedRequest>).user;
    this.security.record('upload.rejected', {
      ...origin(request),
      ...(user ? { userId: user.id, role: user.role } : {}),
      reason: notAnImage ? 'not_an_image' : 'too_large',
    });
  }
}
