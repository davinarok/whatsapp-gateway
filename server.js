cat > server.js <<'EOF'
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;

const sessions = new Map();

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

  if (sessions.has(sessionId)) {
    const existingSession = sessions.get(sessionId);

    return res.json({
      session_id: sessionId,
      status: existingSession.status,
      qr_code: existingSession.qrCode || null
    });
  }

  const sessionData = {
    sessionId,
    storeId: store_id,
    userId: user_id || null,
    status: "starting",
    qrCode: null,
    sock: null
  };

  sessions.set(sessionId, sessionData);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false
    });

    sessionData.sock = sock;
    sessionData.status = "aguardando_qr";

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionData.status = "aguardando_qr";
        sessionData.qrCode = await QRCode.toDataURL(qr);
      }

      if (connection === "open") {
        sessionData.status = "conectado";
        sessionData.qrCode = null;
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        sessionData.status = "desconectado";

        if (shouldReconnect) {
          sessions.delete(sessionId);
        }
      }
    });

    sock.ev.on("messages.upsert", async (messageUpdate) => {
      console.log("Mensagem recebida:", JSON.stringify(messageUpdate, null, 2));
    });

    return res.json({
      session_id: sessionId,
      status: sessionData.status,
      qr_code: sessionData.qrCode
    });
  } catch (error) {
    console.error(error);

    sessionData.status = "erro";

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
    qr_code: sessionData.qrCode || null
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

  const jid = phone.includes("@s.whatsapp.net")
    ? phone
    : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;

  await sessionData.sock.sendMessage(jid, {
    text: message
  });

  return res.json({
    success: true
  });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Gateway rodando na porta ${PORT}`);
});
EOF
