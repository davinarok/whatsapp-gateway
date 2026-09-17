import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const publicPort = Number(process.env.PORT || 3000);
const internalPort = Number(process.env.INTERNAL_SERVER_PORT || 3001);
const internalBaseUrl = `http://127.0.0.1:${internalPort}`;

const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";

// O servidor legado (server.js) ainda cria sessão como `store_${store_id}`.
// O sistema novo usa session_id canônico = whatsapp_contas.id.
// Este proxy faz a ponte sem precisar reescrever o server.js inteiro:
// - entrada externa: session_id UUID
// - runtime interno Baileys: store_UUID
// - webhook de volta ao sistema: session_id volta a ser UUID
const ORIGINAL_SYSTEM_WEBHOOK_URL = process.env.SYSTEM_WEBHOOK_URL;
const ORIGINAL_SYSTEM_WEBHOOK_SECRET = process.env.SYSTEM_WEBHOOK_SECRET;
const INTERNAL_WEBHOOK_PATH = "/__internal/system-webhook";

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBrazilPhone(phone) {
  const digits = cleanDigits(phone);
  return digits || null;
}

function checkSecret(req, res, next) {
  const secret = req.headers["x-gateway-secret"];
  if (!GATEWAY_SECRET) {
    return res.status(500).json({
      success: false,
      error: "WHATSAPP_GATEWAY_SECRET não configurado no servidor"
    });
  }
  if (secret !== GATEWAY_SECRET) {
    return res.status(401).json({ success: false, error: "Não autorizado" });
  }
  next();
}

function parseJsonBody(req) {
  if (!req.body || req.body.length === 0) return {};
  try {
    return JSON.parse(req.body.toString("utf8"));
  } catch {
    return null;
  }
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function toInternalSessionId(sessionId) {
  const value = String(sessionId || "").trim();
  if (!value) return "";
  if (value.startsWith("store_")) return value;
  return `store_${value}`;
}

function toExternalSessionId(sessionId) {
  const value = String(sessionId || "").trim();
  if (value.startsWith("store_")) {
    const stripped = value.slice("store_".length);
    if (isUuidLike(stripped)) return stripped;
  }
  return value;
}

function resolveCanonicalSessionId(body = {}) {
  return String(
    body.session_id ||
    body.sessionId ||
    body.connection_id ||
    body.conta_id ||
    ""
  ).trim();
}

function rewriteSessionFieldsToExternal(value) {
  if (!value || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  if (copy.session_id) copy.session_id = toExternalSessionId(copy.session_id);
  if (copy.sessionId) copy.sessionId = toExternalSessionId(copy.sessionId);
  return copy;
}

async function proxyJsonRequest({ req, res, targetPath, body }) {
  const response = await fetch(`${internalBaseUrl}${targetPath}`, {
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${internalPort}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  return res.status(response.status).json(rewriteSessionFieldsToExternal(data));
}

async function startInternalServer() {
  process.env.PORT = String(internalPort);

  // Redireciona callbacks internos do Baileys para este proxy, onde o session_id
  // `store_UUID` é normalizado para o UUID canônico antes de chegar no Supabase.
  if (ORIGINAL_SYSTEM_WEBHOOK_URL && ORIGINAL_SYSTEM_WEBHOOK_SECRET) {
    process.env.SYSTEM_WEBHOOK_URL = `http://127.0.0.1:${publicPort}${INTERNAL_WEBHOOK_PATH}`;
    process.env.SYSTEM_WEBHOOK_SECRET = ORIGINAL_SYSTEM_WEBHOOK_SECRET;
  }

  await import("./server.js");
}

const app = express();
app.use(cors());
app.use(express.raw({ type: "*/*", limit: "90mb" }));

app.post(INTERNAL_WEBHOOK_PATH, async (req, res) => {
  if (!ORIGINAL_SYSTEM_WEBHOOK_URL || !ORIGINAL_SYSTEM_WEBHOOK_SECRET) {
    return res.status(200).json({ success: false, skipped: true, reason: "webhook_not_configured" });
  }

  const body = parseJsonBody(req);
  if (!body) return res.status(400).json({ success: false, error: "JSON inválido" });

  if (body.connection_type === "qr" || body.raw_payload?.provider === "baileys_qr") {
    body.session_id = toExternalSessionId(body.session_id);
    body.sessionId = toExternalSessionId(body.sessionId || body.session_id);
    if (body.conta_id && String(body.conta_id).startsWith("store_")) body.conta_id = toExternalSessionId(body.conta_id);
    if (body.store_id && String(body.store_id).startsWith("store_")) body.store_id = toExternalSessionId(body.store_id);
  }

  try {
    const response = await fetch(ORIGINAL_SYSTEM_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": ORIGINAL_SYSTEM_WEBHOOK_SECRET
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    return res.status(response.status).send(text);
  } catch (error) {
    console.log("Erro ao encaminhar webhook interno para o sistema:", error.message);
    return res.status(502).json({ success: false, error: error.message });
  }
});

app.post("/sessions", checkSecret, async (req, res) => {
  const body = parseJsonBody(req);
  if (!body) return res.status(400).json({ success: false, error: "JSON inválido" });

  const canonicalSessionId = resolveCanonicalSessionId(body);
  if (!canonicalSessionId) {
    return res.status(400).json({
      success: false,
      error: "session_id ou connection_id é obrigatório para sessões QR multi-conexão"
    });
  }

  const internalBody = {
    ...body,
    // O server.js legado monta `store_${store_id}`. Portanto, para ele criar
    // `store_UUID`, passamos o UUID canônico no campo store_id interno.
    store_id: canonicalSessionId,
    user_id: body.user_id || body.userId || null
  };

  return proxyJsonRequest({ req, res, targetPath: "/sessions", body: internalBody });
});

app.get("/sessions/:sessionId/status", checkSecret, async (req, res) => {
  const internalSessionId = toInternalSessionId(req.params.sessionId);
  const response = await fetch(`${internalBaseUrl}/sessions/${encodeURIComponent(internalSessionId)}/status`, {
    method: "GET",
    headers: { "x-gateway-secret": GATEWAY_SECRET }
  });
  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  return res.status(response.status).json(rewriteSessionFieldsToExternal(data));
});

app.delete("/sessions/:sessionId", checkSecret, async (req, res) => {
  const internalSessionId = toInternalSessionId(req.params.sessionId);
  const response = await fetch(`${internalBaseUrl}/sessions/${encodeURIComponent(internalSessionId)}`, {
    method: "DELETE",
    headers: { "x-gateway-secret": GATEWAY_SECRET }
  });
  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  return res.status(response.status).json(rewriteSessionFieldsToExternal(data));
});

app.post(["/messages/send", "/messages/send-media"], checkSecret, async (req, res) => {
  const body = parseJsonBody(req);
  if (!body) return res.status(400).json({ success: false, error: "JSON inválido" });
  if (body.session_id || body.sessionId) {
    body.session_id = toInternalSessionId(body.session_id || body.sessionId);
    delete body.sessionId;
  }
  return proxyJsonRequest({ req, res, targetPath: req.path, body });
});

app.post("/official/messages/send-template", checkSecret, async (req, res) => {
  const body = parseJsonBody(req);
  if (!body) {
    return res.status(400).json({ success: false, error: "JSON inválido" });
  }

  const {
    phone_number_id,
    access_token,
    to,
    phone,
    template_name,
    template,
    language,
    components
  } = body;

  const targetPhoneNumberId = phone_number_id || META_PHONE_NUMBER_ID;
  const targetAccessToken = access_token || META_ACCESS_TOKEN;
  const destination = normalizeBrazilPhone(to || phone);
  const templateName = template_name || template;
  const templateLanguage = language || "pt_BR";

  if (!targetPhoneNumberId) {
    return res.status(400).json({
      success: false,
      error: "phone_number_id é obrigatório para envio de template pela API oficial"
    });
  }

  if (!targetAccessToken) {
    return res.status(400).json({
      success: false,
      error: "access_token é obrigatório para envio de template pela API oficial"
    });
  }

  if (!destination || !templateName) {
    return res.status(400).json({
      success: false,
      error: "to/phone e template_name são obrigatórios"
    });
  }

  try {
    const templatePayload = {
      name: templateName,
      language: { code: templateLanguage }
    };

    if (Array.isArray(components) && components.length > 0) {
      templatePayload.components = components;
    }

    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${targetPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${targetAccessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: destination,
          type: "template",
          template: templatePayload
        })
      }
    );

    const responseBody = await response.json().catch(async () => ({ raw: await response.text() }));

    console.log("Envio de template oficial Meta:", {
      status: response.status,
      ok: response.ok,
      phoneNumberId: targetPhoneNumberId,
      to: destination,
      templateName,
      language: templateLanguage,
      hasComponents: Array.isArray(components) && components.length > 0,
      body: responseBody
    });

    return res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      status: response.status,
      result: responseBody
    });
  } catch (error) {
    console.log("Erro ao enviar template oficial:", {
      message: error.message,
      templateName,
      language: templateLanguage
    });

    return res.status(500).json({
      success: false,
      error: "Erro ao enviar template oficial",
      details: error.message
    });
  }
});

app.get("/", async (req, res) => {
  try {
    const response = await fetch(`${internalBaseUrl}/`);
    const data = await response.json();
    const routes = Array.isArray(data.routes) ? data.routes : [];
    for (const route of [
      "POST /official/messages/send-template",
      "POST /sessions (proxy session_id canonico)",
      "GET /sessions/:sessionId/status (proxy session_id canonico)",
      "DELETE /sessions/:sessionId (proxy session_id canonico)"
    ]) {
      if (!routes.includes(route)) routes.push(route);
    }
    return res.status(response.status).json({ ...data, routes, canonical_qr_session_proxy: true });
  } catch (error) {
    return res.status(200).json({
      status: "online",
      service: "whatsapp-gateway",
      proxy_enabled: true,
      canonical_qr_session_proxy: true,
      internal_server_error: error.message,
      routes: ["POST /official/messages/send-template"]
    });
  }
});

app.use(async (req, res) => {
  try {
    const targetUrl = `${internalBaseUrl}${req.originalUrl}`;
    const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
    delete headers["content-length"];

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body
    });

    const responseBuffer = Buffer.from(await response.arrayBuffer());
    response.headers.forEach((value, key) => {
      if (!["transfer-encoding", "content-encoding", "content-length"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    return res.status(response.status).send(responseBuffer);
  } catch (error) {
    console.log("Erro ao encaminhar requisição para servidor interno:", {
      method: req.method,
      path: req.originalUrl,
      message: error.message
    });

    return res.status(502).json({
      success: false,
      error: "Erro ao encaminhar requisição para servidor interno",
      details: error.message
    });
  }
});

await startInternalServer();

app.listen(publicPort, "0.0.0.0", () => {
  console.log(`WhatsApp Gateway proxy rodando na porta ${publicPort}`);
});
