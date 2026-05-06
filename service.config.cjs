'use strict';

/**
 * Single source of truth for the Swirlock Chat Orchestrator runtime config.
 *
 * Per Swirlock contracts v2 (`INTERNAL_INFRASTRUCTURE.md` and `API_CONVENTIONS.md`),
 * each service must have exactly one obvious source of truth for runtime config.
 * This file is imported by the application bootstrap and by any process manager
 * (e.g. `ecosystem.config.cjs`) so values are not duplicated across `.env`,
 * source defaults, or README examples.
 *
 * Edit this file to change ports, upstream URLs, the dev bearer token, etc.
 */

const path = require('path');

const env = {
  serviceName: 'swirlock-chat-orchestrator',

  // HTTP listener
  host: '127.0.0.1',
  port: 3200,

  // API version surfaced in `meta.apiVersion` of every response.
  apiVersion: 'v2',

  // CORS origins allowed for browser clients (e.g. the swirlock-chatbot-ui
  // dev server on http://localhost:4200). Empty array disables CORS entirely
  // and the orchestrator stays open only to same-origin / non-browser callers.
  // Production deployments should narrow this list to the deployed UI URL(s).
  http: {
    corsOrigins: [
      'http://localhost:4200',
      'http://127.0.0.1:4200',
    ],
  },

  // Single hardcoded dev user.
  // Replace `bearerToken` with a real secret from a private store before
  // exposing this service outside localhost. The contract surface is designed
  // so bearer auth, mTLS, or another mechanism can be swapped without changing
  // payloads (see API_CONVENTIONS.md "Authentication").
  devUser: {
    userId: 'dev-user',
    displayName: 'Dev User',
    bearerToken: 'dev-token-change-me',
  },

  database: {
    file: path.resolve(__dirname, 'data', 'chat-orchestrator.sqlite'),
  },

  // Final-answer LLM Host endpoint. Convention from INTERNAL_INFRASTRUCTURE.md
  // is port 3213 for a Model Host implementation.
  //
  // Operational note: in the v3 architecture this slot is the Primary LLM
  // Host (Main Computer). Today, the Main Computer deployment does not exist
  // yet, and the only running Model Host is the Utility LLM Host on the
  // local machine. We point the orchestrator at the Utility LLM Host as a
  // temporary substitute for Primary. When the Main Computer comes online,
  // change this baseUrl to the Primary's network URL — no other code needs
  // to change, because the Model Host API is agnostic.
  llmHost: {
    baseUrl: 'http://127.0.0.1:3213',
    callerService: 'chat-orchestrator',
    timeoutMs: 120000,
  },

  // RAG Engine endpoint. The orchestrator uses the WebSocket stream so it can
  // forward retrieval progress to connected chat clients before final-answer
  // inference starts.
  rag: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:3001',
    callerService: 'chat-orchestrator',
    timeoutMs: 90000,
    freshness: 'medium',
    allowedModes: ['local_rag', 'live_web'],
    maxEvidenceChunks: 8,
    synthesisMode: 'brief',
  },
};

module.exports = { env };
