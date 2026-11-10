# Review history archive plan

Working document for a desktop helper that keeps the review history of deleted cards and Incremental Rems, so the Study Dashboard keeps counting it. It also keeps where each deleted Rem lived in the tree. Pick it up at "Phases"; the sections above it hold the decisions and their reasons.

Last updated: **2026-11-10** (plan only, nothing built).

---

## 1. Why this exists

Measured 2026-11-10 (see `findings/CARD_STATE_REFERENCE.md`, "Deleted cards and their repetition history"):

- A card's repetitions live only in its own `cards` row (`h`). An Incremental Rem's live only in its `repHist` slot (Dismissed: `dismissedHistory`).
- Deleting a Rem moves the Rem to `deleted_quanta` and its cards to `deleted_cards`, both intact, with `deletedAt`.
- **RemNote empties that trash after two weeks** (`emptyTrashAfterTwoWeeks`), and "Clear Trash" empties it at once.
- **No SDK call reaches the trash.** Once a Rem is deleted, the plugin sees neither it nor its cards.

The consequence for the dashboard:

- The authoritative daily aggregates are recomputed from live data. That happens on the Refresh Statistics button and at every startup refresh (`refreshAuthoritativeAggregatesFromCardRead`), and the result overwrites the stored shard.
- So **a deleted Rem's reps drop out of the dashboard's totals at the next launch**, not after two weeks.
- The hierarchy view loses them the moment they are deleted.

## 2. Goal

1. Keep every rep the plugin can no longer see: deleted cards, deleted IncRems, deleted Dismissed Rems. For each, keep the date, grade, and response or review time.
2. Keep the Rem each one belonged to: its text, its deleted parents, and its **nearest ancestor that is still alive**. Then the dashboard tree can show it where it used to be.
3. Feed both into the Study Dashboard: the daily aggregates (Summary, Graphs, "Ever") and the hierarchy tree.

Not a goal: restoring Rems, or touching RemNote's data in any way. The helper only reads.

## 3. Decisions

| Decision | Why |
|---|---|
| **Read `remnote.db` from a localhost helper**, read-only (`?mode=ro`). | It's the only way into the trash. The plugin iframe can't read files, and the bridge never serves deleted records. |
| **Part of the existing helper process** (`scripts/ai_ocr_helper.py` serves the routes), with the logic in its own module `scripts/history_archive.py`, also runnable as a CLI. | One LaunchAgent, one port and one Origin check, all of them already installed and trusted. The module stays testable on its own and doesn't need `claude`. |
| **Archive live reps too, not only the trash.** | "Clear Trash" purges at once, and so does a Rem deleted and purged between two scans. Only a copy taken while the card was alive covers those cases. A scan of rows changed since the last one is cheap: the `y` column is indexed (`json_cards_y`, `json_deleted_cards_y`). |
| **Rep identity = the rep timestamp in ms, across all kinds** (card, inc, dism). Not the card or Rem id, and not (kind, timestamp). | Every path that moves history keeps the original `date` but may change the kind, so only the timestamp survives all of them. **Preserve history & remove** turns card reps into `importedRep` entries on the tombstone's Dismissed history, then deletes the cards (§3a). **Dismiss** moves `repHist` to `dismissedHistory`. **Transfer to parent** copies the history to the parent. **Restore from trash** brings the card back with the same reps. **Copies** (imports, "copy to KB") carry history to new ids via `srcRemId`; the test Rem had reps older than itself. **Stale slots**: legacy `bpc` values survive a removed powerup. Two real reps never share a millisecond, because the queue shows one item at a time. |
| **The plugin counts a rep as "ghost" only if its timestamp is in none of the live histories it just read**: card `repetitionHistory`, IncRem `repHist`, Dismissed `dismissedHistory`, `importedRep` entries included. | Live data stays the source of truth. The helper never has to know what the plugin sees, a restored card stops being a ghost automatically, and a rep preserved on a tombstone is counted once, as the tombstone counts it. |
| **When several archived copies share a timestamp, keep the one that was live most recently** (`last_seen_live`). | A rep keeps being counted the way it was last counted, so a total doesn't change kind when a later deletion happens. Example: a tombstone is itself deleted. Its `importedRep` copies (counted as Dismissed time while it lived) win over the original card records, which died first. |
| **The ancestor chain is captured when the archive first sees the Rem deleted, and re-resolved when the dashboard displays it.** | At capture time the parent may already be gone (a whole subtree deleted), so the helper walks `parent` through `deleted_quanta` and `quanta` up to the first live Rem. It stores every link: id, plain text, and whether it was alive. Later, an "alive" ancestor may itself be deleted. The plugin then attaches the ghost to the nearest chain entry that `findOne` still returns, or to a top-level "Deleted Rems" node. |
| **Ghost daily totals go to a small synced key** (`ghostDailyAggregates_<kbId>`, same compact row format as the authoritative shard), **written only when the helper answered.** | Mobile and web have no helper but should still count the reps. The key holds only the days of deleted items, so it stays far below the 900 KB per-key limit (UTF-16, see `findings/PLUGIN_BRIDGE_AND_SDK.md`). If the helper is unreachable, the last good value stays. |
| **Ghost tree nodes are desktop-only**, fetched from the helper when the dashboard opens. | Per-Rem rep lists with texts and chains are too large for synced storage, and the tree is where the desktop is used anyway. Without the helper the tree shows no ghosts, and the totals still include them. |
| **Archive one folder per KB**, `~/.incremental-remnote/history-archive/<kbId>.sqlite`. Scan only KBs the plugin has called in from. | The user requires the helper to read only the KB in use (as the AI OCR helper does), and every folder but one is a test KB. Not under iCloud: launchd can't write there. The existing Claude-config backup hooks can pick it up. |
| **Raw times go to the plugin; the plugin applies the caps.** | The flashcard response-time cap is a plugin setting (`flashcardResponseTimeLimitId`). IncRem review time stays uncapped, as in `computeAuthoritativeAggregatesForCurrentKb`. |

## 3a. Compatibility with commands that move history

The plugin already moves history between Rems before removing things. Each of these produces two copies of the same rep in the DB once the source is deleted: one live, one in the trash. The archive must count it once.

| Command | What it leaves | Handled by |
|---|---|---|
| **Preserve history & remove** (`phr`, `lib/history_transfer.ts`) | Tombstone (live, `preservedHistory` powerup) whose `dismissedHistory` holds every subtree rep. Card reps become `importedRep` with `date` = the card rep's date and time capped and rounded to seconds; IncRem and Dismissed reps are copied as they are. The cards go to `deleted_cards` and the descendants to `deleted_quanta`. | Timestamp identity across kinds. Every trashed copy's date is in the tombstone's live history, so none becomes a ghost. |
| **Dismiss** | `repHist` copied to `dismissedHistory` on the same Rem. | Same Rem stays live, so both copies are live: nothing to do. If it's deleted later, the most-recently-live rule keeps one copy. |
| **Transfer to parent** (`ttp`, `lib/incremental_rem/transfer.ts`) | History on the parent; it already identifies entries by `${date}\|${eventType}`. | Timestamp identity; the parent's live copy wins. |
| **Deleting a tombstone** | Its `importedRep` copies plus the original card and IncRem records, all in the trash. | Most-recently-live rule: the tombstone's copies win, so totals don't move between Card and IncRem. |

Dashboard tree, for the same reason:
- Drop a ghost Rem whose reps were all deduplicated away. The deleted descendants of a tombstone would otherwise show up as empty 🗑 rows under it, while their time is already on the tombstone.
- When the dropped ghosts' chain passes through a live tombstone, the helper can say so (`preservedOn: <tombstone id>`) for the debug report. They are not drawn.

The archive doesn't make the command unnecessary. The tombstone keeps the history in RemNote itself, synced, with no helper, and on any device. The archive is the safety net for deletions that didn't go through it.

## 4. Archive schema (helper side)

```
reps   (kind TEXT,            -- 'card' | 'inc' | 'dism'
        date_ms INTEGER,      -- rep timestamp: THE identity, across kinds (§3)
        item_id TEXT,         -- card id, or Rem id for inc/dism
        rem_id TEXT,
        score REAL,           -- cards: QueueInteractionScore; null for inc/dism
        time_ms INTEGER,      -- card responseTime, or inc reviewTimeSeconds*1000
        event_type TEXT,      -- inc/dism eventType, e.g. 'importedRep' (filtered with repCountsForStats on the plugin)
        first_seen INTEGER,
        last_seen_live INTEGER, -- last scan that saw this copy outside the trash
        PRIMARY KEY (date_ms, kind, item_id))   -- every copy is kept; dedup happens on read

items  (item_id TEXT PRIMARY KEY, kind TEXT, rem_id TEXT,
        last_seen_live INTEGER, seen_in_trash INTEGER, deleted_at INTEGER)

rems   (rem_id TEXT PRIMARY KEY,
        text TEXT,            -- plain text from `key` (refs resolved by name where possible)
        key_json TEXT,        -- raw rich text, for later rendering
        parent_id TEXT,
        deleted_at INTEGER,
        chain_json TEXT,      -- [{id, text, aliveAtCapture}] from parent upward to the first live Rem
        captured_at INTEGER)

scans  (kb_id TEXT, at INTEGER, kind TEXT, watermark_y INTEGER, cards INTEGER, rems INTEGER, ms INTEGER)
```

- Card reps: read `cards.doc.h` and `deleted_cards.doc.h`, with the Rem from `rId`.
- IncRem and Dismissed reps: read the slot value from both layouts, inline `doc.bpc.<code>.<slot>.v` and `doc.ps["<code>_<slot>"].v.v`, in `quanta` and `deleted_quanta`. A slot stored as a child Rem has to be read from the child.
- **The archive never deletes a row.** `rems` rows are written for every Rem that has archived reps. Live Rems' rows are refreshed (text, parent) on each scan, so the ancestry is already there on the day they are deleted.

## 5. Helper routes

All are POST, carry `kbId`, and go through the existing Origin check:

- `/history/scan` `{kbId, full?}`: run a scan now (incremental by default). Returns counts.
- `/history/ghosts` `{kbId}`: every archived rep whose item is no longer live in `remnote.db`. That's a card absent from `cards`, or an inc/dism Rem absent from `quanta` or without the slot. They come with their `rems` rows and chains. The plugin still applies the timestamp test of §3, so this is only a pre-filter that keeps the payload small.
- `/history/status` `{kbId}`: last scans, archive size, how many items are in the trash right now, and the oldest `deletedAt` there.

Background thread: an incremental scan of every known KB every 6 hours and at helper start, plus a full scan weekly. Two weeks is the deadline, so this leaves a wide margin.

## 6. Plugin side

- `src/lib/history_archive.ts`:
  1. `fetchGhosts(plugin)` calls the helper and fails quietly when it's unreachable.
  2. It builds one `Set` of live rep timestamps from all three histories (card, inc, dism, `importedRep` included), using the reads the caller already made.
  3. It drops ghosts found in that set, then keeps one copy per timestamp among the rest (most recently live, §3).
  4. It returns per-Rem ghost records and ghost daily buckets.
- **Aggregates.** `computeAuthoritativeAggregatesForCurrentKb` and `refreshAuthoritativeAggregatesFromCardRead` write the ghost buckets to `ghostDailyAggregates_<kbId>` when the helper answered. `aggregatePeriodStatsCombined` and the Graphs timeline add the ghost buckets to the authoritative ones. Ghost rows carry the same fields as `TimelineDay` (grade split, inc vs card time), so the Graphs tab can stack them.
- **Tree.** The dashboard's gather step (`study_dashboard.tsx`, both scope modes) turns each ghost Rem into a `RemData` with `deleted: true`. Its `parentId` points to a ghost parent if that parent is archived, otherwise to the nearest live chain entry. The existing structural-ancestor walk does the rest. Document mode includes a ghost when the document is in its chain.
- **UI:**
  - a 🗑 marker and the deletion date on ghost rows;
  - a "Include deleted Rems" toggle, on by default;
  - a line in the Summary: "N reps from deleted Rems".
- **No helper, no change.** Without the helper the dashboard behaves exactly as today, plus the synced ghost totals.

## 7. Open questions to measure first (Phase 0)

- Removing a cloze's markup or a card type: does the card go to `deleted_cards`, or stay in `cards`? `findings/CARD_STATE_REFERENCE.md` suggests it stays. If it stays, does `card.getAll()` still return it? If not, its reps are already missing from the dashboard today, and the archive should treat "in `cards` but never returned by the API" as a ghost too. That's what the timestamp test does anyway, as long as the plugin builds its sets from `getAll()`.
- Disabled directions: same question for `card.getAll()`. Per `findings/`, `rem.getCards()` drops them.
- New-layout IncRems: confirm a deleted IncRem's `ps` slot values survive in `deleted_quanta`. The 2026-11-10 sample was legacy `bpc`.
- A trash cleared on another device: does the local `deleted_cards` row vanish on the next sync, and how fast? This sets how much the live archiving matters.
- Preserve history & remove on a test subtree with cards, an IncRem and a Dismissed Rem: confirm that every trashed copy's `date` appears unchanged in the tombstone's `dismissedHistory`. Do the same for Transfer to parent.
- Cost of a full scan on the main KB (1.8 GB, 71k cards, 268k reps) while RemNote is running. WAL readers don't block the writer, but measure the time and check RemNote stays smooth.

## Phases

- [ ] **0. Measure** the open questions above in a test KB, and write the answers to `findings/`.
- [ ] **1. Scanner + archive** (`scripts/history_archive.py`, CLI only):
  - `--kb <id> --scan [--full]`, `--report`;
  - tests on a copy of a test-KB `remnote.db` with a deleted subtree, a restored Rem, an imported copy, a Preserve-history tombstone, and a deleted tombstone.
- [ ] **2. Helper routes + background scans** in `ai_ocr_helper.py`, plus the LaunchAgent restart. Verify `/history/ghosts` on the main KB (read-only).
- [ ] **3. Plugin client** `src/lib/history_archive.ts`:
  - ghost buckets into `ghostDailyAggregates_<kbId>`, merged into Summary and Graphs;
  - check the totals against a manual count from the archive;
  - a no-double-count check: run Preserve history & remove on a test subtree. The dashboard's totals must be identical before and after, with the helper on and off.
- [ ] **4. Dashboard tree**: ghost `RemData` nodes, the marker, the toggle and the Summary line.
- [ ] **5. Backfill** from snapshots: local `backups/`, iCloud `Back Ups/RemNote` `.db.zip`, Google Drive 2024 `.db`; open with `?immutable=1`. Reps found only there are archived with `source = '<backup name>'`.
- [ ] **6. Docs** once the feature is approved: changelog entry, and a section in the Study Dashboard page on the helper and what "deleted Rems" counts mean.
