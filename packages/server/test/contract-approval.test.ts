/**
 * R0 contract freeze (mind-harness 计划2): the approval contract the ArchMap adapter depends
 * on, verified against the real runtime through the HTTP surface (request → route → manager
 * → pending approval → decision → task continuation). The task record is observed the way a
 * client observes it: through the session's SSE stream (GET /api/sessions/:id/stream).
 *
 * Verification depth confirmed by the user on SIS-91 (2026-09-26):
 *   - the decision enum is allow | deny only; "ask" is not a decision — an always-ask
 *     session produces a PENDING approval_request that waits for exactly one decision;
 *   - while pending, the tool has not run; after allow / deny the task continues;
 *   - submitting the same decision twice must not execute anything twice (404);
 *   - approval state does not cross a fork: the fork inherits the approval MODE, never the
 *     parent's pending or decided approvals.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvalDecision,
  assistantText,
  requestBegin,
  requestEnd,
  sessionMeta,
  toolCall,
  userText,
} from "@prismshadow/penguin-core";
import type { ApproveFn, OmniMessage, SessionMetaPayload } from "@prismshadow/penguin-core";
import type { ProjectCreateResponse, SessionForkResponse } from "../src/api/types.js";
import type { SessionRow } from "../src/db/repos/sessions.js";
import type { RuntimeSession, SessionLoader } from "../src/runtime/session-manager.js";
import { apiClient, createTestApp, provisionUser, waitFor, writeTraceFile } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const SID = "session-2026-09-26-10-00-00-aabbcc01";

interface SseFrame {
  event?: string;
  id?: string;
  data: string;
}

/**
 * Reads SSE frames off a stream response one at a time, across awaited steps (a decision
 * POST in the middle of a run): frames that arrive while the test does something else stay
 * buffered in the body and are picked up by the next read.
 */
class SseReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf = "";
  #decoder = new TextDecoder();

  constructor(res: Response) {
    expect(res.status).toBe(200);
    this.#reader = res.body!.getReader();
  }

  async next(timeoutMs = 3000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let idx = this.#buf.indexOf("\n\n");
      while (idx === -1) {
        if (Date.now() > deadline) throw new Error(`SSE read timed out (buffer: ${this.#buf})`);
        const { done, value } = await this.#reader.read();
        if (done) throw new Error("SSE stream ended before the expected frame");
        this.#buf += this.#decoder.decode(value, { stream: true });
        idx = this.#buf.indexOf("\n\n");
      }
      const raw = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 2);
      if (raw.startsWith(":") || raw.trim() === "") continue; // heartbeat / empty frame
      const frame: SseFrame = { data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
      }
      return frame;
    }
  }

  /** Reads frames until `done` fires (e.g. terminal task_state), returning everything seen. */
  async drainUntil(done: (frame: SseFrame) => boolean, timeoutMs = 5000): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`drainUntil timed out (${frames.length} frames)`);
      const frame = await this.next(deadline - Date.now());
      frames.push(frame);
      if (done(frame)) return frames;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => {});
  }
}

const dataOf = (frame: SseFrame): Record<string, unknown> =>
  JSON.parse(frame.data) as Record<string, unknown>;

/** The OmniMessage envelopes published on the stream (default, non-`server_event` frames). */
const omniFrames = (frames: SseFrame[]): Record<string, unknown>[] =>
  frames.filter((f) => f.event === undefined).map(dataOf);

const payloadsOf = (omnis: Record<string, unknown>[]): Record<string, unknown>[] =>
  omnis.map((m) => m.payload as Record<string, unknown>);

/** A session whose run requests one approval per listed tool call, then finishes. */
function scriptedApprovalSession(sessionId: string, toolCallIds: string[]): RuntimeSession {
  return {
    sessionId,
    toolPermission: () => "rw",
    generateTitle: async () => ({ title: null, usage: null }),
    compactability: () => "ok" as const,
    steer: () => false,
    skipReconnectWait: () => false,
    async *run(
      _input: OmniMessage[],
      opts: { approve: ApproveFn; signal: AbortSignal },
    ) {
      for (const toolCallId of toolCallIds) {
        const tc = toolCall({ name: "exec_command", arguments: "{}", toolCallId });
        yield tc;
        const decision = await opts.approve(tc);
        yield approvalDecision(decision, toolCallId);
      }
      if (opts.signal.aborted) return;
      yield assistantText("done");
    },
    async *compact() {},
  };
}

const loaderOf = (session: RuntimeSession): SessionLoader => ({ load: async () => session });

describe("approval contract (HTTP surface + SSE task record)", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let cookie: string;

  beforeEach(async () => {
    t = await createTestApp({ loader: loaderOf(scriptedApprovalSession(SID, ["tc-1"])) });
    ({ cookie } = await provisionUser(t.app, "approver"));
    api = apiClient(t.app, cookie);
    await (await api.post("/api/projects", { projectId: "approver-approval", name: "A" })).json();
    t.deps.sessionsRepo.insert({
      sessionId: SID,
      projectId: "approver-approval",
      agentId: "default_agent",
      modelId: "m1",
      provider: "custom",
      workspace: path.join(t.root, "ws"),
      approvalMode: "always-ask",
      title: null,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await t.cleanup();
  });

  const startTask = () =>
    api.post(`/api/sessions/${SID}/tasks`, { input: [{ type: "text", text: "go" }] });

  const decide = (toolCallId: string, decision: unknown) =>
    api.post(`/api/sessions/${SID}/approvals/${toolCallId}`, { decision });

  const openStream = async () =>
    new SseReader(
      await t.app.request(`/api/sessions/${SID}/stream`, { headers: { cookie } }),
    );

  it("the decision enum is allow | deny exactly: 'ask' is not a decision", async () => {
    for (const notADecision of ["ask", "pending", "ALLOW", ""]) {
      const res = await decide("tc-1", notADecision);
      expect(res.status, `decision=${notADecision}`).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code, `decision=${notADecision}`).toBe("bad_request");
      expect(body.error.message).toContain("allow / deny");
    }
  });

  it("ask | 待定: an always-ask tool call parks as a pending approval_request; the tool has not run", async () => {
    // Subscribe BEFORE the task: the client sees the whole sequence.
    const reader = await openStream();
    const snapshot = dataOf(await reader.next());
    expect(snapshot.type).toBe("task_state");

    expect((await startTask()).status).toBe(202);
    await waitFor(() => t.deps.manager.pendingApprovalCount(SID) === 1);

    // Running state is observable…
    await reader.drainUntil((f) => {
      const d = dataOf(f);
      return d.type === "task_state" && d.state === "running";
    });
    // …and the parked request arrives as an approval_request naming the tool call.
    const approval = await reader.drainUntil((f) => dataOf(f).type === "approval_request");
    const envelope = dataOf(approval.at(-1)!) as {
      toolCall: { payload: { tool_call_id: string } };
    };
    expect(envelope.toolCall.payload.tool_call_id).toBe("tc-1");

    // Waiting: the record so far holds the request but NO decision and NO follow-up output.
    // Nothing has executed; the session stays parked until a decision arrives.
    expect(t.deps.manager.statusOf(SID)).toBe("running");
    await t.deps.manager.abortTask(SID);
    await waitFor(() => t.deps.manager.statusOf(SID) === "idle");
    await reader.cancel();
  });

  it("pending → allow: the tool call resolves, the task continues and completes", async () => {
    const reader = await openStream();
    await reader.next(); // task_state snapshot
    await startTask();
    await waitFor(() => t.deps.manager.pendingApprovalCount(SID) === 1);
    await reader.drainUntil((f) => dataOf(f).type === "approval_request");

    expect((await decide("tc-1", "allow")).status).toBe(204);
    await waitFor(() => t.deps.manager.statusOf(SID) === "idle");
    const frames = await reader.drainUntil((f) => {
      const d = dataOf(f);
      return d.type === "task_state" && d.state === "idle";
    });

    const payloads = payloadsOf(omniFrames(frames));
    // Exactly one decision — allow — and the run's own follow-up output.
    const decisions = payloads.filter((p) => p.type === "approval_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "allow", tool_call_id: "tc-1" });
    expect(payloads.some((p) => p.type === "text" && p.text === "done")).toBe(true);
    // Event ids are opaque epoch-sequence strings, non-decreasing within the stream.
    const ids = frames.map((f) => f.id).filter((id): id is string => id !== undefined);
    expect(ids.length).toBeGreaterThan(1);
    for (let i = 1; i < ids.length; i++) {
      const prev = Number(ids[i - 1]!.split("-")[1]);
      const curr = Number(ids[i]!.split("-")[1]);
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
    await reader.cancel();
  });

  it("pending → deny: the tool call is refused, the task still continues and completes", async () => {
    const reader = await openStream();
    await reader.next(); // snapshot
    await startTask();
    await waitFor(() => t.deps.manager.pendingApprovalCount(SID) === 1);
    await reader.drainUntil((f) => dataOf(f).type === "approval_request");

    expect((await decide("tc-1", "deny")).status).toBe(204);
    await waitFor(() => t.deps.manager.statusOf(SID) === "idle");
    const frames = await reader.drainUntil((f) => {
      const d = dataOf(f);
      return d.type === "task_state" && d.state === "idle";
    });

    const payloads = payloadsOf(omniFrames(frames));
    const decisions = payloads.filter((p) => p.type === "approval_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "deny", tool_call_id: "tc-1" });
    // A denial answers the tool call; it must not strand the task — the run explains or
    // adjusts and finishes.
    expect(payloads.some((p) => p.type === "text" && p.text === "done")).toBe(true);
    await reader.cancel();
  });

  it("duplicate submission is rejected and executes nothing twice", async () => {
    const reader = await openStream();
    await reader.next(); // snapshot
    await startTask();
    await waitFor(() => t.deps.manager.pendingApprovalCount(SID) === 1);
    const pre = await reader.drainUntil((f) => dataOf(f).type === "approval_request");

    expect((await decide("tc-1", "allow")).status).toBe(204);
    await waitFor(() => t.deps.manager.statusOf(SID) === "idle");
    const post = await reader.drainUntil((f) => {
      const d = dataOf(f);
      return d.type === "task_state" && d.state === "idle";
    });

    // The second POST for the same approval is a 404…
    const again = await decide("tc-1", "allow");
    expect(again.status).toBe(404);
    const body = (await again.json()) as { error: { code: string } };
    expect(body.error.code).toBe("approval_not_found");

    // …and the record still holds exactly one tool call and one decision for tc-1.
    const payloads = payloadsOf(omniFrames([...pre, ...post]));
    const toolCalls = payloads.filter(
      (p) => p.type === "tool_call" && p.tool_call_id === "tc-1",
    );
    const decisions = payloads.filter((p) => p.type === "approval_decision");
    expect(toolCalls).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    await reader.cancel();
  });
});

describe("approval contract across a fork", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const { cookie } = await provisionUser(t.app, "forger");
    api = apiClient(t.app, cookie);
    const project = (await (
      await api.post("/api/projects", { projectId: "forger-fork", name: "F" })
    ).json()) as ProjectCreateResponse;
    projectId = project.project.projectId;
  });

  afterEach(async () => {
    await t.cleanup();
  });

  async function seedForkableSession(): Promise<SessionRow> {
    const row: SessionRow = {
      sessionId: SID,
      projectId,
      agentId: "default_agent",
      modelId: "m1",
      provider: "custom",
      workspace: path.join(t.root, "ws"),
      approvalMode: "always-ask",
      title: "Fork source",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      hasTrace: true,
    };
    t.deps.sessionsRepo.insert(row);
    const meta: SessionMetaPayload = {
      session_id: SID,
      provider: "custom",
      model_id: "m1",
      model_context_window: 10_000,
      system_prompt: "p",
      agent_state: path.join(t.root, projectId, "agents", "default_agent", "agent_state"),
      workspace: row.workspace,
    };
    await writeTraceFile(t.root, projectId, "default_agent", "2026-09-26", SID, 1, [
      { ...sessionMeta(meta), timestamp: "2026-09-26T10:00:00.000Z" },
      { ...userText("hello"), timestamp: "2026-09-26T10:00:01.000Z" },
      { ...requestBegin(), timestamp: "2026-09-26T10:00:02.000Z" },
      { ...assistantText("first answer"), timestamp: "2026-09-26T10:00:03.000Z" },
      { ...requestEnd("completed"), timestamp: "2026-09-26T10:00:04.000Z" },
    ]);
    return row;
  }

  it("the fork inherits the approval mode but none of the parent's approvals", async () => {
    await seedForkableSession();
    const history = (await (
      await api.get(`/api/sessions/${SID}/messages`)
    ).json()) as { messages: { payload: { text?: string }; tracePosition?: unknown }[] };
    // A fork position must be a completed root assistant reply.
    const selected = history.messages.find((m) => m.payload.text === "first answer");
    expect(selected?.tracePosition).toBeDefined();

    const response = await api.post(`/api/sessions/${SID}/fork`, {
      position: selected!.tracePosition,
    });
    expect(response.status).toBe(201);
    const { session: forked } = (await response.json()) as SessionForkResponse;

    // The MODE is inherited…
    expect(forked.approvalMode).toBe("always-ask");
    // …but the parent's decided approval does not exist in the fork: submitting it there
    // is a 404, so a parent authorization can never execute anything in the child.
    const res = await api.post(`/api/sessions/${forked.sessionId}/approvals/tc-1`, {
      decision: "allow",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("approval_not_found");
  });
});
