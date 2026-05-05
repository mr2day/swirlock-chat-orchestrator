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
  // HTTP listener
  host: '127.0.0.1',
  port: 3200,

  // API version surfaced in `meta.apiVersion` of every response.
  apiVersion: 'v2',

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

  // RAG Engine hook. Disabled in this first version; the orchestrator calls
  // the LLM Host directly. When you wire up the RAG Engine, set `enabled: true`
  // and point `baseUrl` at it. The orchestrator's `RagService` is the single
  // place that consumes this config.
  rag: {
    enabled: false,
    baseUrl: null,
  },
};

module.exports = { env };
