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


class FakePhoto:
    def __init__(self, i, kind="image"):
        from datetime import datetime, timedelta
        self.id = f"p{i}"
        self.item_type = kind
        self.filename = f"IMG_{i}.HEIC"
        self.size = 1000
        self.asset_date = datetime(2020, 1, 1) + timedelta(days=i)
        self.versions = {"original": {}, "medium": {}, "thumb": {}}
        self.downloads = []

    def download(self, version="original"):
        self.downloads.append(version)
        side = {"original": 4000, "medium": 1600, "thumb": 360}[version]
        out = io.BytesIO()
        Image.new("RGB", (side, side * 3 // 4), "red").save(out, "JPEG")
        return out.getvalue()


class FakeAlbums(list):
    def find(self, name):
        return next((a for a in self if a.name == name), None)


class FakeAlbum:
    def __init__(self, name, photos):
        self.name = name
        self._photos = photos
        self.reads = 0

    @property
    def photos(self):
        self.reads += 1
        return iter(self._photos)

    def get(self, ref):
        return next((p for p in self._photos if p.id == ref), None)


class ListingTest(unittest.TestCase):
    def setUp(self):
        self.c = TestClient(sidecar.app)
        self.h = {"x-vault-token": "t" * 64}
        photos = [FakePhoto(i, "video" if i % 10 == 9 else "image") for i in range(250)]
        self.locke = FakeAlbum("Locke", photos)
        self.fav = FakeAlbum("Favorites", photos[:5])
        self.hidden = FakeAlbum("Hidden", photos[5:7])
        albums = FakeAlbums([self.locke, self.fav, self.hidden, FakeAlbum("Library", photos), FakeAlbum("Recently Deleted", [])])

        class Api:
            class photos:
                pass
        Api.photos.albums = albums
        sess = sidecar.Session(USER, "me@example.com")
        sess.api = Api
        self._get = sidecar.sessions.get
        sidecar.sessions.get = lambda user: sess
        sidecar.listings.clear()

    def tearDown(self):
        sidecar.sessions.get = self._get

    def test_albums_lists_user_albums_and_the_offered_smart_ones(self):
        r = self.c.get(f"/albums?user={USER}", headers=self.h).json()
        self.assertEqual(r, {"albums": ["Locke"], "smart": ["Favorites", "Hidden"]})

    def test_pages_come_from_one_pass_over_the_album(self):
        seen, cursor = [], None
        while True:
            r = self.c.post("/query", headers=self.h, json={"user": USER, "album": "Locke", "limit": 100, **({"cursor": cursor} if cursor else {})}).json()
            seen += [i["ref"] for i in r["items"]]
            cursor = r["cursor"]
            if not cursor:
                break
        self.assertEqual(len(seen), 225, "videos skipped, every image once")
        self.assertEqual(len(set(seen)), 225)
        self.assertEqual(self.locke.reads, 1, "the album was read once for all pages")
        # A new first page reads the album again (photos may have been added).
        self.c.post("/query", headers=self.h, json={"user": USER, "album": "Locke", "limit": 10})
        self.assertEqual(self.locke.reads, 2)

    def test_previews_use_apples_small_copies_never_the_original(self):
        photo = self.locke._photos[3]
        for size, side in (("thumb", 360), ("display", 1600)):
            r = self.c.get(f"/content?user={USER}&album=Locke&ref=p3&size={size}", headers=self.h)
            self.assertEqual(r.status_code, 200)
            with Image.open(io.BytesIO(r.content)) as im:
                self.assertEqual(max(im.size), side)
        self.assertEqual(photo.downloads, ["thumb", "medium"])
        r = self.c.get(f"/content?user={USER}&album=Locke&ref=p3", headers=self.h)
        with Image.open(io.BytesIO(r.content)) as im:
            self.assertEqual(max(im.size), 4000, "no size: the original")
        self.assertEqual(self.c.get(f"/content?user={USER}&album=Locke&ref=p3&size=huge", headers=self.h).status_code, 400)

    def test_smart_albums_by_name(self):
        r = self.c.post("/query", headers=self.h, json={"user": USER, "album": "Hidden"}).json()
        self.assertEqual([i["ref"] for i in r["items"]], ["p5", "p6"])
        self.assertEqual(self.c.post("/query", headers=self.h, json={"user": USER, "album": "Nope"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
