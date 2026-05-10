'use strict';

/**
 * Single source of truth for the Swirlock Chat Orchestrator runtime config.
 *
 * Per Swirlock contracts v5, each service must have exactly one obvious source
 * of truth for runtime config. This file is imported by the application
 * bootstrap and by any process manager (e.g. `ecosystem.config.cjs`) so values
 * are not duplicated across `.env`, source defaults, or README examples.
 *
 * Edit this file to change ports, upstream URLs, the dev bearer token, etc.
 */

const path = require('path');

const env = {
  serviceName: 'swirlock-chat-orchestrator',

  // Listener: WS endpoint /v5/chat is served from this host:port.
  host: '127.0.0.1',
  port: 3200,

  // End-user authentication is delegated to the Swirlock Identity Provider
  // (`swirlock-idp-base`). The orchestrator validates IdP-issued JWT access
  // tokens against the IdP's JWKS on every WebSocket upgrade.
  //
  // - `idpIssuer`: must match the `iss` claim in incoming tokens.
  // - `audience`: this orchestrator's own resource indicator. The chatbot
  //   UI requests tokens with `resource=<this URL>`, the IdP issues a JWT
  //   with that `aud`, and the orchestrator rejects tokens for any other
  //   audience.
  auth: {
    idpIssuer: 'http://127.0.0.1:3300/oidc',
    audience: 'http://127.0.0.1:3200',
  },

  database: {
    file: path.resolve(__dirname, 'data', 'chat-orchestrator.sqlite'),
  },

  // Vanamonde LLM Host. Per the v5 1:1 module-to-LLM rule, the orchestrator
  // consumes exactly one Model Host process at this URL — used for every
  // inference in the live turn pipeline (control-step decisions and
  // final-answer generation).
  llmHost: {
    baseUrl: 'http://127.0.0.1:3213',
    callerService: 'chat-orchestrator',
    timeoutMs: 120000,
  },

  // RAG Engine endpoint. The orchestrator uses the persistent WebSocket
  // stream so it can forward retrieval progress to connected chat clients
  // before final-answer inference starts.
  rag: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:3001',
    callerService: 'chat-orchestrator',
    timeoutMs: 90000,
    freshness: 'medium',
    allowedModes: ['live_web'],
    maxEvidenceChunks: 8,
  },

  // Context Fragmenter peer module. Per v5, the orchestrator opens
  // exactly one persistent WebSocket to the fragmenter and uses it for
  // fire-and-forget notifications (`session.observed`,
  // `session.invalidate`). The user-facing turn pipeline never blocks
  // on fragmenter calls. When `enabled: false`, the orchestrator does
  // not open the socket and silently no-ops the notifiers — useful in
  // dev or when running the orchestrator standalone.
  //
  // `bearerToken` must match the fragmenter's `bearerToken`.
  fragmenter: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:3215',
    bearerToken: 'dev-token-change-me',
    callerService: 'chat-orchestrator',
    timeoutMs: 30000,
  },
};

module.exports = { env };
