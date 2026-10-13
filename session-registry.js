// Registro durável das conexões QR. Guardado no mesmo volume das credenciais Baileys.
// Nunca guarda tokens ou arquivos de autenticação neste JSON.
import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function atomicJsonWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

export function createSessionRegistry(authPath) {
  const file = path.join(authPath, ".gateway-session-registry.json");
  const sessions = new Map();
  if (fs.existsSync(file)) {
    // Corrupção do registro deve parar a inicialização, nunca apagar o registro.
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Registro de sessões QR inválido");
    for (const row of rows) {
      if (UUID.test(row?.id) && UUID.test(row?.storeId)) {
        sessions.set(row.id, {
          id: row.id,
          storeId: row.storeId,
          userId: typeof row.userId === "string" ? row.userId : null
        });
      }
    }
  }
  const persist = () => atomicJsonWrite(file, [...sessions.values()]);
  return {
    file,
    entries: () => [...sessions.values()],
    get: (id) => sessions.get(String(id)) || null,
    upsert({ id, storeId, userId = null }) {
      if (!UUID.test(id) || !UUID.test(storeId)) throw new Error("IDs de sessão/loja inválidos");
      const old = sessions.get(id);
      sessions.set(id, { id, storeId, userId: userId || null });
      try { persist(); } catch (e) { if (old) sessions.set(id, old); else sessions.delete(id); throw e; }
      return sessions.get(id);
    },
    remove(id) {
      const old = sessions.get(id);
      if (!old) return;
      sessions.delete(id);
      try { persist(); } catch (e) { sessions.set(id, old); throw e; }
    }
  };
}

export function createPersistedLidMap(authPath, maxEntries = 20000) {
  const file = path.join(authPath, ".gateway-lid-phone.json");
  const data = new Map();
  if (fs.existsSync(file)) {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Registro de LID inválido");
    for (const [lid, phone] of rows.slice(-maxEntries)) {
      if (/^\d{5,25}$/.test(String(lid)) && /^\d{8,16}$/.test(String(phone))) data.set(String(lid), String(phone));
    }
  }
  let pending = null;
  function flush() {
    if (pending) clearTimeout(pending);
    pending = null;
    atomicJsonWrite(file, [...data.entries()]);
  }
  return {
    get size() { return data.size; },
    get: (lid) => data.get(String(lid)),
    set(lid, phone) {
      lid = String(lid);
      phone = String(phone);
      if (!/^\d{5,25}$/.test(lid) || !/^\d{8,16}$/.test(phone)) return;
      if (data.get(lid) === phone) return;
      data.delete(lid);
      data.set(lid, phone);
      while (data.size > maxEntries) data.delete(data.keys().next().value);
      if (!pending) { pending = setTimeout(flush, 1000); pending.unref?.(); }
    },
    flush
  };
}
