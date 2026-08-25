# Card state reference — disabled, paused, and not-generated cards

Engineering reference. Established by measurement (debug widget → **Probe Card Enablement**)
against a live and a test KB in August 2026. Written because every one of these states looks
identical through the obvious API, and guessing between them produced wrong conclusions twice.

## The core trap

`plugin.card.getAll()` and `rem.getCards()` do **not** return the same thing.

| Source | Returns |
| --- | --- |
| `plugin.card.getAll()` | Every card **record** in the KB, including every disabled one. |
| `rem.getCards()` | Only the cards the Rem currently **surfaces** — disabled cards are dropped. |

So `rem.getCards().length === 0` means *"nothing is surfaced right now"*. It does **not** mean
the Rem has no cards, and it is **not** evidence that a card record is junk. A Rem whose cards
were all switched off looks exactly like a Rem whose cloze markup was deleted.

The scheduler-side marker is `nextRepetitionTime`:

- a card RemNote will never surface has **`nextRepetitionTime === null/undefined`**;
- everything that consumes due-ness (the queue, the Priority Review Document, the Weighted
  Shield) filters on `(nextRepetitionTime ?? Infinity) <= now`, so those cards are invisible to
  all of them — correctly;
- the internal `nextTime` (as opposed to `activeNextTime`, which is what `nextRepetitionTime`
  maps to) is **not exposed** by the SDK. The `Card` object carries only `_id, remId, type,
  createdAt, repetitionHistory, nextRepetitionTime, timesWrongInRow, lastRepetitionTime`. There
  is no "disabled" flag on a card, and no way to read the pre-disable due date.

Repetition history **survives** disabling. A card with 3 reps that gets switched off keeps its 3
reps and loses only its next time.

## The states

| State | Set by the user via | Detect with |
| --- | --- | --- |
| **Paused deck** | Deck powerup → Status = "Paused" on an ancestor | walk ancestors: `hasPowerup(BuiltInPowerupCodes.Deck)` → `getPowerupProperty(Deck, 'Status') === 'Paused'` |
| **Disabled by ancestor** | "Disable Descendant Cards" on an ancestor | walk ancestors: `hasPowerup(BuiltInPowerupCodes.DisableCards)` (code `"u"`) |
| **Disabled on the Rem** | flashcard menu → "Enable Cards" off | `rem.getEnablePractice() === false` (or the Rem's own `DisableCards` powerup) |
| **Practice direction none** | flashcard menu → Flashcard Direction | `rem.getPracticeDirection() === 'none'` |
| **Single card disabled** | queue → disable this card / this cloze | *no Rem-level trace* — see below |
| **Markup removed** | editing the cloze or back side away | *no Rem-level trace* — see below |

### Rem-level states are cheap to detect

`getEnablePractice()`, `getPracticeDirection()` and the two ancestor powerups cover everything
that silences a whole Rem or subtree. Check them first: they explain every card on the Rem at
once.

### The two per-card states are the hard part

Disabling **one** cloze or **one** direction in the queue leaves the Rem untouched:

```
enablePractice=true, practiceDirection=forward, DisableCards on this rem: false
cards: 2 in the card table, 1 surfaced by rem.getCards()
  2GAquyN8FdNYsnVZn  cloze:48545702581399686  inGetCards=false  nextRep=(null)  reps=3
  VHi7KlI4Bk2b224xH  cloze:0592505950758665   inGetCards=true   nextRep=2027-03-14  reps=4
```

Nothing at Rem level distinguishes that from a Rem whose cloze was deleted — in both cases the
card sits in `card.getAll()`, is absent from `rem.getCards()`, and has a null next time.

**The discriminator is the markup itself.** Cloze markup lives in the Rem's rich text as `cId`
on the text elements (also `blocks[].cId` for image clozes, `clozeOrder`, `latexClozes`), and a
cloze card's `type.clozeId` names the cloze it belongs to:

- cloze id **still in the Rem's text** ⇒ the markup exists, so the card was **individually
  disabled**;
- cloze id **absent** ⇒ the cloze was **edited away**;
- forward / backward card: substitute "does the Rem still have a back side" (`rem.backText`).

Verified in both directions on the same card: with the cloze present the probe reports
`markupStillPresent=true`, and after deleting that cloze from the Rem it reports
`markupStillPresent=false` while the card record and its 3 reps persist.

`collectClozeIds()` and `markupStillPresent()` in
[`src/lib/card_analytics_export.ts`](src/lib/card_analytics_export.ts) implement this.

## Signals that do NOT work

- **`rem.getCards().length`** as an existence test — it is a "currently surfaced" filter. Both
  directions of the comparison against `card.getAll()` are meaningless on their own.
- **`getPracticeDirection()`** as a disabled signal. A Rem with `enablePractice=false` still
  reports `'forward'`. RemNote's UI shows "Flashcard Direction: None" for such a Rem as a
  display collapse, not because the stored direction changed. Only 10 Rems in a 72k-card KB
  genuinely carry `'none'`.
- **Card `createdAt` vs Rem `createdAt`** as evidence of anything. A card record can predate its
  own Rem; that does not make it an orphan.
- **`taggedRem()` on built-in powerups** — membership is not enumerable for RemNote built-ins;
  probe with `hasPowerup` from the Rem's side instead.

## Classification order

Implemented as `classifyUnscheduled()` in `src/lib/card_analytics_export.ts`. Order matters —
Rem-wide causes first, because they explain every card on the Rem at once:

1. `rem-missing` — the Rem no longer resolves
2. `paused-document` — nearest Deck ancestor is Paused
3. `cards-disabled-ancestor` — an ancestor carries Disable Descendant Cards
4. `cards-disabled-rem` — `getEnablePractice() === false`, or the Rem's own tag
5. `practice-direction-none` — `getPracticeDirection() === 'none'`
6. `card-disabled-individually` — markup still present ⇒ this one card was switched off
7. `markup-removed` — the cloze id / back side is gone
8. `not-surfaced-unknown` — none of the above could decide it

The ancestor walk must **fold bottom-up**: memoize per node the facts of the chain *from that
node upward*, or a tag found near the leaf leaks onto the ancestors above it, and a cache hit
higher up erases a tag already found below it. Nearest Deck wins for pause (an active sub-deck
under a paused one is not paused); Disable-Cards ORs upward.

## Consequences for the analytics

Unscheduled cards are card records that exist but can never be practised. They must not sit in
the denominator of anything describing practice:

- `Done% = (active − due) / active`, not `(cards − due) / cards` — otherwise a bucket reports
  100% done while holding hundreds of unpractisable cards;
- `%New` counts only **active** new cards (what you could still learn); unscheduled new cards
  are reported separately under `Unsched`;
- FSRS `D / R / S` averages exclude them — an unpractisable card's retrievability decays toward
  zero and would drag the bucket down for no actionable reason;
- `Items` still counts every record, so nothing is hidden.

Throughput and Outcome columns are untouched: those reps genuinely happened, and disabling a
card does not un-practise it.

## How to investigate a specific card

1. Focus the Rem, open the debug widget, hit **Probe Card Enablement**. It prints
   `enablePractice`, `practiceDirection`, the Rem's cloze ids, the whole ancestor chain with its
   flags, and per card `inGetCards` / `nextRepetitionTime` / `reps` / `markupStillPresent` /
   `wouldClassifyAs`.
2. For KB-wide work use **Export cards** in Card Priority × Memory Analytics: one CSV row per
   card with `unscheduledCause`, `remEnablePractice`, `remDisableCardsOwn`,
   `remDisableCardsAncestor`, `remDisablingAncestorId`, `clozeId`, `markupStillPresent`, plus a
   summary file with the bucket × cause matrix.

## Re-enabling

- Rem-level: `rem.setEnablePractice(true)`, `rem.setPracticeDirection(...)`.
- Ancestor-level: remove the Disable Descendant Cards powerup from the ancestor — **this flips
  the entire subtree at once**, so it needs an explicit confirmation and a count of what it will
  affect.
- Single card: no SDK write is known for re-enabling one card; it is done in the queue UI.
- Note that re-enabling in bulk makes every affected card due immediately.
