import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (token !== this.cfg.devUser.bearerToken) {
      throw new UnauthorizedException('Invalid bearer token');
    }
    req.user = {
      userId: this.cfg.devUser.userId,
      displayName: this.cfg.devUser.displayName,
    };
    return true;
  }
}
