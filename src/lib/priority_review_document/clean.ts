import { RNPlugin, PluginRem, RemId, RichTextInterface } from '@remnote/plugin-sdk';
import dayjs from 'dayjs';
import { IncrementalRem } from '../incremental_rem';
import { allIncrementalRemKey } from '../consts';

/**
 * Cleaning a Priority Review Document of entries that are no longer due.
 *
 * A PRD is a snapshot: it is built from what was due at the moment it was
 * created, and every entry is a child Rem whose text is a single Rem reference,
 * tagged INC or FC. Nothing updates those entries afterwards, so once the
 * referenced Rem has been reviewed the entry stays behind and keeps feeding the
 * document's queue — which, under RemNote's current gathering rules, is what
 * lets an old document crowd out the priorities you actually want.
 *
 * The scan is read-only and answers one question per entry: does the referenced
 * Rem still have anything due today?
 *   - FC  → the Rem's OWN cards.
 *   - INC → the Rem is in the IncRem cache and its next repetition has arrived.
 * Descendants are deliberately not consulted: the builder never selected a Rem
 * for its descendants' cards, so cleaning must not keep one for them either.
 *
 * The threshold is the END OF TODAY, not `now` as in the builder's `dueCards`
 * count. The builder is choosing what to serve at this instant; this is deciding
 * what to throw away, and those are not the same question. A card answered Again
 * an hour ago sits in a learning step ten minutes out — not due by `now`, but
 * coming back in this very session, and deleting its entry would take it out of
 * the document that is meant to bring it back. For INC entries the two
 * thresholds coincide: `nextRepDate` is a Daily Document date at midnight, so
 * anything at or before today is already ≤ now.
 *
 * Two whole-KB reads (`card.getAll()` and the IncRem session cache) answer
 * every entry in every document, so the per-entry cost is a map lookup rather
 * than a round trip.
 */

/** Name of the plain tag createPriorityReviewDocument puts on every PRD. */
export const PRD_TAG_NAME = 'Priority Review Queue';
/** Names of the plain tags it puts on each entry. */
export const INC_TAG_NAME = 'INC';
export const FC_TAG_NAME = 'FC';

export type PortalKind = 'inc' | 'fc';

export type EntryStatus =
  /** Referenced Rem still has something due — the entry stays. */
  | 'due'
  /** Reviewed since the document was built — the entry is removable. */
  | 'stale'
  /** The referenced Rem no longer exists — the entry is removable. */
  | 'missing'
  /** Cannot be judged (see {@link PrdScanResult.incCacheUnavailable}) — kept. */
  | 'unknown';

/** Why an entry that is no longer due is kept anyway. */
export type KeepReason = 'has-children' | 'edited-text';

export const KEEP_REASON_LABELS: Record<KeepReason, string> = {
  'has-children': 'have notes written under them',
  'edited-text': 'have text of your own next to the reference',
};

export interface PrdEntry {
  /** The child Rem inside the review document — this is what gets deleted. */
  entryRemId: RemId;
  /** The Rem it references, or null when the text holds no reference. */
  targetRemId: RemId | null;
  targetName: string;
  kind: PortalKind;
  status: EntryStatus;
  /** Set when the entry is no longer due but is being kept anyway. */
  keepReason?: KeepReason;
}

export interface PrdDocReport {
  docRemId: RemId;
  docName: string;
  createdAt: number;
  /** Entries (reference-bearing children) found in the document. */
  totalEntries: number;
  /** Children that are not entries: the metadata block, the graph, your own notes. */
  otherChildren: number;
  /** Entries whose target is still due. */
  dueEntries: PrdEntry[];
  /** Entries that will be deleted. */
  removableEntries: PrdEntry[];
  /** No longer due, but kept because deleting them would lose something. */
  keptEntries: PrdEntry[];
  /** Entries that could not be judged. */
  unknownEntries: PrdEntry[];
}

export interface PrdScanResult {
  docs: PrdDocReport[];
  /** Documents carrying the PRD tag. */
  scannedDocs: number;
  totalEntries: number;
  totalRemovable: number;
  totalDue: number;
  totalKept: number;
  /**
   * True when the IncRem session cache was empty. INC entries are then reported
   * as `unknown` and never deleted — an unbuilt cache would otherwise look
   * exactly like "every incremental Rem has been reviewed".
   */
  incCacheUnavailable: boolean;
  elapsedMs: number;
}

export interface PrdCleanResult {
  deleted: number;
  failed: number;
  /** Documents left with no due entries at all after the deletion. */
  emptiedDocs: { docRemId: RemId; docName: string }[];
}

/**
 * Local, allocation-only rendering of a Rem's text — no round trip.
 *
 * Entry targets are ordinary Rems whose text is overwhelmingly plain, and the
 * label is only ever read by a human scanning the preview, so the accuracy of
 * `plugin.richText.toString()` is not worth one IPC call per entry across
 * potentially thousands of them.
 */
function flattenRichText(text: RichTextInterface | undefined): string {
  if (!Array.isArray(text)) return '';
  return text
    .map((el) => {
      if (typeof el === 'string') return el;
      if (el && typeof el === 'object') {
        if ('text' in el && typeof (el as any).text === 'string') return (el as any).text;
        if ((el as any).i === 'q') return '↪';
      }
      return '';
    })
    .join('')
    .trim();
}

/**
 * Same as {@link flattenRichText} but with Rem references resolved to their own
 * text. Used for document titles only: a PRD title is
 * `Priority Review - [scope ref] - timestamp`, so the reference is the one part
 * that tells two review documents apart, and a "↪" there would make the whole
 * list read as the same document repeated. One extra lookup per document.
 */
async function flattenTitle(
  plugin: RNPlugin,
  text: RichTextInterface | undefined
): Promise<string> {
  const refs = remRefIds(text);
  if (refs.length === 0) return flattenRichText(text);
  const resolved = (await plugin.rem.findMany(refs)) || [];
  const nameById = new Map<RemId, string>(
    resolved.map((r) => [r._id, flattenRichText(r.text) || 'Untitled'])
  );
  if (!Array.isArray(text)) return '';
  return text
    .map((el) => {
      if (typeof el === 'string') return el;
      if (el && typeof el === 'object') {
        if ((el as any).i === 'q') return nameById.get((el as any)._id as RemId) ?? '↪';
        if ('text' in el && typeof (el as any).text === 'string') return (el as any).text;
      }
      return '';
    })
    .join('')
    .trim();
}

/** The Rem references (`{ i: 'q', _id }`) carried by a rich text value. */
function remRefIds(text: RichTextInterface | undefined): RemId[] {
  if (!Array.isArray(text)) return [];
  const ids: RemId[] = [];
  for (const el of text) {
    if (el && typeof el === 'object' && (el as any).i === 'q' && (el as any)._id) {
      ids.push((el as any)._id as RemId);
    }
  }
  return ids;
}

/**
 * True when the child's text holds anything beyond the single Rem reference the
 * builder wrote. Whitespace does not count; a second reference does.
 */
function hasTextOfItsOwn(text: RichTextInterface | undefined): boolean {
  if (!Array.isArray(text)) return false;
  let refs = 0;
  for (const el of text) {
    if (typeof el === 'string') {
      if (el.trim().length > 0) return true;
      continue;
    }
    if (el && typeof el === 'object') {
      if ((el as any).i === 'q') {
        refs++;
        continue;
      }
      // Any other rich-text element (bold run, image, cloze, latex…) is content.
      return true;
    }
  }
  return refs > 1;
}

/** Rem IDs that own at least one card due at any point up to the end of today. */
async function buildDueCardRemIds(plugin: RNPlugin): Promise<Set<RemId>> {
  const cutoff = dayjs().endOf('day').valueOf();
  const allCards = (await plugin.card.getAll()) || [];
  const due = new Set<RemId>();
  for (const card of allCards) {
    // `?? Infinity` mirrors getCardPriority: a disabled direction has a null
    // nextRepetitionTime and must not read as due.
    if ((card.nextRepetitionTime ?? Infinity) <= cutoff) due.add(card.remId);
  }
  return due;
}

/** Rem IDs whose IncRem next-repetition date has arrived (by the end of today). */
async function buildDueIncRemIds(
  plugin: RNPlugin
): Promise<{ due: Set<RemId>; all: Set<RemId>; available: boolean }> {
  const cutoff = dayjs().endOf('day').valueOf();
  const allIncRems =
    (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
  if (allIncRems.length === 0) {
    return { due: new Set<RemId>(), all: new Set<RemId>(), available: false };
  }
  const due = new Set<RemId>();
  const all = new Set<RemId>();
  for (const inc of allIncRems) {
    all.add(inc.remId);
    if (inc.nextRepDate <= cutoff) due.add(inc.remId);
  }
  return { due, all, available: true };
}

/** The Rems carrying a plain tag of the given name, as an ID set. */
async function taggedIdSet(plugin: RNPlugin, tagName: string): Promise<Set<RemId>> {
  const tag = await plugin.rem.findByName([tagName], null);
  if (!tag) return new Set<RemId>();
  const tagged = (await tag.taggedRem()) || [];
  return new Set(tagged.map((r) => r._id));
}

/**
 * Read-only pass over every Priority Review Document in the knowledge base.
 * Writes nothing; the caller decides what to delete from the result.
 */
export async function scanPriorityReviewDocuments(
  plugin: RNPlugin,
  onProgress?: (message: string) => void
): Promise<PrdScanResult> {
  const startedAt = Date.now();
  const empty: PrdScanResult = {
    docs: [],
    scannedDocs: 0,
    totalEntries: 0,
    totalRemovable: 0,
    totalDue: 0,
    totalKept: 0,
    incCacheUnavailable: false,
    elapsedMs: 0,
  };

  onProgress?.('Finding review documents…');
  const prdTag = await plugin.rem.findByName([PRD_TAG_NAME], null);
  if (!prdTag) {
    return { ...empty, elapsedMs: Date.now() - startedAt };
  }
  const docs = (await prdTag.taggedRem()) || [];
  if (docs.length === 0) {
    return { ...empty, elapsedMs: Date.now() - startedAt };
  }

  onProgress?.('Reading due state for the whole knowledge base…');
  const [dueCardRemIds, incState, incTagged, fcTagged] = await Promise.all([
    buildDueCardRemIds(plugin),
    buildDueIncRemIds(plugin),
    taggedIdSet(plugin, INC_TAG_NAME),
    taggedIdSet(plugin, FC_TAG_NAME),
  ]);

  const reports: PrdDocReport[] = [];
  let docIndex = 0;

  for (const doc of docs) {
    docIndex++;
    const docName = (await flattenTitle(plugin, doc.text)) || 'Untitled review document';
    onProgress?.(`Document ${docIndex} of ${docs.length}: ${docName.slice(0, 60)}`);

    const childIds = doc.children || [];
    const children = childIds.length ? (await plugin.rem.findMany(childIds)) || [] : [];

    // One lookup for every target in this document, instead of one per entry.
    const targetIds = new Set<RemId>();
    for (const child of children) {
      for (const id of remRefIds(child.text)) targetIds.add(id);
    }
    const targets = targetIds.size ? (await plugin.rem.findMany([...targetIds])) || [] : [];
    const targetById = new Map<RemId, PluginRem>(targets.map((r) => [r._id, r]));

    const report: PrdDocReport = {
      docRemId: doc._id,
      docName,
      createdAt: doc.createdAt,
      totalEntries: 0,
      otherChildren: 0,
      dueEntries: [],
      removableEntries: [],
      keptEntries: [],
      unknownEntries: [],
    };

    for (const child of children) {
      const refs = remRefIds(child.text);
      if (refs.length === 0) {
        // The metadata code block, the distribution graph, or a note of your own.
        report.otherChildren++;
        continue;
      }
      report.totalEntries++;

      const targetRemId = refs[0];
      const target = targetById.get(targetRemId);
      // The tag is what the builder recorded; inference only covers an entry
      // whose tag was removed, and then the target itself decides — being an
      // IncRem at all, due or not, is what makes an entry an INC entry.
      const kind: PortalKind = incTagged.has(child._id)
        ? 'inc'
        : fcTagged.has(child._id)
          ? 'fc'
          : incState.all.has(targetRemId)
            ? 'inc'
            : 'fc';

      const entry: PrdEntry = {
        entryRemId: child._id,
        targetRemId,
        targetName: target ? flattenRichText(target.text) || 'Untitled' : '(deleted Rem)',
        kind,
        status: 'due',
      };

      if (!target) {
        entry.status = 'missing';
      } else if (kind === 'inc') {
        if (!incState.available) entry.status = 'unknown';
        else entry.status = incState.due.has(targetRemId) ? 'due' : 'stale';
      } else {
        entry.status = dueCardRemIds.has(targetRemId) ? 'due' : 'stale';
      }

      if (entry.status === 'due') {
        report.dueEntries.push(entry);
        continue;
      }
      if (entry.status === 'unknown') {
        report.unknownEntries.push(entry);
        continue;
      }

      // Removable in principle — unless deleting it would take something of
      // yours with it. `remove()` deletes descendants too, so a note written
      // under an entry is not recoverable from a re-run.
      if ((child.children || []).length > 0) {
        entry.keepReason = 'has-children';
        report.keptEntries.push(entry);
      } else if (hasTextOfItsOwn(child.text)) {
        entry.keepReason = 'edited-text';
        report.keptEntries.push(entry);
      } else {
        report.removableEntries.push(entry);
      }
    }

    reports.push(report);
  }

  // Most recent first: that is the document you are most likely reviewing from.
  reports.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const result: PrdScanResult = {
    docs: reports,
    scannedDocs: reports.length,
    totalEntries: reports.reduce((n, d) => n + d.totalEntries, 0),
    totalRemovable: reports.reduce((n, d) => n + d.removableEntries.length, 0),
    totalDue: reports.reduce((n, d) => n + d.dueEntries.length, 0),
    totalKept: reports.reduce((n, d) => n + d.keptEntries.length, 0),
    incCacheUnavailable: !incState.available,
    elapsedMs: Date.now() - startedAt,
  };

  logScan(result);
  return result;
}

/** Full per-document breakdown in the console — the diagnostic half of this command. */
function logScan(result: PrdScanResult) {
  console.log(
    `[PRD Clean] Scanned ${result.scannedDocs} review documents, ${result.totalEntries} entries, ` +
      `in ${(result.elapsedMs / 1000).toFixed(1)}s — ` +
      `${result.totalDue} still due, ${result.totalRemovable} removable, ${result.totalKept} kept.`
  );
  if (result.incCacheUnavailable) {
    console.warn(
      '[PRD Clean] The IncRem cache is empty, so INC entries could not be judged and were left alone.'
    );
  }
  for (const doc of result.docs) {
    console.groupCollapsed(
      `[PRD Clean] ${doc.docName} — ${doc.dueEntries.length} due / ${doc.removableEntries.length} removable / ${doc.totalEntries} entries`
    );
    const row = (e: PrdEntry) => ({
      status: e.status,
      kind: e.kind.toUpperCase(),
      name: e.targetName,
      target: e.targetRemId,
      entry: e.entryRemId,
      kept: e.keepReason ?? '',
    });
    console.table([
      ...doc.removableEntries.map(row),
      ...doc.keptEntries.map(row),
      ...doc.unknownEntries.map(row),
      ...doc.dueEntries.map(row),
    ]);
    console.groupEnd();
  }
}

/**
 * Deletes the removable entries of the given documents and stamps what was
 * removed onto each document's metadata block.
 *
 * Takes the reports produced by {@link scanPriorityReviewDocuments} — already
 * filtered to the documents the user ticked — and re-reads each entry Rem by ID
 * rather than trusting an object captured during the scan.
 */
export async function cleanPriorityReviewDocuments(
  plugin: RNPlugin,
  docs: PrdDocReport[],
  onProgress?: (message: string) => void
): Promise<PrdCleanResult> {
  const result: PrdCleanResult = { deleted: 0, failed: 0, emptiedDocs: [] };
  const total = docs.reduce((n, d) => n + d.removableEntries.length, 0);

  for (const doc of docs) {
    if (doc.removableEntries.length === 0) continue;

    let deletedHere = 0;
    for (const entry of doc.removableEntries) {
      try {
        const rem = await plugin.rem.findOne(entry.entryRemId);
        // Already gone is a success, not a failure — the entry is not there.
        if (rem) await rem.remove();
        deletedHere++;
        result.deleted++;
      } catch (e) {
        console.error(`[PRD Clean] Could not delete entry ${entry.entryRemId}:`, e);
        result.failed++;
      }
      onProgress?.(`Removed ${result.deleted} of ${total}…`);
    }

    await stampMetadata(plugin, doc, deletedHere);

    if (doc.dueEntries.length === 0) {
      result.emptiedDocs.push({ docRemId: doc.docRemId, docName: doc.docName });
    }
  }

  console.log(
    `[PRD Clean] Removed ${result.deleted} entries across ${docs.length} documents` +
      (result.failed ? ` (${result.failed} failed)` : '') +
      (result.emptiedDocs.length
        ? `. ${result.emptiedDocs.length} document(s) now hold nothing due.`
        : '.')
  );
  return result;
}

/**
 * Appends a cleaning line to the document's metadata code block, so the counts
 * printed at creation time are not left contradicting the document's contents.
 * Best-effort: a document whose block was edited away is still cleaned.
 */
async function stampMetadata(plugin: RNPlugin, doc: PrdDocReport, removed: number) {
  if (removed === 0) return;
  try {
    const docRem = await plugin.rem.findOne(doc.docRemId);
    const children = docRem?.children?.length
      ? (await plugin.rem.findMany(docRem.children)) || []
      : [];
    const metadata = children.find((c) => flattenRichText(c.text).startsWith('Scope: '));
    if (!metadata) return;

    const stamp =
      `\nCleaned ${new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}: removed ${removed} reviewed ${removed === 1 ? 'entry' : 'entries'}, ` +
      `${doc.dueEntries.length} still due`;

    await metadata.setText([flattenRichText(metadata.text) + stamp]);
  } catch (e) {
    console.warn(`[PRD Clean] Could not stamp metadata on ${doc.docRemId}:`, e);
  }
}
