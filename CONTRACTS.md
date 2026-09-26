# Frozen Contract Surface (R0)

> **Downstream dependency declaration.** The surface listed here is what the downstream
> ArchMap adapter (mind-harness, 计划2) is built against. It was frozen by the R0 stage of
> the PenguinHarness refactor plan (`mind-harness/docs/planing/penguin-harness-refactor.md`).
> Any change to this surface — endpoint paths, request/response shapes, SSE event semantics,
> the SDK call conventions, or the approval decision enum — must be synced to the
> mind-harness repo's `design.md` 已核对能力表 before landing.
>
> Contract tests: `packages/server/test/contract-surface.test.ts`,
> `packages/server/test/contract-approval.test.ts`, `packages/core/test/contract-sdk.test.ts`.

## SDK (packages/core)

| Contract | Definition | Notes |
| --- | --- | --- |
| `createAgent(opts?)` | `packages/core/src/agent.ts` (exported from the barrel) | Constructs the Agent; no network at construction. |
| `Agent.createSession(opts?)` | `packages/core/src/agent.ts` | Returns a `Session` with a `session-*` id. |
| `Session.run(messages, opts?)` | `packages/core/src/session.ts` | Async generator yielding `OmniMessage`s; `opts.approve` gates tool calls. |
| `OmniMessage` envelope | `packages/core/src/omnimessage/types.ts` | `{ timestamp, type: "session_meta" \| "model_msg" \| "event_msg", payload, origin? }`. |
| Marker vocabulary | `packages/core/src/omnimessage/markers/tags.ts` | `MARKER_TAGS` (11 tags), `TRANSCRIPT_TAGS` (5), `TITLE_NOISE_TAGS` — frozen sets. |

## Server (packages/server)

Mounting: sub-routers registered in `packages/server/src/app.ts`. Error envelope for
handler rejections: `{ error: { code, message } }`.

### Session lifecycle & tasks (`http/routes/sessions.ts`, mounted at `/api/sessions` and `/api/projects/:projectId/agents/:agentId/sessions`)

- `GET/POST /api/projects/:p/agents/:a/sessions` — list / create
- `GET|PATCH|DELETE /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/tasks` — submit a task (`{ input: [{ type: "text" | "image_url", … }] }`)
- `GET /api/sessions/:sessionId/messages` — transcript (trace + live tail)
- `POST /api/sessions/:sessionId/steer`, `DELETE …/steer/:steerId`
- `POST /api/sessions/:sessionId/abort`, `POST …/retry-now`, `POST …/compact`
- `GET /api/sessions/:sessionId/goal`
- `POST /api/sessions/:sessionId/subagents/:childSessionId/message`, `POST …/abort`
- `DELETE /api/sessions/:sessionId/follow-ups/:followUpId`
- `GET /api/sessions/:sessionId/processes`, `POST …/processes/:processId/kill`, `DELETE …/processes/:processId`
- `GET /api/sessions/:sessionId/scratchpad/:fileName`

### Stream & events

- `GET /api/sessions/:sessionId/stream` — per-session SSE: OmniMessages as default frames,
  state changes as `event: server_event`; first frame is always the `task_state` snapshot,
  then still-pending `approval_request`s are replayed. Frame ids are `epoch-seq` strings,
  monotonic within an epoch; a mismatched `Last-Event-ID` epoch yields `resync_required`.
- `GET /api/events` — user-level SSE (`{type:"hello"}` first).

### Fork & traces

- `POST /api/sessions/:sessionId/fork` — `{ position: TracePosition }`,
  `TracePosition = { fileIndex: number ≥ 1, ordinal: number ≥ 0 }`
  (`api/types.ts`); the position must point at a completed root assistant reply of the last
  task (validation in `services/trace-service.ts`).
- `GET /api/sessions/:sessionId/traces[/:index[/analysis]]`
- `GET/POST /api/projects/:p/agents/:a/traces/…` (list / shard / analysis / download / import)

### Workspace files

- `GET /api/sessions/:sessionId/files`, `GET|PUT …/files/content`,
  `POST …/files/stat`, `GET …/files/preview-redirect`

### Approvals — verified semantics (contract-approval.test.ts)

- The decision enum is **`allow | deny` exactly** (`http/validate.ts` requireEnum in
  `sessions.ts`); anything else is a 400 `bad_request`. There is no `ask` decision: an
  `always-ask` approval mode produces a **pending** `approval_request` server event that
  waits for exactly one decision.
- While pending, the tool call has been requested but **not executed**.
- `allow` / `deny` both resolve the pending call; the task continues and completes in
  either case (`approval_decision` OmniMessage carries `{decision, tool_call_id}`).
- Duplicate submission of a decided approval → **404 `approval_not_found`**; nothing
  executes twice.
- Across a fork: the fork inherits the approval **mode** only; a parent's pending or
  decided approval does not exist in the fork (per-session `ApprovalRegistry`), so a
  parent authorization can never execute anything in the child.

### Preview

- `GET /preview/:token/*` — token-scoped static preview.

## Verification

```
pnpm -r typecheck && pnpm -r test && pnpm lint
```

must stay green; the contract tests above pin every item of this inventory.
