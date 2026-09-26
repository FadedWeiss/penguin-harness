/**
 * R0 contract freeze (mind-harness 计划2): the frozen HTTP surface the downstream ArchMap
 * adapter depends on. Every endpoint in the inventory receives a real request through the
 * full app stack (auth → route → handler) — with a nonexistent session the handlers answer
 * with their own verdict, which is exactly what proves the ROUTE still exists and still
 * speaks the app's error envelope. A refactored-away or renamed route would fall through to
 * the app's notFound fallback ("Endpoint does not exist."), which is the one answer this
 * suite treats as a contract break.
 *
 * Deep per-endpoint behavior is pinned by the existing suites (session-fork, sse-stream,
 * workspace-files, trace-*, …); this file freezes the INVENTORY.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const NOT_FOUND_MESSAGE = "Endpoint does not exist.";

interface Endpoint {
  /** Human-readable label for the failure message. */
  label: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

const MISSING = "session-2026-09-26-00-00-00-missing";

/** Every endpoint of the frozen contract inventory (plan 2 R0). */
const INVENTORY: Endpoint[] = [
  // Session lifecycle + agent-scoped session index
  { label: "agent sessions list", method: "GET", path: "/api/projects/p/agents/a/sessions" },
  {
    label: "agent session create",
    method: "POST",
    path: "/api/projects/p/agents/a/sessions",
    body: {},
  },
  { label: "session get", method: "GET", path: `/api/sessions/${MISSING}` },
  { label: "session patch", method: "PATCH", path: `/api/sessions/${MISSING}`, body: {} },
  {
    label: "session fork",
    method: "POST",
    path: `/api/sessions/${MISSING}/fork`,
    body: { position: { fileIndex: 1, ordinal: 0 } },
  },
  { label: "session delete", method: "DELETE", path: `/api/sessions/${MISSING}` },
  { label: "session scratchpad file", method: "GET", path: `/api/sessions/${MISSING}/scratchpad/x.txt` },
  { label: "session messages", method: "GET", path: `/api/sessions/${MISSING}/messages` },
  { label: "session stream (SSE)", method: "GET", path: `/api/sessions/${MISSING}/stream` },
  {
    label: "session task submit",
    method: "POST",
    path: `/api/sessions/${MISSING}/tasks`,
    body: { input: [{ type: "text", text: "go" }] },
  },
  { label: "session steer", method: "POST", path: `/api/sessions/${MISSING}/steer`, body: { input: [{ type: "text", text: "s" }] } },
  { label: "session steer delete", method: "DELETE", path: `/api/sessions/${MISSING}/steer/x` },
  {
    label: "subagent message",
    method: "POST",
    path: `/api/sessions/${MISSING}/subagents/child/message`,
    body: { input: [{ type: "text", text: "go" }] },
  },
  { label: "subagent abort", method: "POST", path: `/api/sessions/${MISSING}/subagents/child/abort` },
  { label: "follow-up delete", method: "DELETE", path: `/api/sessions/${MISSING}/follow-ups/x` },
  { label: "session goal", method: "GET", path: `/api/sessions/${MISSING}/goal` },
  {
    label: "approval decision",
    method: "POST",
    path: `/api/sessions/${MISSING}/approvals/tc-1`,
    body: { decision: "allow" },
  },
  { label: "session abort", method: "POST", path: `/api/sessions/${MISSING}/abort` },
  { label: "session processes", method: "GET", path: `/api/sessions/${MISSING}/processes` },
  { label: "process kill", method: "POST", path: `/api/sessions/${MISSING}/processes/p/kill` },
  { label: "process delete", method: "DELETE", path: `/api/sessions/${MISSING}/processes/p` },
  { label: "retry now", method: "POST", path: `/api/sessions/${MISSING}/retry-now` },
  { label: "compact", method: "POST", path: `/api/sessions/${MISSING}/compact` },
  // Workspace files
  { label: "workspace files list", method: "GET", path: `/api/sessions/${MISSING}/files` },
  { label: "workspace file content", method: "GET", path: `/api/sessions/${MISSING}/files/content?path=x` },
  { label: "workspace preview redirect", method: "GET", path: `/api/sessions/${MISSING}/files/preview-redirect?path=x` },
  { label: "workspace file stat", method: "POST", path: `/api/sessions/${MISSING}/files/stat`, body: { path: "x" } },
  {
    label: "workspace file write",
    method: "PUT",
    path: `/api/sessions/${MISSING}/files/content`,
    body: { path: "x", content: "y" },
  },
  // Context + traces
  { label: "session context", method: "GET", path: `/api/sessions/${MISSING}/context` },
  { label: "session traces", method: "GET", path: `/api/sessions/${MISSING}/traces` },
  { label: "session trace shard", method: "GET", path: `/api/sessions/${MISSING}/traces/1` },
  { label: "session trace analysis", method: "GET", path: `/api/sessions/${MISSING}/traces/1/analysis` },
  // Agent-scoped traces
  { label: "agent traces list", method: "GET", path: "/api/projects/p/agents/a/traces" },
  { label: "agent trace shard", method: "GET", path: "/api/projects/p/agents/a/traces/s/1" },
  { label: "agent trace analysis", method: "GET", path: "/api/projects/p/agents/a/traces/s/1/analysis" },
  { label: "agent trace download", method: "GET", path: "/api/projects/p/agents/a/traces/s/1/download" },
  { label: "trace import", method: "POST", path: "/api/projects/p/agents/a/traces/import", body: {} },
  // Events + preview
  { label: "events stream (SSE)", method: "GET", path: "/api/events" },
  { label: "preview", method: "GET", path: "/preview/invalid-token/x" },
];

describe("frozen contract surface (R0 inventory)", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("every inventory endpoint answers through its own handler, not the notFound fallback", async () => {
    const { cookie } = await provisionUser(t.app, "surface");
    const failures: string[] = [];
    for (const endpoint of INVENTORY) {
      const res = await t.app.request(endpoint.path, {
        method: endpoint.method,
        headers: {
          cookie,
          ...(endpoint.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(endpoint.body !== undefined ? { body: JSON.stringify(endpoint.body) } : {}),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        // A live SSE stream never ends: its 200 + content-type IS the handler's answer.
        expect(res.status, endpoint.label).toBe(200);
        await res.body?.cancel().catch(() => {});
        continue;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON answers (binary, redirects) are handler verdicts too.
      }
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
      if (err?.code === "not_found" && err.message === NOT_FOUND_MESSAGE) {
        failures.push(`${endpoint.method} ${endpoint.path} (${endpoint.label})`);
      }
      if (res.status === 401) {
        failures.push(`${endpoint.method} ${endpoint.path} (${endpoint.label}): auth broke`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("the response envelope keeps its shape: {error: {code, message}} for handler rejections", async () => {
    const { cookie } = await provisionUser(t.app, "envelope");
    const res = await apiClient(t.app, cookie).get(`/api/sessions/${MISSING}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(Object.keys(body).sort()).toEqual(["error"]);
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.code).not.toBe("not_found");
  });
});
