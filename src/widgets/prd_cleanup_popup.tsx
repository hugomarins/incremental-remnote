import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import {
  cleanPriorityReviewDocuments,
  KEEP_REASON_LABELS,
  KeepReason,
  PrdCleanResult,
  PrdDocReport,
  PrdEntry,
  PrdScanResult,
  scanPriorityReviewDocuments,
  UNDELETABLE_REASON_LABELS,
} from '../lib/priority_review_document/clean';

type Phase = 'scanning' | 'review' | 'cleaning' | 'done' | 'error';

/** Entries listed per document when a row is expanded. */
const PREVIEW_LIMIT = 200;

const formatElapsed = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${Math.round(seconds - mins * 60)}s`;
};

/** ~74ms per write on this bridge (measured in lib/image_scan.ts), serialized. */
const estimateDeleteTime = (count: number): string => formatElapsed(count * 74);

const formatDate = (ms: number): string =>
  ms
    ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

/**
 * Scan → review → delete for entries left behind in Priority Review Documents.
 *
 * A PRD is a snapshot of what was due when it was built, and its entries never
 * update. Once an item has been reviewed its entry keeps feeding the document's
 * queue, which is what lets an old review document crowd out the priorities you
 * built it to reach. This finds those entries and removes them.
 *
 * Two stages, like the Empty ECD popup and for the same reason: the scan writes
 * nothing, and you confirm per document against real counts before a single Rem
 * is deleted. The scan alone is also useful on its own — it is the readout of
 * what each review document is still carrying.
 */
export function PrdCleanupPopup() {
  const plugin = usePlugin();

  const [phase, setPhase] = useState<Phase>('scanning');
  const [progress, setProgress] = useState('Starting…');
  const [scan, setScan] = useState<PrdScanResult | null>(null);
  const [clean, setClean] = useState<PrdCleanResult | null>(null);
  const [error, setError] = useState('');
  /** Documents ticked for cleaning. Seeded with every document that has work. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Delete a document outright once cleaning leaves nothing due in it. */
  const [deleteEmptiedDocs, setDeleteEmptiedDocs] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const run = async () => {
      try {
        const result = await scanPriorityReviewDocuments(plugin, (m) => setProgress(m));
        setScan(result);
        setSelected(
          new Set(
            result.docs
              .filter((d) => d.removableEntries.length > 0 || d.deletable)
              .map((d) => d.docRemId)
          )
        );
        setPhase('review');
      } catch (e) {
        console.error('[PRD Clean] scan failed:', e);
        setError((e as any)?.message ?? String(e));
        setPhase('error');
      }
    };
    run();
  }, []);

  useEffect(() => {
    containerRef.current?.focus();
  }, [phase]);

  const close = () => plugin.widget.closePopup();

  const toggleDoc = (docId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });

  const toggleExpanded = (docId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });

  /** A document is worth acting on if it has entries to remove, or can itself go. */
  const hasWork = (doc: PrdDocReport) =>
    doc.removableEntries.length > 0 || (deleteEmptiedDocs && doc.deletable);

  const selectedDocs: PrdDocReport[] =
    scan?.docs.filter((d) => selected.has(d.docRemId) && hasWork(d)) ?? [];
  /** Entries that will actually be walked — those inside a doomed document are not. */
  const selectedEntryCount = selectedDocs
    .filter((d) => !(deleteEmptiedDocs && d.deletable))
    .reduce((n, d) => n + d.removableEntries.length, 0);
  const selectedDocDeletions = deleteEmptiedDocs
    ? selectedDocs.filter((d) => d.deletable).length
    : 0;
  const nothingToDo = selectedEntryCount === 0 && selectedDocDeletions === 0;
  /**
   * Still-due incremental entries sitting in documents that qualify for
   * deletion. Deleting takes them with it, so the count is stated up front
   * rather than discovered afterwards.
   */
  const incInDeletableDocs =
    scan?.docs.filter((d) => d.deletable).reduce((n, d) => n + d.remainingIncEntries, 0) ?? 0;

  const runClean = async () => {
    if (nothingToDo) return;
    setPhase('cleaning');
    setProgress(`Removing 0 of ${selectedEntryCount}…`);
    try {
      setClean(
        await cleanPriorityReviewDocuments(plugin, selectedDocs, { deleteEmptiedDocs }, (m) =>
          setProgress(m)
        )
      );
      setPhase('done');
    } catch (e) {
      console.error('[PRD Clean] deletion failed:', e);
      setError((e as any)?.message ?? String(e));
      setPhase('error');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Not mid-run: Esc is a reflex, and here it would abort work in progress.
      if (phase === 'scanning' || phase === 'cleaning') return;
      e.preventDefault();
      close();
      return;
    }
    // No Enter-to-delete on the review screen — the destructive button is clicked.
    if ((phase === 'done' || phase === 'error') && e.key === 'Enter') {
      e.preventDefault();
      close();
    }
  };

  const primaryButton: React.CSSProperties = {
    background: '#3B82F6',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
  };
  const secondaryButton: React.CSSProperties = {
    background: 'transparent',
    color: 'var(--rn-clr-content-primary)',
    border: '1px solid var(--rn-clr-border-opaque, rgba(128,128,128,0.3))',
    cursor: 'pointer',
  };
  const dangerButton: React.CSSProperties = {
    background: '#dc2626',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
  };

  const header = (
    <div className="flex items-center gap-2">
      <span style={{ fontSize: 18 }}>🧹</span>
      <span className="font-semibold text-base">Clean Priority Review Documents</span>
    </div>
  );

  const kindChip = (kind: PrdEntry['kind']) => (
    <span
      className="text-xs font-mono px-1 rounded"
      style={{
        background: 'var(--rn-clr-background-elevation-20)',
        color: 'var(--rn-clr-content-secondary)',
      }}
    >
      {kind.toUpperCase()}
    </span>
  );

  const entryRow = (entry: PrdEntry, muted: boolean) => (
    <div
      key={entry.entryRemId}
      className="flex items-center gap-2 text-xs py-0.5"
      style={{ color: muted ? 'var(--rn-clr-content-tertiary)' : 'var(--rn-clr-content-secondary)' }}
    >
      {kindChip(entry.kind)}
      <span className="truncate flex-1">{entry.targetName}</span>
      {entry.status === 'missing' && <span style={{ fontStyle: 'italic' }}>deleted Rem</span>}
      {entry.keepReason && (
        <span style={{ fontStyle: 'italic' }}>{KEEP_REASON_LABELS[entry.keepReason]}</span>
      )}
    </div>
  );

  const docRow = (doc: PrdDocReport) => {
    const removable = doc.removableEntries.length;
    const isOpen = expanded.has(doc.docRemId);
    const actionable = hasWork(doc);
    const willBeDeleted = deleteEmptiedDocs && doc.deletable;
    const keptByReason = doc.keptEntries.reduce<Record<string, number>>((acc, e) => {
      if (e.keepReason) acc[e.keepReason] = (acc[e.keepReason] || 0) + 1;
      return acc;
    }, {});

    return (
      <div
        key={doc.docRemId}
        className="rounded p-2"
        style={{ background: 'var(--rn-clr-background-elevation-10)' }}
      >
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={selected.has(doc.docRemId) && actionable}
            disabled={!actionable}
            onChange={() => toggleDoc(doc.docRemId)}
            className="mt-1"
            style={{ cursor: actionable ? 'pointer' : 'not-allowed' }}
          />
          <div className="flex-1 min-w-0">
            <div
              className="text-sm truncate"
              title={doc.docName}
              style={{
                textDecoration: willBeDeleted && selected.has(doc.docRemId) ? 'line-through' : undefined,
              }}
            >
              {doc.docName}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--rn-clr-content-secondary)' }}>
              <span className="font-bold">{doc.dueFlashcards}</span> flashcard
              {doc.dueFlashcards === 1 ? '' : 's'} due ·{' '}
              {doc.remainingIncEntries > 0 && (
                <>
                  <span className="font-bold">{doc.remainingIncEntries}</span> INC ·{' '}
                </>
              )}
              <span className="font-bold" style={{ color: removable ? '#dc2626' : undefined }}>
                {removable}
              </span>{' '}
              reviewed · {doc.totalEntries} entries
              {doc.createdAt ? ` · built ${formatDate(doc.createdAt)}` : ''}
            </div>
            {doc.keptEntries.length > 0 && (
              <div className="text-xs mt-0.5" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                Keeping{' '}
                {Object.entries(keptByReason)
                  .map(([reason, n]) => `${n} that ${KEEP_REASON_LABELS[reason as KeepReason]}`)
                  .join(', ')}
              </div>
            )}
            {doc.unknownEntries.length > 0 && (
              <div className="text-xs mt-0.5" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                {doc.unknownEntries.length} INC {doc.unknownEntries.length === 1 ? 'entry' : 'entries'}{' '}
                could not be judged
              </div>
            )}
            {doc.deletable && (
              <div
                className="text-xs mt-0.5 font-medium"
                style={{ color: deleteEmptiedDocs ? '#dc2626' : 'var(--rn-clr-content-tertiary)' }}
              >
                {doc.remainingIncEntries > 0
                  ? deleteEmptiedDocs
                    ? `No flashcards due — the document itself will be deleted, dropping ${
                        doc.remainingIncEntries
                      } incremental ${doc.remainingIncEntries === 1 ? 'entry' : 'entries'}`
                    : 'No flashcards due — only incremental entries are left'
                  : deleteEmptiedDocs
                    ? 'Nothing due left — the document itself will be deleted'
                    : 'Nothing due left — the document is finished'}
              </div>
            )}
            {doc.undeletableReason && (
              <div className="text-xs mt-0.5" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                No flashcards due, but the document {UNDELETABLE_REASON_LABELS[doc.undeletableReason]}{' '}
                — delete it yourself
              </div>
            )}
          </div>
          <button
            onClick={() => toggleExpanded(doc.docRemId)}
            onMouseDown={(e) => e.preventDefault()}
            className="text-xs px-2 py-0.5 rounded shrink-0"
            style={secondaryButton}
          >
            {isOpen ? 'Hide' : 'Show'}
          </button>
        </div>

        {isOpen && (
          <div
            className="mt-2 pl-6 flex flex-col"
            style={{ maxHeight: 220, overflowY: 'auto' }}
          >
            {removable > 0 && (
              <>
                <div className="text-xs font-semibold mb-1">To remove ({removable})</div>
                {doc.removableEntries.slice(0, PREVIEW_LIMIT).map((e) => entryRow(e, false))}
                {removable > PREVIEW_LIMIT && (
                  <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                    …and {removable - PREVIEW_LIMIT} more — the full list is in the console.
                  </div>
                )}
              </>
            )}
            {doc.keptEntries.length > 0 && (
              <>
                <div className="text-xs font-semibold mt-2 mb-1">
                  Reviewed, but kept ({doc.keptEntries.length})
                </div>
                {doc.keptEntries.slice(0, PREVIEW_LIMIT).map((e) => entryRow(e, true))}
              </>
            )}
            {doc.dueEntries.length > 0 && (
              <>
                <div className="text-xs font-semibold mt-2 mb-1">
                  Still due, staying ({doc.dueEntries.length})
                </div>
                {doc.dueEntries.slice(0, PREVIEW_LIMIT).map((e) => entryRow(e, true))}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{ outline: 'none' }}
    >
      {header}

      {(phase === 'scanning' || phase === 'cleaning') && (
        <div className="flex flex-col gap-2 py-4">
          <div className="text-sm font-medium">
            {phase === 'scanning'
              ? '🔍 Reading every review document…'
              : '🧹 Removing what has been reviewed…'}
          </div>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {progress}
          </div>
          <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
            {phase === 'scanning'
              ? 'Nothing is written yet. Closing this popup stops the scan.'
              : 'Keep this popup open until it finishes — closing it stops the run, and entries already removed stay removed.'}
          </div>
        </div>
      )}

      {phase === 'review' && scan && (
        <>
          <div className="text-sm" style={{ color: 'var(--rn-clr-content-secondary)' }}>
            {scan.scannedDocs === 0 ? (
              'No Priority Review Documents found in this knowledge base.'
            ) : (
              <>
                <span className="font-bold">{scan.scannedDocs}</span> review document
                {scan.scannedDocs === 1 ? '' : 's'} ·{' '}
                <span className="font-bold">{scan.totalEntries.toLocaleString()}</span> entries →{' '}
                <span className="font-bold">{scan.totalDue.toLocaleString()}</span> still due,{' '}
                <span className="font-bold" style={{ color: '#dc2626' }}>
                  {scan.totalRemovable.toLocaleString()}
                </span>{' '}
                already reviewed
                {scan.totalDeletableDocs > 0 && (
                  <>
                    , <span className="font-bold">{scan.totalDeletableDocs}</span> document
                    {scan.totalDeletableDocs === 1 ? '' : 's'} with no flashcards left
                  </>
                )}
                . Read in {formatElapsed(scan.elapsedMs)}.
              </>
            )}
          </div>

          {scan.incCacheUnavailable && (
            <div
              className="text-xs p-2 rounded"
              style={{ background: 'rgba(220,38,38,0.1)', color: 'var(--rn-clr-content-primary)' }}
            >
              The incremental-Rem cache is empty, so INC entries were left alone — an unbuilt cache
              looks exactly like "everything has been reviewed". Reopen the queue once and run this
              again to include them.
            </div>
          )}

          {scan.scannedDocs > 0 && (
            <div className="flex flex-col gap-2" style={{ maxHeight: 360, overflowY: 'auto' }}>
              {scan.docs.map(docRow)}
            </div>
          )}

          {scan.docs.some((d) => d.deletable) && (
            <label
              className="flex items-start gap-2 text-xs rounded p-2"
              style={{ background: 'var(--rn-clr-background-elevation-10)', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={deleteEmptiedDocs}
                onChange={(e) => setDeleteEmptiedDocs(e.target.checked)}
                className="mt-0.5"
                style={{ cursor: 'pointer' }}
              />
              <span>
                <span className="font-medium">
                  Delete the {scan.totalDeletableDocs} document
                  {scan.totalDeletableDocs === 1 ? '' : 's'} with no flashcards left due
                </span>
                <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
                  {' '}
                  — a review document exists to get flashcards reviewed in priority order, so once
                  none of its flashcards is due it is finished, and leaving it behind keeps its Rem
                  references in your knowledge base.
                  {incInDeletableDocs > 0 && (
                    <>
                      {' '}
                      <span style={{ color: 'var(--rn-clr-content-primary)' }}>
                        {incInDeletableDocs} still-due incremental{' '}
                        {incInDeletableDocs === 1 ? 'entry goes' : 'entries go'} with{' '}
                        {scan.totalDeletableDocs === 1 ? 'it' : 'them'}
                      </span>
                      : incremental Rems are injected into every queue by the sorting criteria, so
                      they do not need a review document to come back. The Rems themselves are
                      untouched.
                    </>
                  )}{' '}
                  Never applies to a document holding notes of your own.
                </span>
              </span>
            </label>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {nothingToDo
                ? 'Nothing selected.'
                : `About ${estimateDeleteTime(
                    selectedEntryCount + selectedDocDeletions
                  )}. This cannot be undone.`}
            </div>
            <div className="flex gap-2">
              <button onClick={close} className="px-3 py-1.5 text-sm rounded" style={secondaryButton}>
                Cancel
              </button>
              <button
                onClick={runClean}
                disabled={nothingToDo}
                className="px-4 py-1.5 text-sm font-medium rounded"
                style={
                  nothingToDo
                    ? { ...secondaryButton, opacity: 0.5, cursor: 'not-allowed' }
                    : dangerButton
                }
              >
                {selectedEntryCount > 0 &&
                  `Remove ${selectedEntryCount.toLocaleString()} entr${
                    selectedEntryCount === 1 ? 'y' : 'ies'
                  }`}
                {selectedEntryCount > 0 && selectedDocDeletions > 0 && ' · '}
                {selectedDocDeletions > 0 &&
                  `${selectedEntryCount > 0 ? 'delete' : 'Delete'} ${selectedDocDeletions} document${
                    selectedDocDeletions === 1 ? '' : 's'
                  }`}
                {nothingToDo && 'Remove 0 entries'}
              </button>
            </div>
          </div>
        </>
      )}

      {phase === 'done' && clean && (
        <>
          <div className="text-sm">
            Removed <span className="font-bold">{clean.deleted.toLocaleString()}</span> reviewed
            entr{clean.deleted === 1 ? 'y' : 'ies'}
            {clean.deletedDocs.length > 0 && (
              <>
                {' '}
                and <span className="font-bold">{clean.deletedDocs.length}</span> finished document
                {clean.deletedDocs.length === 1 ? '' : 's'}
                {clean.incEntriesDropped > 0 && (
                  <>
                    {' '}
                    (with {clean.incEntriesDropped} still-due incremental{' '}
                    {clean.incEntriesDropped === 1 ? 'entry' : 'entries'} in them — the Rems
                    themselves are untouched and stay in your queue)
                  </>
                )}
              </>
            )}
            {clean.failed > 0 ? ` — ${clean.failed} could not be deleted (see the console)` : '.'}
          </div>
          {clean.deletedDocs.length > 0 && (
            <div
              className="text-xs p-3 rounded flex flex-col gap-1"
              style={{
                background: 'var(--rn-clr-background-elevation-10)',
                color: 'var(--rn-clr-content-secondary)',
              }}
            >
              <div className="font-semibold">Documents deleted:</div>
              {clean.deletedDocs.slice(0, 10).map((d) => (
                <div key={d.docRemId} className="truncate">
                  {d.docName}
                </div>
              ))}
              {clean.deletedDocs.length > 10 && (
                <div>…and {clean.deletedDocs.length - 10} more.</div>
              )}
            </div>
          )}
          {clean.emptiedDocs.length > 0 && (
            <div
              className="text-xs p-3 rounded flex flex-col gap-1"
              style={{
                background: 'var(--rn-clr-background-elevation-10)',
                color: 'var(--rn-clr-content-secondary)',
              }}
            >
              <div className="font-semibold">
                {clean.emptiedDocs.length} document
                {clean.emptiedDocs.length === 1 ? ' holds' : 's hold'} no due flashcards any more but{' '}
                {clean.emptiedDocs.length === 1 ? 'was' : 'were'} kept — delete{' '}
                {clean.emptiedDocs.length === 1 ? 'it' : 'them'} yourself:
              </div>
              {clean.emptiedDocs.slice(0, 10).map((d) => (
                <div key={d.docRemId} className="truncate">
                  {d.docName}
                  {d.reason !== 'not-requested' && (
                    <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                      {' '}
                      — {UNDELETABLE_REASON_LABELS[d.reason]}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <button onClick={close} className="px-4 py-1.5 text-sm font-medium rounded" style={primaryButton}>
              Close
            </button>
          </div>
        </>
      )}

      {phase === 'error' && (
        <>
          <div className="text-sm" style={{ color: '#dc2626' }}>
            {error || 'Something went wrong — see the console.'}
          </div>
          <div className="flex justify-end">
            <button onClick={close} className="px-4 py-1.5 text-sm font-medium rounded" style={primaryButton}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

renderWidget(PrdCleanupPopup);
