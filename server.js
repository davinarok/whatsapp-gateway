import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from "@whiskeysockets/baileys";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;
const AUTH_PATH = process.env.AUTH_PATH || "./auth";

const sessions = new Map();
const reconnectTimers = new Map();

function checkSecret(req, res, next) {
  const secret = req.headers["x-gateway-secret"];

  if (!GATEWAY_SECRET) {
    return res.status(500).json({
      error: "WHATSAPP_GATEWAY_SECRET não configurado no servidor"
    });
  }

  if (secret !== GATEWAY_SECRET) {
    return res.status(401).json({
      error: "Não autorizado"
    });
  }

  next();
}

function normalizePhone(phone) {
  return phone.includes("@s.whatsapp.net")
    ? phone
    : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
}

function removeAuthFolder(sessionId) {
  const sessionAuthPath = `${AUTH_PATH}/${sessionId}`;

  try {
    if (fs.existsSync(sessionAuthPath)) {
      fs.rmSync(sessionAuthPath, {
        recursive: true,
        force: true
      });
    }

    console.log(`Pasta de autenticação removida: ${sessionAuthPath}`);
  } catch (error) {
    console.log("Erro ao remover pasta de autenticação:", error.message);
  }
}

async function closeSocketSafely(sessionData, logout = false) {
  if (!sessionData?.sock) return;

  if (logout) {
    try {
      await sessionData.sock.logout();
    } catch (error) {
      console.log("Erro ao fazer logout da sessão:", error.message);
    }
  }

  try {
    sessionData.sock.end?.();
  } catch (error) {
    console.log("Erro ao encerrar socket:", error.message);
  }

  sessionData.sock = null;
}

function clearReconnectTimer(sessionId) {
  if (reconnectTimers.has(sessionId)) {
    clearTimeout(reconnectTimers.get(sessionId));
    reconnectTimers.delete(sessionId);
  }
}

async function startWhatsAppSession({ sessionId, storeId, userId }) {
  let sessionData = sessions.get(sessionId);

  if (!sessionData) {
    sessionData = {
      sessionId,
      storeId,
      userId: userId || null,
      status: "starting",
      qrCode: null,
      sock: null,
      lastError: null,
      reconnectAttempts: 0
    };

    sessions.set(sessionId, sessionData);
  }

  clearReconnectTimer(sessionId);

  sessionData.status = "starting";
  sessionData.qrCode = null;

  const { state, saveCreds } = await useMultiFileAuthState(`${AUTH_PATH}/${sessionId}`);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log("Baileys version:", {
    version,
    isLatest,
    sessionId
  });

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "info" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  sessionData.sock = sock;
  sessionData.status = "aguardando_qr";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.status = "aguardando_qr";
      sessionData.qrCode = await QRCode.toDataURL(qr);
      sessionData.lastError = null;

      console.log(`QR Code gerado para sessão ${sessionId}`);
    }

    if (connection === "open") {
      sessionData.status = "conectado";
      sessionData.qrCode = null;
      sessionData.lastError = null;
      sessionData.reconnectAttempts = 0;

      clearReconnectTimer(sessionId);

      console.log(`Sessão ${sessionId} conectada`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      sessionData.qrCode = null;
      sessionData.lastError = {
        statusCode,
        errorMessage,
        shouldReconnect
      };

      console.log("Conexão fechada:", {
        sessionId,
        statusCode,
        errorMessage,
        shouldReconnect
      });

      if (!shouldReconnect) {
        sessionData.status = "deslogado";
        return;
      }

      sessionData.status = "reiniciando";
      sessionData.reconnectAttempts = (sessionData.reconnectAttempts || 0) + 1;

      const reconnectDelay = Math.min(3000 * sessionData.reconnectAttempts, 15000);

      clearReconnectTimer(sessionId);

      const timer = setTimeout(async () => {
        try {
          console.log(`Tentando reconectar sessão ${sessionId}. Tentativa ${sessionData.reconnectAttempts}`);

          await closeSocketSafely(sessionData, false);

          await startWhatsAppSession({
            sessionId,
            storeId,
            userId
          });
        } catch (error) {
          sessionData.status = "erro";
          sessionData.lastError = {
            errorMessage: error.message
          };

          console.log("Erro ao tentar reconectar:", error.message);
        }
      }, reconnectDelay);

      reconnectTimers.set(sessionId, timer);
    }
  });

  sock.ev.on("messages.upsert", async (messageUpdate) => {
    console.log("Mensagem recebida:", JSON.stringify(messageUpdate, null, 2));
  });

  return sessionData;
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "whatsapp-gateway"
  });
});

app.post("/sessions", checkSecret, async (req, res) => {
  const { store_id, user_id } = req.body;

  if (!store_id) {
    return res.status(400).json({
      error: "store_id é obrigatório"
    });
  }

  const sessionId = `store_${store_id}`;
  const existingSession = sessions.get(sessionId);

  if (existingSession) {
    if (
      existingSession.status === "aguardando_qr" ||
      existingSession.status === "conectado" ||
      existingSession.status === "reiniciando" ||
      existingSession.status === "starting"
    ) {
      return res.json({
        session_id: sessionId,
        status: existingSession.status,
        qr_code: existingSession.qrCode || null,
        last_error: existingSession.lastError || null
      });
    }
  }

  try {
    const sessionData = await startWhatsAppSession({
      sessionId,
      storeId: store_id,
      userId: user_id || null
    });

    return res.json({
      session_id: sessionId,
      status: sessionData.status,
      qr_code: sessionData.qrCode || null,
      last_error: sessionData.lastError || null
    });
  } catch (error) {
    console.error(error);

    sessions.set(sessionId, {
      sessionId,
      storeId: store_id,
      userId: user_id || null,
      status: "erro",
      qrCode: null,
      sock: null,
      lastError: {
        errorMessage: error.message
      },
      reconnectAttempts: 0
    });

    return res.status(500).json({
      error: "Erro ao criar sessão WhatsApp",
      details: error.message
    });
  }
});

app.get("/sessions/:sessionId/status", checkSecret, (req, res) => {
  const { sessionId } = req.params;

  if (!sessions.has(sessionId)) {
    return res.status(404).json({
      error: "Sessão não encontrada"
    });
  }

  const sessionData = sessions.get(sessionId);

  return res.json({
    session_id: sessionId,
    status: sessionData.status,
    qr_code: sessionData.qrCode || null,
    last_error: sessionData.lastError || null,
    reconnect_attempts: sessionData.reconnectAttempts || 0
  });
});

app.delete("/sessions/:sessionId", checkSecret, async (req, res) => {
  const { sessionId } = req.params;

  clearReconnectTimer(sessionId);

  const sessionData = sessions.get(sessionId);

  await closeSocketSafely(sessionData, true);

  sessions.delete(sessionId);
  removeAuthFolder(sessionId);

  return res.json({
    success: true,
    session_id: sessionId,
    message: "Sessão removida. Gere um novo QR Code."
  });
});

app.post("/messages/send", checkSecret, async (req, res) => {
  const { session_id, phone, message } = req.body;

  if (!session_id || !phone || !message) {
    return res.status(400).json({
      error: "session_id, phone e message são obrigatórios"
    });
  }

  const sessionData = sessions.get(session_id);

  if (!sessionData || sessionData.status !== "conectado") {
    return res.status(400).json({
      error: "Sessão não conectada"
    });
  }

  try {
    const jid = normalizePhone(phone);

    await sessionData.sock.sendMessage(jid, {
      text: message
    });

    return res.json({
      success: true
    });
  } catch (error) {
    return res.status(500).json({
      error: "Erro ao enviar mensagem",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Gateway rodando na porta ${PORT}`);
});
