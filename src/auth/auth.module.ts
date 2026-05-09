import { Module } from '@nestjs/common';
import { BearerAuthGuard } from './bearer-auth.guard';

/**
 * Authentication module.
 *
 * Today this module exports a single `BearerAuthGuard` that validates
 * the dev token from `service.config.cjs`. The guard is HTTP-shaped and
 * not yet wired into any controller — the live WS endpoint at
 * `/v5/chat` does its own bearer-token check during the upgrade in
 * `main.ts` via `bearer-auth.util.ts`.
 *
 * This module is preserved as the architectural home for the upcoming
 * Swirlock IDP integration (JWT/OIDC validation, scope checks, user
 * account resolution). The current `BearerAuthGuard` will be replaced
 * by an IDP-backed guard at that time.
 */
@Module({
  providers: [BearerAuthGuard],
  exports: [BearerAuthGuard],
})
export class AuthModule {}
