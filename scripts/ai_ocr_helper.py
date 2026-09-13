#!/usr/bin/env python3
"""
AI transcription helper for Incremental RemNote PDF highlights (prototype).

A RemNote plugin runs in a sandboxed iframe and cannot start programs, so it
POSTs a highlight's geometry here. This helper renders exactly that region of
the PDF, hands the image to the user's own `claude` CLI (their subscription —
no API key involved) and returns KaTeX/markdown-ish markup for the plugin to
write back as rich text.

    python3 scripts/ai_ocr_helper.py          # listens on 127.0.0.1:3457

Requires PyMuPDF (`pip install pymupdf`) and a logged-in `claude` CLI.

Environment:
    IR_AI_PORT      port (default 3457)
    IR_AI_MODEL     claude model alias (default sonnet)
    IR_AI_ORIGINS   comma-separated allowed Origin headers; unset = allow all
                    (and log each Origin so it can be pinned)

Files live in ~/.incremental-remnote/ai-ocr/:
    prompt.md       the transcription instructions — edit freely, re-read per request
    requests.log    one JSON line per request (includes the raw highlight Data)
    crops/          the last image sent for each highlight
    pdf-cache/      downloaded PDFs
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pymupdf

PORT = int(os.environ.get('IR_AI_PORT', '3457'))
MODEL = os.environ.get('IR_AI_MODEL', 'sonnet')
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get('IR_AI_ORIGINS', '').split(',') if o.strip()}

HOME = Path.home() / '.incremental-remnote' / 'ai-ocr'
PDF_CACHE = HOME / 'pdf-cache'
CROPS = HOME / 'crops'
LOG = HOME / 'requests.log'
PROMPT_FILE = HOME / 'prompt.md'

DPI = 220
# PDF points of margin around the highlight box. Vertical is larger: a line's
# selection box stops at the text baseline area, while fraction denominators and
# subscripts of display formulae hang below it.
PAD_X, PAD_Y = 6, 14

DEFAULT_PROMPT = r"""Extract text from the images I provide. Do not acknowledge the request, do not comment, and do not ask questions: output the extracted text and nothing else.

The output goes into a single RemNote rem. Never break lines inside a paragraph; separate paragraphs, and set each display formula apart, with one blank line.

Formulae, in KaTeX:
- inline (inside a sentence): $x$
- display (on its own line in the image): $$x$$
- numbered equations use \tag with the number shown in the image
- ALWAYS write a formula containing \tag as display ($$...$$). KaTeX renders \tag only in display mode; written inline it fails and shows the raw source in red.
- words inside formulae are enclosed in \text{} for better rendering.

Emphasise keywords and key concepts or ideas (if you find them) using **bold** or *italic*. Use no other markup: no headings, no list syntax, no code.

If part of the image is illegible, transcribe what you can and mark the gap inline as [illegible].
"""


def log(entry):
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def prompt():
    if not PROMPT_FILE.exists():
        PROMPT_FILE.write_text(DEFAULT_PROMPT)
    return PROMPT_FILE.read_text()


def find_claude():
    # launchd and GUI launches carry a minimal PATH, so check the usual install spots too.
    found = shutil.which('claude')
    for candidate in [found, Path.home() / '.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


LOCAL_FILE = '%LOCAL_FILE%'
REMNOTE_FILES_URL = 'https://remnote-user-data.s3.amazonaws.com/'
REMNOTE_DATA = Path.home() / 'remnote'


def fetch(url, suffix):
    """Local path for a file:// URL, else a cached download. The cache key drops
    the query string so re-signed URLs for the same file hit the cache.

    RemNote stores uploads as `%LOCAL_FILE%<name>`, a placeholder for its S3
    prefix; the desktop app keeps the file itself in ~/remnote/remnote-<kb>/files/."""
    if url.startswith(LOCAL_FILE):
        name = url[len(LOCAL_FILE):]
        for local in REMNOTE_DATA.glob(f'remnote-*/files/{name}'):
            return local
        url = REMNOTE_FILES_URL + name
    if url.startswith('file://'):
        return Path(urllib.parse.unquote(urllib.parse.urlsplit(url).path))
    parts = urllib.parse.urlsplit(url)
    key = hashlib.sha1(f'{parts.netloc}{parts.path}'.encode()).hexdigest()
    path = PDF_CACHE / f'{key}{suffix}'
    if not path.exists():
        tmp = path.with_suffix('.part')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, 'wb') as out:
            shutil.copyfileobj(resp, out)
        tmp.rename(path)
    return path


def page_boxes(data):
    """Highlight Data -> [(pageNumber, (x1, y1, x2, y2) as page fractions)].

    RemNote stores each rect in the coordinates of a page viewport whose size is
    saved alongside it (width/height), so dividing by that size gives fractions
    that are independent of the zoom the highlight was made at. `rects` holds one
    box per line and may span pages; `boundingRect` is the fallback."""
    pos = data.get('position') or {}
    rects = [r for r in (pos.get('rects') or []) if r] or [pos.get('boundingRect')]
    boxes = {}
    for r in rects:
        if not r:
            continue
        page = r.get('pageNumber') or pos.get('pageNumber')
        w, h = r.get('width'), r.get('height')
        if not page or not w or not h:
            continue
        box = (r['x1'] / w, r['y1'] / h, r['x2'] / w, r['y2'] / h)
        prev = boxes.get(page)
        boxes[page] = box if not prev else (
            min(prev[0], box[0]), min(prev[1], box[1]), max(prev[2], box[2]), max(prev[3], box[3]))
    return sorted(boxes.items())


def render_crops(pdf_path, boxes, rem_id):
    doc = pymupdf.open(pdf_path)
    images = []
    for page_number, (fx1, fy1, fx2, fy2) in boxes:
        page = doc[page_number - 1]
        size = page.rect
        clip = pymupdf.Rect(fx1 * size.width - PAD_X, fy1 * size.height - PAD_Y,
                            fx2 * size.width + PAD_X, fy2 * size.height + PAD_Y) & size
        png = page.get_pixmap(clip=clip, dpi=DPI).tobytes('png')
        (CROPS / f'{rem_id}-p{page_number}.png').write_bytes(png)
        images.append(png)
    return images


def transcribe(images, raw_text):
    content = [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png',
                                            'data': base64.b64encode(img).decode()}} for img in images]
    if raw_text.strip():
        instruction = (
            'The image shows the region of a PDF page around one highlight. The PDF viewer extracted '
            'this text for the highlight — its spacing and formulae are garbled, but its words mark '
            'exactly where the highlight starts and ends:\n<raw>\n' + raw_text.strip() + '\n</raw>\n'
            'Transcribe only that passage: drop anything in the image before its first words or after its last words.')
    else:
        instruction = 'Transcribe the image.'
    content.append({'type': 'text', 'text': instruction})
    message = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}})

    claude = find_claude()
    if not claude:
        raise RuntimeError('claude CLI not found')
    # No --bare: it only accepts ANTHROPIC_API_KEY, never the subscription login.
    # Instead strip everything a transcription does not need: tools, MCP servers,
    # settings files (and so hooks) and session persistence.
    cmd = [claude, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
           '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
           '--model', MODEL, '--system-prompt', prompt()]
    proc = subprocess.run(cmd, input=message + '\n', capture_output=True, text=True, timeout=240, cwd=HOME)
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get('type') == 'result':
            if event.get('is_error'):
                raise RuntimeError(event.get('result') or 'claude reported an error')
            return event.get('result', '').strip()
    raise RuntimeError(f'claude exited {proc.returncode}: {proc.stderr.strip()[-400:]}')


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Chromium's Private Network Access preflight for requests into localhost.
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        if self.path == '/':
            return self.send_json(200, {'ok': True, 'claude': find_claude(), 'model': MODEL})
        self.send_json(404, {'ok': False, 'error': 'POST /ocr'})

    def do_POST(self):
        if self.path != '/ocr':
            return self.send_json(404, {'ok': False, 'error': 'POST /ocr'})
        origin = self.headers.get('Origin')
        if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
            log({'at': time.time(), 'origin': origin, 'rejected': True})
            return self.send_json(403, {'ok': False, 'error': f'origin not allowed: {origin}'})

        started = time.time()
        entry = {'at': started, 'origin': origin}
        try:
            req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            rem_id = req.get('remId') or 'unknown'
            data = req.get('data')
            data = json.loads(data) if isinstance(data, str) else (data or {})
            raw_text = req.get('rawText') or ''
            entry.update(remId=rem_id, pdfUrl=req.get('pdfUrl'), data=data, rawText=raw_text[:300])

            image_url = (data.get('content') or {}).get('imageUrl')
            if image_url:
                # Area highlight: RemNote already stored the snapshot.
                images = [fetch(image_url, '.img').read_bytes()]
                raw_text = ''
            else:
                boxes = page_boxes(data)
                if not boxes:
                    raise RuntimeError('highlight Data has no usable position')
                if not req.get('pdfUrl'):
                    raise RuntimeError('no PDF URL')
                images = render_crops(fetch(req['pdfUrl'], '.pdf'), boxes, rem_id)
                entry['boxes'] = boxes

            markup = transcribe(images, raw_text)
            ms = int((time.time() - started) * 1000)
            entry.update(ok=True, ms=ms, markup=markup)
            print(f'[ai-ocr] {rem_id} ok in {ms} ms', flush=True)
            self.send_json(200, {'ok': True, 'markup': markup, 'ms': ms})
        except Exception as e:  # noqa: BLE001 — every failure goes back to the plugin as a toast
            entry.update(ok=False, error=str(e))
            print(f'[ai-ocr] error: {e}', file=sys.stderr, flush=True)
            self.send_json(500, {'ok': False, 'error': str(e)})
        finally:
            log(entry)

    def log_message(self, *args):
        pass


def main():
    for d in (HOME, PDF_CACHE, CROPS):
        d.mkdir(parents=True, exist_ok=True)
    prompt()
    print(f'AI OCR helper on http://127.0.0.1:{PORT}  (claude: {find_claude()}, model: {MODEL})', flush=True)
    print(f'Prompt: {PROMPT_FILE}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
