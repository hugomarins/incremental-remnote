# AI Study Tools — plan and status

Maintainer notes, not published (the docs site is built from `docs/` only).

**Goal:** point the plugin at part of a source — pages, a chapter, the current IncRem's range, a web article — pick a prompt, and get summaries or Q&A written into RemNote with **source pins** to the exact passages, reviewed before anything is inserted.

## Done

| Piece | Where | Docs |
|---|---|---|
| Local helper (`scripts/ai_ocr_helper.py`, LaunchAgent) running `claude -p` on the user's subscription | helper `/ocr` | [AI Transcription](../docs/AI-Transcription-of-PDF-Highlights.md) |
| ✨ AI Transcribe for PDF highlights | `src/lib/ai_ocr.ts`, toolbar button, `ait` | same |
| Plugin-made PDF and HTML highlights | `src/lib/pdf_highlight_create.ts` | — |
| Source pins: find a quote, reuse or create highlights, never overlapping | helper `/locate`, `/source`, `/match`; `src/lib/pdf_source_pins/` | [Source Pins](../docs/Source-Pins.md) |
| Pin Source Quote (`psq`) for PDF page view, saved web articles, PDF Text Reader view (asks which view) | `pdf_source_pins/index.ts`, `pin_source_views_popup.tsx` | same |
| Source Highlight Colour setting; pin rings yellow (PDF page) / purple (HTML source) | `settings.ts`, `ui_helpers.ts` | same, [Colour Coding](../docs/Colour-Coding-Reference.md#reference-pin-rings) |
| Message dialog for failures (toasts can be swallowed) | `src/lib/message_dialog.ts`, `message_popup.tsx` | — |
| Create IncRem: Also Pin the Other PDF View (setting, off by default), tags `pdfextract` | `highlightActions.ts` (`pinOtherReaderView`) | [Source Pins](../docs/Source-Pins.md#create-increm-both-views) |

Entry point for every later phase: `ensureSourcePins(plugin, sourceRemId, quotes, views?)` — takes verbatim quotes (with an optional page hint for PDFs) and returns the highlight ids to pin, per quote and per view. `withPins(richText, ids)` appends them without duplicates.

## Decisions already made

- **Overlap rule:** highlights never overlap. Quote inside a highlight → reuse; ≥60 % covered → reuse only; partial → reuse + create uncovered stretches of ≥4 words; none → create.
- **Recipes** live in the RemNote document **AI Tutor Commands** (each child = name, its child = prompt body); the output type is marked **by tag** (Sentences / Q&A / Free).
- **Q&A:** question on the front, answer on the back, **pin on the back** (a pin's hover preview would reveal the answer on the front).
- **Colour:** one Source Highlight Colour for every view; pin rings distinguish PDF page from HTML source.
- **Review step always**, RemNote-flashcard-generator style: a checkbox per item, **Insert selected** and **Insert all**.
- **Text only by default**, with a **vision** switch (page images) for formula-heavy chapters.
- Popups are keyboard-driven (house pattern); failures go to the message dialog, success to a toast.

## Remaining

### Phase 2 — AI engine

- [ ] Helper `/extract`: a PDF page range as per-page text, and the PDF outline (`doc.get_toc()` — chapters and sections with their pages). HTML sources already have their text via `/source` + `parseArticle`.
- [ ] Helper `/run`: recipe prompt + source text → `claude -p --output-format json`. The plugin appends a fixed contract to the user's prompt: at most N items, most important first; every item cites 1–2 sentences **copied verbatim** from the given text, with the page; allowed markup (`**bold**`, `*italic*`, `$…$`, `$$…$$`); answer as JSON `{"items":[{"front","back","sources":[{"page","quote"}]}]}`. Validate; one retry on malformed JSON.
- [ ] Read recipes from **AI Tutor Commands** in the plugin, with their tag-based type.
- [ ] **Thin slice first:** one command that runs a recipe on the current IncRem's page range and inserts every item with pins, no review UI — to judge output quality on real books before building phase 3.

### Phase 3 — Popup, review, insert (Sentences)

- [ ] Popup: scope (page range / outline section / current IncRem range / whole article), recipe, max items, destination (reuse the hierarchical parent selector), vision switch.
- [ ] Progress and cancel for long runs.
- [ ] Review list: checkbox per item, editable text, source quote under each, Insert selected / Insert all.
- [ ] Insert Sentences: one Rem per item, markup → rich text (`convertRichText`), pins from one batched `ensureSourcePins` call. Quotes that cannot be located: ask the model once to correct them, else insert without a pin and flag the item.

### Phase 4 — Q&A and queue integration

- [ ] Q&A insert: `setText(front)` + `setBackText(back + pins)`.
- [ ] Default scope from the IncRem under review (queue and Editor Review).
- [ ] Vision mode: send page images (helper already renders crops for `/ocr`).

### Phase 5 — Docs

- [ ] Changelog entry, feature page, settings/commands references (per `DOCUMENTATION.md`), version bump.

### Phase A — Read aloud (audio of a document)

**Goal:** a command reads the focused Rem and its descendants, in tree order, turns them into a spoken script (verbatim, lightly adapted, or summarised), makes the audio with a TTS API and puts it into RemNote as a playable, stored audio Rem.

Decisions (2026-11-13):

- **Lives in IE**, not a separate plugin: it reuses the audio storage door (`localize_media.ts`, the `audio` bridge op), the Local Media Bridge connection, and this plan's scope → recipe → review → insert pipeline.
- **Hidden without the helper:** the command is registered only while the **Local Media Bridge** setting is on, and so is **Upscale image with ChatGPT** (both need the helper; users without it should not see them).
- **Split of work** (same as Upscale): the plugin reads the tree, applies the reading rules, shows the popup and inserts; the helper (`/tts`, `scripts/media_bridge/tts.py`) calls the TTS APIs, joins the parts into a mono mp3 (ffmpeg), serves it for the import door and keeps a copy. API keys stay in a local `.env` read by the helper, never in plugin settings (those are synced in plain text, account-wide).
- **Engines** (chosen by ear on mixed English/Portuguese notes): Gemini TTS, one call per language block (`speechConfig.languageCode` takes one code), voice drawn from an approved list; Azure `en-US-AndrewMultilingualNeural`, one `<voice>` per language run, when the script has ≥ 3 inline foreign terms (only Azure switches language mid-sentence). ElevenLabs and macOS `say` were rejected. No style instructions in the text (Gemini reads them aloud).
- **Engine choice is the user's:** `/tts/plan` lists every engine (available = its keys are in the helper's `.env`, voices, its own estimate, and how it treats the marks) and the one it suggests (Azure from 3 marked terms, else Gemini, among the available ones). The popup preselects the suggestion, lists the others (unavailable ones greyed, "no key"), and re-plans on a change. The script keeps its `<en>`/`<pt>` marks whatever the engine: Azure switches language on them; Gemini drops them and reads the term in the line's language, which the popup says.
- **Modes** (popup choice): **Literal** (reading rules only, no LLM), **Adapted** (a cheap LLM pass that only puts formulas into words, spells units out and marks foreign terms; no content change), **Summary** (an LLM writes the script).
- **Summary:**
  - a **maximum duration** field (minutes); the prompt gets a word budget at ~150 words per minute, and the estimate is shown before generating;
  - an **additional instructions** text field, shown only when Summary is selected (e.g. "focus on the definitions", "end with a 3-question quiz"), appended to the summary prompt;
  - the **summary text is inserted too** (popup option, default on), as children of the audio Rem, the first one saying it is an AI summary of the document;
  - LLM: `claude -p` through the AI helper (`/run`, subscription, no per-call charge); when it fails for usage limits, the helper falls back to the Anthropic API with `ANTHROPIC_API_KEY` from its `.env` (about US$0.05–0.10 per note).
- **Review before paying:** the popup shows the editable script, engine, voice, estimated duration and cost; nothing is synthesised until **Generate**. Above ~12 min it suggests Summary.
- **Placement:** the audio Rem is the first child of the read Rem, caption `🔊 Audio (<voice>)`; an optional setting names a tag to put on it (the author uses `AI audio`).

Reading rules (Literal mode; the other modes start from the same text):

| Element | Rule |
|---|---|
| Tree | Depth-first, collapsed children included. A heading is read as a section title with a pause after it. |
| Powerup property Rems (Next Rep Date, Priority…), tags, source links, the 🤖 marker | Skip. |
| Images, audio, video, drawings, embeds | Skip silently. Tables and code: skip, or say “table omitted”. |
| Existing `🔊 Audio` Rems | Never read (no audio of an audio). |
| Rem references | Read the text the reference shows (the alias, when it points at one). |
| Pins (📌 references to highlights) | Skip. |
| Portals | Read once. |
| Bold / italic | Formatting dropped. **Italic words in the other language become inline language marks** (the author italicises foreign terms), which also drives the Azure switch. |
| Cards | `front :: back` read as “front — back”; cloze read whole; optional quiz style (front, pause, back). |
| LaTeX, units | Without an LLM: units from a dictionary (kN ⇒ kilonewtons); a formula is skipped with “formula omitted”. |
| Language | Per Rem (stopword heuristic), with the same marks the script format uses. |

Script format (shared with the author's `/audio-to-remnote` skill, parsed by `tts.py`): plain text, one idea per line; `[pt]`/`[en]` line prefix for the line's language; `<pt>…</pt>`/`<en>…</en>` around foreign **terms** only (names and acronyms never); `[pause]`/`[pausa]` alone on a line = answer gap before the next line (max(5 s, 2 s + 0.5 s per word)), `[pause N]` fixes N s.

- [x] **A1. Helper `/tts`** (helper v8; v9: `/tts/plan` lists the engines and the suggestion): `tts.py` (script parser and checker, engine choice, Gemini/Azure calls with 429 backoff, mp3 assembly; importable and a CLI), `POST /tts/plan` (free: errors, engine, calls, characters, estimated duration and cost), `POST /tts` → task, `GET /tts/<id>` (stage, result with the served mp3 URL). Keys from the environment or the `envFile` named in `~/.remnote-media-bridge/tts.json`; copies kept in its `audioHome` as `<short-subject>_<remId>.txt/.mp3`.
- [x] **A2. Plugin, Literal mode** (tested 2026-11-13: `lib/read_aloud_script.ts` + test, `lib/read_aloud.ts`, `widgets/read_aloud_popup.tsx`, `register/media_bridge_commands.ts`, setting `read-aloud-tag`): “Read aloud” command (hidden without the bridge; Upscale hidden the same way), tree → script with the rules above, popup (editable script, plan from `/tts/plan`, Generate), insert through the `audio` op code path, optional tag setting.
- [ ] **A3. Adapted and Summary modes** through `/run` (`claude -p`, API fallback), maximum duration field, summary text inserted under the audio Rem.
- [ ] **A4. Docs** (feature page, settings, changelog) when A2 ships.
- [ ] Later, maybe: a helper-free mode (plugin calls the APIs itself) for users without the helper — needs a way to get a `data:`/`blob:` audio through the import door, untested.

## Risks and open questions

- **LLM reliability:** verbatim quotes and valid JSON are not guaranteed. Mitigated by locating every quote (fuzzy matcher, whole-document fallback) and validation — quality only becomes visible on real books.
- **Long scopes:** time and usage for a 30–50 page chapter via `claude -p` are unmeasured; may need chunking by section.
- **Text layers:** scanned PDFs have none (no pins possible); garbled layers only affect locating, not the generated text.
- **Two views:** decide whether generated pins go to the PDF view, the Text Reader view, or both (reuse the popup choice or the Create IncRem setting).

## RemNote facts this relies on

- PDF highlight `Data`: `{content:{text}, position:{boundingRect, rects[], pageNumber}, id, temp}`; rect coordinates are in a viewport whose size (`width`/`height`) is stored with them — the PDF's page size in points. Parent: the PDF's `Highlights` › `Page NNN` Rem (number padded to the page count's digits).
- HTML highlight `Data`: `{startXPath, endXPath, startOffset, endOffset, text, textBefore, textAfter}`, XPaths relative to the `<div>` the viewer mounts the article in (after `<inline_math>`/`<block_math>` → KaTeX and DOMPurify). Parent: `Highlights`, directly.
- A PDF's Text Reader version is a Link powerup (`FileURL`) on the same PDF Rem; its highlights are HTML highlights pointing at the PDF Rem.
- The `Highlights` container is identifiable only by name + being a direct child of the source; do not create it from the plugin (risk of duplicates).
- Anything reached from the index widget must be imported statically: lazily loaded webpack chunks break (`import.meta` banner in `webpack.config.js`).
- New widget files need `npm run dev` restarted (entries are globbed at startup).
