import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/app-error';
import { origin, SecurityEvents, tokenRejection } from '../security/security-events';
import { ROLES_KEY } from './auth.decorators';
import { AuthenticatedRequest, JwtPayload, Role } from './auth.types';

/** Verifies the Bearer token and, if the route declares @Roles, the user's role. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly security: SecurityEvents,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.header('authorization') ?? '').split(' ');

    if (scheme !== 'Bearer' || !token) {
      this.security.record('auth.token_rejected', { ...origin(request), reason: 'missing' });
      throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch (error) {
      // The client gets the same answer whatever the reason; the security log records which one it was.
      this.security.record('auth.token_rejected', { ...origin(request), reason: tokenRejection(error) });
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
    }

    request.user = { id: payload.sub, email: payload.email, name: payload.name, role: payload.role };

    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles && !requiredRoles.includes(payload.role)) {
      this.security.record('authz.denied', { ...origin(request), userId: payload.sub, role: payload.role });
      throw new AppError(403, 'FORBIDDEN', 'Your role cannot perform this action');
    }

    return true;
  }
}
