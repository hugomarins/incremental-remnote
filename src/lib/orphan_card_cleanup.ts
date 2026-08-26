/**
 * Deleting card records that no longer correspond to anything in their Rem.
 *
 * A Rem can hold cloze card records whose cloze ids are absent from its text —
 * the `markup-removed` state in CARD_STATE_REFERENCE.md. They keep their whole
 * repetition history, they can never be practised again, and RemNote's own UI
 * shows them under the Rem while reporting "Cards in Document 0".
 *
 * DELETION IS THE POINT HERE, so the bar is set deliberately high and the flow
 * is split in two: `analyzeOrphanCards` decides and explains, `deleteCards`
 * only executes a list the caller has already been shown. A card qualifies only
 * when ALL of these hold:
 *
 *  - it is a cloze card with a cloze id,
 *  - that cloze id is NOT among the ids in the Rem's current text,
 *  - it has no `nextRepetitionTime` (RemNote will never surface it anyway).
 *
 * Everything else on the Rem is reported with a reason and left alone —
 * including forward/backward records, which a disabled direction can explain
 * and which a text-based markup check cannot rule on.
 *
 * Card deletion is not undoable through this API. `analyzeOrphanCards` therefore
 * returns the full repetition history of every candidate, so the caller can hand
 * the user a backup file BEFORE anything is removed.
 */

import { RNPlugin } from '@remnote/plugin-sdk';
import { collectClozeIds } from './card_analytics_export';
import { SuppressionLease } from './operation_suppression';
import { safeRemTextToString } from './pdfUtils';

/** Why a card on the Rem was NOT selected for deletion. */
export type KeepReason = 'markup-present' | 'scheduled' | 'not-a-cloze' | 'no-cloze-id';

export const KEEP_REASON_LABELS: Record<KeepReason, string> = {
  'markup-present': 'Its cloze is still in the Rem’s text',
  scheduled: 'It has a nextRepetitionTime — RemNote still schedules it',
  'not-a-cloze': 'Forward/backward card — a disabled direction would explain it',
  'no-cloze-id': 'Cloze card with no readable cloze id',
};

export interface OrphanCardAnalysis {
  remId: string;
  remText: string;
  /** Cloze ids currently in the Rem's text. */
  remClozeIds: string[];
  totalCards: number;
  /** Cards the Rem currently surfaces, for context. */
  surfacedCards: number;
  /** Ids selected for deletion — every one meets all three conditions. */
  deletable: string[];
  /** Everything not selected, with the reason it was kept. */
  kept: Array<{ cardId: string; type: string; reason: KeepReason }>;
  keptByReason: Record<KeepReason, number>;
  /** Full records of the deletable cards — the backup, taken before deleting. */
  backup: Array<{
    cardId: string;
    remId: string;
    clozeId: string | null;
    createdAt: number | null;
    nextRepetitionTime: number | null;
    repetitionHistory: unknown[];
  }>;
}

export async function analyzeOrphanCards(
  plugin: RNPlugin,
  remId: string,
): Promise<OrphanCardAnalysis | null> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return null;

  const [allCards, surfaced, remText] = await Promise.all([
    plugin.card.getAll(),
    rem.getCards().catch(() => [] as any[]),
    safeRemTextToString(plugin, rem.text),
  ]);

  const remClozeIds = collectClozeIds(rem.text);
  const owned = ((allCards || []) as any[]).filter((c: any) => c.remId === remId);

  const deletable: string[] = [];
  const kept: OrphanCardAnalysis['kept'] = [];
  const keptByReason: Record<KeepReason, number> = {
    'markup-present': 0,
    scheduled: 0,
    'not-a-cloze': 0,
    'no-cloze-id': 0,
  };
  const backup: OrphanCardAnalysis['backup'] = [];

  for (const c of owned) {
    const isCloze = c.type && typeof c.type === 'object' && 'clozeId' in c.type;
    const clozeId = isCloze ? String(c.type.clozeId) : null;
    const type = isCloze ? `cloze:${clozeId}` : String(c.type);

    const reject = (reason: KeepReason) => {
      kept.push({ cardId: c._id, type, reason });
      keptByReason[reason]++;
    };

    if (!isCloze) {
      reject('not-a-cloze');
      continue;
    }
    if (!clozeId) {
      reject('no-cloze-id');
      continue;
    }
    if (remClozeIds.has(clozeId)) {
      reject('markup-present');
      continue;
    }
    if (c.nextRepetitionTime !== null && c.nextRepetitionTime !== undefined) {
      reject('scheduled');
      continue;
    }

    deletable.push(c._id);
    backup.push({
      cardId: c._id,
      remId,
      clozeId,
      createdAt: c.createdAt ?? null,
      nextRepetitionTime: c.nextRepetitionTime ?? null,
      repetitionHistory: c.repetitionHistory ?? [],
    });
  }

  return {
    remId,
    remText,
    remClozeIds: Array.from(remClozeIds),
    totalCards: owned.length,
    surfacedCards: surfaced.length,
    deletable,
    kept,
    keptByReason,
    backup,
  };
}

export interface DeleteCardsResult {
  deleted: number;
  failed: number;
  elapsedMs: number;
}

/**
 * Delete a list of card ids. Sequential: reads overlap fine on the plugin
 * bridge, writes do not. Held under a renewable suppression lease so the
 * plugin's own change listeners don't chase thousands of pointless updates —
 * renewable rather than a bare flag because a popup the user closes never
 * reaches the `finally`.
 */
export async function deleteCards(
  plugin: RNPlugin,
  cardIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<DeleteCardsResult> {
  const t0 = Date.now();
  const result: DeleteCardsResult = { deleted: 0, failed: 0, elapsedMs: 0 };

  const lease = new SuppressionLease(plugin);
  await lease.start();
  try {
    for (let i = 0; i < cardIds.length; i++) {
      try {
        const card = await plugin.card.findOne(cardIds[i]);
        // Already gone — a re-run over a stale list. The desired end state is
        // what is already true, so this is not a failure.
        if (!card) continue;
        await card.remove();
        result.deleted++;
      } catch (e) {
        result.failed++;
        console.error('[OrphanCardCleanup] delete failed for', cardIds[i], e);
      }
      if ((i + 1) % 50 === 0) {
        onProgress?.(i + 1, cardIds.length);
        await lease.renew();
      }
    }
  } finally {
    await lease.release();
  }

  result.elapsedMs = Date.now() - t0;
  onProgress?.(cardIds.length, cardIds.length);
  console.log(
    `[OrphanCardCleanup] deleted ${result.deleted}, failed ${result.failed} · ` +
      `${(result.elapsedMs / 1000).toFixed(1)}s`,
  );
  return result;
}
