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

/**
 * HTTP-shaped bearer guard preserved for future Swirlock IDP wiring.
 *
 * Not wired into any controller today — the orchestrator has no HTTP
 * routes; the live WS endpoint authenticates during the upgrade in
 * `main.ts` via `bearer-auth.util.ts`. When IDP work begins, replace
 * the dev-token equality check below with IDP-backed JWT validation
 * and surface the resolved identity through `req.user`.
 */
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
