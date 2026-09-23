import { AppEvents, PluginRem, QueueInteractionScore, QueueItemType, RemId, RNPlugin } from '@remnote/plugin-sdk';
import { masteryDrillMinDelayMinutesId } from './consts';
import { getIESetting } from './settings';
import { FinalDrillEntry, finalDrillIdsKey } from './mastery_drill_status';
import { showMessageDialog } from './message_dialog';

/**
 * TEST: can the Mastery Drill run in RemNote's own Practice queue rather than the
 * embedded <Queue>?
 *
 * The embed hard-codes `inArticle: true`, which switches off every flashcard widget
 * location (ours and every other plugin's). A native queue would show them all.
 * The catch: a plugin cannot hand RemNote a card-id list (the filtered queue reads
 * its ids from the host's localStorage), so the native drill has to be a document
 * queue over the drill Rems, with card-level control done by skipping on
 * QueueLoadCard.
 *
 * The test answers three questions, reported in a dialog when the queue closes:
 *   1. Does `/flashcards/<doc>/all` serve not-due drill cards through reference
 *      entries, and does rating them record a repetition and reschedule the card?
 *   2. Does a card come back in the same session (after being rated or skipped)?
 *   3. How long is a skip? A non-drill card is visible from its QueueLoadCard until
 *      removeCurrentCardFromQueue resolves: that round trip is the flash.
 *
 * It rebuilds one document per KB ("Mastery Drill (native queue test)") on every
 * run and changes nothing else. Ratings go through the normal QueueCompleteCard
 * handler, so the drill list is updated exactly as a regular queue would update it.
 */

const LOG = '[DrillNativeTest]';
const docIdKey = (kbId: string) => `mastery-drill-native-test-doc_${kbId}`;
const DOC_TITLE = 'Mastery Drill (native queue test)';

// Module state. Read synchronously by the GetNextCard callback, which runs in the
// same realm (index.tsx onActivate), so it must never need an await.
let testDocId: RemId | null = null;
let active = false;

/**
 * True while the test queue is open. Our own post-rating work (drill list, history, priority
 * caches) waits DRILL_TEST_DEFER_MS then, so it is not queued ahead of a sibling skip on the
 * plugin bridge: the slow skips all came right after a rating.
 */
export const DRILL_TEST_DEFER_MS = 1000;
export const deferIfDrillNativeTest = () =>
  active ? new Promise<void>((resolve) => setTimeout(resolve, DRILL_TEST_DEFER_MS)) : Promise.resolve();

/** True while the queue open on screen is the drill test document. Synchronous. */
export function isDrillNativeTestQueue(subQueueId: string | undefined): boolean {
  return !!testDocId && subQueueId === testDocId;
}

interface BuildInfo {
  readyCardIds: Set<string>;
  remIds: Set<RemId>;
  coolingLeftOut: number;
  otherKbLeftOut: number;
  missingCards: number;
  totalCardsOfRems: number;
  minDelayMinutes: number;
  cardRem: Map<string, RemId>;
  /** Latest review of ANY card of the Rem, at build time. */
  remLastSeen: Map<RemId, number>;
  /** Sibling cards (not in the drill) whose Rem was reviewed within the bury window at build time. */
  siblingsLikelyBuried: number;
  siblings: number;
}

/** RemNote holds back a Rem's other cards for 60 minutes after one of them is seen. */
const BURY_WINDOW_MS = 60 * 60_000;

type SkipReason = 'sibling' | 'otherRem' | 'ratedOrCooling';

/** Past either limit the test stops skipping: something is looping. */
const MAX_LOADS_PER_CARD = 6;
const MAX_SKIPS = 60;

/**
 * Reveal mask: while the test queue is open, every card's content stays invisible for its
 * first MASK_MS, then fades in. A sibling removed inside that window is never seen. It only
 * works if RemNote mounts a fresh `.rn-queue__content` per card (the animation restarts on
 * mount, not on a class change) — watch whether every drill card fades in.
 */
const MASK_MS = 400;
const MASK_CSS_ID = 'mastery-drill-native-test-mask';
const MASK_CSS = `
@keyframes ie-drill-test-reveal { from { opacity: 0; } to { opacity: 1; } }
.rn-queue__content { animation: ie-drill-test-reveal 120ms ease-out ${MASK_MS}ms both; }
`.trim();

interface SessionStats {
  build: BuildInfo;
  /** Cards still allowed to be shown. Rated cards leave it (they left the drill or restarted cooling). */
  allowed: Set<string>;
  loads: number;
  shownDrill: number;
  loadsByCard: Map<string, number>;
  skippedCards: Set<string>;
  ratedCards: Map<string, QueueInteractionScore | undefined>;
  skips: Record<SkipReason, number>;
  skipMs: number[];
  /**
   * Drill cards shown by the queue, in order. Without the getCurrentCard pre-check a removal
   * can land on the NEXT card; such a card is shown and then vanishes unrated. Checked at exit.
   */
  shownOrder: string[];
  /** Rems whose sibling card we skipped: RemNote marks a removed card as just seen, burying the Rem's other cards. */
  skippedSiblingRems: Set<RemId>;
  /** Times RemNote's "Time to Take a Break" (buried cards) screen came up. */
  buriedScreens: number;
  skipAttempts: number;
  idlessLoads: number;
  tripped: boolean;
  reappearAfterRating: string[];
  /** Shown again without having been rated or skipped. */
  reappearUnrated: string[];
  reappearAfterSkip: string[];
  ratings: number;
  recorded: number;
  rescheduled: number;
  ratingNotes: string[];
  lastLoad: { cardId: string; at: number; nextRepAtLoad?: number; histLenAtLoad: number } | null;
  enteredAt: number;
}

let stats: SessionStats | null = null;
let lastBuild: BuildInfo | null = null;

/**
 * A NEW document every run. Practice All remembers progress per document id
 * (`cramQueue.finishedCards.<docId>`, and skipped cards count as finished), which is what
 * raised "Continue where you left off?" on every entry. A fresh id has no progress.
 */
async function replaceDoc(plugin: RNPlugin, kbId: string): Promise<PluginRem> {
  const storedId = await plugin.storage.getSynced<string>(docIdKey(kbId));
  if (storedId) {
    const previous = await plugin.rem.findOne(storedId);
    if (previous) await previous.remove();
  }
  const doc = await plugin.rem.createRem();
  if (!doc) throw new Error('Could not create the test document.');
  await doc.setText([DOC_TITLE]);
  await doc.setIsDocument(true);
  await plugin.storage.setSynced(docIdKey(kbId), doc._id);
  return doc;
}

async function buildTestDoc(plugin: RNPlugin): Promise<{ doc: PluginRem; info: BuildInfo }> {
  const kb = await plugin.kb.getCurrentKnowledgeBaseData();
  const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
  const minDelayMinutes = Number(await getIESetting(plugin, masteryDrillMinDelayMinutesId)) || 0;
  const items = ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];

  const now = Date.now();
  const readyCardIds = new Set<string>();
  const remIds = new Set<RemId>();
  const cardRem = new Map<string, RemId>();
  let coolingLeftOut = 0;
  let otherKbLeftOut = 0;
  let missingCards = 0;

  for (const item of items) {
    const inKb = typeof item === 'string' ? isPrimary : item.kbId === kb._id;
    if (!inKb) {
      otherKbLeftOut++;
      continue;
    }
    const cardId = typeof item === 'string' ? item : item.cardId;
    const addedAt = typeof item === 'string' ? undefined : item.addedAt;
    if (addedAt && now - addedAt < minDelayMinutes * 60_000) {
      coolingLeftOut++;
      continue;
    }
    const card = await plugin.card.findOne(cardId);
    if (!card?.remId) {
      missingCards++;
      continue;
    }
    readyCardIds.add(cardId);
    remIds.add(card.remId);
    cardRem.set(cardId, card.remId);
  }

  // How many cards those Rems carry in total: every one beyond the drill cards is
  // a sibling the queue will offer and the test will have to skip.
  // RemNote's bury hides the other cards of a Rem seen within the last hour, so record when
  // each Rem was last reviewed: it tells whether a sibling could be offered at all.
  let totalCardsOfRems = 0;
  let siblings = 0;
  let siblingsLikelyBuried = 0;
  const remLastSeen = new Map<RemId, number>();
  for (const remId of remIds) {
    const rem = await plugin.rem.findOne(remId);
    const cards = (await rem?.getCards()) ?? [];
    totalCardsOfRems += cards.length;
    let last = 0;
    for (const c of cards) for (const h of c.repetitionHistory ?? []) if (h.date > last) last = h.date;
    remLastSeen.set(remId, last);
    const remSiblings = cards.filter((c) => !readyCardIds.has(c._id)).length;
    siblings += remSiblings;
    if (last && now - last < BURY_WINDOW_MS) siblingsLikelyBuried += remSiblings;
  }

  const doc = await replaceDoc(plugin, kb._id);
  for (const remId of remIds) {
    const entry = await plugin.rem.createRem();
    if (!entry) continue;
    await entry.setParent(doc);
    await entry.setText([{ i: 'q', _id: remId }]);
  }

  const info: BuildInfo = {
    readyCardIds,
    remIds,
    coolingLeftOut,
    otherKbLeftOut,
    missingCards,
    totalCardsOfRems,
    minDelayMinutes,
    cardRem,
    remLastSeen,
    siblingsLikelyBuried,
    siblings,
  };
  console.log(
    `${LOG} built ${doc._id}: ${readyCardIds.size} ready cards on ${remIds.size} Rems ` +
      `(${totalCardsOfRems} cards in total on those Rems); left out: ${coolingLeftOut} cooling, ` +
      `${otherKbLeftOut} other KB, ${missingCards} missing; ${siblings} sibling cards, ` +
      `${siblingsLikelyBuried} on Rems reviewed in the last hour (likely buried)`
  );
  console.log(`${LOG} ready cards:`, [...readyCardIds].join(', '));
  return { doc, info };
}

/** The debug command: rebuild the document and open it in Practice All. */
export async function runDrillNativeTest(plugin: RNPlugin): Promise<void> {
  try {
    await plugin.app.toast('Building the drill test document…');
    const { doc, info } = await buildTestDoc(plugin);
    if (info.readyCardIds.size === 0) {
      await showMessageDialog(plugin, {
        title: 'Mastery Drill test',
        message: 'No drill card is ready in this knowledge base, so there is nothing to practise.',
        detail: `${info.coolingLeftOut} cooling, ${info.otherKbLeftOut} in other KBs, ${info.missingCards} missing.`,
        tone: 'info',
      });
      return;
    }
    testDocId = doc._id;
    lastBuild = info;
    await plugin.window.setURL(`/flashcards/${doc._id}/all`);
  } catch (e) {
    console.error(`${LOG} failed:`, e);
    await showMessageDialog(plugin, {
      title: 'Mastery Drill test failed',
      message: String(e),
      tone: 'error',
    });
  }
}

const SCORE_NAMES: Record<number, string> = {
  [QueueInteractionScore.AGAIN]: 'Again',
  [QueueInteractionScore.HARD]: 'Hard',
  [QueueInteractionScore.GOOD]: 'Good',
  [QueueInteractionScore.EASY]: 'Easy',
  [QueueInteractionScore.TOO_EARLY]: 'Too early',
};
const scoreName = (s: QueueInteractionScore | undefined) => (s === undefined ? '?' : SCORE_NAMES[s] ?? String(s));

const days = (ms: number) => `${(ms / 86_400_000).toFixed(1)}d`;

function report(s: SessionStats): { message: string; detail: string } {
  const b = s.build;
  const avg = s.skipMs.length ? Math.round(s.skipMs.reduce((a, x) => a + x, 0) / s.skipMs.length) : 0;
  const sorted = [...s.skipMs].sort((a, x) => a - x);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  const skipped = s.skips.sibling + s.skips.otherRem + s.skips.ratedOrCooling;
  // The last shown card is excluded: leaving the queue on it is not a misfire.
  const vanished = s.shownOrder.slice(0, -1).filter((id) => !s.ratedCards.has(id));
  const neverShown = [...b.readyCardIds].filter((id) => !s.loadsByCard.has(id));
  const ago = (id: string) => {
    const last = b.remLastSeen.get(b.cardRem.get(id)!) ?? 0;
    const seen = last ? `Rem last reviewed ${Math.round((s.enteredAt - last) / 60_000)} min before the queue opened` : 'Rem never reviewed';
    return s.skippedSiblingRems.has(b.cardRem.get(id)!) ? `${seen}; a sibling was skipped → buried` : seen;
  };
  const buriedBySkip = neverShown.filter((id) => s.skippedSiblingRems.has(b.cardRem.get(id)!)).length;
  const lines = [
    `Document: ${b.readyCardIds.size} ready drill cards on ${b.remIds.size} Rems (${b.totalCardsOfRems} cards in total on those Rems).`,
    `Siblings: ${b.siblings} non-drill cards on those Rems, ${b.siblingsLikelyBuried} on Rems reviewed in the last hour (likely buried).`,
    `Left out: ${b.coolingLeftOut} cooling (${b.minDelayMinutes} min), ${b.otherKbLeftOut} other KB, ${b.missingCards} missing.`,
    '',
    ...(s.tripped ? ['⚠️ LOOP DETECTED: the circuit breaker stopped skipping partway through.', ''] : []),
    `1. Served: ${s.shownDrill} drill cards shown, ${s.loads} card loads in all (${s.idlessLoads} id-less loads ignored).`,
    `   Rated ${s.ratings}: ${s.recorded} recorded in history, ${s.rescheduled} rescheduled.`,
    `   Never shown: ${neverShown.length} of ${b.readyCardIds.size} drill cards (${buriedBySkip} after a sibling of theirs was skipped).`,
    `   "Time to Take a Break" (buried) screens: ${s.buriedScreens}.`,
    `2. Came back: ${s.reappearAfterRating.length} after being rated, ${s.reappearAfterSkip.length} after being skipped, ` +
      `${s.reappearUnrated.length} without either.`,
    `3. Skipped ${skipped}: ${s.skips.sibling} sibling cards, ${s.skips.otherRem} from other Rems, ` +
      `${s.skips.ratedOrCooling} already rated this session.`,
    `   Our post-rating work deferred ${DRILL_TEST_DEFER_MS} ms. Removal call (no pre-check): median ${median} ms, average ${avg} ms, max ${max} ms.`,
    `   Over the ${MASK_MS} ms mask: ${s.skipMs.filter((ms) => ms > MASK_MS).length} of ${s.skipMs.length}.`,
    `   Drill cards shown then gone unrated (misfire suspects, excluding the last one): ${vanished.length}.`,
    `   Individual: ${s.skipMs.join(', ') || '—'} ms.`,
  ];
  const detail = [
    ...vanished.slice(0, 8).map((id) => `Shown, never rated: ${id}`),
    ...neverShown.slice(0, 8).map((id) => `Never shown: ${id} (${ago(id)})`),
    ...s.ratingNotes.slice(-12),
    ...(s.reappearAfterRating.length ? [`Came back after rating: ${s.reappearAfterRating.slice(0, 8).join(', ')}`] : []),
    ...(s.reappearAfterSkip.length ? [`Came back after skip: ${s.reappearAfterSkip.slice(0, 8).join(', ')}`] : []),
    ...(s.reappearUnrated.length ? [`Came back unrated: ${s.reappearUnrated.slice(0, 8).join(', ')}`] : []),
    'Full per-card log in the console under [DrillNativeTest].',
  ].join('\n');
  return { message: lines.join('\n'), detail };
}

export function registerDrillNativeTestListeners(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.QueueEnter, undefined, (data: any) => {
    active = isDrillNativeTestQueue(data?.subQueueId);
    // Registered from the index realm (these listeners run there), the only place registerCSS works.
    void plugin.app.registerCSS(MASK_CSS_ID, active && lastBuild ? MASK_CSS : '');
    if (!active || !lastBuild) return;
    stats = {
      build: lastBuild,
      allowed: new Set(lastBuild.readyCardIds),
      loads: 0,
      shownDrill: 0,
      loadsByCard: new Map(),
      skippedCards: new Set(),
      ratedCards: new Map(),
      skips: { sibling: 0, otherRem: 0, ratedOrCooling: 0 },
      skipMs: [],
      shownOrder: [],
      skippedSiblingRems: new Set(),
      buriedScreens: 0,
      skipAttempts: 0,
      idlessLoads: 0,
      tripped: false,
      reappearAfterRating: [],
      reappearUnrated: [],
      reappearAfterSkip: [],
      ratings: 0,
      recorded: 0,
      rescheduled: 0,
      ratingNotes: [],
      lastLoad: null,
      enteredAt: Date.now(),
    };
    console.log(`${LOG} queue entered on the test document`);
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    if (!active || !stats) return;
    const s = stats;
    const receivedAt = Date.now();
    const cardId: string | undefined = data?.cardId;

    // RemNote fires an id-less QueueLoadCard around every card change and moves past it on
    // its own. Acting on it is what caused the first run's loop: the remove call landed after
    // the real drill card had loaded, and removed THAT card instead.
    if (!cardId) {
      s.idlessLoads++;
      const screen = await plugin.queue.getCurrentQueueScreenType();
      console.log(`${LOG} id-less QueueLoadCard ignored, screen type ${screen}`);
      if (screen === QueueItemType.PracticeBuried) {
        s.buriedScreens++;
        void plugin.app.toast('RemNote hid some drill cards (buried). Press Keep Practicing to get them.');
      }
      return;
    }

    s.loads++;
    const n = (s.loadsByCard.get(cardId) ?? 0) + 1;
    s.loadsByCard.set(cardId, n);
    if (n > 1) {
      if (s.ratedCards.has(cardId)) s.reappearAfterRating.push(`${cardId} (${scoreName(s.ratedCards.get(cardId))})`);
      else if (s.skippedCards.has(cardId)) s.reappearAfterSkip.push(cardId);
      else s.reappearUnrated.push(cardId);
    }

    // Circuit breaker: a card loading over and over, or skips piling up, means a loop.
    // Stop acting (no more removals) and say so; the report still comes at QueueExit.
    if (!s.tripped && (n > MAX_LOADS_PER_CARD || s.skipAttempts >= MAX_SKIPS)) {
      s.tripped = true;
      console.warn(`${LOG} circuit breaker tripped (card ${cardId} loaded ${n}×, ${s.skipAttempts} skips). No more skips.`);
      void plugin.app.toast('Drill test: loop detected, skipping stopped. Leave the queue for the report.');
    }

    // Decided synchronously, so the skip starts at once. 'notInDrill' is split into
    // sibling / other Rem afterwards, which needs a card read.
    let reason: 'ratedOrCooling' | 'notInDrill' | null = null;
    if (!s.allowed.has(cardId)) {
      reason = s.ratedCards.has(cardId) || s.build.readyCardIds.has(cardId) ? 'ratedOrCooling' : 'notInDrill';
    }

    if (reason) {
      if (s.tripped) return;
      s.skipAttempts++;
      // No getCurrentCard pre-check: it doubled the flash. removeCurrentCardFromQueue acts on
      // whatever is current when it lands; a card it hits by mistake shows up in the report
      // as "shown then gone unrated".
      try {
        await plugin.queue.removeCurrentCardFromQueue(false);
      } catch (e) {
        console.error(`${LOG} skip failed for ${cardId}:`, e);
      }
      const ms = Date.now() - receivedAt;
      s.skipMs.push(ms);
      s.skippedCards.add(cardId);
      let kind: SkipReason;
      if (reason === 'notInDrill') {
        const card = await plugin.card.findOne(cardId);
        kind = card?.remId && s.build.remIds.has(card.remId) ? 'sibling' : 'otherRem';
        if (kind === 'sibling' && card?.remId) s.skippedSiblingRems.add(card.remId);
      } else kind = reason;
      s.skips[kind]++;
      console.log(`${LOG} skip ${cardId} [${kind}] in ${ms} ms`);
      return;
    }

    s.shownDrill++;
    s.shownOrder.push(cardId);
    const card = await plugin.card.findOne(cardId);
    s.lastLoad = {
      cardId,
      at: receivedAt,
      nextRepAtLoad: card?.nextRepetitionTime,
      histLenAtLoad: card?.repetitionHistory?.length ?? 0,
    };
    console.log(
      `${LOG} show ${cardId} (load #${s.loadsByCard.get(cardId)}; history ${s.lastLoad.histLenAtLoad}; ` +
        `due ${card?.nextRepetitionTime ? new Date(card.nextRepetitionTime).toISOString() : '—'})`
    );
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, async (data: any) => {
    if (!active || !stats) return;
    const s = stats;
    const cardId: string | undefined = data?.cardId;
    if (!cardId) return;
    // Synchronously first: the next QueueLoadCard may arrive before the reads below.
    const minDelayZero = s.build.minDelayMinutes <= 0;
    const provisionalScore: QueueInteractionScore | undefined = data?.score;
    const staysEligible =
      minDelayZero &&
      (provisionalScore === QueueInteractionScore.AGAIN || provisionalScore === QueueInteractionScore.HARD);
    if (!staysEligible) s.allowed.delete(cardId);
    await deferIfDrillNativeTest();

    const card = await plugin.card.findOne(cardId);
    const history = card?.repetitionHistory ?? [];
    const last = history[history.length - 1];
    const score: QueueInteractionScore | undefined = provisionalScore ?? last?.score;
    s.ratedCards.set(cardId, score);
    s.ratings++;

    const load = s.lastLoad?.cardId === cardId ? s.lastLoad : null;
    const recorded = !!last?.date && (!load || last.date >= load.at) && history.length > (load?.histLenAtLoad ?? -1);
    const rescheduled =
      !!card?.nextRepetitionTime && (!load || card.nextRepetitionTime !== load.nextRepAtLoad);
    if (recorded) s.recorded++;
    if (rescheduled) s.rescheduled++;
    const nextIn = card?.nextRepetitionTime ? days(card.nextRepetitionTime - Date.now()) : '—';
    const note = `${scoreName(score)} → recorded ${recorded ? 'yes' : 'NO'}, next due in ${nextIn}`;
    s.ratingNotes.push(note);
    console.log(`${LOG} rated ${cardId}: ${note}`);
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, async () => {
    if (!active || !stats) return;
    const s = stats;
    active = false;
    void plugin.app.registerCSS(MASK_CSS_ID, '');
    stats = null;
    const { message, detail } = report(s);
    console.log(`${LOG} REPORT\n${message}\n${detail}`);
    await showMessageDialog(plugin, { title: 'Mastery Drill: native queue test', message, detail, tone: 'info' });
  });
}
