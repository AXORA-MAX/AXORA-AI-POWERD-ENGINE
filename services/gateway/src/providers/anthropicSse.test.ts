import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseFrames, extractTextDelta, isStreamDone, extractUsage } from "./anthropicSse.js";

// A canned, representative Anthropic Messages API stream. Hand-written to
// match the documented event shapes, not captured from a live call (no
// network in this sandbox) — see docs/VERIFICATION.md for what that means
// for confidence in this provider.
const CANNED_STREAM = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"output_tokens":0}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", AXORA"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":12,"output_tokens":5}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

test("parseSseFrames splits a full buffer into complete events with no remainder", () => {
  const { events, rest } = parseSseFrames(CANNED_STREAM);
  assert.equal(events.length, 7);
  assert.equal(rest, "");
});

test("parseSseFrames leaves an incomplete trailing frame in `rest` for the next chunk", () => {
  const partial = CANNED_STREAM.slice(0, CANNED_STREAM.length - 20);
  const { rest } = parseSseFrames(partial);
  assert.ok(rest.length > 0, "expected a non-empty remainder for a truncated buffer");
});

test("extractTextDelta pulls text only from content_block_delta events", () => {
  const { events } = parseSseFrames(CANNED_STREAM);
  const deltas = events.map(extractTextDelta).filter((d): d is string => d !== null);
  assert.deepEqual(deltas, ["Hello", ", AXORA"]);
});

test("isStreamDone is true only for message_stop", () => {
  const { events } = parseSseFrames(CANNED_STREAM);
  const doneFlags = events.map(isStreamDone);
  assert.deepEqual(doneFlags, [false, false, false, false, false, false, true]);
});

test("extractUsage reads token counts from message_delta", () => {
  const { events } = parseSseFrames(CANNED_STREAM);
  const usage = events.map(extractUsage).find((u) => u !== null);
  assert.deepEqual(usage, { input_tokens: 12, output_tokens: 5 });
});

test("parseSseFrames handles chunked delivery across two buffers correctly", () => {
  const mid = Math.floor(CANNED_STREAM.length / 2);
  const first = CANNED_STREAM.slice(0, mid);
  const second = CANNED_STREAM.slice(mid);

  const r1 = parseSseFrames(first);
  const r2 = parseSseFrames(r1.rest + second);

  const allEvents = [...r1.events, ...r2.events];
  const deltas = allEvents.map(extractTextDelta).filter((d): d is string => d !== null);
  assert.deepEqual(deltas, ["Hello", ", AXORA"]);
});
