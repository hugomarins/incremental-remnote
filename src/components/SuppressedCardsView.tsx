/**
 * Suppressed Cards — the bucket × cause breakdown as a tab of its own, plus a
 * drill-down that can act on what it finds.
 *
 * The same breakdown used to appear only after an export, in a panel above the
 * analytics table. That made it a by-product of downloading a CSV, when it is
 * really the answer to "why can't I practise these cards" — so it lives here,
 * with the one cause a user can fix in bulk (`cards-disabled-rem`) opening a
 * list of the actual Rems, each shown as `front → back` with its clozes, ready
 * to be re-enabled.
 *
 * Only `cards-disabled-rem` is actionable from here on purpose. A paused deck
 * is undone by unpausing the deck, an ancestor tag by untagging the ancestor,
 * and `markup-removed` is not a switch at all — offering a "re-enable" button
 * for those would promise something it cannot do.
 */

import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  CardAnalyticsRow,
  computeCardAnalyticsBreakdown,
} from '../lib/card_analytics';
import {
  SuppressedRemEntry,
  SuppressionReport,
  UNSCHEDULED_CAUSE_LABELS,
  UNSCHEDULED_CAUSE_SHORT,
  UnscheduledCause,
  buildSuppressionReport,
  reEnableRems,
  resolveAnomalyRemContext,
} from '../lib/card_analytics_export';
import { CardPriorityInfo } from '../lib/card_priority/types';
import {
  allCardPriorityInfoKey,
  flashcardResponseTimeLimitId,
  fsrsWeightsId,
  suppressionReportKey,
} from '../lib/consts';
import { parseWeightsString } from '../lib/fsrs';
import { getPausedRemIds } from '../lib/paused_decks';
import { resolvePeriod } from '../lib/period';
import { getIESetting } from '../lib/settings';
import { formatTimeAgo } from '../lib/utils';

/** How many Rems get their context resolved. Matches the analytics export. */
const REM_CONTEXT_CAP = 5000;

/** The only cause this view can undo in bulk. */
const ACTIONABLE_CAUSE: UnscheduledCause = 'cards-disabled-rem';

const cell: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'right',
  fontSize: '11px',
  whiteSpace: 'nowrap',
};
const head: React.CSSProperties = {
  ...cell,
  fontWeight: 700,
  color: 'var(--rn-clr-content-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

function causeColor(cause: UnscheduledCause, empty: boolean): string | undefined {
  if (empty) return 'var(--rn-clr-content-tertiary)';
  if (cause === 'paused-document') return '#0ea5e9';
  if (cause === 'cards-disabled-table') return 'var(--rn-clr-content-secondary)';
  if (cause === ACTIONABLE_CAUSE) return '#a855f7';
  return 'var(--rn-clr-content-primary)';
}

// --- Drill-down -----------------------------------------------------------

function RemPicker({
  entries,
  title,
  busy,
  onClose,
  onReEnable,
}: {
  entries: SuppressedRemEntry[];
  title: string;
  busy: string | null;
  onClose: () => void;
  onReEnable: (remIds: string[]) => void;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const allSelected = entries.length > 0 && selected.size === entries.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.remId)));
  const toggleOne = (remId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(remId)) next.delete(remId);
      else next.add(remId);
      return next;
    });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--rn-clr-background-primary)',
          border: '1px solid var(--rn-clr-background-tertiary)',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '860px',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--rn-clr-background-tertiary)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: '13px' }}>{title}</div>
            <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
              {entries.length.toLocaleString()} Rem(s) · re-enabling makes their cards due
              immediately
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '15px',
              color: 'var(--rn-clr-content-tertiary)',
            }}
          >
            ✕
          </button>
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 14px',
            borderBottom: '1px solid var(--rn-clr-background-tertiary)',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: 'pointer' }} />
          Select all ({entries.length.toLocaleString()})
        </label>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {entries.map((e) => (
            <label
              key={e.remId}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                padding: '7px 14px',
                borderBottom: '1px solid var(--rn-clr-background-secondary)',
                fontSize: '11.5px',
                lineHeight: 1.5,
                cursor: 'pointer',
                background: selected.has(e.remId) ? 'rgba(59,130,246,0.07)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(e.remId)}
                onChange={() => toggleOne(e.remId)}
                style={{ marginTop: '3px', cursor: 'pointer' }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div>
                  <span>{e.text || '(no text)'}</span>
                  {e.backText && (
                    <>
                      <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> → </span>
                      <span>{e.backText}</span>
                    </>
                  )}
                </div>
                {e.clozeTexts.length > 0 && (
                  <div style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10.5px' }}>
                    clozes: {e.clozeTexts.map((c) => `{{${c}}}`).join(' · ')}
                  </div>
                )}
                <div style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10.5px' }}>
                  priority {e.priority} · {e.cards} card(s)
                  {e.newCards > 0 && `, ${e.newCards} never practised`}
                  {e.inTable && ' · in a table'}
                </div>
              </div>
            </label>
          ))}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--rn-clr-background-tertiary)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <span style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
            {busy ?? `${selected.size.toLocaleString()} selected`}
          </span>
          <button
            type="button"
            disabled={!!busy || selected.size === 0}
            onClick={() => onReEnable(Array.from(selected))}
            style={{
              padding: '5px 12px',
              fontSize: '11px',
              fontWeight: 700,
              borderRadius: '4px',
              border: '1px solid var(--rn-clr-background-tertiary)',
              background: selected.size > 0 ? '#3b82f6' : 'var(--rn-clr-background-secondary)',
              color: selected.size > 0 ? '#fff' : 'var(--rn-clr-content-tertiary)',
              cursor: busy || selected.size === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Re-enable {selected.size.toLocaleString()} Rem(s)
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Main view ------------------------------------------------------------

export function SuppressedCardsView() {
  const plugin = usePlugin();
  const [report, setReport] = React.useState<SuppressionReport | null>(null);
  const [state, setState] = React.useState<'idle' | 'computing' | 'ready'>('idle');
  const [phase, setPhase] = React.useState<string>('');
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [drill, setDrill] = React.useState<{ bucket: string; cause: UnscheduledCause } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const compute = React.useCallback(async () => {
    setError(null);
    setState('computing');
    setPhase('Replaying every card…');
    try {
      const [infos, weightsRaw, capSec] = await Promise.all([
        plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey),
        getIESetting(plugin, fsrsWeightsId),
        getIESetting(plugin, flashcardResponseTimeLimitId),
      ]);
      const weights = parseWeightsString(weightsRaw);
      const cardCapMs = ((capSec ?? 180) as number) * 1000;
      // Suppression is a property of the KB right now, not of a review window,
      // so this view always runs over the full history.
      const { startMs, endMs } = resolvePeriod('all', '', '');
      const pausedRemIds = await getPausedRemIds(plugin);

      const rows: CardAnalyticsRow[] = [];
      await computeCardAnalyticsBreakdown(
        plugin as any,
        infos ?? [],
        weights,
        cardCapMs,
        false,
        { id: 'all', startMs, endMs, customStart: '', customEnd: '' },
        (done, total) => setProgress({ done, total }),
        (row) => rows.push(row),
        pausedRemIds,
      );

      setPhase('Resolving Rems…');
      setProgress({ done: 0, total: 0 });
      const context = await resolveAnomalyRemContext(
        plugin as any,
        rows,
        REM_CONTEXT_CAP,
        (done, total) => setProgress({ done, total }),
      );

      const built = buildSuppressionReport(rows, context, !!pausedRemIds);
      await plugin.storage.setSession(suppressionReportKey, built);
      setReport(built);
      setState('ready');
    } catch (e: any) {
      console.error('[SuppressedCards] compute failed', e);
      setError(e?.message || String(e));
      setState('idle');
    } finally {
      setPhase('');
    }
  }, [plugin]);

  React.useEffect(() => {
    plugin.storage
      .getSession<SuppressionReport>(suppressionReportKey)
      .then((cached) => {
        if (cached?.entries) {
          setReport(cached);
          setState('ready');
        }
      })
      .catch(() => {});
  }, [plugin]);

  const handleReEnable = async (remIds: string[]) => {
    setBusy(`Re-enabling 0 / ${remIds.length}…`);
    try {
      const res = await reEnableRems(plugin as any, remIds, (done, total) =>
        setBusy(`Re-enabling ${done} / ${total}…`),
      );
      await plugin.app.toast(
        `Re-enabled ${res.enabled} Rem(s)` +
          (res.failed.length ? `, ${res.failed.length} failed` : '') +
          '. Recomputing…',
      );
      setDrill(null);
      setBusy(null);
      await compute();
    } catch (e: any) {
      console.error('[SuppressedCards] re-enable failed', e);
      await plugin.app.toast(`Re-enable failed: ${e?.message || String(e)}`);
      setBusy(null);
    }
  };

  if (state === 'computing') {
    const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
    return (
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>{phase}</div>
        <div
          style={{
            width: '100%',
            maxWidth: '420px',
            margin: '0 auto',
            height: '10px',
            borderRadius: '5px',
            background: 'var(--rn-clr-background-tertiary, #e5e7eb)',
            overflow: 'hidden',
          }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: '#3b82f6' }} />
        </div>
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
          {progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({pct.toFixed(0)}%)
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div style={{ padding: '24px', textAlign: 'center' }}>
        {error && (
          <div style={{ color: '#991b1b', fontSize: '12px', marginBottom: '10px' }}>{error}</div>
        )}
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-secondary)', marginBottom: '12px' }}>
          Breaks every card RemNote will not serve down by cause, bucket by bucket — and lets you
          re-enable the ones that were switched off on their Rem.
        </div>
        <button
          type="button"
          onClick={compute}
          style={{
            padding: '6px 14px',
            fontSize: '12px',
            fontWeight: 700,
            borderRadius: '4px',
            border: '1px solid var(--rn-clr-background-tertiary)',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            cursor: 'pointer',
          }}
        >
          Compute breakdown
        </button>
      </div>
    );
  }

  const { summary } = report;
  const suppressedTotal = summary.unscheduledTotal + summary.pausedTotal;
  const drillEntries = drill
    ? report.entries.filter((e) => e.bucket === drill.bucket && e.cause === drill.cause)
    : [];

  return (
    <div style={{ paddingTop: '4px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          marginBottom: '10px',
          padding: '8px 12px',
          borderRadius: '6px',
          background: 'var(--rn-clr-background-secondary)',
          border: '1px solid var(--rn-clr-background-tertiary)',
          fontSize: '11px',
        }}
      >
        <div style={{ color: 'var(--rn-clr-content-secondary)' }}>
          <strong>{suppressedTotal.toLocaleString()}</strong> of{' '}
          {summary.totalCards.toLocaleString()} card records are suppressed (
          {summary.unscheduledTotal.toLocaleString()} unscheduled +{' '}
          {summary.pausedTotal.toLocaleString()} paused) · computed{' '}
          {formatTimeAgo(report.computedAt)}
          {!report.pausedScanApplied && (
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>
              {' '}
              · paused decks not scanned
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={compute}
          style={{
            padding: '4px 10px',
            fontSize: '11px',
            fontWeight: 600,
            borderRadius: '4px',
            border: '1px solid var(--rn-clr-background-tertiary)',
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            cursor: 'pointer',
          }}
        >
          ↻ Recompute
        </button>
      </div>

      <div style={{ marginBottom: '10px', fontSize: '11px', lineHeight: 1.7 }}>
        {summary.causes.map((c) => (
          <div key={c.cause} style={{ color: 'var(--rn-clr-content-secondary)' }}>
            · {c.label}: <strong style={{ color: causeColor(c.cause, false) }}>
              {c.cards.toLocaleString()}
            </strong>{' '}
            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              ({c.newCards.toLocaleString()} never practised)
            </span>
          </div>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--rn-clr-background-tertiary)' }}>
              <th style={{ ...head, textAlign: 'left' }}>Bucket</th>
              <th style={head}>Cards</th>
              <th style={head}>Suppressed</th>
              {summary.causes.map((c) => (
                <th key={c.cause} style={head} title={c.label}>
                  {UNSCHEDULED_CAUSE_SHORT[c.cause]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.perBucket.map((b, i) => {
              const suppressed = summary.causes.reduce(
                (sum, c) => sum + (b.causeCounts[c.cause] ?? 0),
                0,
              );
              return (
                <tr
                  key={b.bucket}
                  style={{
                    background: i % 2 === 0 ? 'transparent' : 'var(--rn-clr-background-secondary)',
                    borderBottom: '1px solid var(--rn-clr-background-tertiary)',
                  }}
                >
                  <td style={{ ...cell, textAlign: 'left', fontWeight: 500 }}>{b.bucket}</td>
                  <td style={{ ...cell, color: 'var(--rn-clr-content-tertiary)' }}>
                    {b.cards.toLocaleString()}
                  </td>
                  <td style={{ ...cell, fontWeight: 700 }}>
                    {suppressed.toLocaleString()}
                    {b.cards > 0 && (
                      <span style={{ color: 'var(--rn-clr-content-tertiary)', fontWeight: 400 }}>
                        {' '}
                        ({((suppressed / b.cards) * 100).toFixed(0)}%)
                      </span>
                    )}
                  </td>
                  {summary.causes.map((c) => {
                    const n = b.causeCounts[c.cause] ?? 0;
                    const actionable = c.cause === ACTIONABLE_CAUSE && n > 0;
                    return (
                      <td key={c.cause} style={{ ...cell, color: causeColor(c.cause, n === 0) }}>
                        {n === 0 ? '·' : n.toLocaleString()}
                        {actionable && (
                          <button
                            type="button"
                            onClick={() => setDrill({ bucket: b.bucket, cause: c.cause })}
                            title="List these Rems and re-enable the ones you want"
                            style={{
                              marginLeft: '5px',
                              padding: '0 5px',
                              fontSize: '10px',
                              fontWeight: 700,
                              borderRadius: '3px',
                              border: '1px solid #a855f7',
                              background: 'transparent',
                              color: '#a855f7',
                              cursor: 'pointer',
                            }}
                          >
                            ▸
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr style={{ borderTop: '2px solid var(--rn-clr-background-tertiary)', fontWeight: 700 }}>
              <td style={{ ...cell, textAlign: 'left' }}>All KB</td>
              <td style={{ ...cell, color: 'var(--rn-clr-content-tertiary)' }}>
                {summary.totalCards.toLocaleString()}
              </td>
              <td style={cell}>{suppressedTotal.toLocaleString()}</td>
              {summary.causes.map((c) => (
                <td key={c.cause} style={{ ...cell, color: causeColor(c.cause, false) }}>
                  {c.cards.toLocaleString()}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: '10px',
          fontSize: '10.5px',
          color: 'var(--rn-clr-content-tertiary)',
          lineHeight: 1.6,
        }}
      >
        <strong>▸</strong> opens the Rems behind a count. Only{' '}
        <em>{UNSCHEDULED_CAUSE_LABELS[ACTIONABLE_CAUSE]}</em> is offered, because it is the only
        cause undone by a per-Rem switch: a paused deck is unpaused on the deck, an inherited tag
        is removed from the ancestor, and a deleted cloze is not a switch at all. Re-enabling
        makes those cards due immediately — work through the high-priority buckets first rather
        than selecting everything at once.
      </div>

      {drill && (
        <RemPicker
          entries={drillEntries}
          title={`${UNSCHEDULED_CAUSE_LABELS[drill.cause]} · bucket ${drill.bucket}`}
          busy={busy}
          onClose={() => setDrill(null)}
          onReEnable={handleReEnable}
        />
      )}
    </div>
  );
}
