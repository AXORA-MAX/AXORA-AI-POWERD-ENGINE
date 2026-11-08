import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenJson, jsonParser } from "./jsonParser.js";

test("flattenJson handles flat objects", () => {
  assert.deepEqual(flattenJson({ a: 1, b: "two" }), ["a: 1", "b: two"]);
});

test("flattenJson handles nested objects with dotted paths", () => {
  assert.deepEqual(flattenJson({ user: { name: "Ada", age: 30 } }), [
    "user.name: Ada",
    "user.age: 30",
  ]);
});

test("flattenJson handles arrays with bracket-indexed paths", () => {
  assert.deepEqual(flattenJson({ tags: ["a", "b"] }), ["tags[0]: a", "tags[1]: b"]);
});

test("flattenJson handles a top-level array of objects", () => {
  assert.deepEqual(flattenJson([{ id: 1 }, { id: 2 }]), ["[0].id: 1", "[1].id: 2"]);
});

test("jsonParser end-to-end produces readable flattened text", async () => {
  const json = Buffer.from(JSON.stringify({ title: "AXORA", tags: ["ai", "os"] }));
  const text = await jsonParser.parse(json);
  assert.ok(text.includes("title: AXORA"));
  assert.ok(text.includes("tags[0]: ai"));
});
