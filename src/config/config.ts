import * as path from 'path';

export interface AuthConfig {
  /** OpenID Connect issuer URL of the Swirlock IdP. */
  idpIssuer: string;
  /** This service's own resource indicator. JWT `aud` must match. */
  audience: string;
}

export interface DatabaseConfig {
  file: string;
}

export interface LlmHostConfig {
  baseUrl: string;
  callerService: string;
  timeoutMs: number;
}

export interface UtilityLlmHostConfig {
  /** When false, classifier turns run on the main LlmHost. */
  enabled: boolean;
  /** WS URL of the remote utility model host (e.g. gemma4:e4b @ 192.168.0.194:3213). */
  baseUrl: string;
  callerService: string;
  timeoutMs: number;
  /** When true, on unreachable/error the classifier silently falls back to the main LlmHost. */
  fallbackToMainOnError: boolean;
}

export interface RagConfig {
  enabled: boolean;
  baseUrl: string | null;
  callerService: string;
  timeoutMs: number;
  freshness: 'low' | 'medium' | 'high' | 'realtime';
  allowedModes: Array<'local_rag' | 'live_web'>;
  maxEvidenceChunks: number;
}

export interface FragmenterConfig {
  /**
   * When false, the orchestrator skips opening a socket to the
   * Context Fragmenter. The user-facing turn pipeline is unaffected;
   * this is the dev/standalone mode.
   */
  enabled: boolean;
  baseUrl: string | null;
  bearerToken: string;
  callerService: string;
  timeoutMs: number;
}

export interface ServiceConfig {
  serviceName: string;
  host: string;
  port: number;
  auth: AuthConfig;
  database: DatabaseConfig;
  llmHost: LlmHostConfig;
  utilityLlmHost: UtilityLlmHostConfig;
  rag: RagConfig;
  fragmenter: FragmenterConfig;
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');

export function loadServiceConfig(): ServiceConfig {
  const cfgPath = path.resolve(process.cwd(), 'service.config.cjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(cfgPath) as { env?: ServiceConfig };
  if (!mod?.env) {
    throw new Error(`service.config.cjs at ${cfgPath} must export { env }`);
  }
  validate(mod.env);
  return mod.env;
}

function validate(c: ServiceConfig): void {
  const must = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`service.config.cjs invalid: ${msg}`);
  };
  must(c.host, 'host required');
  must(c.serviceName, 'serviceName required');
  must(typeof c.port === 'number' && c.port > 0, 'port required');
  must(c.auth?.idpIssuer, 'auth.idpIssuer required');
  must(c.auth?.audience, 'auth.audience required');
  must(c.database?.file, 'database.file required');
  must(c.llmHost?.baseUrl, 'llmHost.baseUrl required');
  must(c.llmHost?.callerService, 'llmHost.callerService required');
  must(typeof c.llmHost?.timeoutMs === 'number', 'llmHost.timeoutMs required');
  must(
    typeof c.utilityLlmHost?.enabled === 'boolean',
    'utilityLlmHost.enabled required',
  );
  if (c.utilityLlmHost?.enabled) {
    must(c.utilityLlmHost.baseUrl, 'utilityLlmHost.baseUrl required when enabled');
    must(
      c.utilityLlmHost.callerService,
      'utilityLlmHost.callerService required when enabled',
    );
    must(
      typeof c.utilityLlmHost.timeoutMs === 'number',
      'utilityLlmHost.timeoutMs required when enabled',
    );
    must(
      typeof c.utilityLlmHost.fallbackToMainOnError === 'boolean',
      'utilityLlmHost.fallbackToMainOnError required when enabled',
    );
  }
  must(typeof c.rag?.enabled === 'boolean', 'rag.enabled required');
  if (!c.rag) throw new Error('service.config.cjs invalid: rag required');
  const rag = c.rag;
  must(rag?.callerService, 'rag.callerService required');
  must(typeof rag?.timeoutMs === 'number', 'rag.timeoutMs required');
  must(
    ['low', 'medium', 'high', 'realtime'].includes(String(rag?.freshness)),
    'rag.freshness invalid',
  );
  must(Array.isArray(rag?.allowedModes), 'rag.allowedModes required');
  must(
    rag.allowedModes.every((mode) => ['local_rag', 'live_web'].includes(mode)),
    'rag.allowedModes invalid',
  );
  must(
    Number.isInteger(rag?.maxEvidenceChunks) && rag.maxEvidenceChunks > 0,
    'rag.maxEvidenceChunks required',
  );
  must(!rag.enabled || rag.baseUrl, 'rag.baseUrl required when enabled');

  if (!c.fragmenter)
    throw new Error('service.config.cjs invalid: fragmenter required');
  const frag = c.fragmenter;
  must(typeof frag.enabled === 'boolean', 'fragmenter.enabled required');
  must(frag.callerService, 'fragmenter.callerService required');
  must(typeof frag.timeoutMs === 'number', 'fragmenter.timeoutMs required');
  must(
    !frag.enabled || frag.baseUrl,
    'fragmenter.baseUrl required when enabled',
  );
  must(
    !frag.enabled ||
      (typeof frag.bearerToken === 'string' && frag.bearerToken.length > 0),
    'fragmenter.bearerToken required when enabled',
  );
}
