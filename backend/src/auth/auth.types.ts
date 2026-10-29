import { Request } from 'express';

export type Role = 'ADMIN' | 'SELLER';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

export type AuthenticatedRequest = Request & { user: AuthUser };
