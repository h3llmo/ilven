import io
import os
import tempfile
import unittest
from pathlib import Path

_tmp = tempfile.mkdtemp()
Path(_tmp, "token").write_text("t" * 64)
Path(_tmp, "key").write_text("ab" * 32)
os.environ.update(ICLOUD_TOKEN_FILE=f"{_tmp}/token", ICLOUD_KEY_FILE=f"{_tmp}/key", ICLOUD_DATA_DIR=f"{_tmp}/data")

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

import app as sidecar  # noqa: E402

USER = "a" * 64


class StoreTest(unittest.TestCase):
    def test_session_files_are_encrypted_and_bound_to_the_user(self):
        src = tempfile.mkdtemp()
        Path(src, "me.session").write_text('{"session_token": "SECRET-TOKEN"}')
        Path(src, "me.cookiejar").write_text("X-APPLE-WEBAUTH=SECRET-COOKIE")
        sidecar.store.save(USER, "me@example.com", src)
        blob = (Path(_tmp) / "data/users" / f"{USER}.enc").read_bytes()
        self.assertNotIn(b"SECRET", blob)
        self.assertNotIn(b"me@example.com", blob)
        dst = tempfile.mkdtemp()
        self.assertEqual(sidecar.store.load(USER, dst), "me@example.com")
        self.assertIn("SECRET-TOKEN", Path(dst, "me.session").read_text())
        # Another user's id can't open it (AAD binding).
        other = "b" * 64
        (Path(_tmp) / "data/users" / f"{other}.enc").write_bytes(blob)
        with self.assertRaises(Exception):
            sidecar.store.load(other, tempfile.mkdtemp())
        sidecar.store.delete(USER)
        self.assertIsNone(sidecar.store.load(USER, tempfile.mkdtemp()))


class ConvertTest(unittest.TestCase):
    def test_heic_and_png_become_jpeg_with_orientation_applied(self):
        im = Image.new("RGBA", (40, 20), (255, 0, 0, 255))
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90° on display
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "HEIF", exif=exif.tobytes())
        out = sidecar.to_jpeg(buf.getvalue())
        self.assertEqual(out[:3], b"\xff\xd8\xff")
        with Image.open(io.BytesIO(out)) as j:
            self.assertEqual(j.size, (20, 40), "orientation applied")
            self.assertFalse(j.getexif(), "metadata stripped")
        png = io.BytesIO()
        im.save(png, "PNG")
        self.assertEqual(sidecar.to_jpeg(png.getvalue())[:3], b"\xff\xd8\xff")


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.c = TestClient(sidecar.app)

    def test_token_required(self):
        self.assertEqual(self.c.get(f"/status?user={USER}").status_code, 401)
        self.assertEqual(self.c.get(f"/status?user={USER}", headers={"x-vault-token": "nope"}).status_code, 401)
        self.assertEqual(self.c.get("/healthz").status_code, 200)

    def test_not_connected_user(self):
        h = {"x-vault-token": "t" * 64}
        self.assertEqual(self.c.get(f"/status?user={USER}", headers=h).json(), {"state": "disconnected"})
        self.assertEqual(self.c.get(f"/albums?user={USER}", headers=h).status_code, 409)
        self.assertEqual(self.c.get("/status?user=../../etc", headers=h).status_code, 400)


if __name__ == "__main__":
    unittest.main()
