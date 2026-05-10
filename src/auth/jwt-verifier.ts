import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export interface VerifiedAccessToken {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  clientId?: string;
  scope?: string;
  raw: JWTPayload;
}

/**
 * Verifies IdP-issued JWT access tokens against the IdP's JWKS.
 * `iss` must match `auth.idpIssuer`; `aud` must include `auth.audience`.
 * Built on `jose.createRemoteJWKSet`, which caches JWKS in memory and
 * refreshes on `kid` miss.
 */
@Injectable()
export class JwtVerifier {
  private readonly log = new Logger(JwtVerifier.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(@Inject(SERVICE_CONFIG) cfg: ServiceConfig) {
    this.issuer = cfg.auth.idpIssuer;
    this.audience = cfg.auth.audience;
    const jwksUrl = new URL(this.issuer.replace(/\/$/, '') + '/jwks');
    this.jwks = createRemoteJWKSet(jwksUrl, {
      cacheMaxAge: 10 * 60 * 1000, // 10 min
      cooldownDuration: 5 * 1000,
    });
    this.log.log(
      `JWT verifier configured: issuer=${this.issuer} audience=${this.audience} jwks=${jwksUrl}`,
    );
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('Token missing `sub` claim.');
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified:
        typeof payload.email_verified === 'boolean'
          ? payload.email_verified
          : undefined,
      clientId:
        typeof payload.client_id === 'string' ? payload.client_id : undefined,
      scope: typeof payload.scope === 'string' ? payload.scope : undefined,
      raw: payload,
    };
  }
}
