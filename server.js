import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage
} from "@whiskeysockets/baileys";

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

const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v20.0";
const META_DEFAULT_STORE_ID = process.env.META_DEFAULT_STORE_ID || null;

const MAX_MEDIA_SIZE_MB = Number(process.env.MAX_MEDIA_SIZE_MB || 60);
const MAX_MEDIA_SIZE_BYTES = MAX_MEDIA_SIZE_MB * 1024 * 1024;

const sessions = new Map();
const reconnectTimers = new Map();
const lidToPhoneMap = new Map();

function checkSecret(req, res, next) {
  const secret = req.headers["x-gateway-secret"];
  if (!GATEWAY_SECRET) return res.status(500).json({ error: "WHATSAPP_GATEWAY_SECRET não configurado no servidor" });
  if (secret !== GATEWAY_SECRET) return res.status(401).json({ error: "Não autorizado" });
  next();
}

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBrazilPhone(phone) {
  const digits = cleanDigits(phone);
  if (!digits) return null;
  return digits;
}

function normalizePhoneToJid(phone) {
  const value = String(phone || "").trim();
  if (!value || value.endsWith("@lid")) return null;
  if (value.endsWith("@s.whatsapp.net")) return value;
  const digits = cleanDigits(value);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function cleanPhoneFromJid(jid) {
  return cleanDigits(String(jid || "").replace("@s.whatsapp.net", "").replace("@c.us", ""));
}

function cleanLidFromJid(jid) {
  return cleanDigits(String(jid || "").replace("@lid", ""));
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
  console.log("Mapeamento LID -> telefone salvo em memória:", { lid: cleanLid, phone: cleanPhone, source });
}

function getDeepStringValues(obj, maxDepth = 6) {
  const results = [];
  const seen = new WeakSet();

  function walk(value, depth) {
    if (!value || depth > maxDepth) return;
    if (typeof value === "string") return results.push(value);
    if (typeof value !== "object" || Buffer.isBuffer(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
  }

  walk(obj, 0);
  return results;
}

function getDeepValuesByKey(obj, wantedKeys = [], maxDepth = 7) {
  const results = [];
  const seen = new WeakSet();

  function walk(value, depth) {
    if (!value || typeof value !== "object" || depth > maxDepth || Buffer.isBuffer(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wantedKeys.includes(key) && typeof child === "string") results.push(child);
      if (child && typeof child === "object") walk(child, depth + 1);
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
    "remoteJid", "remoteJidAlt", "participant", "participantAlt",
    "sender", "recipient", "jid", "id", "user", "lid", "phone"
  ]);

  const deepStrings = getDeepStringValues(msg).filter((value) =>
    value.includes("@s.whatsapp.net") || value.includes("@lid")
  );

  return [...new Set([...directValues, ...deepByKey, ...deepStrings])];
}

function getContactIdentity(remoteJid, msg = {}) {
  const cleanJid = String(remoteJid || "").trim();
  const possibleJids = extractPossibleJids(msg, cleanJid);
  const phoneJid = possibleJids.find(isPhoneJid);
  const lidJid = possibleJids.find(isLidJid);
  const phone = phoneJid ? cleanPhoneFromJid(phoneJid) : null;
  const lid = lidJid ? cleanLidFromJid(lidJid) : isLidJid(cleanJid) ? cleanLidFromJid(cleanJid) : null;

  if (lid && phone) rememberLidPhoneMapping({ lid, phone, source: "same_payload" });

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

  const fallbackDigits = cleanDigits(cleanJid);
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
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
  if (message.editedMessage?.message) return unwrapMessage(message.editedMessage.message);
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
  if (cleanMessage?.conversation || cleanMessage?.extendedTextMessage) return "text";
  if (cleanMessage?.imageMessage) return "image";
  if (cleanMessage?.videoMessage) return "video";
  if (cleanMessage?.audioMessage) return "audio";
  if (cleanMessage?.documentMessage) return "document";
  if (cleanMessage?.stickerMessage) return "sticker";
  if (cleanMessage?.locationMessage || cleanMessage?.liveLocationMessage) return "location";
  if (cleanMessage?.contactMessage || cleanMessage?.contactsArrayMessage) return "contact";
  if (cleanMessage?.buttonsResponseMessage || cleanMessage?.templateButtonReplyMessage) return "button_response";
  if (cleanMessage?.listResponseMessage) return "list_response";
  if (cleanMessage?.pollCreationMessage || cleanMessage?.pollCreationMessageV3) return "poll";
  if (cleanMessage?.protocolMessage) return "protocol";
  if (cleanMessage?.reactionMessage) return "reaction";
  if (cleanMessage?.messageContextInfo) return "context";
  return "unknown";
}

function getMediaInfo(message) {
  const cleanMessage = unwrapMessage(message);
  if (cleanMessage?.imageMessage) return { media_type: "image", media_message: cleanMessage.imageMessage, baileys_type: "imageMessage" };
  if (cleanMessage?.videoMessage) return { media_type: "video", media_message: cleanMessage.videoMessage, baileys_type: "videoMessage" };
  if (cleanMessage?.audioMessage) return { media_type: "audio", media_message: cleanMessage.audioMessage, baileys_type: "audioMessage" };
  if (cleanMessage?.documentMessage) return { media_type: "document", media_message: cleanMessage.documentMessage, baileys_type: "documentMessage" };
  if (cleanMessage?.stickerMessage) return { media_type: "sticker", media_message: cleanMessage.stickerMessage, baileys_type: "stickerMessage" };
  return null;
}

function getMessageTimestamp(messageTimestamp) {
  try {
    const timestampNumber = Number(messageTimestamp);
    if (!messageTimestamp || Number.isNaN(timestampNumber)) return new Date().toISOString();
    return new Date(timestampNumber * 1000).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function removeAuthFolder(sessionId) {
  const sessionAuthPath = `${AUTH_PATH}/${sessionId}`;
  try {
    if (fs.existsSync(sessionAuthPath)) fs.rmSync(sessionAuthPath, { recursive: true, force: true });
    console.log(`Pasta de autenticação removida: ${sessionAuthPath}`);
  } catch (error) {
    console.log("Erro ao remover pasta de autenticação:", error.message);
  }
}

async function closeSocketSafely(sessionData, logout = false) {
  if (!sessionData?.sock) return;
  if (logout) {
    try { await sessionData.sock.logout(); } catch (error) { console.log("Erro ao fazer logout da sessão:", error.message); }
  }
  try { sessionData.sock.end?.(); } catch (error) { console.log("Erro ao encerrar socket:", error.message); }
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
    console.log("Webhook do sistema não configurado. Mensagem não enviada.", {
      hasWebhookUrl: Boolean(SYSTEM_WEBHOOK_URL),
      hasWebhookSecret: Boolean(SYSTEM_WEBHOOK_SECRET)
    });
    return { success: false, skipped: true, reason: "webhook_not_configured" };
  }

  try {
    const response = await fetch(SYSTEM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": SYSTEM_WEBHOOK_SECRET },
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    console.log("Resposta do webhook:", { status: response.status, ok: response.ok, body: responseText?.slice?.(0, 1000) || responseText });
    return { success: response.ok, status: response.status, body: responseText };
  } catch (error) {
    console.log("Erro ao enviar mensagem para webhook:", error.message);
    return { success: false, error: error.message };
  }
}

async function downloadIncomingMedia({ sock, msg, mediaInfo }) {
  const buffer = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    { logger: pino({ level: "info" }), reuploadRequest: sock.updateMediaMessage }
  );

  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("Falha ao baixar mídia do WhatsApp");
  if (buffer.length > MAX_MEDIA_SIZE_BYTES) throw new Error(`Mídia excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);

  const mediaMessage = mediaInfo.media_message || {};
  return {
    media_base64: buffer.toString("base64"),
    media_size_bytes: buffer.length,
    media_type: mediaInfo.media_type,
    media_mime_type: mediaMessage.mimetype || null,
    media_file_name: mediaMessage.fileName || mediaMessage.title || `${mediaInfo.media_type}-${Date.now()}`,
    media_caption: mediaMessage.caption || null,
    media_seconds: mediaMessage.seconds || null,
    media_file_length: mediaMessage.fileLength?.toString?.() || null,
    media_baileys_type: mediaInfo.baileys_type
  };
}

async function getBufferFromMediaRequest(body) {
  if (body.media_base64) {
    const base64 = String(body.media_base64).includes(",") ? String(body.media_base64).split(",").pop() : String(body.media_base64);
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > MAX_MEDIA_SIZE_BYTES) throw new Error(`Mídia excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);
    return buffer;
  }

  if (body.media_url) {
    const response = await fetch(body.media_url);
    if (!response.ok) throw new Error(`Erro ao baixar media_url: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_MEDIA_SIZE_BYTES) throw new Error(`Mídia excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);
    return buffer;
  }

  throw new Error("Informe media_base64 ou media_url");
}

async function convertAudioToOggOpus(inputBuffer) {
  const inputPath = path.join(os.tmpdir(), `audio-input-${randomUUID()}.webm`);
  const outputPath = path.join(os.tmpdir(), `audio-output-${randomUUID()}.ogg`);
  fs.writeFileSync(inputPath, inputBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec("libopus")
        .audioBitrate("48k")
        .audioChannels(1)
        .format("ogg")
        .outputOptions(["-vn", "-application", "voip"])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    return fs.readFileSync(outputPath);
  } finally {
    try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  }
}

async function buildBaileysMediaMessage({ mediaType, buffer, mimetype, fileName, caption }) {
  if (mediaType === "image") return { image: buffer, mimetype: mimetype || "image/jpeg", caption: caption || undefined };
  if (mediaType === "video") return { video: buffer, mimetype: mimetype || "video/mp4", caption: caption || undefined };

  if (mediaType === "audio") {
    console.log("Preparando áudio para WhatsApp:", { originalMimetype: mimetype, originalSizeBytes: buffer.length });
    const convertedBuffer = await convertAudioToOggOpus(buffer);
    console.log("Áudio convertido para OGG/Opus:", { convertedSizeBytes: convertedBuffer.length });
    return { audio: convertedBuffer, mimetype: "audio/ogg; codecs=opus", ptt: true };
  }

  if (mediaType === "document") return { document: buffer, mimetype: mimetype || "application/octet-stream", fileName: fileName || `documento-${Date.now()}` };
  if (mediaType === "sticker") return { sticker: buffer };
  throw new Error("media_type inválido. Use image, video, audio, document ou sticker.");
}

function getMetaTimestamp(timestamp) {
  return getMessageTimestamp(timestamp);
}

function extractOfficialText(message = {}) {
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "image") return message.image?.caption || "";
  if (message.type === "video") return message.video?.caption || "";
  if (message.type === "document") return message.document?.caption || "";
  if (message.type === "button") return message.button?.text || message.button?.payload || "";
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.title ||
      message.interactive?.list_reply?.description ||
      message.interactive?.list_reply?.id ||
      ""
    );
  }
  return "";
}

function extractOfficialMedia(message = {}) {
  const media = message.image || message.video || message.audio || message.document || message.sticker;
  if (!media) return null;
  return {
    media_id: media.id || null,
    media_mime_type: media.mime_type || null,
    media_file_name: media.filename || null,
    media_caption: media.caption || null,
    media_sha256: media.sha256 || null
  };
}

async function downloadOfficialMediaAsBase64(mediaId, accessToken) {
  if (!mediaId || !accessToken) return null;

  const metaMediaResponse = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!metaMediaResponse.ok) {
    const errorText = await metaMediaResponse.text();
    throw new Error(`Erro ao buscar URL da mídia oficial: HTTP ${metaMediaResponse.status} ${errorText}`);
  }

  const mediaMetadata = await metaMediaResponse.json();
  if (!mediaMetadata?.url) throw new Error("Meta não retornou URL da mídia oficial");

  const fileResponse = await fetch(mediaMetadata.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileResponse.ok) {
    const errorText = await fileResponse.text();
    throw new Error(`Erro ao baixar mídia oficial: HTTP ${fileResponse.status} ${errorText}`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  if (buffer.length > MAX_MEDIA_SIZE_BYTES) throw new Error(`Mídia oficial excede o limite de ${MAX_MEDIA_SIZE_MB}MB`);

  return {
    media_base64: buffer.toString("base64"),
    media_size_bytes: buffer.length,
    media_mime_type: mediaMetadata.mime_type || fileResponse.headers.get("content-type") || null
  };
}

function getOfficialStoreId({ req, value }) {
  return (
    req.query.store_id ||
    req.query.conta_id ||
    req.headers["x-store-id"] ||
    req.headers["x-conta-id"] ||
    META_DEFAULT_STORE_ID ||
    value?.metadata?.phone_number_id ||
    "official"
  );
}

async function forwardOfficialMessage({ req, value, message, contact }) {
  const phoneNumberId = value?.metadata?.phone_number_id || null;
  const displayPhoneNumber = value?.metadata?.display_phone_number || null;
  const storeId = getOfficialStoreId({ req, value });
  const contactPhone = normalizeBrazilPhone(message.from);
  const officialMedia = extractOfficialMedia(message);
  const accessToken = req.headers["x-meta-access-token"] || META_ACCESS_TOKEN;

  let mediaPayload = {};
  if (officialMedia?.media_id) {
    try {
      console.log("Mídia oficial recebida. Iniciando download:", { phoneNumberId, mediaId: officialMedia.media_id, type: message.type });
      const downloaded = await downloadOfficialMediaAsBase64(officialMedia.media_id, accessToken);
      mediaPayload = {
        media_base64: downloaded?.media_base64 || null,
        media_size_bytes: downloaded?.media_size_bytes || null,
        media_mime_type: downloaded?.media_mime_type || officialMedia.media_mime_type || null
      };
    } catch (error) {
      mediaPayload = { media_download_error: error.message, media_mime_type: officialMedia.media_mime_type || null };
      console.log("Erro ao baixar mídia oficial:", { mediaId: officialMedia.media_id, error: error.message });
    }
  }

  const payload = {
    tipo: "whatsapp_message",
    conta_id: storeId,
    store_id: storeId,
    connection_type: "official",
    phone_number_id: phoneNumberId,
    display_phone_number: displayPhoneNumber,
    session_id: `official_${phoneNumberId || storeId}`,

    contact_phone: contactPhone,
    contact_jid: contactPhone ? `${contactPhone}@s.whatsapp.net` : null,
    contact_lid: null,
    contact_name: contact?.profile?.name || null,
    identity_source: "official_wa_id",

    message_id: message.id || null,
    from_me: false,
    direction: "inbound",

    message_text: extractOfficialText(message) || officialMedia?.media_caption || "",
    message_type: officialMedia ? "media" : (message.type || "unknown"),

    media_type: officialMedia ? message.type : null,
    media_id: officialMedia?.media_id || null,
    media_mime_type: mediaPayload.media_mime_type || officialMedia?.media_mime_type || null,
    media_file_name: officialMedia?.media_file_name || null,
    media_caption: officialMedia?.media_caption || null,
    media_size_bytes: mediaPayload.media_size_bytes || null,
    media_base64: mediaPayload.media_base64 || null,
    media_download_error: mediaPayload.media_download_error || null,
    media_baileys_type: null,

    timestamp: getMetaTimestamp(message.timestamp),
    raw_payload: {
      provider: "meta_cloud_api",
      metadata: value?.metadata || null,
      contact: contact || null,
      message: {
        id: message.id || null,
        from: message.from || null,
        timestamp: message.timestamp || null,
        type: message.type || null,
        text: message.text || null,
        interactive: message.interactive || null,
        button: message.button || null,
        context: message.context || null,
        media: officialMedia || null
      }
    }
  };

  console.log("Mensagem oficial processada:", {
    storeId, phoneNumberId, contactPhone: payload.contact_phone,
    contactName: payload.contact_name, messageId: payload.message_id,
    messageType: payload.message_type, mediaType: payload.media_type,
    hasMediaBase64: Boolean(payload.media_base64)
  });

  return sendMessageToSystemWebhook(payload);
}

async function forwardOfficialStatus({ req, value, status }) {
  const phoneNumberId = value?.metadata?.phone_number_id || null;
  const storeId = getOfficialStoreId({ req, value });

  const payload = {
    tipo: "whatsapp_status",
    conta_id: storeId,
    store_id: storeId,
    connection_type: "official",
    phone_number_id: phoneNumberId,
    display_phone_number: value?.metadata?.display_phone_number || null,
    message_id: status.id || null,
    recipient_id: status.recipient_id || null,
    status: status.status || null,
    timestamp: getMetaTimestamp(status.timestamp),
    conversation: status.conversation || null,
    pricing: status.pricing || null,
    errors: status.errors || null,
    raw_payload: { provider: "meta_cloud_api", metadata: value?.metadata || null, status }
  };

  console.log("Status oficial recebido:", { storeId, phoneNumberId, messageId: payload.message_id, status: payload.status });
  return sendMessageToSystemWebhook(payload);
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
      if (remoteJid.includes("@g.us")) { console.log("Mensagem de grupo ignorada:", remoteJid); continue; }
      if (remoteJid === "status@broadcast") continue;

      const contactIdentity = getContactIdentity(remoteJid, msg);
      const cleanMessage = unwrapMessage(msg.message);
      const messageText = extractMessageText(cleanMessage);
      const messageType = extractMessageType(cleanMessage);
      const mediaInfo = getMediaInfo(cleanMessage);

      if (!messageText && !mediaInfo && ["unknown", "protocol", "reaction", "context"].includes(messageType)) {
        console.log("Mensagem ignorada sem conteúdo útil:", {
          sessionId, remoteJid, fromMe, messageId, messageType, contactIdentity,
          rawKeys: cleanMessage ? Object.keys(cleanMessage) : []
        });
        continue;
      }

      let mediaPayload = null;
      if (mediaInfo) {
        try {
          console.log("Mídia recebida. Iniciando download:", {
            sessionId, storeId, messageId, mediaType: mediaInfo.media_type,
            mimetype: mediaInfo.media_message?.mimetype || null,
            fileName: mediaInfo.media_message?.fileName || null
          });
          mediaPayload = await downloadIncomingMedia({ sock: sessionData?.sock, msg, mediaInfo });
          console.log("Mídia baixada com sucesso:", {
            messageId, mediaType: mediaPayload.media_type,
            sizeBytes: mediaPayload.media_size_bytes,
            mimetype: mediaPayload.media_mime_type
          });
        } catch (mediaError) {
          console.log("Erro ao baixar mídia recebida:", { messageId, error: mediaError.message });
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
        connection_type: "qr",
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
          provider: "baileys_qr",
          key: msg.key,
          pushName: msg.pushName || null,
          messageTimestamp: msg.messageTimestamp || null,
          messageType,
          mediaInfo: mediaInfo ? {
            media_type: mediaInfo.media_type,
            baileys_type: mediaInfo.baileys_type,
            mimetype: mediaInfo.media_message?.mimetype || null,
            fileName: mediaInfo.media_message?.fileName || null,
            caption: mediaInfo.media_message?.caption || null
          } : null,
          possible_jids_found: contactIdentity.possible_jids_found || []
        }
      };

      console.log("Mensagem processada:", {
        sessionId, storeId, contaId: storeId, tipo: "whatsapp_message",
        contactPhone: contactIdentity.contact_phone,
        contactJid: contactIdentity.contact_jid,
        contactLid: contactIdentity.contact_lid,
        identitySource: contactIdentity.identity_source,
        possibleJidsFound: contactIdentity.possible_jids_found || [],
        fromMe, direction: payload.direction, messageText: payload.message_text,
        messageType: payload.message_type, mediaType: payload.media_type,
        hasMediaBase64: Boolean(payload.media_base64), messageId
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
      sessionId, storeId, userId: userId || null,
      status: "starting", qrCode: null, sock: null,
      lastError: null, reconnectAttempts: 0
    };
    sessions.set(sessionId, sessionData);
  }

  clearReconnectTimer(sessionId);
  sessionData.status = "starting";
  sessionData.qrCode = null;

  const { state, saveCreds } = await useMultiFileAuthState(`${AUTH_PATH}/${sessionId}`);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log("Baileys version:", { version, isLatest, sessionId });

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
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

    console.log("Connection update:", {
      sessionId,
      connection: connection || null,
      hasQr: Boolean(qr),
      isNewLogin: Boolean(isNewLogin),
      receivedPendingNotifications: Boolean(receivedPendingNotifications),
      statusCode: lastDisconnect?.error?.output?.statusCode || null,
      errorMessage: lastDisconnect?.error?.message || null
    });

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
      sessionData.lastError = { statusCode, errorMessage, shouldReconnect };

      console.log("Conexão fechada:", { sessionId, statusCode, errorMessage, shouldReconnect });

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
          await startWhatsAppSession({ sessionId, storeId, userId });
        } catch (error) {
          sessionData.status = "erro";
          sessionData.lastError = { errorMessage: error.message };
          console.log("Erro ao tentar reconectar:", error.message);
        }
      }, reconnectDelay);

      reconnectTimers.set(sessionId, timer);
    }
  });

  sock.ev.on("messages.upsert", async (messageUpdate) => {
    await processIncomingOrOutgoingMessages({ messageUpdate, sessionId, storeId });
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
    official_api_enabled: Boolean(META_ACCESS_TOKEN && META_PHONE_NUMBER_ID),
    official_webhook_configured: Boolean(META_WEBHOOK_VERIFY_TOKEN),
    routes: [
      "POST /sessions",
      "GET /sessions/:sessionId/status",
      "DELETE /sessions/:sessionId",
      "POST /messages/send",
      "POST /messages/send-media",
      "GET /official/webhook",
      "POST /official/webhook",
      "POST /official/messages/send",
      "POST /official/messages/send-media"
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
    lid_phone_mappings_count: lidToPhoneMap.size,
    official_api_enabled: Boolean(META_ACCESS_TOKEN && META_PHONE_NUMBER_ID),
    official_webhook_configured: Boolean(META_WEBHOOK_VERIFY_TOKEN)
  });
});

app.post("/sessions", checkSecret, async (req, res) => {
  const { store_id, user_id } = req.body;

  if (!store_id) return res.status(400).json({ error: "store_id é obrigatório" });

  const sessionId = `store_${store_id}`;
  const existingSession = sessions.get(sessionId);

  if (existingSession && ["aguardando_qr", "conectado", "reiniciando", "starting"].includes(existingSession.status)) {
    return res.json({
      session_id: sessionId,
      status: existingSession.status,
      qr_code: existingSession.qrCode || null,
      last_error: existingSession.lastError || null
    });
  }

  try {
    const sessionData = await startWhatsAppSession({ sessionId, storeId: store_id, userId: user_id || null });
    return res.json({
      session_id: sessionId,
      status: sessionData.status,
      qr_code: sessionData.qrCode || null,
      last_error: sessionData.lastError || null
    });
  } catch (error) {
    console.error(error);
    sessions.set(sessionId, {
      sessionId, storeId: store_id, userId: user_id || null,
      status: "erro", qrCode: null, sock: null,
      lastError: { errorMessage: error.message }, reconnectAttempts: 0
    });
    return res.status(500).json({ error: "Erro ao criar sessão WhatsApp", details: error.message });
  }
});

app.get("/sessions/:sessionId/status", checkSecret, (req, res) => {
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) return res.status(404).json({ error: "Sessão não encontrada" });

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
  return res.json({ success: true, session_id: sessionId, message: "Sessão removida. Gere um novo QR Code." });
});

app.post("/messages/send", checkSecret, async (req, res) => {
  const { session_id, phone, contact_jid, message } = req.body;

  if (!session_id || !message || (!phone && !contact_jid)) {
    return res.status(400).json({ error: "session_id, message e phone ou contact_jid são obrigatórios" });
  }

  const sessionData = sessions.get(session_id);
  if (!sessionData || sessionData.status !== "conectado") return res.status(400).json({ error: "Sessão não conectada" });

  try {
    const preferredDestination = phone || contact_jid;

    if (String(preferredDestination).endsWith("@lid")) {
      return res.status(400).json({
        error: "Não é possível enviar mensagem para @lid. Use o telefone real do contato.",
        code: "cannot_send_to_lid"
      });
    }

    const jid = normalizePhoneToJid(preferredDestination);
    if (!jid) return res.status(400).json({ error: "Destino inválido. Informe um telefone real ou um JID @s.whatsapp.net.", code: "invalid_destination" });

    const result = await sessionData.sock.sendMessage(jid, { text: message });
    console.log("Mensagem enviada pelo endpoint:", { session_id, phone, contact_jid, jid, message, result });

    return res.json({
      success: true,
      jid,
      message_id: result?.key?.id || null,
      from_me: result?.key?.fromMe || null,
      status: result?.status || null,
      raw_result: result
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao enviar mensagem", details: error.message });
  }
});

app.post("/messages/send-media", checkSecret, async (req, res) => {
  const { session_id, phone, contact_jid, media_type, media_url, media_base64, media_mime_type, media_file_name, caption } = req.body;

  if (!session_id || (!phone && !contact_jid)) return res.status(400).json({ error: "session_id e phone ou contact_jid são obrigatórios" });
  if (!media_type) return res.status(400).json({ error: "media_type é obrigatório. Use image, video, audio, document ou sticker." });
  if (!media_url && !media_base64) return res.status(400).json({ error: "media_url ou media_base64 é obrigatório" });

  const sessionData = sessions.get(session_id);
  if (!sessionData || sessionData.status !== "conectado") return res.status(400).json({ error: "Sessão não conectada" });

  try {
    const preferredDestination = phone || contact_jid;

    if (String(preferredDestination).endsWith("@lid")) {
      return res.status(400).json({
        error: "Não é possível enviar mídia para @lid. Use o telefone real do contato.",
        code: "cannot_send_to_lid"
      });
    }

    const jid = normalizePhoneToJid(preferredDestination);
    if (!jid) return res.status(400).json({ error: "Destino inválido. Informe um telefone real ou um JID @s.whatsapp.net.", code: "invalid_destination" });

    const buffer = await getBufferFromMediaRequest({ media_url, media_base64 });
    const baileysMessage = await buildBaileysMediaMessage({
      mediaType: media_type,
      buffer,
      mimetype: media_mime_type,
      fileName: media_file_name,
      caption
    });

    const result = await sessionData.sock.sendMessage(jid, baileysMessage);

    console.log("Mídia enviada pelo endpoint:", {
      session_id, phone, contact_jid, jid, media_type, media_mime_type,
      media_file_name, sizeBytes: buffer.length, messageId: result?.key?.id || null
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
    return res.status(500).json({ error: "Erro ao enviar mídia", details: error.message });
  }
});

app.get("/official/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Verificação webhook Meta recebida:", {
    mode,
    tokenMatches: token === META_WEBHOOK_VERIFY_TOKEN,
    hasChallenge: Boolean(challenge)
  });

  if (mode === "subscribe" && token === META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/official/webhook", async (req, res) => {
  try {
    console.log("Webhook oficial Meta recebido:", JSON.stringify(req.body, null, 2));

    const tasks = [];

    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value || {};
        const contacts = value.contacts || [];
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        for (const message of messages) {
          const contact = contacts.find((item) => item.wa_id === message.from) || null;
          tasks.push(forwardOfficialMessage({ req, value, message, contact }));
        }

        for (const status of statuses) {
          tasks.push(forwardOfficialStatus({ req, value, status }));
        }
      }
    }

    if (tasks.length > 0) await Promise.allSettled(tasks);
    return res.sendStatus(200);
  } catch (error) {
    console.log("Erro ao processar webhook oficial Meta:", error.message);
    return res.sendStatus(200);
  }
});

app.post("/official/messages/send", checkSecret, async (req, res) => {
  const { phone_number_id, access_token, to, phone, message } = req.body;
  const targetPhoneNumberId = phone_number_id || META_PHONE_NUMBER_ID;
  const targetAccessToken = access_token || META_ACCESS_TOKEN;
  const destination = normalizeBrazilPhone(to || phone);

  if (!targetPhoneNumberId) return res.status(400).json({ error: "phone_number_id é obrigatório para envio pela API oficial" });
  if (!targetAccessToken) return res.status(400).json({ error: "access_token é obrigatório para envio pela API oficial" });
  if (!destination || !message) return res.status(400).json({ error: "to/phone e message são obrigatórios" });

  try {
    const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${targetPhoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${targetAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: destination,
        type: "text",
        text: { preview_url: false, body: message }
      })
    });

    const body = await response.json().catch(async () => ({ raw: await response.text() }));

    console.log("Envio oficial Meta:", { status: response.status, ok: response.ok, phoneNumberId: targetPhoneNumberId, to: destination, body });

    return res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      status: response.status,
      result: body
    });
  } catch (error) {
    console.log("Erro ao enviar mensagem oficial:", error.message);
    return res.status(500).json({ error: "Erro ao enviar mensagem oficial", details: error.message });
  }
});
async function uploadOfficialMediaBufferToMeta({
  phoneNumberId,
  accessToken,
  buffer,
  filename,
  mimeType
}) {
  if (!phoneNumberId) throw new Error("phoneNumberId ausente no upload de mídia Meta");
  if (!accessToken) throw new Error("accessToken ausente no upload de mídia Meta");
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("buffer inválido no upload de mídia Meta");

  const formData = new FormData();

  formData.append("messaging_product", "whatsapp");

  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
  formData.append("file", blob, filename || `media-${Date.now()}`);

  const response = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: formData
    }
  );

  const body = await response.json().catch(async () => ({
    raw: await response.text()
  }));

  console.log("Upload de mídia oficial Meta:", {
    status: response.status,
    ok: response.ok,
    phoneNumberId,
    filename,
    mimeType,
    sizeBytes: buffer.length,
    body
  });

  if (!response.ok) {
    throw new Error(`Falha no upload de mídia Meta: HTTP ${response.status} ${JSON.stringify(body)}`);
  }

  if (!body?.id) {
    throw new Error(`Upload de mídia Meta não retornou id: ${JSON.stringify(body)}`);
  }

  return body;
}
app.post("/official/messages/send-media", checkSecret, async (req, res) => {
  const {
    phone_number_id,
    access_token,
    to,
    phone,

    // aliases aceitos pelo Lovable/Supabase
    media_type,
    type,

    media_url,
    media_id,

    caption,

    media_file_name,
    filename,

    media_mime_type,
    mime_type
  } = req.body;

  const targetPhoneNumberId = phone_number_id || META_PHONE_NUMBER_ID;
  const targetAccessToken = access_token || META_ACCESS_TOKEN;
  const destination = normalizeBrazilPhone(to || phone);

  const finalMediaType = media_type || type;
  const finalFileName =
    media_file_name ||
    filename ||
    `${finalMediaType || "media"}-${Date.now()}`;

  const originalMimeType = media_mime_type || mime_type || null;

  if (!targetPhoneNumberId) {
    return res.status(400).json({
      success: false,
      error: "phone_number_id é obrigatório para envio pela API oficial"
    });
  }

  if (!targetAccessToken) {
    return res.status(400).json({
      success: false,
      error: "access_token é obrigatório para envio pela API oficial"
    });
  }

  if (!destination || !finalMediaType || (!media_url && !media_id)) {
    return res.status(400).json({
      success: false,
      error: "to/phone, media_type/type e media_url ou media_id são obrigatórios"
    });
  }

  if (!["image", "video", "audio", "document"].includes(finalMediaType)) {
    return res.status(400).json({
      success: false,
      error: "media_type inválido para API oficial. Use image, video, audio ou document."
    });
  }

  try {
    let finalMediaPayload = null;
    let uploadResult = null;

    const isWebmAudio =
      finalMediaType === "audio" &&
      (
        String(originalMimeType || "").toLowerCase().includes("webm") ||
        String(finalFileName || "").toLowerCase().endsWith(".webm")
      );

    if (media_id) {
      finalMediaPayload = { id: media_id };
    } else if (isWebmAudio) {
      console.log("Áudio webm detectado para API Oficial Meta. Iniciando conversão:", {
        phoneNumberId: targetPhoneNumberId,
        to: destination,
        originalMimeType,
        fileName: finalFileName
      });

      const originalBuffer = await getBufferFromMediaRequest({ media_url });

      console.log("Áudio webm baixado:", {
        originalSizeBytes: originalBuffer.length,
        originalMimeType
      });

      const convertedBuffer = await convertAudioToOggOpus(originalBuffer);

      console.log("Áudio convertido para ogg/opus:", {
        convertedSizeBytes: convertedBuffer.length
      });

      uploadResult = await uploadOfficialMediaBufferToMeta({
        phoneNumberId: targetPhoneNumberId,
        accessToken: targetAccessToken,
        buffer: convertedBuffer,
        filename: finalFileName.replace(/\.webm$/i, ".ogg"),
        mimeType: "audio/ogg"
      });

      finalMediaPayload = { id: uploadResult.id };
    } else {
      finalMediaPayload = { link: media_url };
    }

    if (caption && ["image", "video", "document"].includes(finalMediaType)) {
      finalMediaPayload.caption = caption;
    }

    if (finalFileName && finalMediaType === "document") {
      finalMediaPayload.filename = finalFileName;
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
          type: finalMediaType,
          [finalMediaType]: finalMediaPayload
        })
      }
    );

    const body = await response.json().catch(async () => ({
      raw: await response.text()
    }));

    console.log("Envio de mídia oficial Meta:", {
      status: response.status,
      ok: response.ok,
      phoneNumberId: targetPhoneNumberId,
      to: destination,
      mediaType: finalMediaType,
      originalMimeType,
      fileName: finalFileName,
      usedMetaUpload: Boolean(uploadResult?.id),
      metaMediaId: uploadResult?.id || media_id || null,
      body
    });

    return res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      status: response.status,
      result: body,
      meta_media_id: uploadResult?.id || media_id || null,
      converted_audio: Boolean(isWebmAudio)
    });
  } catch (error) {
    console.log("Erro ao enviar mídia oficial:", {
      message: error.message,
      mediaType: finalMediaType,
      originalMimeType,
      fileName: finalFileName
    });

    return res.status(500).json({
      success: false,
      error: "Erro ao enviar mídia oficial",
      details: error.message,
      media_type: finalMediaType,
      media_mime_type: originalMimeType,
      media_file_name: finalFileName
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Gateway rodando na porta ${PORT}`);
});
