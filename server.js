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
  Browsers,
  downloadMediaMessage
} from "@whiskeysockets/baileys";

import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "90mb" }));

const PORT = process.env.PORT || 3000;
const GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;
const AUTH_PATH = process.env.AUTH_PATH || "./auth";

const SYSTEM_WEBHOOK_URL = process.env.SYSTEM_WEBHOOK_URL;
const SYSTEM_WEBHOOK_SECRET = process.env.SYSTEM_WEBHOOK_SECRET;

const MAX_MEDIA_SIZE_MB = Number(process.env.MAX_MEDIA_SIZE_MB || 60);
const MAX_MEDIA_SIZE_BYTES = MAX_MEDIA_SIZE_MB * 1024 * 1024;

const sessions = new Map();
const reconnectTimers = new Map();

// Mapa temporário em memória: contact_lid -> contact_phone
// Importante: some em redeploy/restart. O Lovable/Supabase também precisa persistir esse vínculo.
const lidToPhoneMap = new Map();

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

function normalizePhoneToJid(phone) {
  const value = String(phone || "").trim();

  if (!value) return null;

  if (value.endsWith("@lid")) return null;

  if (value.endsWith("@s.whatsapp.net")) return value;

  const digits = value.replace(/\D/g, "");

  if (!digits) return null;

  return `${digits}@s.whatsapp.net`;
}

function cleanPhoneFromJid(jid) {
  return String(jid || "")
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace(/\D/g, "");
}

function cleanLidFromJid(jid) {
  return String(jid || "")
    .replace("@lid", "")
    .replace(/\D/g, "");
}

function isPhoneJid(value) {
  return String(value || "").endsWith("@s.whatsapp.net");
}

function isLidJid(value) {
  return String(value || "").endsWith("@lid");
}

function rememberLidPhoneMapping({ lid, phone, source = "unknown" }) {
  const cleanLid = cleanLidFromJid(lid);
  const cleanPhone = cleanPhoneFromJid(phone);

  if (!cleanLid || !cleanPhone) return;

  lidToPhoneMap.set(cleanLid, cleanPhone);

  console.log("Mapeamento LID -> telefone salvo em memória:", {
    lid: cleanLid,
    phone: cleanPhone,
    source
  });
}

function getDeepStringValues(obj, maxDepth = 6) {
  const results = [];
  const seen = new WeakSet();

  function walk(value, depth) {
    if (!value || depth > maxDepth) return;

    if (typeof value === "string") {
      results.push(value);
      return;
    }

    if (typeof value !== "object") return;
    if (Buffer.isBuffer(value)) return;

    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }

    for (const child of Object.values(value)) {
      walk(child, depth + 1);
    }
  }

  walk(obj, 0);
  return results;
}

function getDeepValuesByKey(obj, wantedKeys = [], maxDepth = 7) {
  const results = [];
  const seen = new WeakSet();

  function walk(value, depth) {
    if (!value || typeof value !== "object" || depth > maxDepth) return;
    if (Buffer.isBuffer(value)) return;

    if (seen.has(value)) return;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (wantedKeys.includes(key) && typeof child === "string") {
        results.push(child);
      }

      if (child && typeof child === "object") {
        walk(child, depth + 1);
      }
    }
  }

  walk(obj, 0);
  return results;
}

function extractPossibleJids(msg = {}, remoteJid = "") {
  const directValues = [
    remoteJid,
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.participant,
    msg?.participantAlt,
    msg?.sender,
    msg?.recipient,
    msg?.message?.senderKeyDistributionMessage?.groupId
  ].filter(Boolean);

  const deepByKey = getDeepValuesByKey(msg, [
    "remoteJid",
    "remoteJidAlt",
    "participant",
    "participantAlt",
    "sender",
    "recipient",
    "jid",
    "id",
    "user",
    "lid",
    "phone"
  ]);

  const deepStrings = getDeepStringValues(msg).filter((value) => {
    return value.includes("@s.whatsapp.net") || value.includes("@lid");
  });

  return [...new Set([...directValues, ...deepByKey, ...deepStrings])];
}

function getContactIdentity(remoteJid, msg = {}) {
  const cleanJid = String(remoteJid || "").trim();

  const possibleJids = extractPossibleJids(msg, cleanJid);

  const phoneJid = possibleJids.find((jid) => isPhoneJid(jid));
  const lidJid = possibleJids.find((jid) => isLidJid(jid));

  const phone = phoneJid ? cleanPhoneFromJid(phoneJid) : null;

  const lid = lidJid
    ? cleanLidFromJid(lidJid)
    : isLidJid(cleanJid)
      ? cleanLidFromJid(cleanJid)
      : null;

  if (lid && phone) {
    rememberLidPhoneMapping({
      lid,
      phone,
      source: "same_payload"
    });
  }

  if (isLidJid(cleanJid)) {
    const mappedPhone = lid ? lidToPhoneMap.get(lid) : null;

    return {
      contact_phone: mappedPhone || null,
      contact_jid: mappedPhone ? `${mappedPhone}@s.whatsapp.net` : cleanJid,
      contact_lid: lid || null,
      identity_source: mappedPhone ? "memory_lid_map" : "lid_only",
      possible_jids_found: possibleJids
    };
  }

  if (phoneJid) {
    return {
      contact_phone: phone || null,
      contact_jid: phoneJid,
      contact_lid: lid || null,
      identity_source: lid ? "phone_jid_with_lid" : "phone_jid",
      possible_jids_found: possibleJids
    };
  }

  if (isPhoneJid(cleanJid)) {
    const directPhone = cleanPhoneFromJid(cleanJid);

    return {
      contact_phone: directPhone || null,
      contact_jid: cleanJid,
      contact_lid: lid || null,
      identity_source: "direct_phone_jid",
      possible_jids_found: possibleJids
    };
  }

  const fallbackDigits = cleanJid.replace(/\D/g, "");

  return {
    contact_phone: fallbackDigits || null,
    contact_jid: cleanJid || null,
    contact_lid: lid || null,
    identity_source: "fallback",
    possible_jids_found: possibleJids
  };
}

function unwrapMessage(message) {
  if (!message) return null;

  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }

  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }

  if (message.editedMessage?.message) {
    return unwrapMessage(message.editedMessage.message);
  }

  return message;
}

function extractMessageText(message) {
  const cleanMessage = unwrapMessage(message);

  return (
    cleanMessage?.conversation ||
    cleanMessage?.extendedTextMessage?.text ||
    cleanMessage?.imageMessage?.caption ||
    cleanMessage?.videoMessage?.caption ||
    cleanMessage?.documentMessage?.caption ||
    cleanMessage?.buttonsResponseMessage?.selectedDisplayText ||
    cleanMessage?.listResponseMessage?.title ||
    cleanMessage?.listResponseMessage?.description ||
    cleanMessage?.templateButtonReplyMessage?.selectedDisplayText ||
    cleanMessage?.pollCreationMessage?.name ||
    cleanMessage?.pollCreationMessageV3?.name ||
    ""
  );
}

function extractMessageType(message) {
  const cleanMessage = unwrapMessage(message);

  if (cleanMessage?.conversation) return "text";
  if (cleanMessage?.extendedTextMessage) return "text";
  if (cleanMessage?.imageMessage) return "image";
  if (cleanMessage?.videoMessage) return "video";
  if (cleanMessage?.audioMessage) return "audio";
  if (cleanMessage?.documentMessage) return "document";
  if (cleanMessage?.stickerMessage) return "sticker";
  if (cleanMessage?.locationMessage) return "location";
  if (cleanMessage?.liveLocationMessage) return "location";
  if (cleanMessage?.contactMessage) return "contact";
  if (cleanMessage?.contactsArrayMessage) return "contact";
  if (cleanMessage?.buttonsResponseMessage) return "button_response";
  if (cleanMessage?.listResponseMessage) return "list_response";
  if (cleanMessage?.templateButtonReplyMessage) return "button_response";
  if (cleanMessage?.pollCreationMessage) return "poll";
  if (cleanMessage?.pollCreationMessageV3) return "poll";
  if (cleanMessage?.protocolMessage) return "protocol";
  if (cleanMessage?.reactionMessage) return "reaction";
  if (cleanMessage?.messageContextInfo) return "context";

  return "unknown";
}

function getMediaInfo(message) {
  const cleanMessage = unwrapMessage(message);

  if (cleanMessage?.imageMessage) {
    return {
      media_type: "image",
      media_message: cleanMessage.imageMessage,
      baileys_type: "imageMessage"
    };
  }

  if (cleanMessage?.videoMessage) {
    return {
      media_type: "video",
      media_message: cleanMessage.videoMessage,
      baileys_type: "videoMessage"
    };
  }

  if (cleanMessage?.audioMessage) {
    return {
      media_type: "audio",
      media_message: cleanMessage.audioMessage,
      baileys_type: "audioMessage"
    };
  }

  if (cleanMessage?.documentMessage) {
    return {
      media_type: "document",
      media_message: cleanMessage.documentMessage,
      baileys_type: "documentMessage"
    };
  }

  if (cleanMessage?.stickerMessage) {
    return {
      media_type: "sticker",
      media_message: cleanMessage.stickerMessage,
      baileys_type: "stickerMessage"
    };
  }

  return null;
}

function getMessageTimestamp(messageTimestamp) {
  try {
    if (!messageTimestamp) return new Date().toISOString();

    const timestampNumber = Number(messageTimestamp);

    if (Number.isNaN(timestampNumber)) {
      return new Date().toISOString();
    }

    return new Date(timestampNumber * 1000).toISOString();
  } catch {
    return new Date().toISOString();
  }
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

async function sendMessageToSystemWebhook(payload) {
  if (!SYSTEM_WEBHOOK_URL || !SYSTEM_WEBHOOK_SECRET) {
    console.log("Webhook do sistema não configurado. Mensagem não enviada ao Supabase.", {
      hasWebhookUrl: Boolean(SYSTEM_WEBHOOK_URL),
      hasWebhookSecret: Boolean(SYSTEM_WEBHOOK_SECRET)
    });

    return {
      success: false,
      skipped: true,
      reason: "webhook_not_configured"
    };
  }

  try {
    const response = await fetch(SYSTEM_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": SYSTEM_WEBHOOK_SECRET
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();

    console.log("Resposta do webhook:", {
      status: response.status,
      ok: response.ok,
      body: responseText?.slice?.(0, 1000) || responseText
    });

    return {
      success: response.ok,
      status: response.status,
      body: responseText
    };
  } catch (error) {
    console.log("Erro ao enviar mensagem para webhook:", error.message);

    return {
      success: false,
      error: error.message
    };
  }
}

async function downloadIncomingMedia({ sock, msg, mediaInfo }) {
  const logger = pino({ level: "info" });

  const buffer = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage
    }
  );

  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Falha ao baixar mídia do WhatsApp");
  }

  if (buffer.length > MAX_MEDIA_SIZE_BYTES) {
    throw new Error(`Mídia excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);
  }

  const mediaMessage = mediaInfo.media_message || {};

  return {
    media_base64: buffer.toString("base64"),
    media_size_bytes: buffer.length,
    media_type: mediaInfo.media_type,
    media_mime_type: mediaMessage.mimetype || null,
    media_file_name:
      mediaMessage.fileName ||
      mediaMessage.title ||
      `${mediaInfo.media_type}-${Date.now()}`,
    media_caption: mediaMessage.caption || null,
    media_seconds: mediaMessage.seconds || null,
    media_file_length: mediaMessage.fileLength?.toString?.() || null,
    media_baileys_type: mediaInfo.baileys_type
  };
}

async function getBufferFromMediaRequest(body) {
  if (body.media_base64) {
    const base64 = String(body.media_base64).includes(",")
      ? String(body.media_base64).split(",").pop()
      : String(body.media_base64);

    const buffer = Buffer.from(base64, "base64");

    if (buffer.length > MAX_MEDIA_SIZE_BYTES) {
      throw new Error(`Mídia excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);
    }

    return buffer;
  }

  if (body.media_url) {
    const response = await fetch(body.media_url);

    if (!response.ok) {
      throw new Error(`Erro ao baixar media_url: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_MEDIA_SIZE_BYTES) {
      throw new Error(`Mídia excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);
    }

    return buffer;
  }

  throw new Error("Informe media_base64 ou media_url");
}
async function convertAudioToOggOpus(inputBuffer) {
  const tempDir = os.tmpdir();

  const inputPath = path.join(tempDir, `audio-input-${randomUUID()}.webm`);
  const outputPath = path.join(tempDir, `audio-output-${randomUUID()}.ogg`);

  fs.writeFileSync(inputPath, inputBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec("libopus")
        .audioBitrate("48k")
        .audioChannels(1)
        .format("ogg")
        .outputOptions([
          "-vn",
          "-application", "voip"
        ])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    const outputBuffer = fs.readFileSync(outputPath);

    return outputBuffer;
  } finally {
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch {}

    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
  }
}
async function buildBaileysMediaMessage({ mediaType, buffer, mimetype, fileName, caption }) {
  if (mediaType === "image") {
    return {
      image: buffer,
      mimetype: mimetype || "image/jpeg",
      caption: caption || undefined
    };
  }

  if (mediaType === "video") {
    return {
      video: buffer,
      mimetype: mimetype || "video/mp4",
      caption: caption || undefined
    };
  }

  if (mediaType === "audio") {
    console.log("Preparando áudio para WhatsApp:", {
      originalMimetype: mimetype,
      originalSizeBytes: buffer.length
    });

    const convertedBuffer = await convertAudioToOggOpus(buffer);

    console.log("Áudio convertido para OGG/Opus:", {
      convertedSizeBytes: convertedBuffer.length
    });

    return {
      audio: convertedBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true
    };
  }

  if (mediaType === "document") {
    return {
      document: buffer,
      mimetype: mimetype || "application/octet-stream",
      fileName: fileName || `documento-${Date.now()}`
    };
  }

  if (mediaType === "sticker") {
    return {
      sticker: buffer
    };
  }

  throw new Error("media_type inválido. Use image, video, audio, document ou sticker.");
}

async function processIncomingOrOutgoingMessages({ messageUpdate, sessionId, storeId }) {
  const messages = messageUpdate.messages || [];
  const sessionData = sessions.get(sessionId);

  for (const msg of messages) {
    try {
      if (!msg?.message) continue;

      const remoteJid = msg.key?.remoteJid || "";
      const fromMe = Boolean(msg.key?.fromMe);
      const messageId = msg.key?.id || null;

      if (!remoteJid) continue;

      if (remoteJid.includes("@g.us")) {
        console.log("Mensagem de grupo ignorada:", remoteJid);
        continue;
      }

      if (remoteJid === "status@broadcast") {
        continue;
      }

      const contactIdentity = getContactIdentity(remoteJid, msg);
      const cleanMessage = unwrapMessage(msg.message);
      const messageText = extractMessageText(cleanMessage);
      const messageType = extractMessageType(cleanMessage);
      const mediaInfo = getMediaInfo(cleanMessage);

      if (!messageText && !mediaInfo && ["unknown", "protocol", "reaction", "context"].includes(messageType)) {
        console.log("Mensagem ignorada sem conteúdo útil:", {
          sessionId,
          remoteJid,
          fromMe,
          messageId,
          messageType,
          contactIdentity,
          rawKeys: cleanMessage ? Object.keys(cleanMessage) : []
        });
        continue;
      }

      let mediaPayload = null;

      if (mediaInfo) {
        try {
          console.log("Mídia recebida. Iniciando download:", {
            sessionId,
            storeId,
            messageId,
            mediaType: mediaInfo.media_type,
            mimetype: mediaInfo.media_message?.mimetype || null,
            fileName: mediaInfo.media_message?.fileName || null
          });

          mediaPayload = await downloadIncomingMedia({
            sock: sessionData?.sock,
            msg,
            mediaInfo
          });

          console.log("Mídia baixada com sucesso:", {
            messageId,
            mediaType: mediaPayload.media_type,
            sizeBytes: mediaPayload.media_size_bytes,
            mimetype: mediaPayload.media_mime_type
          });
        } catch (mediaError) {
          console.log("Erro ao baixar mídia recebida:", {
            messageId,
            error: mediaError.message
          });

          mediaPayload = {
            media_download_error: mediaError.message,
            media_type: mediaInfo.media_type,
            media_mime_type: mediaInfo.media_message?.mimetype || null,
            media_file_name: mediaInfo.media_message?.fileName || null,
            media_caption: mediaInfo.media_message?.caption || null,
            media_baileys_type: mediaInfo.baileys_type
          };
        }
      }

      const payload = {
        tipo: "whatsapp_message",
        conta_id: storeId,

        store_id: storeId,
        session_id: sessionId,

        contact_phone: contactIdentity.contact_phone,
        contact_jid: contactIdentity.contact_jid,
        contact_lid: contactIdentity.contact_lid,
        contact_name: msg.pushName || null,
        identity_source: contactIdentity.identity_source,

        message_id: messageId,
        from_me: fromMe,
        direction: fromMe ? "outbound" : "inbound",

        message_text: messageText || mediaPayload?.media_caption || "",
        message_type: mediaPayload ? "media" : messageType,

        media_type: mediaPayload?.media_type || null,
        media_mime_type: mediaPayload?.media_mime_type || null,
        media_file_name: mediaPayload?.media_file_name || null,
        media_caption: mediaPayload?.media_caption || null,
        media_size_bytes: mediaPayload?.media_size_bytes || null,
        media_base64: mediaPayload?.media_base64 || null,
        media_download_error: mediaPayload?.media_download_error || null,
        media_baileys_type: mediaPayload?.media_baileys_type || null,

        timestamp: getMessageTimestamp(msg.messageTimestamp),

        raw_payload: {
          key: msg.key,
          pushName: msg.pushName || null,
          messageTimestamp: msg.messageTimestamp || null,
          messageType,
          mediaInfo: mediaInfo
            ? {
                media_type: mediaInfo.media_type,
                baileys_type: mediaInfo.baileys_type,
                mimetype: mediaInfo.media_message?.mimetype || null,
                fileName: mediaInfo.media_message?.fileName || null,
                caption: mediaInfo.media_message?.caption || null
              }
            : null,
          possible_jids_found: contactIdentity.possible_jids_found || []
        }
      };

      console.log("Mensagem processada:", {
        sessionId,
        storeId,
        contaId: storeId,
        tipo: "whatsapp_message",
        contactPhone: contactIdentity.contact_phone,
        contactJid: contactIdentity.contact_jid,
        contactLid: contactIdentity.contact_lid,
        identitySource: contactIdentity.identity_source,
        possibleJidsFound: contactIdentity.possible_jids_found || [],
        fromMe,
        direction: fromMe ? "outbound" : "inbound",
        messageText: payload.message_text,
        messageType: payload.message_type,
        mediaType: payload.media_type,
        hasMediaBase64: Boolean(payload.media_base64),
        messageId
      });

      await sendMessageToSystemWebhook(payload);
    } catch (error) {
      console.log("Erro ao processar uma mensagem:", error.message);
    }
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
    await processIncomingOrOutgoingMessages({
      messageUpdate,
      sessionId,
      storeId
    });
  });

  return sessionData;
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "whatsapp-gateway",
    webhook_configured: Boolean(SYSTEM_WEBHOOK_URL && SYSTEM_WEBHOOK_SECRET),
    media_enabled: true,
    max_media_size_mb: MAX_MEDIA_SIZE_MB,
    lid_phone_mappings_count: lidToPhoneMap.size,
    routes: [
      "POST /sessions",
      "GET /sessions/:sessionId/status",
      "DELETE /sessions/:sessionId",
      "POST /messages/send",
      "POST /messages/send-media"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "whatsapp-gateway",
    webhook_configured: Boolean(SYSTEM_WEBHOOK_URL && SYSTEM_WEBHOOK_SECRET),
    media_enabled: true,
    max_media_size_mb: MAX_MEDIA_SIZE_MB,
    lid_phone_mappings_count: lidToPhoneMap.size
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
    reconnect_attempts: sessionData.reconnectAttempts || 0,
    webhook_configured: Boolean(SYSTEM_WEBHOOK_URL && SYSTEM_WEBHOOK_SECRET),
    media_enabled: true,
    lid_phone_mappings_count: lidToPhoneMap.size
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
  const { session_id, phone, contact_jid, message } = req.body;

  if (!session_id || !message || (!phone && !contact_jid)) {
    return res.status(400).json({
      error: "session_id, message e phone ou contact_jid são obrigatórios"
    });
  }

  const sessionData = sessions.get(session_id);

  if (!sessionData || sessionData.status !== "conectado") {
    return res.status(400).json({
      error: "Sessão não conectada"
    });
  }

  try {
    const preferredDestination = phone || contact_jid;

    if (String(preferredDestination).endsWith("@lid")) {
      return res.status(400).json({
        error: "Não é possível enviar mensagem para @lid. Use o telefone real do contato.",
        code: "cannot_send_to_lid"
      });
    }

    const jid = normalizePhoneToJid(preferredDestination);

    if (!jid) {
      return res.status(400).json({
        error: "Destino inválido. Informe um telefone real ou um JID @s.whatsapp.net.",
        code: "invalid_destination"
      });
    }

    const result = await sessionData.sock.sendMessage(jid, {
      text: message
    });

    console.log("Mensagem enviada pelo endpoint:", {
      session_id,
      phone,
      contact_jid,
      jid,
      message,
      result
    });

    return res.json({
      success: true,
      jid,
      message_id: result?.key?.id || null,
      from_me: result?.key?.fromMe || null,
      status: result?.status || null,
      raw_result: result
    });
  } catch (error) {
    return res.status(500).json({
      error: "Erro ao enviar mensagem",
      details: error.message
    });
  }
});

app.post("/messages/send-media", checkSecret, async (req, res) => {
  const {
    session_id,
    phone,
    contact_jid,
    media_type,
    media_url,
    media_base64,
    media_mime_type,
    media_file_name,
    caption
  } = req.body;

  if (!session_id || (!phone && !contact_jid)) {
    return res.status(400).json({
      error: "session_id e phone ou contact_jid são obrigatórios"
    });
  }

  if (!media_type) {
    return res.status(400).json({
      error: "media_type é obrigatório. Use image, video, audio, document ou sticker."
    });
  }

  if (!media_url && !media_base64) {
    return res.status(400).json({
      error: "media_url ou media_base64 é obrigatório"
    });
  }

  const sessionData = sessions.get(session_id);

  if (!sessionData || sessionData.status !== "conectado") {
    return res.status(400).json({
      error: "Sessão não conectada"
    });
  }

  try {
    const preferredDestination = phone || contact_jid;

    if (String(preferredDestination).endsWith("@lid")) {
      return res.status(400).json({
        error: "Não é possível enviar mídia para @lid. Use o telefone real do contato.",
        code: "cannot_send_to_lid"
      });
    }

    const jid = normalizePhoneToJid(preferredDestination);

    if (!jid) {
      return res.status(400).json({
        error: "Destino inválido. Informe um telefone real ou um JID @s.whatsapp.net.",
        code: "invalid_destination"
      });
    }

    const buffer = await getBufferFromMediaRequest({
      media_url,
      media_base64
    });

    const baileysMessage = await buildBaileysMediaMessage({
  mediaType: media_type,
  buffer,
  mimetype: media_mime_type,
  fileName: media_file_name,
  caption
});

    const result = await sessionData.sock.sendMessage(jid, baileysMessage);

    console.log("Mídia enviada pelo endpoint:", {
      session_id,
      phone,
      contact_jid,
      jid,
      media_type,
      media_mime_type,
      media_file_name,
      sizeBytes: buffer.length,
      messageId: result?.key?.id || null
    });

    return res.json({
      success: true,
      jid,
      message_id: result?.key?.id || null,
      from_me: result?.key?.fromMe || null,
      status: result?.status || null,
      media_type,
      media_mime_type: media_mime_type || null,
      media_file_name: media_file_name || null,
      raw_result: result
    });
  } catch (error) {
    console.log("Erro ao enviar mídia:", error.message);

    return res.status(500).json({
      error: "Erro ao enviar mídia",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Gateway rodando na porta ${PORT}`);
});
