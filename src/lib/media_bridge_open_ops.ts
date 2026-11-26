/**
 * Local Media Bridge — `open-rem` and `open-pdf`: an outside tool (a reader, a search
 * page, a script) shows the user a Rem, or a place in a PDF, in RemNote.
 *
 * `open-pdf` has no SDK call to lean on: a plugin cannot set a PDF's page. What it can
 * do is ask RemNote to scroll to a highlight (`scrollToReaderHighlight`, the jump the
 * PDF bookmarks use), which also opens the PDF when it is not in a pane. So the op
 * files a highlight at the wanted place, asks for the scroll, and removes the
 * highlight a few seconds later. While it is there it marks the spot in blue.
 */
import { BuiltInPowerupCodes, PluginRem, ReactRNPlugin } from '@remnote/plugin-sdk';
import type { BridgeOpJob, BridgeOpResult } from './media_bridge_ops';
import { createPdfHighlight, HighlightRect } from './pdf_highlight_create';
import { existingPageRemNear } from './pdf_source_pins';
import { openRemInNewPane, waitForPaneOpen } from './remHelpers';
import { safeRemTextToString } from './pdfUtils';

const fail = (summary: string): BridgeOpResult => ({ ok: false, summary, message: summary });

const titleOf = async (plugin: ReactRNPlugin, rem: PluginRem) => {
  const text = (await safeRemTextToString(plugin, rem.text)).trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/** `pane: "new"` opens beside what is on screen; anything else replaces the focused pane. */
const wantsNewPane = (job: BridgeOpJob) => job.pane === 'new';

// --- open-rem ----------------------------------------------------------------

export async function runOpenRem(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const rem = job.remIds[0] ? await plugin.rem.findOne(job.remIds[0]) : undefined;
  if (!rem) return fail('rem not found');
  if (wantsNewPane(job)) await openRemInNewPane(plugin, rem._id);
  else await plugin.window.openRem(rem);
  return { ok: true, summary: `opened “${await titleOf(plugin, rem)}”`, remId: rem._id };
}

// --- open-pdf ----------------------------------------------------------------

/** Markers a reload kept from being removed: swept on the next open-pdf. */
const MARKERS_KEY = 'media_bridge_open_pdf_markers';
/** The highlight's rects are fractions of the page, in a viewport of this size. */
const UNIT = 1000;
/** With no `y`, aim a little below the top so the page's first lines are on screen. */
const TOP_OF_PAGE_Y = 0.22;
const SCROLL_RETRIES_MS = [1500, 3500, 6000];
const MARKER_LIFE_MS = 9000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sweepMarkers(plugin: ReactRNPlugin) {
  const ids = (await plugin.storage.getLocal<string[]>(MARKERS_KEY).catch(() => undefined)) ?? [];
  if (!Array.isArray(ids) || !ids.length) return;
  for (const id of ids) {
    try {
      const rem = await plugin.rem.findOne(id);
      // Only what is still a bare highlight: never a Rem the user has built on.
      if (rem && (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) && !(await rem.getChildrenRem()).length) {
        await rem.remove();
      }
    } catch (e) {
      console.warn('[MediaBridge] open-pdf: could not remove an old marker', id, e);
    }
  }
  await plugin.storage.setLocal(MARKERS_KEY, []);
}

/**
 * The marker's rects. RemNote centres the view on the FIRST rect's top-left corner, so
 * that one is a zero-width anchor on the page's centre line (the page stays centred);
 * the band the user sees comes second, and only when a `y` was given.
 */
function markerRects(page: number, y: number | null): { boundingRect: HighlightRect; rects: HighlightRect[] } {
  const at = Math.round((y ?? TOP_OF_PAGE_Y) * UNIT);
  const rect = (x1: number, y1: number, x2: number, y2: number): HighlightRect => ({
    x1,
    y1,
    x2,
    y2,
    width: UNIT,
    height: UNIT,
    pageNumber: page,
  });
  const anchor = rect(UNIT / 2, at, UNIT / 2, at);
  if (y === null) return { boundingRect: anchor, rects: [anchor] };
  const band = rect(UNIT * 0.06, at, UNIT * 0.94, Math.min(UNIT, at + 12));
  return { boundingRect: band, rects: [anchor, band] };
}

export async function runOpenPdf(plugin: ReactRNPlugin, job: BridgeOpJob): Promise<BridgeOpResult> {
  const pdf = job.remIds[0] ? await plugin.rem.findOne(job.remIds[0]) : undefined;
  if (!pdf) return fail('PDF rem not found');
  if (!(await pdf.hasPowerup(BuiltInPowerupCodes.UploadedFile))) return fail('that rem is not a PDF');
  const page = Math.round(Number(job.page));
  if (!Number.isFinite(page) || page < 1) return fail('`page` must be a PDF page number, from 1');
  const rawY = job.y === null || job.y === undefined ? null : Number(job.y);
  const y = rawY === null || !Number.isFinite(rawY) ? null : Math.min(1, Math.max(0, rawY));
  const label = typeof job.quote === 'string' && job.quote.trim() ? job.quote.trim().slice(0, 160) : `Page ${page}`;
  const name = await titleOf(plugin, pdf);

  await sweepMarkers(plugin);

  const open = async () => {
    if ((await plugin.window.getOpenPaneRemIds()).includes(pdf._id)) return;
    if (wantsNewPane(job)) await openRemInNewPane(plugin, pdf._id);
    else await plugin.window.openRem(pdf);
  };

  const place = await existingPageRemNear(plugin, pdf, page);
  if (!place) {
    // Nothing to file a highlight under (RemNote creates the Highlights container with
    // the first highlight): the PDF opens where it was last read.
    await open();
    return {
      ok: true,
      summary: `opened “${name}” (page ${page} not reached: this PDF has no highlights yet)`,
      reached: false,
    };
  }

  const marker = await createPdfHighlight(plugin, {
    pdfRemId: pdf._id,
    parentId: place.parentId,
    text: label,
    position: { ...markerRects(page, y), pageNumber: page },
    color: 'Blue',
  });
  if (!marker) {
    await open();
    return { ok: true, summary: `opened “${name}” (page ${page} not reached)`, reached: false };
  }
  const pending = (await plugin.storage.getLocal<string[]>(MARKERS_KEY).catch(() => undefined)) ?? [];
  await plugin.storage.setLocal(MARKERS_KEY, [...pending, marker._id]);

  const scroll = () => {
    try {
      void marker.scrollToReaderHighlight();
    } catch (e) {
      console.warn('[MediaBridge] open-pdf: scroll failed', e);
    }
  };
  const wasOpen = (await plugin.window.getOpenPaneRemIds()).includes(pdf._id);
  await open();
  // The job answers now; the reader of a PDF opened cold takes a while to mount, so the
  // scroll is repeated (it is idempotent) and the marker removed afterwards. This runs in
  // the index widget, which outlives pane changes.
  void (async () => {
    if (wasOpen) {
      await sleep(300);
      scroll();
    } else {
      await waitForPaneOpen(plugin, pdf._id, 8000);
      let last = 0;
      for (const at of SCROLL_RETRIES_MS) {
        await sleep(at - last);
        last = at;
        scroll();
      }
    }
    await sleep(wasOpen ? 5000 : MARKER_LIFE_MS - SCROLL_RETRIES_MS[SCROLL_RETRIES_MS.length - 1]);
    try {
      await marker.remove();
      const left = (await plugin.storage.getLocal<string[]>(MARKERS_KEY)) ?? [];
      await plugin.storage.setLocal(MARKERS_KEY, left.filter((id) => id !== marker._id));
    } catch (e) {
      console.warn('[MediaBridge] open-pdf: marker not removed, the next open-pdf sweeps it', e);
    }
  })();

  return { ok: true, summary: `opened “${name}” at page ${page}`, reached: true, page };
}
