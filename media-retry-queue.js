// Recuperação de mídias cujos bytes foram baixados mas não puderam
// ser gravados no Supabase Storage. Arquivos ficam no volume /app/auth.
// Limite de uso: 150 MB, sem substituir credenciais ou dados já persistidos.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function createMediaRetryQueue(authPath, { maxPendingBytes = 150 * 1024 * 1024 } = {}) {
  const root = path.join(authPath, ".media-upload-pending");
  fs.mkdirSync(root, { recursive: true });
  let active = false;
  const validIds = () => fs.readdirSync(root).filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f)).map((f) => f.slice(0, -5)).sort();
  const pendingBytes = () => fs.readdirSync(root).filter((f) => f.endsWith(".bin")).reduce((sum, f) => sum + fs.statSync(path.join(root, f)).size, 0);
  async function enqueue(meta, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 1) return false;
    if (buffer.length > maxPendingBytes || pendingBytes() + buffer.length > maxPendingBytes) return false;
    const id = randomUUID();
    const file = path.join(root, id + ".bin");
    const json = path.join(root, id + ".json");
    try {
      await fs.promises.writeFile(file, buffer, { flag: "wx", mode: 0o600 });
      await fs.promises.writeFile(json, JSON.stringify(meta), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      await Promise.allSettled([fs.promises.rm(file, { force: true }), fs.promises.rm(json, { force: true })]);
      throw e;
    }
  }
  async function drain(deliver, maxItems = 3) {
    if (active) return { busy: true };
    active = true;
    let sent = 0, failed = 0;
    try {
      for (const id of validIds().slice(0, maxItems)) {
        const file = path.join(root, id + ".bin");
        const json = path.join(root, id + ".json");
        try {
          const meta = JSON.parse(await fs.promises.readFile(json, "utf8"));
          const bytes = await fs.promises.readFile(file);
          if (!(await deliver(meta, bytes))) { failed++; break; }
          await fs.promises.rm(json);
          await fs.promises.rm(file);
          sent++;
        } catch (e) {
          console.warn("Mídia pendente não recuperada", { id, reason: e.message });
          failed++;
          break;
        }
      }
    } finally {
      active = false;
    }
    return { sent, failed };
  }
  return { enqueue, drain, count: () => validIds().length, pendingBytes };
}
