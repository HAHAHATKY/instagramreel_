const CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const IMAGE_SIGNATURES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  return parsed.origin;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function makeLinkCode(botToken, updateId) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(botToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`selfie-link:${updateId}`)),
  ).slice(0, 12);
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createStoredLink(db, baseUrl, code) {
  if (!safeBaseUrl(baseUrl) || !CODE_PATTERN.test(code)) {
    throw new Error("Invalid short link configuration.");
  }
  const tokenHash = await sha256Hex(code);
  await db.prepare("INSERT OR IGNORE INTO selfie_links (token_hash) VALUES (?)")
    .bind(tokenHash)
    .run();
  return `${baseUrl}/selfie/${code}`;
}

async function linkIsValid(db, code) {
  if (!CODE_PATTERN.test(code)) return false;
  const tokenHash = await sha256Hex(code);
  const row = await db.prepare("SELECT 1 AS found FROM selfie_links WHERE token_hash = ?")
    .bind(tokenHash)
    .first();
  return Boolean(row);
}

function parseBotCommand(update, adminUserId) {
  const message = update?.message;
  if (
    !message ||
    message.chat?.type !== "private" ||
    !Number.isSafeInteger(message.from?.id) ||
    !/^\d+$/.test(String(adminUserId ?? "")) ||
    String(message.from.id) !== String(adminUserId) ||
    typeof message.text !== "string"
  ) {
    return null;
  }
  const command = message.text.trim().split(/\s+/, 1)[0].split("@", 1)[0].toLowerCase();
  if (command === "/newlink" || command === "/start") return "newlink";
  return null;
}

async function telegramCall(token, method, init) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
  } catch {
    throw new Error("Telegram request failed.");
  }
  if (!response.ok) throw new Error("Telegram rejected the request.");
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Telegram returned an invalid response.");
  }
  if (!result || result.ok !== true) throw new Error("Telegram rejected the request.");
  return result;
}

async function sendBotMessage(token, chatId, text) {
  await telegramCall(token, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
}

function commandReply(link) {
  return `Odkaz na stránku pro pořízení selfie: ${link}\n\n` +
    "Stránka předem jasně říká, že klepnutím na tlačítko návštěvník odešle svou fotku " +
    "do Telegram chatu provozovatele. Kamera se zapne až po výslovném povolení; " +
    "fotka se pořídí a odešle jen po klepnutí na tlačítko.";
}

async function handleBotUpdate(update, env) {
  const command = parseBotCommand(update, env.ADMIN_TELEGRAM_USER_ID);
  if (!command) return false;
  const updateId = update.update_id;
  if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
  const chatId = String(update.message.chat.id);
  const existing = await env.DB.prepare(
    "SELECT response_chat_id FROM processed_bot_updates WHERE update_id = ?",
  ).bind(updateId).first();
  if (existing) {
    const code = await makeLinkCode(env.TELEGRAM_BOT_TOKEN, updateId);
    const link = `${safeBaseUrl(env.PUBLIC_BASE_URL)}/selfie/${code}`;
    await sendBotMessage(env.TELEGRAM_BOT_TOKEN, existing.response_chat_id, commandReply(link));
    return true;
  }

  const code = await makeLinkCode(env.TELEGRAM_BOT_TOKEN, updateId);
  const link = await createStoredLink(env.DB, env.PUBLIC_BASE_URL, code);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_bot_updates (update_id, response_chat_id) VALUES (?, ?)",
  ).bind(updateId, chatId).run();
  await sendBotMessage(env.TELEGRAM_BOT_TOKEN, chatId, commandReply(link));
  return true;
}

function safeEqual(first, second) {
  if (typeof first !== "string" || typeof second !== "string" || first.length !== second.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

async function readBoundedBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function matchesSignature(bytes, signature) {
  return bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);
}

async function relayPhoto(request, env) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_MULTIPART_BYTES)) {
    return jsonResponse({ detail: "Požadavek je příliš velký. Maximální velikost fotografie je 5 MB." }, 413);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return jsonResponse({ detail: "Očekávali jsme fotografii JPEG nebo PNG." }, 415);
  }
  const body = await readBoundedBody(request, MAX_MULTIPART_BYTES);
  if (!body) {
    return jsonResponse({ detail: "Požadavek je příliš velký. Maximální velikost fotografie je 5 MB." }, 413);
  }
  let form;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("Content-Type") },
      body,
    }).formData();
  } catch {
    return jsonResponse({ detail: "Formát nahrané fotografie je neplatný." }, 400);
  }
  const photo = form.get("photo");
  if (!(photo instanceof File)) {
    return jsonResponse({ detail: "Vyberte fotografii k odeslání." }, 400);
  }
  if (photo.size === 0) return jsonResponse({ detail: "Vyberte fotografii k odeslání." }, 400);
  if (photo.size > MAX_PHOTO_BYTES) {
    return jsonResponse({ detail: "Fotografie je příliš velká. Maximální velikost je 5 MB." }, 413);
  }
  const contentType = photo.type.toLowerCase();
  const signature = IMAGE_SIGNATURES[contentType];
  if (!signature) return jsonResponse({ detail: "Podporujeme pouze obrázky JPEG a PNG." }, 415);
  const photoBytes = new Uint8Array(await photo.arrayBuffer());
  if (!matchesSignature(photoBytes, signature)) {
    return jsonResponse({ detail: "Soubor neodpovídá deklarovanému typu obrázku." }, 400);
  }

  const telegramForm = new FormData();
  telegramForm.append("chat_id", env.TELEGRAM_CHAT_ID);
  telegramForm.append(
    "photo",
    new Blob([photoBytes], { type: contentType }),
    contentType === "image/png" ? "selfie.png" : "selfie.jpg",
  );
  try {
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "sendPhoto", {
      method: "POST",
      body: telegramForm,
    });
  } catch {
    return jsonResponse({ detail: "Fotografii se nepodařilo doručit do Telegramu. Zkuste to znovu." }, 502);
  }
  return jsonResponse({ message: "Fotografie byla odeslána." });
}

async function configureWebhook(request, env, baseUrl) {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!safeEqual(authorization, `Bearer ${env.WEBHOOK_SETUP_KEY ?? ""}`) ||
      !env.WEBHOOK_SETUP_KEY) {
    return jsonResponse({ detail: "Nepovolený požadavek." }, 401);
  }
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    return jsonResponse({ detail: "Webhook není správně nakonfigurovaný." }, 503);
  }
  try {
    await telegramCall(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${baseUrl}/telegram/webhook`,
        secret_token: webhookSecret,
        allowed_updates: ["message"],
      }),
    });
  } catch {
    return jsonResponse({ detail: "Telegram webhook se nepodařilo nakonfigurovat." }, 502);
  }
  return jsonResponse({ message: "Telegram webhook byl nakonfigurován." });
}

async function handleWebhook(request, env) {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!webhookSecret || !safeEqual(
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
    webhookSecret,
  )) {
    return jsonResponse({ detail: "Nepovolený požadavek." }, 401);
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEBHOOK_BYTES)) {
    return jsonResponse({ detail: "Požadavek je příliš velký." }, 413);
  }
  const body = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  if (!body) return jsonResponse({ detail: "Požadavek je příliš velký." }, 413);
  let update;
  try {
    update = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return jsonResponse({ detail: "Neplatný webhook požadavek." }, 400);
  }
  if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id)) {
    return jsonResponse({ detail: "Neplatný webhook požadavek." }, 400);
  }
  try {
    await handleBotUpdate(update, env);
  } catch {
    return jsonResponse({ detail: "Webhook se nepodařilo zpracovat." }, 500);
  }
  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/admin/configure-webhook") {
      const baseUrl = safeBaseUrl(env.PUBLIC_BASE_URL ?? "");
      if (!baseUrl) return jsonResponse({ detail: "Veřejná HTTPS URL není nakonfigurovaná." }, 503);
      return configureWebhook(request, env, baseUrl);
    }
    if (request.method === "POST" && url.pathname === "/api/send-photo") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return jsonResponse({ detail: "Odesílání zatím není nakonfigurované. Zkuste to prosím později." }, 503);
      }
      return relayPhoto(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/selfie/")) {
      const code = url.pathname.slice("/selfie/".length);
      if (code.includes("/") || !CODE_PATTERN.test(code)) {
        return jsonResponse({ detail: "Tento odkaz neexistuje." }, 404);
      }
      let valid = false;
      try {
        valid = await linkIsValid(env.DB, code);
      } catch {
        return jsonResponse({ detail: "Odkaz se nepodařilo ověřit." }, 503);
      }
      if (!valid) return jsonResponse({ detail: "Tento odkaz neexistuje." }, 404);
      const response = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }
    return env.ASSETS.fetch(request);
  },
};

export {
  commandReply,
  createStoredLink,
  handleBotUpdate,
  linkIsValid,
  makeLinkCode,
  parseBotCommand,
  relayPhoto,
  safeBaseUrl,
};
