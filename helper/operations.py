#!/usr/bin/python3
"""Local file actions. Never interpolate paths into a shell command."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from urllib.parse import urlparse, unquote
import zipfile


def local_path(uri):
    parsed = urlparse(uri)
    if parsed.scheme != 'file' or parsed.netloc not in ('', 'localhost'):
        raise ValueError('Nur lokale Dateien werden unterstützt.')
    path = Path(unquote(parsed.path))
    if not path.exists():
        raise ValueError('Die Quelldatei existiert nicht mehr.')
    return path


def executable(*names):
    for name in names:
        if command := shutil.which(name):
            return command
    raise ValueError('Benötigtes Programm fehlt: ' + ' / '.join(names))


active_process = None


def terminate(*_):
    if active_process and active_process.poll() is None:
        try:
            os.killpg(active_process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    sys.exit(143)


def execute(args, timeout=600):
    global active_process
    active_process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, start_new_session=True)
    try:
        stdout, stderr = active_process.communicate(timeout=timeout)
        if active_process.returncode:
            raise ValueError(stderr[-600:] or 'Dateiverarbeitung fehlgeschlagen.')
        return stdout
    finally:
        if active_process.poll() is None:
            os.killpg(active_process.pid, signal.SIGKILL)
            active_process.wait()
        active_process = None


def output_path(source, suffix):
    directory = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'notchy' / 'exports'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=source.stem[:80] + '-', suffix=suffix, dir=directory)
    os.close(descriptor)
    return Path(name)


def add_to_zip(archive, source):
    # No symlink following, no recursion into a linked directory.
    if source.is_dir():
        for root, dirs, files in os.walk(source, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(root) / name).is_symlink()]
            for name in files:
                path = Path(root) / name
                if not path.is_symlink():
                    archive.write(path, Path(source.name) / path.relative_to(source))
    elif not source.is_symlink():
        archive.write(source, source.name)


def process(action, uri, option=''):
    source = local_path(uri)
    destination = None
    if action == 'zip-many':
        # One archive for a Regal selection; duplicate names get a counter.
        sources = [local_path(item) for item in json.loads(option)][:200]
        if not sources:
            raise ValueError('Keine Dateien ausgewählt.')
        destination = output_path(Path('Archiv'), '.zip')
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for item in sources:
                add_to_zip(archive, item)
        return {'uri': destination.as_uri(), 'message': f'{len(sources)} Dateien gepackt · {destination.name} im Regal'}
    if action == 'copy':
        destination = output_path(source, source.suffix)
        shutil.copyfile(source, destination)
    elif action == 'zip':
        destination = output_path(source, '.zip')
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            add_to_zip(archive, source)
    elif action == 'image':
        if option not in ('png', 'jpg', 'webp', 'tiff', 'bmp', 'gif'):
            raise ValueError('Nicht unterstütztes Bildformat.')
        destination = output_path(source, '.' + option)
        execute([executable('magick', 'convert'), str(source), str(destination)])
    elif action == 'pdf-compress':
        destination = output_path(source, '.pdf')
        execute([executable('gs'), '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook',
                 '-dNOPAUSE', '-dBATCH', '-dSAFER', f'-sOutputFile={destination}', str(source)])
    elif action == 'document-pdf':
        destination = output_path(source, '.pdf')
        with tempfile.TemporaryDirectory(prefix='notchy-office-') as temp:
            profile = Path(temp, 'profile').as_uri()
            execute([executable('libreoffice'), '-env:UserInstallation=' + profile, '--headless',
                     '--convert-to', 'pdf', '--outdir', temp, str(source)])
            result = Path(temp, source.stem + '.pdf')
            if not result.exists():
                raise ValueError('LibreOffice hat keine PDF-Datei erzeugt.')
            shutil.copyfile(result, destination)
    elif action == 'ocr':
        text = execute([executable('tesseract'), str(source), 'stdout'])
        return {'text': text.strip(), 'message': 'Erkannter Text wurde kopiert.'}
    elif action == 'background':
        destination = output_path(source, '.png')
        execute([executable('rembg'), 'i', str(source), str(destination)])
    elif action == 'video':
        try:
            mb = int(option)
        except ValueError:
            raise ValueError('Ungültige Zielgröße.') from None
        if not 1 <= mb <= 2000:
            raise ValueError('Zielgröße muss zwischen 1 und 2000 MB liegen.')
        duration = float(execute([executable('ffprobe'), '-v', 'error', '-show_entries',
                                 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(source)]))
        if duration <= 0:
            raise ValueError('Videolänge ist ungültig.')
        # Two-pass encoding, reserve container overhead and audio budget.
        bitrate = int(mb * 1024 * 1024 * 8 * .96 / duration - 128000)
        if bitrate < 32000:
            raise ValueError('Zielgröße ist zu klein für diese Videolänge.')
        destination = output_path(source, '.mp4')
        with tempfile.TemporaryDirectory(prefix='notchy-ffmpeg-') as temp:
            args = [executable('ffmpeg'), '-nostdin', '-y', '-i', str(source), '-c:v', 'libx264',
                    '-b:v', str(bitrate), '-passlogfile', str(Path(temp, 'pass'))]
            execute(args + ['-pass', '1', '-an', '-f', 'null', '/dev/null'], timeout=3600)
            execute(args + ['-pass', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(destination)], timeout=3600)
        return {'uri': destination.as_uri(), 'message': f'Video komprimiert ({destination.stat().st_size / 1048576:.1f} MB). Die Zielgröße ist eine Näherung.'}
    else:
        raise ValueError('Unbekannte Aktion.')
    return {'uri': destination.as_uri(), 'message': f'Erstellt: {destination.name}'}


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        print(json.dumps(process(*sys.argv[1:4]), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
