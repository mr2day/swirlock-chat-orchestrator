import * as path from 'path';

export interface DevUserConfig {
  userId: string;
  displayName: string;
  bearerToken: string;
}

export interface DatabaseConfig {
  file: string;
}

export interface LlmHostConfig {
  baseUrl: string;
  callerService: string;
  timeoutMs: number;
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

export interface ExperimentalConfig {
  /**
   * When `true`, the orchestrator runs the linear Decision Pipeline
   * (DecisionsService + DECISION_PIPELINE.md) for live turns instead
   * of the agent control loop. Defaults to `false` while Phase F1 is
   * landed; flipped to `true` in Phase F2 once the pipeline has been
   * verified live and the loop is ready to be deleted.
   */
  decisionPipeline?: boolean;
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
  devUser: DevUserConfig;
  database: DatabaseConfig;
  llmHost: LlmHostConfig;
  rag: RagConfig;
  fragmenter: FragmenterConfig;
  experimental?: ExperimentalConfig;
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
  must(c.devUser?.userId, 'devUser.userId required');
  must(c.devUser?.bearerToken, 'devUser.bearerToken required');
  must(c.database?.file, 'database.file required');
  must(c.llmHost?.baseUrl, 'llmHost.baseUrl required');
  must(c.llmHost?.callerService, 'llmHost.callerService required');
  must(typeof c.llmHost?.timeoutMs === 'number', 'llmHost.timeoutMs required');
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

  if (c.experimental !== undefined) {
    must(
      c.experimental.decisionPipeline === undefined ||
        typeof c.experimental.decisionPipeline === 'boolean',
      'experimental.decisionPipeline must be a boolean',
    );
  }
}
