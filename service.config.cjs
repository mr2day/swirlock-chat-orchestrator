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

  // Single hardcoded dev user.
  // Replace `bearerToken` with a real secret from a private store before
  // exposing this service outside localhost. The contract surface is designed
  // so bearer auth, mTLS, or another mechanism can be swapped without
  // changing payloads.
  devUser: {
    userId: 'dev-user',
    displayName: 'Dev User',
    bearerToken: 'dev-token-change-me',
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
    allowedModes: ['local_rag', 'live_web'],
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

  // Experimental feature flags. See REFACTOR_PLAN.md and
  // DECISION_PIPELINE.md.
  experimental: {
    // Phase F1 / F2 of the v5 refactor: when `true`, ConversationFlow
    // runs the linear Decision Pipeline (one short utilitarian LLM
    // call per branch + final answer) instead of the iterative agent
    // control loop. Default is `false` while F1 is live; flipped to
    // `true` in F2 once verified.
    decisionPipeline: false,
  },
};

module.exports = { env };
