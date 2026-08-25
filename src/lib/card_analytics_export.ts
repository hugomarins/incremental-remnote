/**
 * Per-card export for the Card Priority × Memory Analytics tab.
 *
 * The table shows aggregates; this turns the same population into one CSV row
 * per card so a bucket's %New / Due discrepancy can be traced to individual
 * cards. Rows come straight from `computeCardAnalyticsBreakdown`'s `onRow`
 * sink, so the New / Due / Stale predicates and the bucketing are the table's,
 * not a re-implementation.
 *
 * On top of the raw rows it adds:
 *  - per-Rem rollups (how many of the Rem's cards are unscheduled / due),
 *  - a diagnosis summary (the New × schedule-state matrix, overall and per
 *    bucket), which is what answers "why is this bucket 2% New but 0 due?",
 *  - lazily resolved Rem context (text, paused-document flag, and the
 *    `rem.getCards()` count) for a capped set of the most interesting Rems —
 *    the expensive part, so it only runs for cards that are New-but-not-due.
 */

import { RNPlugin, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { CardAnalyticsRow } from './card_analytics';
import { safeRemTextToString } from './pdfUtils';

/** Extra per-Rem context, resolved only for the capped anomaly set. */
export interface RemContext {
  text: string;
  /** `rem.getPracticeDirection()` — 'none' means the Rem generates no cards at all. */
  practiceDirection: 'forward' | 'backward' | 'none' | 'both' | null;
  /** The Rem itself carries the built-in Disable Cards powerup. */
  disableCardsOwn: boolean;
  /** An ancestor carries Disable Cards, which suppresses the whole subtree. */
  disableCardsAncestor: boolean;
  /** Cards this Rem reports through `rem.getCards()`. A value BELOW the number
   *  of cards `card.getAll()` returned for the same Rem means at least one
   *  practice direction is disabled — RemNote drops disabled directions from
   *  `rem.getCards()` while `card.getAll()` still returns them. */
  cardsViaGetCards: number | null;
  /** True when an ancestor carries the Deck powerup with Status = "Paused". */
  inPausedDocument: boolean;
  /** True when the Rem itself is missing (deleted / not resolvable). */
  missing: boolean;
}

/**
 * Why an unscheduled card is unscheduled. Ordered from "a setting you can flip"
 * to "the Rem simply doesn't make this card any more".
 */
export type UnscheduledCause =
  | 'paused-document'
  | 'cards-disabled'
  | 'practice-direction-none'
  | 'direction-not-generated'
  | 'no-cards-generated'
  | 'rem-missing'
  | 'unresolved';

export const UNSCHEDULED_CAUSE_LABELS: Record<UnscheduledCause, string> = {
  'paused-document': 'Inside a paused deck',
  'cards-disabled': 'Cards disabled (own or inherited tag)',
  'practice-direction-none': 'Practice direction = none',
  'direction-not-generated': 'This direction is no longer generated',
  'no-cards-generated': 'Rem generates no cards at all (orphaned card record)',
  'rem-missing': 'Owning Rem not found',
  unresolved: 'Not resolved (outside the Rem-context cap)',
};

/**
 * Classify one unscheduled card. `remCardsInPopulation` is how many cards
 * `card.getAll()` returned for the Rem; `cardsViaGetCards` is how many the Rem
 * itself still generates. Fewer generated than stored means the stored card no
 * longer corresponds to anything RemNote will schedule.
 */
export function classifyUnscheduled(
  ctx: RemContext | undefined,
  remCardsInPopulation: number,
): UnscheduledCause {
  if (!ctx) return 'unresolved';
  if (ctx.missing) return 'rem-missing';
  if (ctx.inPausedDocument) return 'paused-document';
  if (ctx.disableCardsOwn || ctx.disableCardsAncestor) return 'cards-disabled';
  if (ctx.practiceDirection === 'none') return 'practice-direction-none';
  if (ctx.cardsViaGetCards === 0) return 'no-cards-generated';
  if (ctx.cardsViaGetCards !== null && ctx.cardsViaGetCards < remCardsInPopulation) {
    return 'direction-not-generated';
  }
  return 'unresolved';
}

export interface ExportSummary {
  totalCards: number;
  /** Cards counted as New by the table (no gradeable rep in the effective history). */
  newCards: number;
  dueCards: number;
  /** The interesting cell: New but NOT due — invisible to the queue and to the PRD. */
  newNotDue: number;
  /** Of `newNotDue`, how many have no `nextRepetitionTime` at all. */
  newUnscheduled: number;
  /** Of `newNotDue`, how many are scheduled into the future. */
  newScheduledAhead: number;
  /** Non-new cards with no `nextRepetitionTime` — practised once, now parked. */
  reviewedUnscheduled: number;
  /** New-but-not-due cards whose history is non-empty (skipped / reset, never graded). */
  newWithSomeHistory: number;
  /** Every unscheduled card (New or reviewed) — the queue can reach none of them. */
  unscheduledTotal: number;
  /** Unscheduled cards by cause, most common first. Requires resolved Rem context. */
  causes: Array<{ cause: UnscheduledCause; label: string; cards: number; newCards: number }>;
  /** Per-bucket version of the same matrix, in table order. */
  perBucket: Array<{
    bucket: string;
    cards: number;
    newCards: number;
    dueCards: number;
    newNotDue: number;
    newUnscheduled: number;
    newScheduledAhead: number;
  }>;
}

/** Rollup of one Rem's cards inside the analysed population. */
interface RemRollup {
  cards: number;
  unscheduled: number;
  due: number;
  newCards: number;
}

function rollupByRem(rows: CardAnalyticsRow[]): Map<string, RemRollup> {
  const map = new Map<string, RemRollup>();
  for (const r of rows) {
    let e = map.get(r.remId);
    if (!e) {
      e = { cards: 0, unscheduled: 0, due: 0, newCards: 0 };
      map.set(r.remId, e);
    }
    e.cards++;
    if (r.scheduleState === 'unscheduled') e.unscheduled++;
    if (r.isDue) e.due++;
    if (r.isNew) e.newCards++;
  }
  return map;
}

export function summarizeRows(
  rows: CardAnalyticsRow[],
  context?: Map<string, RemContext>,
): ExportSummary {
  const rollups = rollupByRem(rows);
  const causeCounts = new Map<UnscheduledCause, { cards: number; newCards: number }>();
  const perBucketMap = new Map<string, ExportSummary['perBucket'][number]>();
  const summary: ExportSummary = {
    totalCards: rows.length,
    newCards: 0,
    dueCards: 0,
    newNotDue: 0,
    newUnscheduled: 0,
    newScheduledAhead: 0,
    reviewedUnscheduled: 0,
    newWithSomeHistory: 0,
    unscheduledTotal: 0,
    causes: [],
    perBucket: [],
  };

  for (const r of rows) {
    let b = perBucketMap.get(r.bucket);
    if (!b) {
      b = {
        bucket: r.bucket,
        cards: 0,
        newCards: 0,
        dueCards: 0,
        newNotDue: 0,
        newUnscheduled: 0,
        newScheduledAhead: 0,
      };
      perBucketMap.set(r.bucket, b);
    }
    b.cards++;
    if (r.isNew) {
      summary.newCards++;
      b.newCards++;
    }
    if (r.isDue) {
      summary.dueCards++;
      b.dueCards++;
    }
    if (r.isNew && !r.isDue) {
      summary.newNotDue++;
      b.newNotDue++;
      if (r.scheduleState === 'unscheduled') {
        summary.newUnscheduled++;
        b.newUnscheduled++;
      } else {
        summary.newScheduledAhead++;
        b.newScheduledAhead++;
      }
      if (r.historyEntries > 0) summary.newWithSomeHistory++;
    }
    if (!r.isNew && r.scheduleState === 'unscheduled') summary.reviewedUnscheduled++;

    if (r.scheduleState === 'unscheduled') {
      summary.unscheduledTotal++;
      const cause = classifyUnscheduled(context?.get(r.remId), rollups.get(r.remId)!.cards);
      const entry = causeCounts.get(cause) ?? { cards: 0, newCards: 0 };
      entry.cards++;
      if (r.isNew) entry.newCards++;
      causeCounts.set(cause, entry);
    }
  }

  summary.causes = Array.from(causeCounts.entries())
    .map(([cause, v]) => ({ cause, label: UNSCHEDULED_CAUSE_LABELS[cause], ...v }))
    .sort((a, b) => b.cards - a.cards);

  // Numeric bucket order ("0-10%" … "90-100%") rather than insertion order.
  summary.perBucket = Array.from(perBucketMap.values()).sort(
    (a, b) => parseInt(a.bucket, 10) - parseInt(b.bucket, 10),
  );
  return summary;
}

interface AncestorFacts {
  /** First Deck ancestor has Status = "Paused". */
  paused: boolean;
  /** Some ancestor carries the Disable Cards powerup. */
  disableCards: boolean;
}

/**
 * Walks the ancestor chain once, collecting both facts that can silence a
 * Rem's cards from above: a paused Deck, and an inherited Disable Cards tag.
 * `card.getAll()` returns cards for both states, so the ancestor walk is the
 * only reliable signal — the same check the Priority Review Document makes.
 *
 * Results are memoized per ancestor Rem: siblings share chains, and without
 * the cache a few thousand walks saturate the plugin IPC bridge.
 */
async function ancestorFacts(rem: any, cache: Map<string, AncestorFacts>): Promise<AncestorFacts> {
  const chain: string[] = [];
  let cursor = await rem.getParentRem();
  let hops = 0;
  let result: AncestorFacts = { paused: false, disableCards: false };

  while (cursor && hops < 64) {
    const cached = cache.get(cursor._id);
    if (cached) {
      result = cached;
      break;
    }
    chain.push(cursor._id);
    if (await cursor.hasPowerup(BuiltInPowerupCodes.DisableCards)) {
      result.disableCards = true;
    }
    if (!result.paused && (await cursor.hasPowerup(BuiltInPowerupCodes.Deck))) {
      const status = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
      if (status === 'Paused') result.paused = true;
    }
    cursor = await cursor.getParentRem();
    hops++;
  }
  // Every Rem on the walked chain shares the outcome of the chain above it.
  for (const id of chain) cache.set(id, result);
  return result;
}

/**
 * Resolve Rem context for every Rem that owns at least one UNSCHEDULED card —
 * the cards with no `nextRepetitionTime`, whatever their New/reviewed status.
 * Those are precisely the cards the queue and the Priority Review Document can
 * never surface, so they are the ones worth the IPC cost. Most important
 * (lowest priority number) first, capped at `maxRems`.
 */
export async function resolveAnomalyRemContext(
  plugin: RNPlugin,
  rows: CardAnalyticsRow[],
  maxRems: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, RemContext>> {
  const byRem = new Map<string, number>(); // remId -> best (lowest) priority
  for (const r of rows) {
    if (r.scheduleState !== 'unscheduled') continue;
    const prev = byRem.get(r.remId);
    if (prev === undefined || r.priority < prev) byRem.set(r.remId, r.priority);
  }
  const targets = Array.from(byRem.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, maxRems)
    .map(([remId]) => remId);

  const missingContext = (): RemContext => ({
    text: '',
    practiceDirection: null,
    disableCardsOwn: false,
    disableCardsAncestor: false,
    cardsViaGetCards: null,
    inPausedDocument: false,
    missing: true,
  });

  const out = new Map<string, RemContext>();
  const ancestorCache = new Map<string, AncestorFacts>();
  for (let i = 0; i < targets.length; i++) {
    const remId = targets[i];
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        out.set(remId, missingContext());
      } else {
        const [text, cards, direction, disableOwn, ancestors] = await Promise.all([
          safeRemTextToString(plugin, rem.text),
          rem.getCards().catch(() => null),
          rem.getPracticeDirection().catch(() => null),
          rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
          ancestorFacts(rem, ancestorCache).catch(() => ({ paused: false, disableCards: false })),
        ]);
        out.set(remId, {
          text,
          practiceDirection: direction as RemContext['practiceDirection'],
          disableCardsOwn: !!disableOwn,
          disableCardsAncestor: ancestors.disableCards,
          cardsViaGetCards: cards ? cards.length : null,
          inPausedDocument: ancestors.paused,
          missing: false,
        });
      }
    } catch {
      out.set(remId, missingContext());
    }
    if (onProgress && (i + 1) % 25 === 0) {
      onProgress(i + 1, targets.length);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (onProgress) onProgress(targets.length, targets.length);
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function iso(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

const CSV_COLUMNS = [
  'cardId',
  'remId',
  'cardType',
  'priority',
  'percentile',
  'bucket',
  'isNew',
  'isDue',
  'isStale',
  'scheduleState',
  'nextRepetitionTime',
  'nextRepetitionTimeMs',
  'createdAt',
  'historyEntries',
  'gradeableRepsLifetime',
  'gradeableRepsEffective',
  'nonGradeableInteractions',
  'hasReset',
  'lastScore',
  'lastInteractionDate',
  'remCardsInPopulation',
  'remCardsUnscheduled',
  'remCardsDue',
  'remCardsNew',
  'remCardsViaGetCards',
  'remPracticeDirection',
  'remCardsDisabled',
  'remInPausedDocument',
  'unscheduledCause',
  'remText',
] as const;

/**
 * Serialize every row, joining in the per-Rem rollups and whatever Rem context
 * was resolved. Context columns stay blank for Rems outside the resolved cap.
 */
export function rowsToCsv(rows: CardAnalyticsRow[], context: Map<string, RemContext>): string {
  const rollups = rollupByRem(rows);
  const lines: string[] = [CSV_COLUMNS.join(',')];

  for (const r of rows) {
    const roll = rollups.get(r.remId)!;
    const ctx = context.get(r.remId);
    const cardsDisabled = ctx && !ctx.missing ? ctx.disableCardsOwn || ctx.disableCardsAncestor : '';
    const cause =
      r.scheduleState === 'unscheduled' ? classifyUnscheduled(ctx, roll.cards) : '';
    lines.push(
      [
        r.cardId,
        r.remId,
        r.cardType,
        r.priority,
        r.percentile.toFixed(3),
        r.bucket,
        r.isNew,
        r.isDue,
        r.isStale,
        r.scheduleState,
        iso(r.nextRepetitionTime),
        r.nextRepetitionTime ?? '',
        iso(r.createdAt),
        r.historyEntries,
        r.gradeableRepsLifetime,
        r.gradeableRepsEffective,
        r.nonGradeableInteractions,
        r.hasReset,
        r.lastScore ?? '',
        iso(r.lastInteractionDate),
        roll.cards,
        roll.unscheduled,
        roll.due,
        roll.newCards,
        ctx?.cardsViaGetCards ?? '',
        ctx?.practiceDirection ?? '',
        cardsDisabled,
        ctx ? ctx.inPausedDocument : '',
        cause,
        ctx?.text ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

/** Human-readable diagnosis, mirrored into the console and the download. */
export function summaryToText(summary: ExportSummary, meta: string): string {
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
  const lines = [
    `Card analytics export — ${meta}`,
    ``,
    `Cards analysed:              ${summary.totalCards.toLocaleString()}`,
    `New (no gradeable rep):      ${summary.newCards.toLocaleString()} (${pct(summary.newCards, summary.totalCards)})`,
    `Due (nextRepetitionTime≤now):${summary.dueCards.toLocaleString()}`,
    ``,
    `New AND NOT due:             ${summary.newNotDue.toLocaleString()}`,
    `  · no nextRepetitionTime:   ${summary.newUnscheduled.toLocaleString()}  ← unreachable by the queue and the Priority Review Document`,
    `  · scheduled into future:   ${summary.newScheduledAhead.toLocaleString()}`,
    `  · with some history:       ${summary.newWithSomeHistory.toLocaleString()}  (interacted with, never graded: skipped / reset)`,
    ``,
    `Reviewed but unscheduled:    ${summary.reviewedUnscheduled.toLocaleString()}`,
    ``,
    `All unscheduled cards:       ${summary.unscheduledTotal.toLocaleString()} (${pct(summary.unscheduledTotal, summary.totalCards)} of the population) — by cause:`,
    ...summary.causes.map(
      (c) =>
        `  · ${c.label.padEnd(52)} ${String(c.cards).padStart(6)}  (${c.newCards.toLocaleString()} of them New)`,
    ),
    ``,
    `Per bucket:`,
    `bucket        cards     new     due  new&notDue  newUnscheduled  newAhead`,
    ...summary.perBucket.map((b) =>
      [
        b.bucket.padEnd(12),
        String(b.cards).padStart(6),
        String(b.newCards).padStart(7),
        String(b.dueCards).padStart(7),
        String(b.newNotDue).padStart(11),
        String(b.newUnscheduled).padStart(15),
        String(b.newScheduledAhead).padStart(9),
      ].join(' '),
    ),
  ];
  return lines.join('\n');
}

/** Trigger a browser download of `content` under `filename`. */
export function downloadText(content: string, filename: string, mime = 'text/csv') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
