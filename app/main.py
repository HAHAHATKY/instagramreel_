import os
import asyncio
import base64
import hashlib
import hmac
import logging
import re
import secrets
import sqlite3
from contextlib import asynccontextmanager, closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Iterator
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

BASE_DIR: Final = Path(__file__).resolve().parent
MAX_PHOTO_BYTES: Final = 5 * 1024 * 1024
MAX_REQUEST_BYTES: Final = MAX_PHOTO_BYTES + 64 * 1024
SHORT_CODE_PATTERN: Final = re.compile(r"^[A-Za-z0-9_-]{16}$")
ALLOWED_IMAGE_TYPES: Final = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/png": b"\x89PNG\r\n\x1a\n",
}
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TelegramConfig:
    bot_token: str
    chat_id: str


@dataclass(frozen=True)
class BotConfig:
    bot_token: str
    base_url: str
    admin_user_id: int


def database_path() -> Path:
    return Path(os.getenv("DATABASE_PATH", "data/links.sqlite3"))


def connect_database() -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS selfie_links (
            token_hash TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS processed_bot_updates (
            update_id INTEGER PRIMARY KEY,
            response_chat_id TEXT,
            response_kind TEXT
        )
        """
    )
    return connection


@contextmanager
def database_connection() -> Iterator[sqlite3.Connection]:
    connection = connect_database()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def normalize_base_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url.strip())
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("BASE_URL must be an HTTPS origin without a path.")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("BASE_URL must use HTTPS outside localhost.")
    return f"{parsed.scheme}://{parsed.netloc}"


def get_bot_config() -> BotConfig | None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    raw_base_url = os.getenv("BASE_URL", "").strip() or os.getenv(
        "RENDER_EXTERNAL_URL", ""
    ).strip()
    raw_admin_id = os.getenv("ADMIN_TELEGRAM_USER_ID", "").strip()
    if not token or not raw_base_url or not raw_admin_id:
        return None
    try:
        admin_user_id = int(raw_admin_id)
        base_url = normalize_base_url(raw_base_url)
    except ValueError as exc:
        raise RuntimeError("Invalid bot configuration; check BASE_URL and ADMIN_TELEGRAM_USER_ID.") from exc
    if admin_user_id <= 0:
        raise RuntimeError("ADMIN_TELEGRAM_USER_ID must be a positive Telegram user ID.")
    return BotConfig(token, base_url, admin_user_id)


def create_short_link(base_url: str, token: str | None = None) -> str:
    safe_base_url = normalize_base_url(base_url)
    token = token or secrets.token_urlsafe(12)
    if not SHORT_CODE_PATTERN.fullmatch(token):
        raise ValueError("Short link token has an invalid format.")
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    with database_connection() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO selfie_links (token_hash) VALUES (?)",
            (token_hash,),
        )
    return f"{safe_base_url}/selfie/{token}"


def short_link_exists(token: str) -> bool:
    if not SHORT_CODE_PATTERN.fullmatch(token):
        return False
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    with database_connection() as connection:
        row = connection.execute(
            "SELECT 1 FROM selfie_links WHERE token_hash = ?",
            (token_hash,),
        ).fetchone()
    return row is not None


def get_telegram_config() -> TelegramConfig:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        raise HTTPException(
            status_code=503,
            detail="Odesílání zatím není nakonfigurované. Zkuste to prosím později.",
        )
    return TelegramConfig(bot_token=token, chat_id=chat_id)


def validate_image(data: bytes, content_type: str | None) -> str:
    normalized_type = (content_type or "").split(";", 1)[0].strip().lower()
    expected_signature = ALLOWED_IMAGE_TYPES.get(normalized_type)
    if expected_signature is None:
        raise HTTPException(
            status_code=415,
            detail="Podporujeme pouze obrázky JPEG a PNG.",
        )
    if not data.startswith(expected_signature):
        raise HTTPException(
            status_code=400,
            detail="Soubor neodpovídá deklarovanému typu obrázku.",
        )
    return normalized_type


async def relay_photo(config: TelegramConfig, photo: bytes, content_type: str) -> None:
    url = f"https://api.telegram.org/bot{config.bot_token}/sendPhoto"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                url,
                data={"chat_id": config.chat_id},
                files={
                    "photo": (
                        "selfie.png" if content_type == "image/png" else "selfie.jpg",
                        photo,
                        content_type,
                    )
                },
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Telegram neodpověděl včas. Zkuste odeslání znovu.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail="Fotografii se nepodařilo doručit do Telegramu.",
        ) from exc

    if response.is_error:
        raise HTTPException(
            status_code=502,
            detail="Telegram fotografii nepřijal. Zkontrolujte nastavení a zkuste to znovu.",
        )

    try:
        result = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Telegram vrátil neplatnou odpověď.",
        ) from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise HTTPException(
            status_code=502,
            detail="Telegram fotografii nepřijal. Zkontrolujte nastavení a zkuste to znovu.",
        )


def bot_link_token(config: BotConfig, update_id: int) -> str:
    digest = hmac.new(
        config.bot_token.encode("utf-8"),
        f"selfie-link:{update_id}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode("ascii").rstrip("=")


def build_bot_reply(
    update: dict,
    config: BotConfig,
    update_id: int | None = None,
) -> tuple[str, str] | None:
    message = update.get("message")
    if not isinstance(message, dict):
        return None
    chat = message.get("chat")
    sender = message.get("from")
    if not isinstance(chat, dict) or not isinstance(sender, dict):
        return None
    if chat.get("type") != "private" or sender.get("id") != config.admin_user_id:
        return None

    text = message.get("text", "")
    if not isinstance(text, str):
        text = ""
    command = text.split(maxsplit=1)[0].split("@", 1)[0].lower() if text else ""
    chat_id = str(chat.get("id"))
    if command in {"/start", "/newlink"}:
        token = bot_link_token(config, update_id) if update_id is not None else None
        link = create_short_link(config.base_url, token)
        return chat_id, (
            f"Tady je odkaz na stránku pro pořízení selfie: {link}\n\n"
            "Stránka předem jasně říká, že fotka se odešle do Telegram chatu. "
            "Kamera se zapne až po výslovném povolení a fotka se odešle jen po klepnutí na tlačítko."
        )
    return chat_id, "Použij /newlink pro vytvoření odkazu na stránku pro selfie do Telegramu."


async def send_bot_message(client: httpx.AsyncClient, token: str, chat_id: str, text: str) -> None:
    response = await client.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
    )
    if response.is_error:
        raise RuntimeError("Telegram rejected the bot reply.")
    try:
        result = response.json()
    except ValueError as exc:
        raise RuntimeError("Telegram returned an invalid bot reply response.") from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise RuntimeError("Telegram rejected the bot reply.")


async def poll_telegram_bot(config: BotConfig) -> None:
    offset = 0
    timeout = httpx.Timeout(40.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        while True:
            try:
                response = await client.get(
                    f"https://api.telegram.org/bot{config.bot_token}/getUpdates",
                    params={"offset": offset, "timeout": 30, "allowed_updates": '["message"]'},
                    timeout=timeout,
                )
                response.raise_for_status()
                result = response.json()
                if not isinstance(result, dict) or result.get("ok") is not True:
                    raise RuntimeError("Telegram returned an invalid updates response.")
                updates = result.get("result", [])
                if not isinstance(updates, list):
                    raise RuntimeError("Telegram returned an invalid updates list.")
                for update in updates:
                    if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
                        continue
                    try:
                        await handle_bot_update(client, config, update)
                    except Exception as exc:
                        logger.warning("Could not process Telegram bot update (%s).", type(exc).__name__)
                        break
                    offset = max(offset, update["update_id"] + 1)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Telegram bot polling failed (%s); retrying shortly.", type(exc).__name__)
                await asyncio.sleep(5)


async def handle_bot_update(
    client: httpx.AsyncClient,
    config: BotConfig,
    update: dict,
) -> None:
    update_id = update["update_id"]
    reply = build_bot_reply(update, config, update_id)
    if reply is None:
        return
    response_chat_id, response_text = reply
    response_kind = "link" if "/selfie/" in response_text else "help"
    with database_connection() as connection:
        row = connection.execute(
            "SELECT response_chat_id, response_kind FROM processed_bot_updates WHERE update_id = ?",
            (update_id,),
        ).fetchone()
        if row is None:
            connection.execute(
                """
                INSERT INTO processed_bot_updates (update_id, response_chat_id, response_kind)
                VALUES (?, ?, ?)
                """,
                (update_id, response_chat_id, response_kind),
            )
        else:
            response_chat_id, response_kind = row
            if response_kind == "link":
                token = bot_link_token(config, update_id)
                response_text = (
                    f"Tady je odkaz na stránku pro pořízení selfie: "
                    f"{config.base_url}/selfie/{token}\n\n"
                    "Stránka předem jasně říká, že fotka se odešle do Telegram chatu. "
                    "Kamera se zapne až po výslovném povolení a fotka se odešle jen po klepnutí na tlačítko."
                )
            else:
                response_text = "Použij /newlink pro vytvoření odkazu na stránku pro selfie do Telegramu."
    if response_chat_id is not None and response_text is not None:
        await send_bot_message(client, config.bot_token, response_chat_id, response_text)


@asynccontextmanager
async def lifespan(_: FastAPI):
    with closing(connect_database()):
        pass
    bot_config = get_bot_config()
    bot_task = None
    if bot_config:
        bot_task = asyncio.create_task(poll_telegram_bot(bot_config))
    elif os.getenv("TELEGRAM_BOT_TOKEN", "").strip():
        logger.warning(
            "Telegram link bot is disabled; configure BASE_URL and ADMIN_TELEGRAM_USER_ID."
        )
    try:
        yield
    finally:
        if bot_task:
            bot_task.cancel()
            try:
                await bot_task
            except asyncio.CancelledError:
                pass


app = FastAPI(
    title="Selfie do Telegramu",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def enforce_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            request_size = int(content_length)
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"detail": "Neplatná velikost požadavku."},
            )
        if request_size < 0 or request_size > MAX_REQUEST_BYTES:
            return JSONResponse(
                status_code=413,
                content={
                    "detail": "Požadavek je příliš velký. Maximální velikost fotografie je 5 MB."
                },
            )
    return await call_next(request)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


@app.get("/selfie/{token}", include_in_schema=False)
async def short_link(token: str):
    if not short_link_exists(token):
        raise HTTPException(status_code=404, detail="Tento odkaz neexistuje.")
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/styles.css", include_in_schema=False)
async def styles():
    return FileResponse(BASE_DIR / "static" / "styles.css", media_type="text/css")


@app.get("/app.js", include_in_schema=False)
async def script():
    return FileResponse(
        BASE_DIR / "static" / "app.js",
        media_type="text/javascript",
    )


@app.post("/api/send-photo")
async def send_photo(photo: UploadFile = File(...)):
    data = await photo.read(MAX_PHOTO_BYTES + 1)
    await photo.close()
    if not data:
        raise HTTPException(status_code=400, detail="Vyberte fotografii k odeslání.")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Fotografie je příliš velká. Maximální velikost je 5 MB.",
        )
    content_type = validate_image(data, photo.content_type)
    config = get_telegram_config()
    await relay_photo(config, data, content_type)
    return {"message": "Fotografie byla odeslána."}
