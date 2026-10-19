#!/usr/bin/python3
"""Fetch player-supplied raster art, with bounded decoding outside GNOME Shell."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

LIMIT = 8 * 1024 * 1024


def fetch(uri):
    parsed = urlsplit(uri)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Unsupported cover URI')
    started = time.monotonic()
    with urlopen(Request(uri, headers={'User-Agent': 'Notchy/0.1', 'Accept': 'image/*'}), timeout=8) as response:
        if urlsplit(response.url).scheme not in ('http', 'https'):
            raise ValueError('Unsupported redirect')
        if int(response.headers.get('Content-Length', '0')) > LIMIT:
            raise ValueError('Cover too large')
        data = bytearray()
        while True:
            chunk = response.read(min(65536, LIMIT + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > LIMIT or time.monotonic() - started > 15:
                raise ValueError('Cover exceeds limit')
    return bytes(data)


def decode(data):
    # Only raster types; SVG would allow an additional document/resource path.
    raster = data.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff', b'GIF87a', b'GIF89a')) or (data[:4] == b'RIFF' and data[8:12] == b'WEBP')
    if not raster or len(data) > LIMIT:
        raise ValueError('Unsupported cover image')
    loader = GdkPixbuf.PixbufLoader.new()
    dimensions = []

    def prepare(obj, width, height):
        dimensions.append((width, height))
        # Decode at display resolution, also for images with excessive dimensions.
        ratio = min(1, 512 / max(1, width, height))
        obj.set_size(max(1, int(width * ratio)), max(1, int(height * ratio)))

    loader.connect('size-prepared', prepare)
    loader.write(data)
    loader.close()
    if not dimensions or max(dimensions[0]) > 8192 or dimensions[0][0] * dimensions[0][1] > 32_000_000:
        raise ValueError('Cover dimensions exceed limit')
    pixbuf = loader.get_pixbuf()
    if not pixbuf:
        raise ValueError('Invalid cover')
    return pixbuf


def cache_cover(uri, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / (hashlib.sha256(uri.encode()).hexdigest() + '.png')
    if path.is_file() and time.time() - path.stat().st_mtime < 86400:
        return path
    pixbuf = decode(fetch(uri))
    fd, temporary = tempfile.mkstemp(prefix='.cover-', dir=directory)
    os.close(fd)
    try:
        pixbuf.savev(temporary, 'png', [], [])
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    # Keep a small private cache; never alter original local covers.
    for old in sorted(directory.glob('*.png'), key=lambda p: p.stat().st_mtime, reverse=True)[50:]:
        old.unlink(missing_ok=True)
    return path


if __name__ == '__main__':
    try:
        print(cache_cover(sys.argv[1], sys.argv[2]))
    except Exception:
        # URLs can contain temporary authentication tokens. Do not log them.
        print('cover not available', file=sys.stderr)
        sys.exit(1)
