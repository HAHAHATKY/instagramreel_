import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, mock, test } from "node:test";
import worker, {
  createStoredLink,
  handleBotUpdate,
  linkIsValid,
  parseBotCommand,
  safeBaseUrl,
} from "../worker.mjs";

const BOT_CONFIG = {
  TELEGRAM_BOT_TOKEN: "offline-test-token",
  TELEGRAM_CHAT_ID: "-100123",
  ADMIN_TELEGRAM_USER_ID: "12345",
  TELEGRAM_WEBHOOK_SECRET: "offline-webhook-secret",
  WEBHOOK_SETUP_KEY: "offline-setup-key",
  PUBLIC_BASE_URL: "https://selfie.example",
};

class FakeD1 {
  constructor() {
    this.links = new Set();
    this.updates = new Map();
  }

  prepare(sql) {
    let values = [];
    return {
      bind(...boundValues) {
        values = boundValues;
        return this;
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO selfie_links")) {
          this.db.links.add(values[0]);
          return { success: true };
        }
        if (sql.includes("INSERT OR IGNORE INTO processed_bot_updates")) {
          if (!this.db.updates.has(values[0])) this.db.updates.set(values[0], values[1]);
          return { success: true };
        }
        throw new Error(`Unexpected SQL run: ${sql}`);
      },
      async first() {
        if (sql.includes("SELECT 1 AS found FROM selfie_links")) {
          return this.db.links.has(values[0]) ? { found: 1 } : null;
        }
        if (sql.includes("SELECT response_chat_id FROM processed_bot_updates")) {
          return this.db.updates.has(values[0])
            ? { response_chat_id: this.db.updates.get(values[0]) }
            : null;
        }
        throw new Error(`Unexpected SQL query: ${sql}`);
      },
      db: this,
    };
  }
}

function testEnv(overrides = {}) {
  return {
    ...BOT_CONFIG,
    DB: new FakeD1(),
    ASSETS: { fetch: async () => new Response("<main>Selfie app</main>", {
      headers: { "Content-Type": "text/html" },
    }) },
    ...overrides,
  };
}

function adminUpdate(updateId = 7, text = "/newlink") {
  return {
    update_id: updateId,
    message: {
      text,
      chat: { id: 12345, type: "private" },
      from: { id: 12345 },
    },
  };
}

afterEach(() => mock.restoreAll());

test("base URL requires a public HTTPS origin", () => {
  assert.equal(safeBaseUrl("https://selfie.example/"), "https://selfie.example");
  assert.equal(safeBaseUrl("http://selfie.example"), null);
  assert.equal(safeBaseUrl("https://selfie.example/path"), null);
  assert.equal(safeBaseUrl("https://user:pass@selfie.example"), null);
});

test("selfie page discloses the Telegram destination before camera controls", async () => {
  const [html, js] = await Promise.all([
    readFile(new URL("../app/static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../app/static/app.js", import.meta.url), "utf8"),
  ]);
  const disclosure = html.indexOf("do nakonfigurovaného Telegram chatu provozovatele");
  const cameraButton = html.indexOf('id="start-camera"');
  assert.notEqual(disclosure, -1);
  assert.ok(disclosure < cameraButton);
  assert.match(html, /id="send-photo"[^>]*disabled/);
  assert.match(js, /getUserMedia/);
  assert.match(js, /sendButton\.addEventListener\("click"/);
});

test("Wrangler config targets the provisioned free D1 and deployed Worker origin", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"database_name":\s*"telegram-selfie-links"/);
  assert.match(config, /"database_id":\s*"bb259004-f586-4cc3-a188-6eba58b7886d"/);
  assert.match(
    config,
    /"PUBLIC_BASE_URL":\s*"https:\/\/telegram-selfie-page\.millo-lawa\.workers\.dev"/,
  );
});

test("bot only accepts start/newlink from the configured admin in a private chat", () => {
  assert.equal(parseBotCommand(adminUpdate(), "12345"), "newlink");
  assert.equal(parseBotCommand(adminUpdate(7, "/start@selfiebot"), "12345"), "newlink");
  assert.equal(parseBotCommand(adminUpdate(), "98765"), null);
  assert.equal(parseBotCommand(adminUpdate(), undefined), null);
  const groupUpdate = adminUpdate();
  groupUpdate.message.chat.type = "group";
  assert.equal(parseBotCommand(groupUpdate, "12345"), null);
  assert.equal(parseBotCommand(adminUpdate(7, "/help"), "12345"), null);
});

test("link creation stores only the SHA-256 hash and resolution validates code", async () => {
  const db = new FakeD1();
  const link = await createStoredLink(db, "https://selfie.example", "AbCdEfGhIjKlMnOp");
  assert.equal(link, "https://selfie.example/selfie/AbCdEfGhIjKlMnOp");
  assert.equal(db.links.size, 1);
  assert.equal(await linkIsValid(db, "AbCdEfGhIjKlMnOp"), true);
  assert.equal(await linkIsValid(db, "AAAAAAAAAAAAAAAA"), false);
  assert.equal(await linkIsValid(db, "bad/code"), false);
  assert.equal([...db.links][0].includes("AbCdEfGhIjKlMnOp"), false);
});

test("bot retries reuse the same link and record one idempotency row", async () => {
  const env = testEnv();
  const sent = [];
  mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  });
  await handleBotUpdate(adminUpdate(), env);
  await handleBotUpdate(adminUpdate(), env);
  assert.equal(env.DB.links.size, 1);
  assert.equal(env.DB.updates.size, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, sent[1].text);
  assert.match(sent[0].text, /https:\/\/selfie\.example\/selfie\/[A-Za-z0-9_-]{16}/);
  assert.match(sent[0].text, /odešle svou fotku do Telegram chatu/);
});

test("selfie path serves page only for a stored link", async () => {
  const env = testEnv();
  const link = await createStoredLink(env.DB, BOT_CONFIG.PUBLIC_BASE_URL, "0123456789AbCdEf");
  const valid = await worker.fetch(new Request(link), env);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("Cache-Control"), "no-store");
  assert.match(await valid.text(), /Selfie app/);
  const missing = await worker.fetch(new Request(
    "https://selfie.example/selfie/AAAAAAAAAAAAAAAA",
  ), env);
  assert.equal(missing.status, 404);
});

test("webhook rejects invalid secret and accepts authenticated admin command", async () => {
  const env = testEnv();
  mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const unauthorized = await worker.fetch(new Request(
    "https://selfie.example/telegram/webhook",
    { method: "POST", body: JSON.stringify(adminUpdate()) },
  ), env);
  assert.equal(unauthorized.status, 401);

  const response = await worker.fetch(new Request(
    "https://selfie.example/telegram/webhook",
    {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": BOT_CONFIG.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify(adminUpdate()),
    },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(env.DB.links.size, 1);
});

test("webhook setup is protected and registers the secret URL", async () => {
  const env = testEnv();
  const calls = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  });
  const response = await worker.fetch(new Request(
    "https://selfie.example/api/admin/configure-webhook",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${BOT_CONFIG.WEBHOOK_SETUP_KEY}` },
    },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(
    calls[0].url,
    "https://api.telegram.org/botoffline-test-token/setWebhook",
  );
  assert.equal(calls[0].body.url, "https://selfie.example/telegram/webhook");
  assert.equal(calls[0].body.secret_token, BOT_CONFIG.TELEGRAM_WEBHOOK_SECRET);
  assert.deepEqual(calls[0].body.allowed_updates, ["message"]);
});

test("photo relay accepts valid JPEG and never exposes Telegram errors", async () => {
  const env = testEnv();
  let sentForm;
  mock.method(globalThis, "fetch", async (_url, init) => {
    sentForm = init.body;
    return Response.json({ ok: true });
  });
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], {
    type: "image/jpeg",
  }), "selfie.jpg");
  const response = await worker.fetch(new Request(
    "https://selfie.example/api/send-photo",
    { method: "POST", body: form },
  ), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message, "Fotografie byla odeslána.");
  assert.equal(sentForm.get("chat_id"), BOT_CONFIG.TELEGRAM_CHAT_ID);
  assert.equal(sentForm.get("photo").type, "image/jpeg");
});

test("photo relay rejects unsupported, mismatched, and oversized images", async () => {
  const env = testEnv();
  mock.method(globalThis, "fetch", async () => {
    throw new Error("must not contact Telegram");
  });
  const makeRequest = (bytes, type) => {
    const form = new FormData();
    form.append("photo", new Blob([bytes], { type }), "photo");
    return new Request("https://selfie.example/api/send-photo", { method: "POST", body: form });
  };
  const unsupported = await worker.fetch(makeRequest("GIF89a", "image/gif"), env);
  assert.equal(unsupported.status, 415);
  const mismatched = await worker.fetch(makeRequest("not jpeg", "image/jpeg"), env);
  assert.equal(mismatched.status, 400);
  const oversized = await worker.fetch(
    makeRequest(new Uint8Array(5 * 1024 * 1024 + 1).fill(0xff), "image/jpeg"),
    env,
  );
  assert.equal(oversized.status, 413);
});
