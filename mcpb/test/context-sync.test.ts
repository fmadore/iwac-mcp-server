import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextSync, type ContextSyncStatus } from "../src/app/contextSync.js";

interface Context {
  selection: string;
}
interface Send {
  value: Context;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
}

function harness() {
  const calls: Send[] = [];
  const statuses: ContextSyncStatus[] = [];
  let active = 0;
  let maxActive = 0;
  const sync = new ContextSync<Context>((value, signal) => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve, reject) => {
      calls.push({
        value, signal,
        resolve: () => { active--; resolve(); },
        reject: (error) => { active--; reject(error); },
      });
    });
  }, (status) => statuses.push(status));
  return { sync, calls, statuses, maxActive: () => maxActive };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const selection = (value: string) => ({ selection: value });

test("context updates serialize, coalesce to the newest selection, and deduplicate equal JSON", async () => {
  const { sync, calls, statuses, maxActive } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  sync.publish(selection("C"));
  assert.deepEqual(calls.map((call) => call.value.selection), ["A"]);
  calls[0].resolve();
  await turn();
  assert.deepEqual(calls.map((call) => call.value.selection), ["A", "C"]);
  assert.deepEqual(statuses, ["pending"], "stale A does not claim that C was shared");
  calls[1].resolve();
  await turn();
  sync.publish(selection("C"));
  assert.equal(calls.length, 2);
  assert.deepEqual(statuses, ["pending", "shared"]);
  assert.equal(maxActive(), 1);
});

test("A -> B -> A reuses A already in flight and drops unsent B", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  sync.publish(selection("A"));
  calls[0].resolve();
  await turn();
  assert.deepEqual(calls.map((call) => call.value.selection), ["A"]);
  assert.deepEqual(statuses, ["pending", "shared"]);
});

test("A must be sent again when B has already started before returning to A", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  calls[0].resolve();
  await turn();
  sync.publish(selection("B"));
  sync.publish(selection("A"));
  calls[1].resolve();
  await turn();
  assert.deepEqual(calls.map((call) => call.value.selection), ["A", "B", "A"]);
  assert.deepEqual(statuses, ["pending", "shared", "pending"]);
  calls[2].resolve();
  await turn();
  assert.deepEqual(statuses, ["pending", "shared", "pending", "shared"]);
});

test("failure advances to newer work and repeating the failed snapshot does not retry", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  calls[0].reject(new Error("stale A failed"));
  await turn();
  assert.deepEqual(calls.map((call) => call.value.selection), ["A", "B"]);
  assert.deepEqual(statuses, ["pending"]);
  calls[1].reject(new Error("B failed"));
  await turn();
  sync.publish(selection("B"));
  assert.equal(calls.length, 2);
  assert.deepEqual(statuses, ["pending", "failed"]);
  sync.publish(selection("C"));
  calls[2].resolve();
  await turn();
  assert.deepEqual(statuses, ["pending", "failed", "pending", "shared"]);
});

test("stop aborts the sender, drops queued work, and suppresses all later status", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  sync.stop();
  sync.stop();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].reject(new Error("aborted"));
  await turn();
  sync.publish(selection("C"));
  assert.deepEqual(calls.map((call) => call.value.selection), ["A"]);
  assert.deepEqual(statuses, ["pending"]);
});

test("status callbacks may publish, stop, or throw without recursive sends or unhandled failures", async () => {
  const values: string[] = [];
  const statuses: ContextSyncStatus[] = [];
  let sync: ContextSync<Context>;
  sync = new ContextSync<Context>(async (value) => {
    values.push(value.selection);
    if (value.selection === "B") throw new Error("provider rejected");
  }, (status) => {
    statuses.push(status);
    if (status === "pending" && values.length === 0) sync.publish(selection("B"));
    if (status === "failed") sync.publish(selection("C"));
    if (status === "shared") sync.stop();
    throw new Error("status rendering failed");
  });
  sync.publish(selection("A"));
  await turn();
  assert.deepEqual(values, ["B", "C"]);
  assert.deepEqual(statuses, ["pending", "failed", "pending", "shared"]);
  sync.publish(selection("D"));
  assert.deepEqual(values, ["B", "C"]);
});

test("a synchronous sender exception is handled as a failed snapshot", async () => {
  const statuses: ContextSyncStatus[] = [];
  const sync = new ContextSync<Context>(() => { throw new Error("sync failure"); }, (status) => statuses.push(status));
  sync.publish(selection("A"));
  await turn();
  sync.publish(selection("A"));
  assert.deepEqual(statuses, ["pending", "failed"]);
});

test("recovery from synchronous send failures never nests failed-status callbacks", async () => {
  let failures = 0, depth = 0, maxDepth = 0;
  let sync: ContextSync<Context>;
  sync = new ContextSync<Context>(() => { throw new Error("sync failure"); }, (status) => {
    if (status !== "failed") return;
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    failures++;
    if (failures < 4) sync.publish(selection(String(failures)));
    depth--;
  });
  sync.publish(selection("initial"));
  await turn();
  assert.equal(failures, 4);
  assert.equal(maxDepth, 1);
});
