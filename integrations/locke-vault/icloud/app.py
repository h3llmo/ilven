"""
Locke-Vault iCloud sidecar (EXPERIMENTAL).

Reads photos from one album of a user's iCloud Photos library with pyicloud (Apple's private web API).
Only the vault can reach this service (private network + shared token); the vault decides who may use it.

Per user (keyed by an opaque id the vault derives from the user's login):
- the Apple ID password is used once to sign in and is never stored;
- the trusted Apple session (cookies + session token) is kept AES-256-GCM encrypted on the volume and only
  decrypted into a private temporary directory while in use;
- photos are returned as JPEG (HEIC converted), orientation applied, metadata stripped.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
from pillow_heif import register_heif_opener

register_heif_opener()
logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","msg":%(message)r}')
log = logging.getLogger("icloud")
logging.getLogger("pyicloud").setLevel(logging.WARNING)

DATA = Path(os.environ.get("ICLOUD_DATA_DIR", "/data"))
TOKEN = Path(os.environ["ICLOUD_TOKEN_FILE"]).read_text().strip()
KEY = bytes.fromhex(Path(os.environ["ICLOUD_KEY_FILE"]).read_text().strip())
MAX_BYTES = int(os.environ.get("ICLOUD_MAX_BYTES", str(25 * 1024 * 1024)))
SESSION_TTL = 15 * 60  # keep a signed-in service in memory for 15 minutes
USER_RE = re.compile(r"^[a-f0-9]{64}$")


# ---------- Encrypted per-user session store ----------
class Store:
    """Keeps each user's pyicloud cookie directory encrypted at rest (AES-256-GCM, bound to the user id)."""

    def __init__(self, root: Path, key: bytes) -> None:
        self.root = root
        self.aead = AESGCM(key)
        (root / "users").mkdir(parents=True, exist_ok=True)

    def _path(self, user: str) -> Path:
        return self.root / "users" / f"{user}.enc"

    def exists(self, user: str) -> bool:
        return self._path(user).exists()

    def save(self, user: str, apple_id: str, cookie_dir: str) -> None:
        files = {}
        for p in Path(cookie_dir).iterdir():
            if p.is_file():
                files[p.name] = base64.b64encode(p.read_bytes()).decode()
        plain = json.dumps({"appleId": apple_id, "files": files}).encode()
        nonce = os.urandom(12)
        blob = nonce + self.aead.encrypt(nonce, plain, f"icloud:{user}".encode())
        tmp = self._path(user).with_suffix(".part")
        tmp.write_bytes(blob)
        tmp.replace(self._path(user))

    def load(self, user: str, cookie_dir: str) -> str | None:
        """Decrypts the user's session into cookie_dir; returns the Apple ID, or None if not connected."""
        p = self._path(user)
        if not p.exists():
            return None
        blob = p.read_bytes()
        data = json.loads(self.aead.decrypt(blob[:12], blob[12:], f"icloud:{user}".encode()))
        for name, b64 in data["files"].items():
            if "/" in name or name.startswith("."):
                continue
            (Path(cookie_dir) / name).write_bytes(base64.b64decode(b64))
        return data["appleId"]

    def delete(self, user: str) -> None:
        self._path(user).unlink(missing_ok=True)


# ---------- Signed-in services (in memory, per user) ----------
class Session:
    def __init__(self, user: str, apple_id: str) -> None:
        self.user = user
        self.apple_id = apple_id
        self.dir = tempfile.mkdtemp(prefix="icloud-")
        os.chmod(self.dir, 0o700)
        self.api: Any = None
        self.pending_2fa = False
        self.used = time.monotonic()
        self.lock = threading.RLock()

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


class NotConnected(Exception):
    pass


class Sessions:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.by_user: dict[str, Session] = {}
        self.lock = threading.Lock()

    def _evict(self) -> None:
        now = time.monotonic()
        for u, s in list(self.by_user.items()):
            if now - s.used > SESSION_TTL:
                self.by_user.pop(u, None)
                s.close()

    def drop(self, user: str) -> None:
        with self.lock:
            s = self.by_user.pop(user, None)
        if s:
            s.close()

    def connect(self, user: str, apple_id: str, password: str) -> Session:
        from pyicloud import PyiCloudService  # imported lazily: heavy

        self.drop(user)
        s = Session(user, apple_id)
        try:
            s.api = PyiCloudService(apple_id, password, cookie_directory=s.dir)
        except Exception:
            s.close()
            raise
        s.pending_2fa = bool(s.api.requires_2fa)
        with self.lock:
            self.by_user[user] = s
        if not s.pending_2fa:
            self.store.save(user, apple_id, s.dir)
        return s

    def verify(self, user: str, code: str) -> Session:
        with self.lock:
            s = self.by_user.get(user)
        if not s or not s.pending_2fa:
            raise NotConnected("No sign-in waiting for a code. Start again.")
        with s.lock:
            if not s.api.validate_2fa_code(code):
                raise HTTPException(400, {"error": "bad_code", "message": "Apple rejected this code"})
            s.api.trust_session()
            s.pending_2fa = False
            self.store.save(user, s.apple_id, s.dir)
            s.used = time.monotonic()
        return s

    def get(self, user: str) -> Session:
        """A signed-in session, reusing the stored trusted session (no password)."""
        with self.lock:
            self._evict()
            s = self.by_user.get(user)
        if s and not s.pending_2fa and s.api is not None:
            s.used = time.monotonic()
            return s
        from pyicloud import PyiCloudService

        s = Session(user, "")
        apple_id = self.store.load(user, s.dir)
        if not apple_id:
            s.close()
            raise NotConnected("iCloud is not connected")
        s.apple_id = apple_id
        try:
            s.api = PyiCloudService(apple_id, None, cookie_directory=s.dir)
            if s.api.requires_2fa:
                raise NotConnected("Your Apple session expired. Reconnect iCloud in the vault settings.")
        except NotConnected:
            s.close()
            raise
        except Exception as e:  # expired or revoked session: the user must sign in again
            s.close()
            log.info(json.dumps({"event": "session_reuse_failed", "error": type(e).__name__}))
            raise NotConnected("Your Apple session expired. Reconnect iCloud in the vault settings.") from e
        self.store.save(user, apple_id, s.dir)  # Apple may have refreshed the session
        with self.lock:
            self.by_user[user] = s
        return s


store = Store(DATA, KEY)
sessions = Sessions(store)
app = FastAPI(title="locke-vault-icloud", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def require_token(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)
    given = request.headers.get("x-vault-token", "")
    import hmac

    if not hmac.compare_digest(given, TOKEN):
        return JSONResponse({"error": "unauthorized", "message": "Vault token required"}, status_code=401)
    return await call_next(request)


@app.exception_handler(NotConnected)
async def not_connected(_req: Request, e: NotConnected):
    return JSONResponse({"error": "not_connected", "message": str(e)}, status_code=409)


def check_user(user: str) -> str:
    if not USER_RE.match(user):
        raise HTTPException(400, {"error": "bad_request", "message": "Invalid user"})
    return user


def mask(apple_id: str) -> str:
    name, _, domain = apple_id.partition("@")
    return f"{name[:2]}…@{domain}" if domain else f"{apple_id[:2]}…"


@app.get("/healthz")
def healthz():
    return {"ok": True}


class ConnectBody(BaseModel):
    user: str
    appleId: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


@app.post("/connect")
def connect(b: ConnectBody):
    user = check_user(b.user)
    try:
        s = sessions.connect(user, b.appleId.strip(), b.password)
    except Exception as e:
        name = type(e).__name__
        log.info(json.dumps({"event": "connect_failed", "error": name}))
        if "Locked" in name:
            raise HTTPException(403, {"error": "account_locked", "message": "Apple says this account is locked."})
        if "FailedLogin" in name or "Password" in name:
            raise HTTPException(401, {"error": "bad_credentials", "message": "Apple rejected this Apple ID or password."})
        raise HTTPException(502, {"error": "apple_error", "message": f"Apple sign-in failed ({name})."})
    return {"state": "needs_2fa" if s.pending_2fa else "connected", "appleId": mask(s.apple_id)}


class VerifyBody(BaseModel):
    user: str
    code: str = Field(pattern=r"^\d{6}$")


@app.post("/verify")
def verify(b: VerifyBody):
    s = sessions.verify(check_user(b.user), b.code)
    return {"state": "connected", "appleId": mask(s.apple_id)}


class UserBody(BaseModel):
    user: str


@app.post("/disconnect")
def disconnect(b: UserBody):
    user = check_user(b.user)
    sessions.drop(user)
    store.delete(user)
    for k in [k for k in listings if k[0] == user]:
        listings.pop(k, None)
    return {"state": "disconnected"}


@app.get("/status")
def status(user: str):
    user = check_user(user)
    with sessions.lock:
        pending = sessions.by_user.get(user)
    if pending and pending.pending_2fa:
        return {"state": "needs_2fa", "appleId": mask(pending.apple_id)}
    if not store.exists(user):
        return {"state": "disconnected"}
    try:
        s = sessions.get(user)
    except NotConnected as e:
        return {"state": "expired", "message": str(e)}
    return {"state": "connected", "appleId": mask(s.apple_id)}


# Smart albums the vault offers next to the user's own albums. Others (Library, Videos, Recently Deleted…) are not.
SMART = ("Favorites", "Hidden")
NOT_USER_ALBUMS = {"Library", "All Photos", "Bursts", "Favorites", "Hidden", "Live", "Panoramas", "Recently Deleted",
                   "Screenshots", "Slo-mo", "Time-lapse", "Videos", "Portrait", "Long Exposure", "Animated", "Selfies"}


@app.get("/albums")
def albums(user: str):
    s = sessions.get(check_user(user))
    with s.lock:
        # Always re-read: the user may have created the album after connecting (pyicloud caches the list).
        names = sorted({a.name for a in _refresh_albums(s.api.photos) if getattr(a, "name", None)} - NOT_USER_ALBUMS, key=str.casefold)
    return {"albums": names, "smart": list(SMART)}


def _refresh_albums(photos):
    """Re-read the album list (pyicloud caches it for the life of the session)."""
    lib = getattr(photos, "_root_library", None)
    return lib.refresh_albums() if lib is not None and hasattr(lib, "refresh_albums") else photos.albums


def _find(albums, name: str):
    album = albums.find(name)
    if album is None:  # tolerate case and stray spaces ("Locke " / "locke")
        want = name.strip().casefold()
        album = next((a for a in albums if (getattr(a, "name", None) or "").strip().casefold() == want), None)
    return album


def _album(s: Session, name: str):
    if name in SMART:
        album = s.api.photos.albums.find(name)
        if album is None:
            raise HTTPException(404, {"error": "album_not_found", "message": f"iCloud doesn't offer the {name} album for this library"})
        return album
    album = _find(s.api.photos.albums, name)
    if album is None:  # created since the list was cached: re-read it once
        album = _find(_refresh_albums(s.api.photos), name)
    if album is None:
        raise HTTPException(404, {"error": "album_not_found", "message": f'No album named "{name}" in this iCloud library'})
    return album


def _iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


LISTING_TTL = 120  # seconds a listing is reused (paging, workflow scans)
LISTING_MAX = 10_000  # photos listed per album at most


class Listing:
    """One pass over an album, kept briefly: pages are served from it instead of re-reading the album from Apple for
    each page (Apple lists album photos by date taken, so a photo added today may sit anywhere in the list)."""

    def __init__(self, album) -> None:
        self.created = time.monotonic()
        self.it = iter(album.photos)
        self.items: list[dict[str, Any]] = []
        self.photos: dict[str, Any] = {}
        self.done = False

    def fresh(self) -> bool:
        return time.monotonic() - self.created < LISTING_TTL

    def upto(self, n: int) -> None:
        while not self.done and len(self.items) < min(n, LISTING_MAX):
            photo = next(self.it, None)
            if photo is None:
                self.done = True
                break
            if photo.item_type != "image":
                continue
            taken = photo.asset_date
            if taken is not None and taken.tzinfo is None:
                taken = taken.replace(tzinfo=timezone.utc)
            self.photos[photo.id] = photo
            self.items.append({
                "ref": photo.id,
                "name": re.sub(r"\.(heic|heif)$", ".jpg", photo.filename, flags=re.I),
                "contentType": "image/jpeg",
                **({"size": photo.size} if photo.size else {}),
                **({"date": _iso(taken)} if taken else {}),
                "_taken": taken,
            })
        if len(self.items) >= LISTING_MAX:
            self.done = True


listings: dict[tuple[str, str], Listing] = {}


def listing(s: Session, name: str, reuse: bool = True) -> Listing:
    key = (s.user, name)
    cur = listings.get(key)
    if reuse and cur and cur.fresh():
        return cur
    for k, v in list(listings.items()):
        if not v.fresh():
            listings.pop(k, None)
    cur = listings[key] = Listing(_album(s, name))
    return cur


class QueryBody(BaseModel):
    user: str
    album: str = Field(min_length=1, max_length=200)
    text: str | None = Field(default=None, max_length=200)
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    limit: int = Field(default=30, ge=1, le=100)
    cursor: str | None = Field(default=None, pattern=r"^\d{1,6}$")


@app.post("/query")
def query(b: QueryBody):
    s = sessions.get(check_user(b.user))
    start = int(b.cursor or 0)
    lo = datetime.fromisoformat(b.from_.replace("Z", "+00:00")) if b.from_ else None
    hi = datetime.fromisoformat(b.to.replace("Z", "+00:00")) if b.to else None
    text = (b.text or "").lower()
    items: list[dict[str, Any]] = []
    next_cursor = None
    with s.lock:
        # A first page reads the album afresh; later pages continue the same listing.
        lst = listing(s, b.album, reuse=start > 0)
        i = start
        while True:
            lst.upto(i + 1)
            if i >= len(lst.items):
                break
            it = lst.items[i]
            i += 1
            taken = it["_taken"]
            if (lo and taken and taken < lo) or (hi and taken and taken > hi) or (text and text not in it["name"].lower()):
                continue
            items.append({k: v for k, v in it.items() if not k.startswith("_")})
            if len(items) >= b.limit:
                lst.upto(i + 1)
                next_cursor = str(i) if i < len(lst.items) else None
                break
    return {"items": items, "cursor": next_cursor}


def to_jpeg(raw: bytes) -> bytes:
    """Any supported image (HEIC, JPEG, PNG…) → high-quality JPEG, orientation applied, metadata stripped."""
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        out = io.BytesIO()
        im.save(out, "JPEG", quality=92, optimize=True)
        return out.getvalue()


@app.get("/content")
def content(user: str, album: str, ref: str):
    if not re.match(r"^[\w\-/+=.:]{1,300}$", ref):
        raise HTTPException(404, {"error": "not_found", "message": "Photo not found"})
    s = sessions.get(check_user(user))
    with s.lock:
        cached = listings.get((s.user, album))
        photo = cached.photos.get(ref) if cached else None
        if photo is None:
            photo = _album(s, album).get(ref)
        if photo is None or photo.item_type != "image":
            raise HTTPException(404, {"error": "not_found", "message": "Photo not found in this album"})
        if photo.size and photo.size > MAX_BYTES * 2:
            raise HTTPException(413, {"error": "too_large", "message": "This photo is too large"})
        raw = photo.download("original")
        name = re.sub(r"\.(heic|heif|png|jpe?g)$", "", photo.filename, flags=re.I) + ".jpg"
    if not raw:
        raise HTTPException(502, {"error": "apple_error", "message": "Apple returned no data for this photo"})
    jpeg = to_jpeg(raw)
    if len(jpeg) > MAX_BYTES:
        raise HTTPException(413, {"error": "too_large", "message": "This photo is too large"})
    return Response(jpeg, media_type="image/jpeg", headers={"content-disposition": f'inline; filename="{name}"'})
