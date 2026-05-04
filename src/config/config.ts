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
}

export interface ServiceConfig {
  host: string;
  port: number;
  apiVersion: string;
  devUser: DevUserConfig;
  database: DatabaseConfig;
  llmHost: LlmHostConfig;
  rag: RagConfig;
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
  must(typeof c.port === 'number' && c.port > 0, 'port required');
  must(typeof c.apiVersion === 'string' && c.apiVersion.length > 0, 'apiVersion required');
  must(c.devUser?.userId, 'devUser.userId required');
  must(c.devUser?.bearerToken, 'devUser.bearerToken required');
  must(c.database?.file, 'database.file required');
  must(c.llmHost?.baseUrl, 'llmHost.baseUrl required');
  must(c.llmHost?.callerService, 'llmHost.callerService required');
  must(typeof c.llmHost?.timeoutMs === 'number', 'llmHost.timeoutMs required');
  must(typeof c.rag?.enabled === 'boolean', 'rag.enabled required');
}
