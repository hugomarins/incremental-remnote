import { RNPlugin } from '@remnote/plugin-sdk';
import { onboardingTipsStateKey, onboardingTipsSnoozeKey } from './consts';

/**
 * The tip pile behind the Incremental RemNote sidebar hub.
 *
 * A tip is one small thing the plugin can do, phrased so it can be acted on
 * immediately. **One tip per session**: the panel draws a tip when it mounts,
 * and once it is answered the tip area is done until the next start. The user
 * has three answers to each:
 *
 *  - **I Got It** — acknowledged, and never shown again. Persisted per knowledge
 *    base in synced storage, so it survives reloads and follows the user across
 *    devices.
 *  - **✕** — not now. The tip stays in the pile and can resurface later; the
 *    panel also goes quiet for {@link TIP_SNOOZE_MS}, so a reload inside that
 *    window does not immediately produce another tip.
 *  - **Learn More** — opens the docs section for the feature, when the tip names
 *    one. Not every tip has a page (some are habits, not features), hence the
 *    optional `docsPath`.
 */
/**
 * Which pile a tip belongs to. The order of this list is the order the piles are
 * drawn in — see {@link pickTip}. It is not decoration: a tip is drawn at random,
 * so without staging, adding a dozen utility tips would make it more likely than
 * not that a brand-new user's first tip is about cycling text case rather than
 * about Alt+X.
 */
export const TIP_CATEGORY_ORDER = ['basics', 'utilities'] as const;
export type TipCategory = (typeof TIP_CATEGORY_ORDER)[number];

export interface OnboardingTip {
  /**
   * Stable identity. NEVER reuse or renumber an id: acknowledgements are stored
   * by id, so a recycled id would silently arrive pre-dismissed for every
   * existing user. Retiring a tip means deleting the entry and burying the id.
   */
  id: string;
  /**
   * Which pile this belongs to. Everything in an earlier category is exhausted
   * before a later one is offered, so `basics` teaches the daily loop and
   * `utilities` waits until it has been learnt. New feature tips go at the END
   * of their category.
   */
  category: TipCategory;
  /** Three or four words. The sidebar column is ~130px at its narrowest. */
  title: string;
  /**
   * ONE line of prose — roughly 90 characters, hard ceiling 110. This renders in
   * a sidebar the user can drag down to about 130px wide, where 90 characters
   * already wrap to four lines. A tip is a hook, not an explanation: the
   * explanation is what `docsPath` is for.
   */
  body: string;
  /**
   * Docs target for "Learn More", relative to `IE_DOCS_BASE_URL` (e.g.
   * `'Getting-Started/#making-a-rem-incremental'`). Omit when the tip has no
   * single page behind it; the button is then not rendered.
   */
  docsPath?: string;
}

/** How long the tip panel stays quiet after a tip is closed with ✕. */
export const TIP_SNOOZE_MS = 2 * 60 * 60 * 1000;

/**
 * The starter pile: the handful of things a new user has to know before the
 * plugin stops looking like a queue with extra buttons. Ordered roughly by when
 * they become useful, though tips are drawn at random — order is documentation
 * for whoever edits this list, not a sequence the user experiences.
 */
export const ONBOARDING_TIPS: OnboardingTip[] = [
  {
    id: 'create-first-incremental-rem',
    category: 'basics',
    title: 'Your first Incremental Rem',
    body: 'Alt+X on any Rem, nothing selected, and it joins your queue. No flashcard needed.',
    docsPath: 'Getting-Started/#method-2-keyboard-shortcut',
  },
  {
    id: 'extract-while-reading',
    category: 'basics',
    title: 'Extract, don’t re-read',
    body: 'Alt+X with text selected pulls that passage out on its own. The source shrinks each pass.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-extract-altx--altshiftx',
  },
  {
    id: 'cloze-an-extract',
    category: 'basics',
    title: 'Extract → flashcard',
    body: 'Alt+Z clozes the words that matter. Reading becomes remembering, in place.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-cloze-altz--altshiftz',
  },
  {
    id: 'set-a-priority',
    category: 'basics',
    title: 'Priority runs the queue',
    body: 'Alt+P sets it. It is the one knob that changes what your day looks like.',
    docsPath: 'Prioritization-&-Sorting/#setting-priorities',
  },
  {
    id: 'priority-inheritance',
    category: 'basics',
    title: 'Set priority once',
    body: 'Priority is inherited — prioritise a document, override only the exceptions.',
    docsPath: 'Prioritization-&-Sorting/#priority-inheritance-system',
  },
  {
    id: 'sorting-criteria',
    category: 'basics',
    title: 'Tune your queue mix',
    body: 'Cards vs. reading vs. randomness, saved as presets. Click Sorting above.',
    docsPath: 'Prioritization-&-Sorting/#sorting-criteria',
  },
  {
    id: 'answer-buttons',
    category: 'basics',
    title: 'More than “next”',
    body: 'Reschedule, dismiss, reprioritise or open in the editor — without leaving the queue.',
    docsPath: 'Reviewing-Items-in-the-Queue/#the-answer-buttons',
  },
  {
    id: 'review-in-editor',
    category: 'basics',
    title: 'Review outside the queue',
    body: 'Long reading needs room. Ctrl+Shift+J opens the item in the editor and times it.',
    docsPath: 'Reviewing-Items-in-the-Editor/',
  },
  {
    id: 'priority-review-document',
    category: 'basics',
    title: 'Too many cards due?',
    body: 'A Priority Review Document collects the top items into one doc you can actually finish.',
    docsPath: 'Priority-Review-Document/',
  },
  {
    id: 'pdf-workflow',
    category: 'basics',
    title: 'Read PDFs incrementally',
    body: 'The plugin keeps your page, and turns highlights into prioritised extracts.',
    docsPath: 'PDF-Incremental-Reading-Workflow/',
  },
  {
    id: 'incremental-adoption',
    category: 'basics',
    title: 'Adopt it incrementally',
    body: 'Start with Incremental Rems and priority. Add the rest when the habit gets boring.',
    docsPath: 'What-is-Incrementalism%3F/',
  },
  {
    id: 'increm-list',
    category: 'basics',
    title: 'See the whole queue',
    body: 'The IncRem List shows priorities, due dates and history — and edits them inline.',
    docsPath: 'IncRem-List-and-Main-View/',
  },
  {
    id: 'keyboard-shortcuts',
    category: 'basics',
    title: 'One keystroke away',
    body: 'Alt+X, Alt+Shift+X and Alt+P cover the daily loop. Click to see the rest.',
    docsPath: 'Keyboard-Shortcuts/',
  },
  {
    id: 'study-dashboard',
    category: 'basics',
    title: 'Where did the time go?',
    body: 'The Study Dashboard breaks your reviews down by document and period.',
    docsPath: 'Study-Dashboard/',
  },
  {
    id: 'settings-live-here',
    category: 'basics',
    title: 'Settings, all in one place',
    body: 'The ⚙ above opens them: grouped, and each one linked to the page explaining it.',
    docsPath: 'Plugin-Settings-Reference/',
  },

  // --- Utilities -------------------------------------------------------
  // Drawn only once every `basics` tip has been acknowledged.
  {
    id: 'filter-images',
    category: 'utilities',
    title: 'Find every figure',
    body: 'Search cannot see images. Tag them once, then filter a document down to its figures.',
    docsPath: 'Utilities/#filter-a-document-by-images',
  },
  {
    id: 'pin-ring-indicators',
    category: 'utilities',
    title: 'Pins tell you more',
    body: 'Switch on pin rings: each pin then says where it goes — your figure, or the source.',
    docsPath: 'Colour-Coding-Reference/#reference-pin-rings',
  },
  {
    id: 'open-source-floating',
    category: 'utilities',
    title: 'Peek at the source',
    body: 'Hover a pin, press Opt+Shift+O: the PDF opens beside your card, queue still running.',
    docsPath: 'Utilities/#floating-window-interaction-closing',
  },
  {
    id: 'find-rem-picker',
    category: 'utilities',
    title: 'When [[ fails you',
    body: 'Opt+Shift+F finds Rems that RemNote’s own reference search buries, and links them.',
    docsPath: 'Utilities/#find-rem-reference-or-open',
  },
  {
    id: 'text-case-converter',
    category: 'utilities',
    title: 'Fix SHOUTING headings',
    body: 'Shift+F3 cycles the selection: Title Case, UPPERCASE, lowercase. Formatting survives.',
    docsPath: 'Utilities/#text-case-converter',
  },
  {
    id: 'set-next-heading-level',
    category: 'utilities',
    title: 'Headings without picking',
    body: 'Run “hn” and the Rem takes the level below its parent. Structure stays consistent.',
    docsPath: 'Utilities/#set-next-heading-level',
  },
  {
    id: 'inlinize-break-lists',
    category: 'utilities',
    title: 'Rescue a flattened list',
    body: 'A highlight that ate its line breaks: “inl” rebuilds the items, “brl” splits them out.',
    docsPath: 'Utilities/#inlinize-break-lists-from-pdf-highlights',
  },
  {
    id: 'hide-in-queue',
    category: 'utilities',
    title: 'Hide a spoiler parent',
    body: 'Tag a Rem “hiq” and its text is masked on descendant cards — the bullet still shows.',
    docsPath: 'Utilities/#hide-in-queue',
  },
  {
    id: 'remove-from-queue',
    category: 'utilities',
    title: 'Erase a middle level',
    body: '“rfq” drops a parent from card display entirely, pulling its children up a level.',
    docsPath: 'Utilities/#remove-from-queue-rfq',
  },
  {
    id: 'no-hierarchy',
    category: 'utilities',
    title: 'Card with no ancestry',
    body: '“nh” hides every ancestor on a card, front and back. For when context gives it away.',
    docsPath: 'Utilities/#no-hierarchy-nh',
  },
  {
    id: 'hide-parent',
    category: 'utilities',
    title: 'Hide just the parent',
    body: '“hp” masks the immediate parent on the front, then reveals it on the back.',
    docsPath: 'Utilities/#hide-parent-hp',
  },
  {
    id: 'remove-parent',
    category: 'utilities',
    title: 'Drop the parent entirely',
    body: '“rp” removes the parent from both sides of the card. Clozes get it automatically.',
    docsPath: 'Utilities/#remove-parent-rp-new',
  },
];

/** Acknowledgement state, stored per knowledge base under one synced key. */
interface TipsState {
  /** Ids the user has answered "I Got It" to. */
  acknowledged: string[];
}

/**
 * Synced storage is shared across every knowledge base the user owns, so the
 * state is partitioned by KB id — the same shape as the shield history. A tip
 * dismissed while learning anatomy should not be silently pre-dismissed in a
 * knowledge base started next year.
 */
type TipsStateByKb = Record<string, TipsState>;

async function getKbId(plugin: RNPlugin): Promise<string> {
  const kb = await plugin.kb.getCurrentKnowledgeBaseData();
  return kb?._id ?? 'default';
}

export async function getAcknowledgedTipIds(plugin: RNPlugin): Promise<string[]> {
  const byKb = (await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)) || {};
  return byKb[await getKbId(plugin)]?.acknowledged ?? [];
}

export async function acknowledgeTip(plugin: RNPlugin, tipId: string): Promise<void> {
  const kbId = await getKbId(plugin);
  const byKb = (await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)) || {};
  const current = byKb[kbId]?.acknowledged ?? [];
  if (current.includes(tipId)) return;
  byKb[kbId] = { acknowledged: [...current, tipId] };
  await plugin.storage.setSynced(onboardingTipsStateKey, byKb);
}

/** Used by the "start over" affordance, and by anyone debugging the pile. */
export async function resetAcknowledgedTips(plugin: RNPlugin): Promise<void> {
  const kbId = await getKbId(plugin);
  const byKb = (await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)) || {};
  delete byKb[kbId];
  await plugin.storage.setSynced(onboardingTipsStateKey, byKb);
  await plugin.storage.setLocal(onboardingTipsSnoozeKey, 0);
}

/**
 * Snooze lives in *local* storage, not synced: "not right now" is about the
 * session in front of you, and syncing it would silence the panel on a device
 * the user has not touched yet.
 */
export async function snoozeTips(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setLocal(onboardingTipsSnoozeKey, Date.now() + TIP_SNOOZE_MS);
}

export async function tipsAreSnoozed(plugin: RNPlugin): Promise<boolean> {
  const until = (await plugin.storage.getLocal<number>(onboardingTipsSnoozeKey)) ?? 0;
  return Date.now() < until;
}

/**
 * Draw one tip from what is left. Called once per panel mount — a session shows
 * one tip and no more, whichever way the user answers it.
 *
 * Random WITHIN a category, but categories are exhausted IN ORDER: no `utilities`
 * tip is offered while a `basics` tip is still unacknowledged. Without that
 * staging the pile is a flat lottery, and adding the twelve utility tips would
 * have made it more likely than not that a new user's first tip was about
 * cycling text case rather than about Alt+X — the list order alone would not
 * have prevented it, since nothing consulted the order.
 *
 * Random within the category rather than sequential so a user who keeps
 * dismissing with ✕ is not shown the same tip on every mount.
 */
export function pickTip(acknowledged: string[]): OnboardingTip | null {
  for (const category of TIP_CATEGORY_ORDER) {
    const pool = ONBOARDING_TIPS.filter(
      (t) => t.category === category && !acknowledged.includes(t.id)
    );
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];
  }
  return null;
}
