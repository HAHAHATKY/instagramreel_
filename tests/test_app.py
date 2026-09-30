import os
import asyncio
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main


JPEG = b"\xff\xd8\xff" + b"test-image"
PNG = b"\x89PNG\r\n\x1a\n" + b"test-image"


class TelegramRelayTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.environment = patch.dict(
            os.environ,
            {
                "TELEGRAM_BOT_TOKEN": "test-token",
                "TELEGRAM_CHAT_ID": "test-chat",
                "ADMIN_TELEGRAM_USER_ID": "12345",
                "BASE_URL": "https://example.test",
                "DATABASE_PATH": os.path.join(self.temp_dir.name, "links.sqlite3"),
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_missing_configuration_returns_safe_error(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}):
            response = self.client.post(
                "/api/send-photo",
                files={"photo": ("selfie.jpg", JPEG, "image/jpeg")},
            )
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("test-token", response.text)

    def test_page_discloses_destination_and_serves_client(self):
        page = self.client.get("/")
        script = self.client.get("/app.js")

        self.assertEqual(page.status_code, 200)
        self.assertIn("lang=\"cs\"", page.text)
        self.assertIn("Telegram chat", page.text)
        self.assertIn("Pořídit a odeslat selfie", page.text)
        self.assertEqual(script.status_code, 200)
        self.assertIn("getUserMedia", script.text)

    def test_generated_short_link_resolves_and_unknown_link_does_not(self):
        link = main.create_short_link("https://example.test")
        token = link.rsplit("/", 1)[-1]

        self.assertEqual(len(token), 16)
        self.assertTrue(main.short_link_exists(token))
        self.assertEqual(self.client.get(f"/selfie/{token}").status_code, 200)
        self.assertEqual(self.client.get("/selfie/AAAAAAAAAAAAAAAA").status_code, 404)
        with main.database_connection() as connection:
            saved_hash = connection.execute(
                "SELECT token_hash FROM selfie_links"
            ).fetchone()[0]
        self.assertNotIn(token, saved_hash)

    def test_bot_start_and_newlink_create_links_only_for_admin_private_chat(self):
        config = main.BotConfig("test-token", "https://example.test", 12345)
        update = {
            "message": {
                "text": "/newlink",
                "chat": {"id": 12345, "type": "private"},
                "from": {"id": 12345},
            }
        }

        reply = main.build_bot_reply(update, config)

        self.assertIsNotNone(reply)
        self.assertIn("https://example.test/selfie/", reply[1])
        self.assertIn("fotka se odešle do Telegram chatu", reply[1])
        self.assertEqual(
            main.build_bot_reply(
                {
                    "message": {
                        "text": "/start",
                        "chat": {"id": 12345, "type": "private"},
                        "from": {"id": 99999},
                    }
                },
                config,
            ),
            None,
        )
        self.assertIsNone(
            main.build_bot_reply(
                {
                    "message": {
                        "text": "/newlink",
                        "chat": {"id": -10, "type": "group"},
                        "from": {"id": 12345},
                    }
                },
                config,
            )
        )

    def test_base_url_requires_https_outside_localhost(self):
        with self.assertRaises(ValueError):
            main.normalize_base_url("http://example.test")
        with self.assertRaises(ValueError):
            main.normalize_base_url("https://example.test/path")

    def test_render_external_url_is_used_when_base_url_is_empty(self):
        with patch.dict(
            os.environ,
            {"BASE_URL": "", "RENDER_EXTERNAL_URL": "https://service.onrender.com"},
        ):
            config = main.get_bot_config()
        self.assertEqual(config.base_url, "https://service.onrender.com")

    def test_bot_update_processing_is_idempotent_and_offline(self):
        class FakeResponse:
            is_error = False

            @staticmethod
            def json():
                return {"ok": True}

        class FakeClient:
            def __init__(self):
                self.messages = []

            async def post(self, url, json):
                self.messages.append((url, json))
                return FakeResponse()

        client = FakeClient()
        config = main.BotConfig("test-token", "https://example.test", 12345)
        update = {
            "update_id": 8,
            "message": {
                "text": "/start",
                "chat": {"id": 12345, "type": "private"},
                "from": {"id": 12345},
            },
        }
        asyncio.run(main.handle_bot_update(client, config, update))
        asyncio.run(main.handle_bot_update(client, config, update))

        self.assertEqual(len(client.messages), 2)
        self.assertEqual(client.messages[0][1], client.messages[1][1])
        link_token = client.messages[0][1]["text"].split("/selfie/", 1)[1].split()[0]
        with main.database_connection() as connection:
            count = connection.execute("SELECT COUNT(*) FROM selfie_links").fetchone()[0]
            saved_hash = connection.execute(
                "SELECT token_hash FROM selfie_links"
            ).fetchone()[0]
            response_kind = connection.execute(
                "SELECT response_kind FROM processed_bot_updates WHERE update_id = 8"
            ).fetchone()[0]
        self.assertEqual(count, 1)
        self.assertNotIn(link_token, saved_hash)
        self.assertEqual(response_kind, "link")

    def test_rejects_unsupported_media_type(self):
        response = self.client.post(
            "/api/send-photo",
            files={"photo": ("selfie.gif", b"GIF89a", "image/gif")},
        )
        self.assertEqual(response.status_code, 415)

    def test_rejects_mismatched_image_signature(self):
        response = self.client.post(
            "/api/send-photo",
            files={"photo": ("selfie.jpg", b"not an image", "image/jpeg")},
        )
        self.assertEqual(response.status_code, 400)

    def test_rejects_photo_larger_than_limit(self):
        response = self.client.post(
            "/api/send-photo",
            files={
                "photo": (
                    "selfie.jpg",
                    b"\xff\xd8\xff" + b"x" * main.MAX_PHOTO_BYTES,
                    "image/jpeg",
                )
            },
        )
        self.assertEqual(response.status_code, 413)

    def test_rejects_request_larger_than_limit(self):
        response = self.client.post(
            "/api/send-photo",
            headers={"content-length": str(main.MAX_REQUEST_BYTES + 1)},
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(
            response.json()["detail"],
            "Požadavek je příliš velký. Maximální velikost fotografie je 5 MB.",
        )

    def test_successful_relay_does_not_expose_credentials(self):
        class FakeResponse:
            is_error = False

            @staticmethod
            def json():
                return {"ok": True}

        class FakeClient:
            def __init__(self, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def post(self, url, data, files):
                self.asserted_url = url
                self.asserted_data = data
                self.asserted_files = files
                return FakeResponse()

        with patch.object(main.httpx, "AsyncClient", FakeClient):
            response = self.client.post(
                "/api/send-photo",
                files={"photo": ("selfie.jpg", PNG, "image/png")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"message": "Fotografie byla odeslána."})
        self.assertNotIn("test-token", response.text)

    def test_telegram_rejection_returns_safe_error(self):
        class FakeResponse:
            is_error = True

        class FakeClient:
            def __init__(self, timeout):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def post(self, url, data, files):
                return FakeResponse()

        with patch.object(main.httpx, "AsyncClient", FakeClient):
            response = self.client.post(
                "/api/send-photo",
                files={"photo": ("selfie.jpg", JPEG, "image/jpeg")},
            )

        self.assertEqual(response.status_code, 502)
        self.assertNotIn("test-token", response.text)


if __name__ == "__main__":
    unittest.main()
