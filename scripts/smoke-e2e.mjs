// One-shot E2E smoke test:
//  - opens /v5/chat against the orchestrator
//  - creates a session, submits a turn
//  - waits for turn.done
//  - polls the shared SQLite for fragmenter_session_summaries
//
// Must be run while:
//  - the orchestrator is up (this script reads its host/port from
//    service.config.cjs)
//  - the fragmenter is up (port 3215)
//  - the Vanamonde LLM Host is reachable (per orchestrator config)
//
// Cleans up the test session at the end.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const cfg = require("../service.config.cjs").env;

const dbFile = cfg.database.file;
const wsUrl = `ws://${cfg.host}:${cfg.port}/v5/chat?token=${encodeURIComponent(
  cfg.devUser.bearerToken,
)}`;

console.log(`[smoke] connecting to ${wsUrl}`);
const ws = new WebSocket(wsUrl);

let sessionId;
const sessionCorr = randomUUID();
const turnCorr = randomUUID();
let turnDone = false;
let turnError;

ws.on("open", () => {
  console.log("[smoke] sending session.create");
  ws.send(
    JSON.stringify({
      type: "session.create",
      correlationId: sessionCorr,
      payload: {
        request: {
          requestContext: {
            callerService: "smoke-e2e",
            requestedAt: new Date().toISOString(),
            priority: "interactive",
          },
          participant: { userId: cfg.devUser.userId, displayName: "Smoke" },
          app: { appId: "smoke-e2e", personaId: "gigi-the-robot" },
        },
      },
    }),
  );
});

ws.on("message", (raw) => {
  let env;
  try {
    env = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }

  if (env.type === "session.created") {
    sessionId = env.payload.sessionId;
    console.log(`[smoke] session.created sessionId=${sessionId}`);
    ws.send(
      JSON.stringify({
        type: "turn.submit",
        correlationId: turnCorr,
        payload: {
          sessionId,
          request: {
            requestContext: {
              callerService: "smoke-e2e",
              requestedAt: new Date().toISOString(),
              priority: "interactive",
            },
            message: {
              parts: [
                {
                  type: "text",
                  text:
                    process.env.SMOKE_QUERY ??
                    "Spune-mi cu un singur cuvant in romaneste cu ce e construita Statuia Libertatii.",
                },
              ],
              occurredAt: new Date().toISOString(),
            },
          },
        },
      }),
    );
    return;
  }

  if (env.type === "turn.chunk") {
    process.stdout.write(env.payload.text);
    return;
  }

  if (env.type === "turn.done") {
    turnDone = true;
    console.log("\n[smoke] turn.done");
    return;
  }

  if (env.type === "error") {
    turnError = env.error;
    console.error("[smoke] error envelope:", env.error);
    return;
  }

  if (
    env.type === "turn.classifying" ||
    env.type === "turn.started" ||
    env.type === "turn.accepted"
  ) {
    console.log(`[smoke] <- ${env.type}`);
  }
});

ws.on("error", (err) => {
  console.error("[smoke] ws error:", err.message);
  process.exit(1);
});

const TURN_TIMEOUT = 120_000;
const start = Date.now();
while (!turnDone && !turnError && Date.now() - start < TURN_TIMEOUT) {
  await delay(500);
}
if (turnError) {
  process.exit(1);
}
if (!turnDone) {
  console.error("[smoke] turn.done never arrived");
  process.exit(1);
}

// Wait briefly for the fragmenter to receive session.observed and run.
console.log("[smoke] waiting up to 60s for fragmenter consolidation");
const db = new Database(dbFile, { readonly: false });

const SUMMARY_TIMEOUT = 60_000;
const summaryStart = Date.now();
let summaryRow;
while (Date.now() - summaryStart < SUMMARY_TIMEOUT) {
  summaryRow = db
    .prepare(
      `SELECT summary, through_seq, generated_at FROM fragmenter_session_summaries WHERE session_id = ?`,
    )
    .get(sessionId);
  if (summaryRow) break;
  await delay(1000);
}

if (!summaryRow) {
  console.error("[smoke] no fragmenter_session_summaries row for session");
  cleanup(1);
} else {
  console.log("\n[smoke] fragmenter_session_summaries row:");
  console.log(`  through_seq:  ${summaryRow.through_seq}`);
  console.log(`  generated_at: ${summaryRow.generated_at}`);
  console.log(`  summary:`);
  console.log(`    ${summaryRow.summary.split("\n").join("\n    ")}`);
  console.log("\n[smoke] OK");
  cleanup(0);
}

function cleanup(exitCode) {
  if (process.env.SMOKE_NO_CLEANUP === '1') {
    console.log(`[smoke] SMOKE_NO_CLEANUP=1; leaving session ${sessionId} in DB`);
    try { ws.close(); } catch {}
    db.close();
    process.exit(exitCode);
    return;
  }
  try {
    if (sessionId) {
      db.prepare(
        `DELETE FROM fragmenter_session_summaries WHERE session_id = ?`,
      ).run(sessionId);
      db.prepare(
        `DELETE FROM fragmenter_consolidation_runs WHERE session_id = ?`,
      ).run(sessionId);
      db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      db.prepare(`DELETE FROM decision_events WHERE session_id = ?`).run(
        sessionId,
      );
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    }
  } catch (err) {
    console.error("[smoke] cleanup failed:", err.message);
  }
  try {
    ws.close();
  } catch {}
  db.close();
  process.exit(exitCode);
}
