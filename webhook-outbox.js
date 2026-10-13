// Fila persistente de callbacks para que falhas transitórias do Supabase
// não provoquem perda silenciosa de mensagens. Reentrega é at-least-once:
// o webhook receptor DEVE usar message_id para deduplicação.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function createWebhookOutbox(authPath, { maxEntries = 2000, maxPayloadBytes = 256 * 1024 } = {}) {
  const directory = path.join(authPath, ".webhook-outbox");
  fs.mkdirSync(directory, { recursive: true });
  let draining = false;
  const files = () => fs.readdirSync(directory).filter((file) => /^[0-9a-f-]{36}\.json$/i.test(file)).sort();

  function enqueue(payload) {
    // media_upload_init deve devolver signed_url imediatamente; não pode ser reenviado.
    // Nunca armazenar Base64 grande na fila.
    if (payload?.media_upload_init || payload?.media_base64) return false;
    const raw = JSON.stringify(payload);
    if (Buffer.byteLength(raw) > maxPayloadBytes) return false;
    if (files().length >= maxEntries) return false;
    const name = randomUUID() + ".json";
    fs.writeFileSync(path.join(directory, name), raw, { flag: "wx", mode: 0o600 });
    return true;
  }

  async function drain(send, limit = 30) {
    if (draining) return { busy: true };
    draining = true;
    let sent = 0, failed = 0;
    try {
      for (const name of files().slice(0, limit)) {
        const file = path.join(directory, name);
        try {
          const payload = JSON.parse(fs.readFileSync(file, "utf8"));
          const ok = await send(payload);
          if (!ok) { failed++; break; }
          fs.rmSync(file, { force: true });
          sent++;
        } catch (error) {
          // Arquivo corrompido não é apagado automaticamente; isolar para análise.
          console.error("Falha na fila de webhook", { file: name, reason: error.message });
          failed++;
          break;
        }
      }
    } finally { draining = false; }
    return { sent, failed };
  }

  return { enqueue, drain, count: () => files().length, directory };
}
