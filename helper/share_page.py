"""The pages a phone sees when it scans Notchy's QR code (helper/share.py),
in Notchy's design: the black notch hangs from the top and names the
computer, the files are the Regal's tiles, AirDrop's radar turns while the
computer is asked, a ring fills with the bytes really sent.

Everything is inside the page — styles, symbols, one small script — so the
strict Content-Security-Policy stays and nothing is loaded from elsewhere.
Texts follow Notchy's language. Anything that comes from a file name is
escaped for HTML, and for the script as JSON with "<" escaped.
"""
import html
import json
import mimetypes
import os
from pathlib import Path
import pwd
import socket
from urllib.parse import quote

from i18n import _, language, ngettext, number

# The type label's colour on a document tile, as in the Regal.
KINDS = {'heic': 'img', 'heif': 'img', 'jpg': 'img', 'jpeg': 'img', 'png': 'img', 'webp': 'img', 'gif': 'img', 'avif': 'img',
         'pdf': 'pdf', 'zip': 'zip', 'gz': 'zip', 'xz': 'zip', '7z': 'zip', 'rar': 'zip', 'tar': 'zip',
         'mp4': 'video', 'mov': 'video', 'mkv': 'video', 'webm': 'video', 'mp3': 'audio', 'm4a': 'audio', 'flac': 'audio', 'wav': 'audio', 'ogg': 'audio'}
LAPTOPS = {8, 9, 10, 11, 14, 30, 31, 32}


def computer_name():
    """How the computer is called on the phone: its pretty hostname, else „Laptop von Matthias“."""
    try:
        for line in Path('/etc/machine-info').read_text().splitlines():
            if line.startswith('PRETTY_HOSTNAME='):
                name = line.split('=', 1)[1].strip().strip('"\'')
                if name:
                    return name[:60]
    except OSError:
        pass
    try:
        chassis = int(Path('/sys/class/dmi/id/chassis_type').read_text().strip())
    except (OSError, ValueError):
        chassis = 0
    device = _('laptop') if chassis in LAPTOPS else _('computer')
    try:
        real = pwd.getpwuid(os.getuid()).pw_gecos.split(',')[0].strip()
    except (KeyError, OSError):
        real = ''
    first = real.split()[0] if real else ''
    if not first:
        return socket.gethostname()[:60] or 'Notchy'
    # Translators: how the computer is named on the phone, e.g. „Laptop von Matthias“.
    return _("%(name)s’s %(device)s") % {'name': first, 'device': device}


def size_text(size):
    for unit, factor in (('GB', 1e9), ('MB', 1e6), ('kB', 1e3)):
        if size >= factor:
            value = size / factor
            return f'{number(value, 1 if value < 10 else 0)} {unit}'
    return f'{size} B'


def kind(name):
    extension = Path(name).suffix.lower().lstrip('.')
    return extension[:4].upper() or '—', KINDS.get(extension, 'doc')


def is_image(name):
    return (mimetypes.guess_type(name)[0] or '').startswith('image/') or Path(name).suffix.lower() in ('.heic', '.heif', '.avif')


def script_json(value):
    """JSON that is safe inside a <script> element."""
    return json.dumps(value, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


ICONS = {
    'airdrop': '<svg viewBox="0 0 24 24"><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M7.5 16.5a6.5 6.5 0 1 1 9 0"/><path d="M5 19a10 10 0 1 1 14 0"/><path d="M10 14a2.8 2.8 0 1 1 4 0"/></g><path fill="#fff" d="M12 13.5l2.6 6.5H9.4z"/></svg>',
    'check': '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'down': '<svg viewBox="0 0 24 24"><path d="M12 4v12m-5-5 5 5 5-5M5 20h14" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'laptop': '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.6" fill="none" stroke="#fff" stroke-width="2"/><path d="M2 19h20" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    'x': '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
}

STYLE = """
:root { color-scheme: dark; --blue: #3a9bff; --blue-2: #0a6ee6; --accept: #0a84ff; --green: #34c759; --tile: #161618; --line: rgba(255,255,255,.07);
  --muted: rgba(255,255,255,.55); --faint: rgba(255,255,255,.38); }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; background: #000; color: #fff; }
body { font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, "Segoe UI", system-ui, sans-serif; min-height: 100vh; padding: 0 0 calc(28px + env(safe-area-inset-bottom)); }
main { max-width: 520px; margin: 0 auto; }
.notch { margin: 0 auto; width: min(76%, 340px); min-height: 46px; border-radius: 0 0 24px 24px; background: #000; box-shadow: 0 0 0 1px rgba(255,255,255,.07);
  display: flex; align-items: center; gap: 10px; padding: calc(8px + env(safe-area-inset-top)) 16px 9px; }
.notch .badge { width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(180deg, var(--blue), var(--blue-2)); display: grid; place-items: center; flex: none; transition: background .3s; }
.notch .badge svg { width: 14px; height: 14px; }
.notch .badge.done { background: linear-gradient(180deg, var(--green), #1f9e42); } .notch .badge.off { background: rgba(255,255,255,.14); }
.notch b { font-size: 14px; display: block; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notch small { font-size: 12px; color: var(--muted); display: block; line-height: 1.25; }
.notch > div { min-width: 0; }
.surface { margin: 14px 14px 0; border-radius: 28px; padding: 16px 14px 18px; background: linear-gradient(180deg, #0b0b0d 0%, #121216 100%); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
.head { display: flex; align-items: baseline; gap: 8px; padding: 0 4px 12px; }
.head b { font-size: 17px; } .head span { font-size: 13px; color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.tiles.single { grid-template-columns: 1fr; }
.tile { text-align: center; display: block; color: inherit; text-decoration: none; position: relative; }
.tile .card { height: 112px; border-radius: 18px; background: var(--tile); box-shadow: inset 0 0 0 1px var(--line); display: grid; place-items: center; position: relative; overflow: hidden; }
.tiles.single .card { height: 240px; }
.tile .card img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.doc { width: 42px; height: 54px; border-radius: 7px; background: #2c2c30; position: relative; }
.tiles.single .doc { width: 64px; height: 82px; border-radius: 10px; }
.doc i { position: absolute; left: 50%; bottom: 7px; transform: translateX(-50%); font-style: normal; font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 4px; background: #d0d0d4; color: #1c1c1e; white-space: nowrap; }
.doc i.img { background: #6fd39a; } .doc i.pdf { background: #ff8a80; } .doc i.zip { background: #ffd27a; } .doc i.video { background: #9fc4ff; } .doc i.audio { background: #e0a8ff; }
.tile .name { font-size: 13px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; }
.tile .size { font-size: 12px; color: var(--faint); }
.mark { position: absolute; right: 8px; bottom: 8px; width: 28px; height: 28px; border-radius: 50%; background: rgba(0,0,0,.6); display: grid; place-items: center; }
.mark svg { width: 14px; height: 14px; }
.tile.loading .mark { background: rgba(0,0,0,.6); border: 2px solid rgba(255,255,255,.2); border-top-color: var(--blue); animation: spin 1s linear infinite; }
.tile.loading .mark svg { display: none; }
.tile.done .mark { background: var(--green); }
.tile.add .card { background: transparent; box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.18); font-size: 34px; font-weight: 300; color: var(--muted); }
.tile.add .name { color: var(--muted); }
.tile .remove { position: absolute; left: 8px; top: 8px; width: 24px; height: 24px; border-radius: 50%; background: rgba(0,0,0,.6); display: grid; place-items: center; border: 0; padding: 0; }
.tile .remove svg { width: 11px; height: 11px; }
.pill { display: block; width: 100%; margin-top: 16px; border: 0; border-radius: 99px; padding: 13px; font: inherit; font-weight: 700; font-size: 16px; color: #fff; background: var(--accept); text-align: center; text-decoration: none; }
.pill.quiet { background: #2c2c30; } .pill:disabled { opacity: .45; }
.hint { font-size: 12.5px; color: var(--faint); text-align: center; margin-top: 12px; }
.hero { display: grid; place-items: center; padding: 26px 0 8px; }
.radar { width: 132px; height: 132px; position: relative; display: grid; place-items: center; }
.radar .r { position: absolute; inset: 0; border-radius: 50%; border: 1.5px solid rgba(110,180,255,.75); animation: ping 1.8s ease-out infinite; opacity: 0; }
.radar .r:nth-child(2) { animation-delay: .6s; } .radar .r:nth-child(3) { animation-delay: 1.2s; }
.core { width: 68px; height: 68px; border-radius: 50%; background: linear-gradient(180deg, var(--blue), var(--blue-2)); display: grid; place-items: center; position: relative; }
.core svg { width: 30px; height: 30px; }
.core.done { background: linear-gradient(180deg, var(--green), #1f9e42); } .core.off { background: rgba(255,255,255,.14); }
.ring { width: 132px; height: 132px; position: relative; display: grid; place-items: center; }
.ring svg { position: absolute; inset: 0; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 7; stroke-linecap: round; }
.ring .value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
.big { text-align: center; font-size: 20px; font-weight: 700; margin-top: 14px; }
.small { text-align: center; font-size: 14px; color: var(--muted); margin-top: 4px; padding: 0 8px; }
.list { margin-top: 18px; display: flex; flex-direction: column; gap: 7px; }
.row { display: flex; align-items: center; gap: 11px; background: var(--tile); border-radius: 15px; padding: 9px 11px; box-shadow: inset 0 0 0 1px var(--line); }
.row .mini { width: 30px; height: 38px; border-radius: 6px; background: #2c2c30 center/cover; flex: none; }
.row > div { flex: 1; min-width: 0; } .row b { display: block; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .row small { color: var(--faint); font-size: 12px; }
.row .st { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; }
.row .st.done { background: var(--green); } .row .st.now { border: 2px solid rgba(255,255,255,.15); border-top-color: var(--blue); animation: spin 1s linear infinite; }
.row .st svg { width: 12px; height: 12px; } .row .st:not(.done) svg { display: none; }
[hidden] { display: none !important; }
@keyframes ping { 0% { transform: scale(.45); opacity: .85; } 100% { transform: scale(1); opacity: 0; } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .radar .r, .tile.loading .mark, .row .st.now { animation: none; } .radar .r { opacity: .3; } }
"""


def notch(name, subtitle, badge='airdrop', state=''):
    return (f'<header class="notch"><span class="badge {state}" id="badge">{ICONS[badge]}</span>'
            f'<div><b>{html.escape(name)}</b><small id="subtitle">{html.escape(subtitle)}</small></div></header>')


def document(body, title='Notchy', script=''):
    return f"""<!doctype html><html lang="{language()}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#000000">
<title>{html.escape(title)}</title><style>{STYLE}</style></head><body><main>{body}</main>{script}</body></html>""".encode()


def tile_card(name, preview_url=None, big=False):
    label, colour = kind(name)
    image = f'<img src="{html.escape(preview_url)}" alt="" loading="lazy" onerror="this.remove()">' if preview_url else ''
    return f'<div class="card"><div class="doc"><i class="{colour}">{html.escape(label)}</i></div>{image}<span class="mark">{ICONS["down"]}</span></div>'


def send_page(token, name, files, sizes):
    count, total = len(files), sum(sizes)
    tiles = ''.join(
        f'<a class="tile" data-index="{i}" href="/{token}/f/{i}/{html.escape(quote(f.name))}" download>'
        f'{tile_card(f.name, f"/{token}/p/{i}" if is_image(f.name) else None)}'
        f'<div class="name">{html.escape(f.name)}</div><div class="size" data-size="{html.escape(size_text(s))}">{html.escape(size_text(s))}</div></a>'
        for i, (f, s) in enumerate(zip(files, sizes)))
    single = count == 1
    head = '' if single else f'<div class="head"><b>{html.escape(_("For you"))}</b><span>{html.escape(ngettext("%d file", "%d files", count) % count)} · {html.escape(size_text(total))}</span></div>'
    extra = '' if single else f'<a class="pill" id="all" href="/{token}/all.zip" download>{html.escape(_("Download All (ZIP)"))}</a>'
    body = (notch(name, ngettext('shares %d file', 'shares %d files', count) % count)
            + f'<section class="surface">{head}<div class="tiles{" single" if single else ""}">{tiles}</div>{extra}'
            + f'<div class="hint" id="hint">{html.escape(_("Valid while the banner on the computer is open"))}</div></section>')
    texts = {'sent': _('transferred'), 'look': _('Transferred – look in your phone’s downloads.')}
    script = f"""<script>
const T = {script_json(texts)}, base = '/{token}';
const tiles = [...document.querySelectorAll('.tile')], waiting = new Set();
let timer = 0;
const mark = done => {{ for (const [i, tile] of tiles.entries()) if (done[i]) {{ tile.classList.remove('loading'); tile.classList.add('done');
  tile.querySelector('.mark').innerHTML = {script_json(ICONS['check'])}; const size = tile.querySelector('.size'); size.textContent = size.dataset.size + ' · ' + T.sent; waiting.delete(i); }}
  if (tiles.length === 1 && done[0]) document.getElementById('hint').textContent = T.look; }};
// What Notchy has delivered, asked only while a download runs.
const poll = async () => {{
  timer = 0;
  try {{ const r = await fetch(base + '/state', {{cache: 'no-store'}}); mark((await r.json()).delivered); }} catch {{ return; }}
  if (waiting.size) timer = setTimeout(poll, 1500);
}};
const start = indexes => {{ for (const i of indexes) {{ if (tiles[i].classList.contains('done')) continue; tiles[i].classList.add('loading'); waiting.add(i); }} if (!timer) timer = setTimeout(poll, 1200); }};
tiles.forEach((tile, i) => tile.addEventListener('click', () => start([i])));
document.getElementById('all')?.addEventListener('click', () => start(tiles.map((_t, i) => i)));
</script>"""
    return document(body, name, script)


def gone_page(name):
    body = (notch(name, _('Link expired'), 'laptop', 'off')
            + f'<section class="surface"><div class="hero"><div class="core off">{ICONS["x"]}</div></div>'
            + f'<div class="big">{html.escape(_("This link is no longer valid"))}</div>'
            + f'<div class="small">{html.escape(_("The banner on the computer was closed. Scan the new code."))}</div></section>')
    return document(body, name)


def receive_page(token, name):
    texts = {
        'accepts': _('accepts files'), 'asking': _('is asking'), 'receiving': _('is receiving'), 'declined': _('declined'),
        'chosen1': _('%d chosen'), 'more': _('Choose more'), 'choose': _('Choose photos or files'),
        'sending': _('Sending…'), 'of': _('%1$s of %2$s'), 'sent': _('Sent'), 'failed': _('Sending failed.'),
        'declinedBig': _('Declined'), 'declinedSmall': _('“Decline” was chosen on the computer – or nobody answered.'),
        'retry': _('Try Again'), 'again': _('Send More'),
        'has1': ngettext('has %d file', 'has %d files', 1), 'hasN': ngettext('has %d file', 'has %d files', 2),
        'shelf1': ngettext('%d file is in the Shelf now', '%d files are in the Shelf now', 1), 'shelfN': ngettext('%d file is in the Shelf now', '%d files are in the Shelf now', 2),
        'files1': ngettext('%d file', '%d files', 1), 'filesN': ngettext('%d file', '%d files', 2),
    }
    body = f"""{notch(name, texts['accepts'], 'laptop')}
<section class="surface" id="pick">
  <div class="head"><b>{html.escape(_('To the computer'))}</b><span id="count"></span></div>
  <div class="tiles" id="tiles"><label class="tile add" id="add"><input type="file" multiple hidden id="input"><div class="card">＋</div><div class="name" id="addName">{html.escape(texts['choose'])}</div></label></div>
  <button class="pill" id="send" disabled>{html.escape(_('Send'))}</button>
  <div class="hint">{html.escape(_('The computer asks before it takes anything'))}</div>
</section>
<section class="surface" id="wait" hidden>
  <div class="hero"><div class="radar"><span class="r"></span><span class="r"></span><span class="r"></span><div class="core">{ICONS['airdrop']}</div></div></div>
  <div class="big">{html.escape(_('Waiting for “Accept”'))}</div><div class="small" id="waitSmall"></div>
  <div class="hint">{html.escape(_('The question appears in the computer’s notch'))}</div>
</section>
<section class="surface" id="run" hidden>
  <div class="hero"><div class="ring"><svg viewBox="0 0 132 132" width="132" height="132"><circle cx="66" cy="66" r="60" stroke="rgba(255,255,255,.13)"/><circle id="arc" cx="66" cy="66" r="60" stroke="#3a9bff" stroke-dasharray="0 377"/></svg><span class="value" id="percent">0 %</span></div></div>
  <div class="big" id="runBig">{html.escape(texts['sending'])}</div><div class="small" id="runSmall"></div>
  <div class="list" id="list"></div>
</section>
<section class="surface" id="end" hidden>
  <div class="hero"><div class="core" id="endCore"></div></div>
  <div class="big" id="endBig"></div><div class="small" id="endSmall"></div>
  <button class="pill quiet" id="again"></button>
</section>"""
    script = f"""<script>
const T = {script_json(texts)}, base = '/{token}', lang = {script_json(language())};
const icons = {script_json(ICONS)};
const $ = id => document.getElementById(id);
const fmt = (text, ...values) => {{ let n = 0; return text.replace(/%(\\d\\$)?[sd]/g, (_m, pos) => String(values[pos ? Number(pos[0]) - 1 : n++])); }};
const plural = (one, many, n) => fmt(n === 1 ? one : many, n);
const number = value => new Intl.NumberFormat(lang, {{maximumFractionDigits: value < 10 ? 1 : 0}}).format(value);
const size = bytes => {{ for (const [unit, f] of [['GB', 1e9], ['MB', 1e6], ['kB', 1e3]]) if (bytes >= f) return `${{number(bytes / f)}} ${{unit}}`; return `${{bytes}} B`; }};
const percent = value => new Intl.NumberFormat(lang, {{style: 'percent'}}).format(value);
const kinds = {script_json(KINDS)};
let files = [];
const show = id => {{ for (const s of ['pick', 'wait', 'run', 'end']) $(s).hidden = s !== id; }};
const notch = (subtitle, badge, state = '') => {{ $('subtitle').textContent = subtitle; $('badge').className = 'badge ' + state; $('badge').innerHTML = icons[badge]; }};
const card = file => {{
  const ext = (file.name.split('.').pop() || '').toLowerCase(), card = document.createElement('div'), doc = document.createElement('div'), label = document.createElement('i');
  card.className = 'card'; doc.className = 'doc'; label.className = kinds[ext] || 'doc'; label.textContent = file.name.includes('.') ? ext.slice(0, 4).toUpperCase() : '—';
  doc.append(label); card.append(doc);
  if (file.type.startsWith('image/')) {{ const img = document.createElement('img'); img.alt = ''; img.src = URL.createObjectURL(file); img.onerror = () => img.remove(); card.append(img); }}
  return card;
}};
const draw = () => {{
  const tiles = $('tiles'), add = $('add');
  for (const t of [...tiles.children]) if (t !== add) t.remove();
  files.forEach((file, i) => {{
    const tile = document.createElement('div'); tile.className = 'tile';
    const remove = document.createElement('button'); remove.className = 'remove'; remove.innerHTML = icons.x; remove.setAttribute('aria-label', '×');
    remove.onclick = () => {{ files.splice(i, 1); draw(); }};
    const name = document.createElement('div'), small = document.createElement('div'); name.className = 'name'; small.className = 'size';
    name.textContent = file.name; small.textContent = size(file.size);
    const c = card(file); c.append(remove); tile.append(c, name, small); tiles.insertBefore(tile, add);
  }});
  $('addName').textContent = files.length ? T.more : T.choose;
  $('count').textContent = files.length ? `${{fmt(T.chosen1, files.length)}} · ${{size(files.reduce((n, f) => n + f.size, 0))}}` : '';
  $('send').disabled = !files.length;
}};
$('input').onchange = () => {{ files.push(...$('input').files); $('input').value = ''; draw(); }};
const end = (ok, count) => {{
  show('end');
  $('endCore').className = 'core ' + (ok ? 'done' : 'off'); $('endCore').innerHTML = ok ? icons.check : icons.x;
  if (ok) {{ notch(plural(T.has1, T.hasN, count), 'check', 'done'); $('endBig').textContent = T.sent; $('endSmall').textContent = plural(T.shelf1, T.shelfN, count); $('again').textContent = T.again; }}
  else {{ notch(T.declined, 'laptop', 'off'); $('endBig').textContent = T.declinedBig; $('endSmall').textContent = T.declinedSmall; $('again').textContent = T.retry; }}
}};
const failed = () => {{ show('end'); notch(T.accepts, 'laptop', 'off'); $('endCore').className = 'core off'; $('endCore').innerHTML = icons.x; $('endBig').textContent = T.failed; $('endSmall').textContent = ''; $('again').textContent = T.retry; }};
$('again').onclick = () => {{ if ($('endCore').classList.contains('done')) files = []; draw(); notch(T.accepts, 'laptop'); show('pick'); }};
$('send').onclick = async () => {{
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.size, 0);
  show('wait'); notch(T.asking, 'laptop'); $('waitSmall').textContent = `${{plural(T.files1, T.filesN, files.length)}} · ${{size(total)}}`;
  let answer;
  try {{ const r = await fetch(base + '/ask', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({{files: files.map(f => ({{name: f.name, size: f.size}}))}})}}); answer = await r.json(); }}
  catch {{ failed(); return; }}
  if (!answer.ok) {{ end(false, 0); return; }}
  show('run'); notch(T.receiving, 'laptop');
  const list = $('list'); list.replaceChildren();
  const rows = files.map(file => {{
    const row = document.createElement('div'), mini = document.createElement('span'), text = document.createElement('div'), b = document.createElement('b'), small = document.createElement('small'), st = document.createElement('span');
    row.className = 'row'; mini.className = 'mini'; if (file.type.startsWith('image/')) mini.style.backgroundImage = `url("${{URL.createObjectURL(file)}}")`;
    b.textContent = file.name; small.textContent = size(file.size); st.className = 'st'; st.innerHTML = icons.check;
    text.append(b, small); row.append(mini, text, st); list.append(row); return st;
  }});
  let done = 0;
  const progress = loaded => {{ const value = Math.min(1, (done + loaded) / Math.max(1, total)); $('arc').setAttribute('stroke-dasharray', `${{(value * 377).toFixed(1)}} 377`);
    $('percent').textContent = percent(value); $('runSmall').textContent = fmt(T.of, size(done + loaded), size(total)); }};
  progress(0);
  for (const [i, file] of files.entries()) {{
    rows[i].className = 'st now';
    const ok = await new Promise(resolve => {{
      const x = new XMLHttpRequest(); x.open('PUT', `${{base}}/up/${{answer.ticket}}/${{i}}`);
      x.upload.onprogress = e => progress(e.loaded);
      x.onload = () => resolve(x.status === 200); x.onerror = () => resolve(false); x.send(file);
    }});
    if (!ok) {{ failed(); return; }}
    done += file.size; rows[i].className = 'st done'; progress(0);
  }}
  end(true, files.length);
}};
draw();
</script>"""
    return document(body, name, script)

