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

/**
 * Collect every cloze id present in a Rem's rich text. Cloze markup is carried
 * on rich-text elements as `cId` (plus `blocks` for image clozes, `clozeOrder`
 * and `latexClozes`), so the ids here are exactly the clozes the Rem currently
 * defines. Comparing them against a card's `type.clozeId` answers the one
 * question `rem.getCards()` cannot: is this card's markup still in the text?
 */
export function collectClozeIds(richText: any): Set<string> {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) ids.add(v);
  };
  const visit = (node: any, depth: number) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.cId)) node.cId.forEach(add);
    else add(node.cId);
    if (Array.isArray(node.clozeOrder)) {
      for (const c of node.clozeOrder) {
        if (typeof c === 'string') add(c);
        else visit(c, depth + 1);
      }
    }
    if (Array.isArray(node.latexClozes)) node.latexClozes.forEach(add);
    if (Array.isArray(node.blocks)) visit(node.blocks, depth + 1);
    if (Array.isArray(node.text)) visit(node.text, depth + 1);
  };
  visit(richText, 0);
  return ids;
}

/**
 * Does the Rem still define the markup this card was generated from?
 *
 * - cloze card: its cloze id must still appear in the Rem's text.
 * - forward / backward card: the Rem must still have a back side.
 *
 * `null` means we cannot tell (unknown card type, or context not resolved).
 * This is the signal that separates a card the user switched off ONE AT A TIME
 * in the queue — markup intact, card simply not surfaced — from a card whose
 * cloze or descriptor was edited away.
 */
export function markupStillPresent(
  ctx: Pick<RemContext, 'clozeIds' | 'hasBackText'>,
  cardType: string,
  clozeId: string | null,
): boolean | null {
  if (cardType === 'cloze') {
    if (!clozeId) return null;
    return ctx.clozeIds.includes(clozeId);
  }
  if (cardType === 'forward' || cardType === 'backward') return ctx.hasBackText;
  return null;
}

/**
 * Is this card's practice direction currently enabled on the Rem?
 *
 * Only meaningful for forward / backward cards — cloze cards are independent of
 * the practice direction and are governed per card.
 *
 * Measured: disabling a DIRECTION card in the queue does not just hide that
 * card, it rewrites the Rem's practice direction ('both' → 'forward' when the
 * backward card is switched off). So unlike a disabled cloze, a disabled
 * direction DOES leave a Rem-level trace — and the way back is
 * `setPracticeDirection`, not a per-card action.
 */
export function directionEnabled(
  practiceDirection: RemContext['practiceDirection'],
  cardType: string,
): boolean | null {
  if (cardType !== 'forward' && cardType !== 'backward') return null;
  if (practiceDirection === null) return null;
  if (practiceDirection === 'both') return true;
  return practiceDirection === cardType;
}

/** Extra per-Rem context, resolved only for the capped anomaly set. */
export interface RemContext {
  text: string;
  /**
   * `rem.getEnablePractice()` — RemNote's own answer to "does this Rem generate
   * flashcards for the queue?". This is the per-Rem "Enable Cards" toggle in the
   * flashcard menu, and the signal that distinguishes a card the user switched
   * off from one the Rem genuinely no longer produces.
   */
  enablePractice: boolean | null;
  /** `rem.getPracticeDirection()` — the Rem's enabled practice directions. */
  practiceDirection: 'forward' | 'backward' | 'none' | 'both' | null;
  /** The Rem itself carries the built-in Disable Cards powerup. */
  disableCardsOwn: boolean;
  /** An ancestor carries Disable Cards, which suppresses the whole subtree. */
  disableCardsAncestor: boolean;
  /** Nearest such ancestor — the Rem to untag to re-enable the subtree. */
  disablingAncestorId: string | null;
  /** Cloze ids the Rem's text currently defines. */
  clozeIds: string[];
  /** Whether the Rem still has a back side (what a forward/backward card needs). */
  hasBackText: boolean;
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
 * Why an unscheduled card is unscheduled.
 *
 * Important: `rem.getCards()` returning 0 does NOT mean the card record is
 * junk. RemNote drops DISABLED cards from `rem.getCards()` while `card.getAll()`
 * still returns them, so a card the user deliberately switched off looks
 * identical to one whose Rem no longer produces it. Only `getEnablePractice()`,
 * the practice direction and the ancestor tag can tell those apart, which is
 * why `no-cards-generated` is the last resort here, not the first guess.
 */
export type UnscheduledCause =
  | 'paused-document'
  | 'cards-disabled-ancestor'
  | 'cards-disabled-rem'
  | 'direction-disabled'
  | 'card-disabled-individually'
  | 'markup-removed'
  | 'not-surfaced-unknown'
  | 'rem-missing'
  | 'unresolved';

/**
 * Column headers for the bucket × cause matrix. Distinct within 13 characters —
 * truncating the slugs collided `cards-disabled-rem` with `cards-disabled-ancestor`.
 */
export const UNSCHEDULED_CAUSE_SHORT: Record<UnscheduledCause, string> = {
  'paused-document': 'paused-deck',
  'cards-disabled-ancestor': 'off-ancestor',
  'cards-disabled-rem': 'off-rem',
  'direction-disabled': 'dir-off',
  'card-disabled-individually': 'off-card',
  'markup-removed': 'markup-gone',
  'not-surfaced-unknown': 'unknown',
  'rem-missing': 'rem-missing',
  unresolved: 'unresolved',
};

export const UNSCHEDULED_CAUSE_LABELS: Record<UnscheduledCause, string> = {
  'paused-document': 'Inside a paused deck',
  'cards-disabled-ancestor': 'Disabled by an ancestor’s “Disable Descendant Cards”',
  'cards-disabled-rem': 'Cards switched off on the Rem itself',
  'direction-disabled': 'This direction is switched off on the Rem',
  'card-disabled-individually': 'This single card switched off (markup still present)',
  'markup-removed': 'The cloze / back side this card came from is gone',
  'not-surfaced-unknown': 'Not surfaced — cause undetermined',
  'rem-missing': 'Owning Rem not found',
  unresolved: 'Not resolved (outside the Rem-context cap)',
};

/**
 * Classify one unscheduled card, most actionable cause first. `remCardsInPopulation`
 * is how many cards `card.getAll()` returned for the Rem; `cardsViaGetCards` is how
 * many the Rem still surfaces.
 */
export function classifyUnscheduled(
  ctx: RemContext | undefined,
  card: Pick<CardAnalyticsRow, 'cardType' | 'clozeId'>,
): UnscheduledCause {
  if (!ctx) return 'unresolved';
  if (ctx.missing) return 'rem-missing';
  // Rem-wide suppressions first: they explain every card on the Rem at once.
  if (ctx.inPausedDocument) return 'paused-document';
  if (ctx.disableCardsAncestor) return 'cards-disabled-ancestor';
  if (ctx.disableCardsOwn || ctx.enablePractice === false) return 'cards-disabled-rem';
  // Forward / backward cards are governed by the Rem's practice direction, and
  // switching one off in the queue rewrites that direction. Cloze cards are NOT
  // affected by it, so this test is scoped to direction cards only.
  if (directionEnabled(ctx.practiceDirection, card.cardType) === false) {
    return 'direction-disabled';
  }
  // Rem is enabled and this card's direction (if any) is on, so this is about
  // THIS card. Its markup decides: still in the text ⇒ the user switched this
  // one card off in the queue; gone ⇒ the Rem no longer produces it. Card counts
  // cannot separate these — a Rem whose cards were all individually disabled
  // reports zero from getCards(), exactly like a Rem whose markup was deleted.
  const present = markupStillPresent(ctx, card.cardType, card.clozeId);
  if (present === true) return 'card-disabled-individually';
  if (present === false) return 'markup-removed';
  return 'not-surfaced-unknown';
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
    /** Unscheduled cards in this bucket by cause — which lever applies where. */
    causeCounts: Partial<Record<UnscheduledCause, number>>;
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
        causeCounts: {},
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
      const cause = classifyUnscheduled(context?.get(r.remId), r);
      const entry = causeCounts.get(cause) ?? { cards: 0, newCards: 0 };
      entry.cards++;
      if (r.isNew) entry.newCards++;
      causeCounts.set(cause, entry);
      b.causeCounts[cause] = (b.causeCounts[cause] ?? 0) + 1;
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
  /** Nearest Deck ancestor has Status = "Paused". */
  paused: boolean;
  /** Some ancestor carries the Disable Cards powerup ("Disable Descendant Cards"). */
  disableCards: boolean;
  /** Id of the nearest ancestor carrying it — what the user has to go and untag. */
  disablingAncestorId: string | null;
}

/**
 * Walks the ancestor chain once, collecting both facts that can silence a
 * Rem's cards from above: a paused Deck, and an inherited "Disable Descendant
 * Cards" tag. `card.getAll()` returns cards in both states, so the walk is the
 * only way to see them.
 *
 * Results are memoized per ancestor, since siblings share chains and a few
 * thousand un-memoized walks saturate the plugin IPC bridge. The memo stores,
 * for each node, the facts of the chain *from that node upward* — so the walk
 * collects each node's own flags first and then folds top-down. Folding matters:
 * a tag found near the leaf must not be attributed to the ancestors above it,
 * and a cache hit higher up must not erase a tag already found below it.
 */
async function ancestorFacts(rem: any, cache: Map<string, AncestorFacts>): Promise<AncestorFacts> {
  const chain: Array<{ id: string; ownDisable: boolean; ownDeckPaused: boolean | null }> = [];
  let cursor = await rem.getParentRem();
  let hops = 0;
  let base: AncestorFacts = { paused: false, disableCards: false, disablingAncestorId: null };

  while (cursor && hops < 64) {
    const cached = cache.get(cursor._id);
    if (cached) {
      base = cached;
      break;
    }
    const [ownDisable, isDeck] = await Promise.all([
      cursor.hasPowerup(BuiltInPowerupCodes.DisableCards),
      cursor.hasPowerup(BuiltInPowerupCodes.Deck),
    ]);
    let ownDeckPaused: boolean | null = null;
    if (isDeck) {
      const status = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
      ownDeckPaused = status === 'Paused';
    }
    chain.push({ id: cursor._id, ownDisable: !!ownDisable, ownDeckPaused });
    cursor = await cursor.getParentRem();
    hops++;
  }

  // Fold from the top of the walked chain back down, memoizing each node.
  let acc = base;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    acc = {
      disableCards: acc.disableCards || node.ownDisable,
      // Nearest Deck wins — a paused sub-deck under an active one is paused,
      // and an active sub-deck under a paused one is not.
      paused: node.ownDeckPaused !== null ? node.ownDeckPaused : acc.paused,
      disablingAncestorId: node.ownDisable ? node.id : acc.disablingAncestorId,
    };
    cache.set(node.id, acc);
  }
  return acc;
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
    enablePractice: null,
    practiceDirection: null,
    disableCardsOwn: false,
    disableCardsAncestor: false,
    disablingAncestorId: null,
    clozeIds: [],
    hasBackText: false,
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
        const [text, cards, enablePractice, direction, disableOwn, ancestors] = await Promise.all([
          safeRemTextToString(plugin, rem.text),
          rem.getCards().catch(() => null),
          rem.getEnablePractice().catch(() => null),
          rem.getPracticeDirection().catch(() => null),
          rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
          ancestorFacts(rem, ancestorCache).catch(
            (): AncestorFacts => ({ paused: false, disableCards: false, disablingAncestorId: null }),
          ),
        ]);
        out.set(remId, {
          text,
          enablePractice: enablePractice as boolean | null,
          practiceDirection: direction as RemContext['practiceDirection'],
          disableCardsOwn: !!disableOwn,
          disableCardsAncestor: ancestors.disableCards,
          disablingAncestorId: ancestors.disablingAncestorId,
          clozeIds: Array.from(collectClozeIds(rem.text)),
          hasBackText: Array.isArray(rem.backText) && rem.backText.length > 0,
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
  'remEnablePractice',
  'remPracticeDirection',
  'remDisableCardsOwn',
  'remDisableCardsAncestor',
  'remDisablingAncestorId',
  'remInPausedDocument',
  'clozeId',
  'markupStillPresent',
  'directionEnabled',
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
    const cause = r.scheduleState === 'unscheduled' ? classifyUnscheduled(ctx, r) : '';
    const markup = ctx ? markupStillPresent(ctx, r.cardType, r.clozeId) : null;
    const dirEnabled = ctx ? directionEnabled(ctx.practiceDirection, r.cardType) : null;
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
        ctx && ctx.enablePractice !== null ? ctx.enablePractice : '',
        ctx?.practiceDirection ?? '',
        ctx && !ctx.missing ? ctx.disableCardsOwn : '',
        ctx && !ctx.missing ? ctx.disableCardsAncestor : '',
        ctx?.disablingAncestorId ?? '',
        ctx ? ctx.inPausedDocument : '',
        r.clozeId ?? '',
        markup === null ? '' : markup,
        dirEnabled === null ? '' : dirEnabled,
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
    ...(summary.causes.length > 0
      ? [
          `Unscheduled by bucket × cause:`,
          [
            'bucket'.padEnd(12),
            ...summary.causes.map((c) => UNSCHEDULED_CAUSE_SHORT[c.cause].padStart(13)),
          ].join(' '),
          ...summary.perBucket.map((b) =>
            [
              b.bucket.padEnd(12),
              ...summary.causes.map((c) => String(b.causeCounts[c.cause] ?? 0).padStart(13)),
            ].join(' '),
          ),
          [
            'TOTAL'.padEnd(12),
            ...summary.causes.map((c) => String(c.cards).padStart(13)),
          ].join(' '),
          ``,
        ]
      : []),
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

// --- Single-Rem enablement probe ------------------------------------------
//
// The export classifies thousands of cards from a handful of signals; this
// prints every one of those signals for ONE Rem so the classification can be
// checked against what RemNote's own UI says about it. Read-only.

export interface RemEnablementProbe {
  remId: string;
  text: string;
  /** RemNote's own "does this Rem generate flashcards" answer. */
  enablePractice: boolean | null;
  practiceDirection: string | null;
  /** Cards the Rem surfaces — disabled cards are NOT included here. */
  cardsViaGetCards: number;
  /** Card records that exist for this Rem in the card table. */
  cardsViaGetAll: number;
  disableCardsOwn: boolean;
  /** Cloze ids the Rem's text currently defines. */
  clozeIds: string[];
  hasBackText: boolean;
  /** Raw keys on the card object — used to look for undocumented state (e.g. a
   *  surviving `nextTime` next to a nulled `activeNextTime`). */
  rawCardKeys: string[];
  /** Ancestor chain, nearest first, with the flags that silence a subtree. */
  ancestors: Array<{
    remId: string;
    text: string;
    disableCards: boolean;
    deckStatus: string | null;
  }>;
  cards: Array<{
    cardId: string;
    type: string;
    inGetCards: boolean;
    nextRepetitionTime: string;
    reps: number;
    /** For clozes, the card's cloze id. */
    clozeId: string;
    /** Is this card's markup still in the Rem? The individually-disabled test. */
    markupStillPresent: boolean | null;
    /** For forward/backward cards: is that direction still on? null for clozes. */
    directionEnabled: boolean | null;
    /** What the export would call this card if it were unscheduled. */
    wouldClassifyAs: string;
  }>;
}

export async function probeRemCardEnablement(
  plugin: RNPlugin,
  remId: string,
): Promise<RemEnablementProbe | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const [text, viaGetCards, enablePractice, practiceDirection, disableCardsOwn, allCards] =
    await Promise.all([
      safeRemTextToString(plugin, rem.text),
      rem.getCards().catch(() => [] as any[]),
      rem.getEnablePractice().catch(() => null),
      rem.getPracticeDirection().catch(() => null),
      rem.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
      plugin.card.getAll(),
    ]);

  const surfacedIds = new Set(viaGetCards.map((c: any) => c._id));
  const owned = (allCards || []).filter((c: any) => c.remId === remId);
  const clozeIds = Array.from(collectClozeIds(rem.text));
  const hasBackText = Array.isArray(rem.backText) && rem.backText.length > 0;

  const ancestors: RemEnablementProbe['ancestors'] = [];
  let cursor = await rem.getParentRem();
  let hops = 0;
  while (cursor && hops < 64) {
    const [disableCards, isDeck, aText] = await Promise.all([
      cursor.hasPowerup(BuiltInPowerupCodes.DisableCards).catch(() => false),
      cursor.hasPowerup(BuiltInPowerupCodes.Deck).catch(() => false),
      safeRemTextToString(plugin, cursor.text),
    ]);
    let deckStatus: string | null = null;
    if (isDeck) {
      deckStatus =
        ((await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status')) as string) ?? null;
    }
    ancestors.push({ remId: cursor._id, text: aText, disableCards: !!disableCards, deckStatus });
    cursor = await cursor.getParentRem();
    hops++;
  }

  const probeCtx: RemContext = {
    text,
    enablePractice: enablePractice as boolean | null,
    practiceDirection: practiceDirection as RemContext['practiceDirection'],
    disableCardsOwn: !!disableCardsOwn,
    disableCardsAncestor: ancestors.some((a) => a.disableCards),
    disablingAncestorId: ancestors.find((a) => a.disableCards)?.remId ?? null,
    clozeIds,
    hasBackText,
    cardsViaGetCards: viaGetCards.length,
    inPausedDocument: ancestors.some((a) => a.deckStatus === 'Paused'),
    missing: false,
  };

  return {
    remId,
    text,
    enablePractice: enablePractice as boolean | null,
    practiceDirection: practiceDirection as string | null,
    cardsViaGetCards: viaGetCards.length,
    cardsViaGetAll: owned.length,
    disableCardsOwn: !!disableCardsOwn,
    clozeIds,
    hasBackText,
    rawCardKeys: owned.length > 0 ? Object.keys(owned[0]) : [],
    ancestors,
    cards: owned.map((c: any) => {
      const cardType =
        c.type && typeof c.type === 'object' && 'clozeId' in c.type ? 'cloze' : String(c.type);
      const clozeId =
        c.type && typeof c.type === 'object' && 'clozeId' in c.type ? String(c.type.clozeId) : null;
      return {
        cardId: c._id,
        type: clozeId ? `cloze:${clozeId}` : cardType,
        inGetCards: surfacedIds.has(c._id),
        nextRepetitionTime: c.nextRepetitionTime
          ? new Date(c.nextRepetitionTime).toISOString()
          : '(null)',
        reps: c.repetitionHistory?.length ?? 0,
        clozeId: clozeId ?? '',
        markupStillPresent: markupStillPresent(probeCtx, cardType, clozeId),
        directionEnabled: directionEnabled(probeCtx.practiceDirection, cardType),
        // A cause only means something for an UNSCHEDULED card. A card with a
        // real nextRepetitionTime is simply scheduled; running the classifier
        // on it would report the cause it WOULD have, which reads as a verdict.
        wouldClassifyAs: c.nextRepetitionTime
          ? '(scheduled — n/a)'
          : classifyUnscheduled(probeCtx, { cardType, clozeId }),
      };
    }),
  };
}
