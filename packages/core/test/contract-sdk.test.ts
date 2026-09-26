/**
 * R0 contract freeze (mind-harness 计划2): the SDK surface the downstream ArchMap adapter
 * depends on. Pins createAgent / Agent.createSession / Session.run's OmniMessage stream
 * shape and the marker tag vocabulary.
 *
 * No network: the Agent and Session are only constructed — pulling a single message from
 * run() is what would issue the first LLM request, and that is out of scope here (the HTTP
 * contract tests in penguin-server cover the wire behavior end to end).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantText,
  createAgent,
  isEventMessage,
  isModelMessage,
  isSessionMeta,
  requestBegin,
  sessionMeta,
  toolCall,
  userText,
} from "../src/index.js";
import type { OmniMessage, SessionMetaPayload } from "../src/index.js";
import { MARKER_TAGS, TRANSCRIPT_TAGS, TITLE_NOISE_TAGS } from "../src/omnimessage/markers/tags.js";
import { stubProviderKeys } from "./provider-keys.js";

const SESSION_META: SessionMetaPayload = {
  session_id: "session-1",
  provider: "custom",
  model_id: "m1",
  model_context_window: 10_000,
  system_prompt: "p",
  agent_state: "/tmp/agent_state",
  workspace: "/tmp/w",
};

let tmpRoot: string;
let restoreKeys: () => void;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-contract-"));
  process.env.PENGUIN_HOME = tmpRoot;
  restoreKeys = stubProviderKeys();
});

afterEach(async () => {
  restoreKeys();
  delete process.env.PENGUIN_HOME;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("SDK contract: createAgent / Agent.createSession / Session.run", () => {
  it("createAgent resolves and hands out a session; run() is a lazy OmniMessage async generator", async () => {
    const agent = await createAgent();
    const session = await agent.createSession();
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId).toMatch(/^session-/);

    // Constructing the iterator must not issue any request (lazy bootstrap); the stream
    // contract is "async iterable of OmniMessage".
    const stream = session.run([userText("hi")]);
    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
    await stream.return(null);
  });

  it("every OmniMessage on the wire carries exactly the frozen type enum and envelope", () => {
    const messages: OmniMessage[] = [
      sessionMeta(SESSION_META),
      userText("hello"),
      assistantText("hi"),
      toolCall({ name: "exec_command", arguments: "{}", toolCallId: "tc-1" }),
      requestBegin(),
    ];
    for (const message of messages) {
      // Envelope: timestamp + type + payload, per omnimessage/types.ts.
      expect(typeof message.timestamp).toBe("string");
      expect(["session_meta", "model_msg", "event_msg"]).toContain(message.type);
      expect(message.payload).toBeInstanceOf(Object);
    }
    // Guards classify the frozen three-type union: model traffic (text, tool_call, …) is
    // model_msg, harness lifecycle events are event_msg, and session_meta opens the stream.
    expect(isSessionMeta(messages[0]!)).toBe(true);
    expect(isModelMessage(messages[1]!)).toBe(true);
    expect(isModelMessage(messages[2]!)).toBe(true);
    expect(isModelMessage(messages[3]!)).toBe(true); // tool_call rides model traffic
    expect(isEventMessage(messages[4]!)).toBe(true);
    expect(isModelMessage(messages[0]!)).toBe(false);
    expect(isSessionMeta(messages[1]!)).toBe(false);
  });
});

describe("SDK contract: marker vocabulary (OmniMessage markers)", () => {
  it("MARKER_TAGS stays exactly the frozen set the adapter can parse", () => {
    expect(Object.values(MARKER_TAGS).sort()).toEqual(
      [
        "turn_aborted",
        "turn_retried",
        "context_summary",
        "summary",
        "user_steering",
        "use_skills",
        "handoff_from",
        "scheduled_task",
        "background_task_done",
        "model_switch_from",
        "developer_instructions",
      ].sort(),
    );
  });

  it("TRANSCRIPT_TAGS stays exactly the frozen inner-block set", () => {
    expect(Object.values(TRANSCRIPT_TAGS).sort()).toEqual(
      ["user_input", "thinking", "text", "tool_call", "tool_call_output"].sort(),
    );
  });

  it("title noise is a subset of MARKER_TAGS", () => {
    for (const tag of TITLE_NOISE_TAGS) {
      expect(Object.values(MARKER_TAGS)).toContain(tag);
    }
  });
});
