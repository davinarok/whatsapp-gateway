import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionRegistry, createPersistedLidMap } from "./session-registry.js";
import { createWebhookOutbox } from "./webhook-outbox.js";
import { createMediaRetryQueue } from "./media-retry-queue.js";

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sandbox = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-tests-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { force: true, recursive: true }); }
};

test("registry survives restart and preserves the real store identifier", () => sandbox((dir) => {
  const a = createSessionRegistry(dir);
  a.upsert({ id: CONN, storeId: STORE, userId: null });
  const b = createSessionRegistry(dir);
  assert.equal(b.get(CONN)?.storeId, STORE);
  assert.equal(b.entries().length, 1);
  assert.throws(() => b.upsert({ id: "not-uuid", storeId: STORE }));
}));

test("registry can remove one connection without affecting others", () => sandbox((dir) => {
  const reg = createSessionRegistry(dir);
  reg.upsert({ id: CONN, storeId: STORE });
  reg.upsert({ id: OTHER, storeId: STORE });
  reg.remove(CONN);
  assert.equal(createSessionRegistry(dir).get(CONN), null);
  assert.equal(createSessionRegistry(dir).get(OTHER).storeId, STORE);
}));

test("LID mappings are isolated per QR session and survive restart", () => sandbox((dir) => {
  const a = createPersistedLidMap(dir, 3);
  const lid = "111111111";
  const namespace1 = `store_${CONN}:${lid}`;
  const namespace2 = `store_${OTHER}:${lid}`;
  a.set(namespace1, "5511999999999");
  a.set(namespace2, "5511888888888");
  a.set("bad", "not-a-phone");
  a.flush();
  const b = createPersistedLidMap(dir, 3);
  assert.equal(b.size, 2);
  assert.equal(b.get(namespace1), "5511999999999");
  assert.equal(b.get(namespace2), "5511888888888");
  assert.equal(b.get(lid), undefined);
}));


test("outbox retains failed messages, retries without duplication", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-outbox-"));
  try {
    const a = createWebhookOutbox(dir);
    assert.equal(a.enqueue({ message_id: "msg-01", message_text: "teste" }), true);
    assert.equal(a.enqueue({ media_upload_init: true, message_id: "init" }), false);
    assert.equal(a.enqueue({ media_base64: "AAA", message_id: "media" }), false);
    assert.equal(a.count(), 1);
    const b = createWebhookOutbox(dir);
    assert.deepEqual(await b.drain(async () => false), { sent: 0, failed: 1 });
    assert.equal(b.count(), 1);
    const replay = [];
    assert.deepEqual(await b.drain(async (p) => { replay.push(p.message_id); return true; }), { sent: 1, failed: 0 });
    assert.deepEqual(replay, ["msg-01"]);
    assert.equal(b.count(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("legacy routes keep the correct gateway authentication and never auto logout", () => {
  const proxy = fs.readFileSync("gateway-entry.js", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(proxy, /sessionRegistry\.upsert/);
  assert.match(proxy, /restorePersistedSessions/);
  assert.match(proxy, /x-whatsapp-api-secret/);
  assert.match(proxy, /\/history\/sync/);
  assert.match(server, /WHATSAPP_SYNC_FULL_HISTORY/);
  assert.match(server, /MAX_RECONNECT_ATTEMPTS/);
  assert.match(server, /webhookOutbox\.enqueue/);
  assert.doesNotMatch(server, /Resetando credenciais incompletas/);
  assert.match(server, /persistIncomingMediaDirect\(\{/);
});

test("media retry queue keeps binary bytes on disk across instances and cleans after delivery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-media-"));
  try {
    const first = createMediaRetryQueue(dir, { maxPendingBytes: 32 });
    assert.equal(await first.enqueue({ messageId: "media-1" }, Buffer.from("abc")), true);
    assert.equal(first.count(), 1);
    const second = createMediaRetryQueue(dir, { maxPendingBytes: 32 });
    let attempts = 0;
    const result1 = await second.drain(async (meta, bytes) => {
      attempts++;
      assert.equal(meta.messageId, "media-1");
      assert.equal(bytes.toString(), "abc");
      return false;
    });
    assert.equal(result1.failed, 1);
    assert.equal(second.count(), 1);
    const result2 = await second.drain(async () => true);
    assert.equal(result2.sent, 1);
    assert.equal(second.count(), 0);
    assert.equal(await second.enqueue({ messageId: "too-big" }, Buffer.alloc(33)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
