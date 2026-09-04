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

async function startInternalServer() {
  process.env.PORT = String(internalPort);
  await import("./server.js");
}

const app = express();
app.use(cors());
app.use(express.raw({ type: "*/*", limit: "90mb" }));

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
    if (!routes.includes("POST /official/messages/send-template")) {
      routes.push("POST /official/messages/send-template");
    }
    return res.status(response.status).json({ ...data, routes });
  } catch (error) {
    return res.status(200).json({
      status: "online",
      service: "whatsapp-gateway",
      proxy_enabled: true,
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
  console.log(`Servidor interno rodando na porta ${internalPort}`);
  console.log("Rota oficial de templates ativa: POST /official/messages/send-template");
});
