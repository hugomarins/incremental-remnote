/**
 * Flashcard Repetition History popup widget.
 *
 * Shows every card of one Rem: its full repetition history with Delay, Next
 * Interval, per-step FSRS D/S, and any pluginData — and, underneath them all,
 * the Rem's CardPriority history (every priority it has held, with the source
 * and the gesture that set it).
 *
 * WHY THE CARDS COLLAPSE
 *
 * A Rem can easily carry eight cards (five clozes plus forward/backward is an
 * ordinary shape), and eight full tables stacked in a popup is unreadable. So
 * each card is a section that opens and closes, modelled on RemNote's own
 * "Bullet Information" panel: the header names the card the way that panel does
 * — `Cloze (the pressure differences)`, `Forward Card` — and carries the
 * totals, so a collapsed section still answers "how many reps, how much time,
 * when next". Sections start collapsed whenever there is more than one card;
 * a single-card Rem opens straight into its table, since there is nothing to
 * choose between.
 */
import {
    renderWidget,
    usePlugin,
    useTrackerPlugin,
    WidgetLocation,
    QueueInteractionScore,
} from '@remnote/plugin-sdk';
import React, { useMemo, useEffect, useState } from 'react';
import { computeFSRSStatesPerReview, computeFSRSState, parseWeightsString } from '../lib/fsrs';
import { formatStabilityDays, formatTimeAgo, getRetrievabilityColor } from '../lib/utils';
import { resolveRemTextForBreadcrumb } from '../lib/richTextRemRefs';
import { displayFsrsDsrId, fsrsWeightsId, powerupCode, dismissedPowerupCode } from '../lib/consts';
import { useIESetting } from '../lib/settings';
import { buildCardLabels, CardLabel } from '../lib/card_labels';
import {
    PriorityHistoryEntry,
    readCardPriorityHistory,
    priorityEventLabel,
    priorityEventIcon,
    summarizePriorityHistory,
} from '../lib/priority_history';

function scoreLabel(score: QueueInteractionScore): string {
    switch (score) {
        case QueueInteractionScore.AGAIN: return 'Again';
        case QueueInteractionScore.HARD: return 'Hard';
        case QueueInteractionScore.GOOD: return 'Good';
        case QueueInteractionScore.EASY: return 'Easy';
        case QueueInteractionScore.TOO_EARLY: return 'Too Early';
        case QueueInteractionScore.VIEWED_AS_LEECH: return 'Leech';
        case QueueInteractionScore.RESET: return 'Reset';
        case QueueInteractionScore.MANUAL_DATE: return 'Manual Date';
        case QueueInteractionScore.MANUAL_EASE: return 'Manual Ease';
        default: return `Unknown (${score})`;
    }
}

function scoreColor(score: QueueInteractionScore): string {
    switch (score) {
        case QueueInteractionScore.AGAIN: return '#ef4444';
        case QueueInteractionScore.HARD: return '#f59e0b';
        case QueueInteractionScore.GOOD: return '#22c55e';
        case QueueInteractionScore.EASY: return '#3b82f6';
        default: return 'var(--rn-clr-content-tertiary)';
    }
}

/** Format a delay in ms as a human-readable string (like RemNote's display) */
function formatDelay(delayMs: number): string {
    const absDays = Math.abs(delayMs) / (1000 * 60 * 60 * 24);
    const direction = delayMs > 0 ? 'late' : 'early';

    if (absDays < 0.5) return 'On Target Day';
    if (absDays < 1.5) return `1 day ${direction}`;
    if (absDays < 7) return `${Math.round(absDays)} days ${direction}`;
    if (absDays < 30) return `${Math.round(absDays / 7)} weeks ${direction}`;
    if (absDays < 60) return `a month ${direction}`;
    if (absDays < 335) return `${Math.round(absDays / 30.44)} months ${direction}`;
    if (absDays < 548) return `a year ${direction}`;
    return `${(absDays / 365.25).toFixed(1)} years ${direction}`;
}

/** Format an interval in ms as a human-readable duration */
function formatInterval(intervalMs: number): string {
    const days = intervalMs / (1000 * 60 * 60 * 24);
    if (days < 0.007) return 'immediate'; // < 10 min
    if (days < 0.042) return `${Math.round(days * 24 * 60)} min`;
    if (days < 1) return `${Math.round(days * 24)} hours`;
    if (days < 1.5) return '1 day';
    if (days < 30) return `${Math.round(days)} days`;
    if (days < 365) return `${(days / 30.44).toFixed(1)} months`;
    return `${(days / 365.25).toFixed(1)} years`;
}

/** "4 min", "1.2 h" — the TIME SPENT figure, from summed response times. */
function formatMinutes(totalMinutes: number): string {
    if (totalMinutes <= 0) return 'None';
    if (totalMinutes < 60) return `${totalMinutes} min`;
    return `${(totalMinutes / 60).toFixed(1)} h`;
}

const cellStyle: React.CSSProperties = { padding: '3px 6px', whiteSpace: 'nowrap' };

/** Tailwind's red-500, the colour lapses are called out in throughout the popup. */
const LAPSE_COLOR = '#ef4444';

/**
 * The Practiced Queues dashboard's retention thresholds and colours, as hex:
 * ≥90% green-600, <80% red-500, amber-600 in between. Repeated as literals
 * rather than imported because that widget expresses them as Tailwind class
 * names and this one styles inline — the numbers are the contract, and they are
 * stated here so the two cannot silently drift apart unnoticed.
 */
function retentionColor(retention: number): string {
    if (retention >= 90) return '#16a34a';
    if (retention < 80) return LAPSE_COLOR;
    return '#ca8a04';
}

/**
 * Retention over a set of graded answers: the share that were not "Again".
 *
 * Same definition the Practiced Queues dashboard uses (remembered / practised),
 * applied to a card's own history instead of a session's. `null` when there is
 * nothing graded to divide by — a new card has no retention, and showing it as
 * 100% would flatter it.
 */
function retentionOf(gradeableCount: number, lapses: number): number | null {
    if (gradeableCount <= 0) return null;
    return ((gradeableCount - lapses) / gradeableCount) * 100;
}

/** "7 (2)" — repetitions with lapses called out in red. */
function RepsWithLapses({ reps, lapses }: { reps: number; lapses: number }) {
    return (
        <>
            {reps}
            {lapses > 0 && (
                <span
                    style={{ color: LAPSE_COLOR, marginLeft: 4 }}
                    title={`${lapses} lapse${lapses === 1 ? '' : 's'} — answers graded "Again"`}
                >
                    ({lapses})
                </span>
            )}
        </>
    );
}

/** "94% retention", coloured on the dashboard's thresholds. */
function RetentionText({ retention }: { retention: number | null }) {
    if (retention === null) {
        return <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>no retention yet</span>;
    }
    return (
        <span title="Share of graded answers that were not “Again”">
            <span style={{ color: retentionColor(retention), fontWeight: 600 }}>
                {retention.toFixed(0)}%
            </span>{' '}
            retention
        </span>
    );
}

const buttonStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '2px 6px',
    borderRadius: 4,
    border: '1px solid var(--rn-clr-border-primary)',
    background: 'transparent',
    cursor: 'pointer',
    color: 'var(--rn-clr-content-secondary)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
};

interface CardStats {
    /** History sorted oldest-first, everything included. */
    sortedHistory: any[];
    /** The slice after the last RESET — what the current schedule is built on. */
    activeHistory: any[];
    totalMinutes: number;
    /** Answers with a real grade (Again/Hard/Good/Easy) — retention's denominator. */
    gradeableCount: number;
    /** Answers graded "Again". */
    lapses: number;
    /** Share of `gradeableCount` that was not a lapse; null when nothing is graded. */
    retention: number | null;
    /** No repetitions at all — RemNote's "New Card". */
    isNew: boolean;
    cardAgeText: string;
    cardAgeMs: number;
    firstRepDate: number | null;
    lastPracticeDate: Date | null;
    nextRepDate: Date | null;
    staleDate: Date | null;
    isStale: boolean;
    nextIntervalMs: number | null;
    coverageText: string;
    costText: string;
}

/**
 * Everything both the collapsed header and the expanded body need for one card.
 *
 * Extracted so the two renderings cannot disagree: the totals in a collapsed
 * header are the same numbers the open section shows, computed once.
 */
function computeCardStats(card: any): CardStats {
    const sortedHistory = [...card.history].sort((a: any, b: any) => a.date - b.date);

    const lastResetIndex = sortedHistory.map((h: any) => h.score).lastIndexOf(QueueInteractionScore.RESET);
    const activeHistory = lastResetIndex !== -1 ? sortedHistory.slice(lastResetIndex + 1) : sortedHistory;

    const gradeableReps = activeHistory.filter((h: any) =>
        h.score === QueueInteractionScore.AGAIN ||
        h.score === QueueInteractionScore.HARD ||
        h.score === QueueInteractionScore.GOOD ||
        h.score === QueueInteractionScore.EASY
    );
    const totalMs = gradeableReps.reduce((acc: number, h: any) => acc + (h.responseTime || 0), 0);
    const totalMinutes = Math.round(totalMs / 6000) / 10;

    const lapses = gradeableReps.filter((h: any) => h.score === QueueInteractionScore.AGAIN).length;
    const retention = retentionOf(gradeableReps.length, lapses);

    const firstRepDate = activeHistory.length > 0 ? activeHistory[0].date : null;
    const cardAgeMs = firstRepDate ? Date.now() - firstRepDate : 0;
    const cardAgeDays = Math.max(0, Math.floor(cardAgeMs / (1000 * 60 * 60 * 24)));
    const cardAgeText = formatStabilityDays(cardAgeDays);

    const lastRep = sortedHistory.length > 0 ? sortedHistory[sortedHistory.length - 1] : null;
    const lastPracticeDate = lastRep ? new Date(lastRep.date) : null;
    const nextRepDate = card.nextRepetitionTime ? new Date(card.nextRepetitionTime) : null;

    let coverageText = '';
    let coverageMsForCost = 0;
    if (firstRepDate && nextRepDate) {
        const coverageMs = nextRepDate.getTime() - firstRepDate;
        if (coverageMs > 0) {
            const coverageDays = Math.max(0, Math.floor(coverageMs / (1000 * 60 * 60 * 24)));
            coverageText = `, 📊 Coverage: ${formatStabilityDays(coverageDays)}`;
            coverageMsForCost = coverageMs;
        }
    }

    let costText = '';
    const isNextRepInFuture = nextRepDate && nextRepDate.getTime() > Date.now();
    if (firstRepDate && totalMinutes > 0) {
        if (isNextRepInFuture && coverageMsForCost > 0) {
            const coverageYears = coverageMsForCost / (1000 * 60 * 60 * 24 * 365);
            if (coverageYears > 0) {
                costText = `, 💰 Cost: ${(totalMinutes / coverageYears).toFixed(1)} min/year`;
            }
        } else {
            const ageYears = cardAgeMs / (1000 * 60 * 60 * 24 * 365);
            if (ageYears > 0) {
                costText = `, 💰 Cost: ${(totalMinutes / ageYears).toFixed(1)} min/year`;
            }
        }
    }

    let isStale = false;
    let staleDate: Date | null = null;
    let nextIntervalMs: number | null = null;
    if (lastRep && nextRepDate) {
        nextIntervalMs = nextRepDate.getTime() - lastRep.date;
        // Stale means overdue by more than twice the last interval.
        staleDate = new Date(lastRep.date + 2 * nextIntervalMs);
        isStale = Date.now() > staleDate.getTime();
    }

    return {
        sortedHistory,
        activeHistory,
        totalMinutes,
        gradeableCount: gradeableReps.length,
        lapses,
        retention,
        isNew: sortedHistory.length === 0,
        cardAgeText,
        cardAgeMs,
        firstRepDate,
        lastPracticeDate,
        nextRepDate,
        staleDate,
        isStale,
        nextIntervalMs,
        coverageText,
        costText,
    };
}

/** One of the four tiles in a card's collapsed summary, mirroring RemNote's panel. */
function StatTile({
    label,
    value,
    sub,
}: {
    label: string;
    value: React.ReactNode;
    sub?: React.ReactNode;
}) {
    return (
        <div
            style={{
                flex: '1 1 110px',
                minWidth: 96,
                padding: '5px 8px',
                borderRadius: 6,
                border: '1px solid var(--rn-clr-border-primary)',
                background: 'var(--rn-clr-background-primary)',
            }}
        >
            <div style={{ fontSize: 9, letterSpacing: '0.4px', color: 'var(--rn-clr-content-tertiary)' }}>
                {label}
            </div>
            <div style={{ fontSize: 12, color: 'var(--rn-clr-content-primary)' }}>{value}</div>
            {sub && (
                <div style={{ fontSize: 9, color: 'var(--rn-clr-content-tertiary)' }}>{sub}</div>
            )}
        </div>
    );
}

interface RemTotals {
    cards: number;
    newCards: number;
    staleCards: number;
    reps: number;
    lapses: number;
    minutes: number;
    retention: number | null;
}

/**
 * Rem-wide totals across every card.
 *
 * Retention is pooled, not a mean of the per-card percentages: averaging a card
 * with 40 answers against one with 2 would let the small card swing the figure,
 * and the dashboard's definition — remembered ÷ practised — is already an
 * aggregate. Summing both sides first keeps this number comparable with the one
 * the Practiced Queues history shows for a session.
 */
function computeRemTotals(statsList: CardStats[]): RemTotals {
    let newCards = 0;
    let staleCards = 0;
    let reps = 0;
    let lapses = 0;
    let minutes = 0;
    let gradeable = 0;
    for (const s of statsList) {
        if (s.isNew) newCards++;
        if (s.isStale) staleCards++;
        reps += s.activeHistory.length;
        lapses += s.lapses;
        minutes += s.totalMinutes;
        gradeable += s.gradeableCount;
    }
    return {
        cards: statsList.length,
        newCards,
        staleCards,
        reps,
        lapses,
        minutes: Math.round(minutes * 10) / 10,
        retention: retentionOf(gradeable, lapses),
    };
}

/** The four rem-wide tiles, above the per-card sections. */
function RemTotalsHeader({ totals }: { totals: RemTotals }) {
    const composition: string[] = [];
    if (totals.newCards > 0) composition.push(`${totals.newCards} new`);
    if (totals.staleCards > 0) composition.push(`${totals.staleCards} stale`);

    return (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <StatTile
                label="CARDS"
                value={`${totals.cards}`}
                sub={composition.length ? composition.join(' · ') : 'all reviewed'}
            />
            <StatTile
                label="REPETITIONS"
                value={<RepsWithLapses reps={totals.reps} lapses={totals.lapses} />}
                sub="across all cards"
            />
            <StatTile label="TIME SPENT" value={formatMinutes(totals.minutes)} sub="all cards" />
            <StatTile
                label="RETENTION"
                value={
                    totals.retention === null ? (
                        '—'
                    ) : (
                        <span style={{ color: retentionColor(totals.retention), fontWeight: 700 }}>
                            {totals.retention.toFixed(0)}%
                        </span>
                    )
                }
                sub="graded answers kept"
            />
        </div>
    );
}

/**
 * The Rem's CardPriority history — every priority it has held, newest first.
 *
 * Rem-level, so it sits once at the bottom rather than inside any card section:
 * the CardPriority powerup tags the Rem, and all of its cards share the value.
 */
function PriorityHistorySection({ entries }: { entries: PriorityHistoryEntry[] }) {
    const summary = useMemo(() => summarizePriorityHistory(entries), [entries]);

    return (
        <div style={{ marginTop: 18, borderTop: '2px solid var(--rn-clr-border-primary)', paddingTop: 10 }}>
            <div
                style={{
                    fontWeight: 600,
                    fontSize: 12,
                    color: 'var(--rn-clr-content-primary)',
                    marginBottom: 6,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    flexWrap: 'wrap',
                }}
            >
                <span>🎚 Card Priority History</span>
                {summary.last && (
                    <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--rn-clr-content-tertiary)' }}>
                        now {summary.last.p} · {summary.entries.length} change
                        {summary.entries.length === 1 ? '' : 's'}
                        {summary.min !== null && summary.min !== summary.max
                            ? ` · range ${summary.min}–${summary.max}`
                            : ''}
                        {summary.manualCount > 0 ? ` · ${summary.manualCount} by hand` : ''}
                    </span>
                )}
            </div>

            {entries.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--rn-clr-content-tertiary)', paddingLeft: 2 }}>
                    No priority changes recorded yet. Changes are recorded from the moment this
                    version of the plugin sets a priority — earlier ones left no trace to recover.
                </div>
            ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ borderBottom: '2px solid var(--rn-clr-border-primary)', fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>When</th>
                            <th style={{ ...cellStyle, textAlign: 'right' }}>Priority</th>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>Change</th>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>Event</th>
                            <th style={{ ...cellStyle, textAlign: 'left' }}>Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* Newest first — the current priority is the thing being explained. */}
                        {[...entries].reverse().map((entry, i) => {
                            const previous = entries[entries.length - 1 - i - 1];
                            const delta = previous ? entry.p - previous.p : null;
                            const isCurrent = i === 0;
                            const isOrigin = i === entries.length - 1;
                            return (
                                <tr
                                    key={`${entry.t}-${i}`}
                                    style={{
                                        borderBottom: '1px solid var(--rn-clr-border-primary)',
                                        backgroundColor: isCurrent
                                            ? 'var(--rn-clr-background-secondary)'
                                            : 'transparent',
                                    }}
                                >
                                    <td style={cellStyle}>
                                        {new Date(entry.t).toLocaleDateString()}
                                        <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: 4 }}>
                                            {new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </td>
                                    <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 600 }}>{entry.p}</td>
                                    <td style={cellStyle}>
                                        {isOrigin ? (
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>first set</span>
                                        ) : delta === null || delta === 0 ? (
                                            '—'
                                        ) : (
                                            <span style={{ color: delta < 0 ? '#22c55e' : '#f59e0b' }}>
                                                {previous.p} → {entry.p} ({delta > 0 ? '+' : ''}
                                                {delta})
                                            </span>
                                        )}
                                    </td>
                                    <td style={cellStyle}>
                                        {priorityEventIcon(entry.e)} {priorityEventLabel(entry.e)}
                                    </td>
                                    <td style={{ ...cellStyle, color: 'var(--rn-clr-content-tertiary)' }}>
                                        {entry.s}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function FlashcardRepetitionHistory() {
    const plugin = usePlugin();

    const showFsrsDsr = useIESetting(displayFsrsDsrId);
    const fsrsWeightsRaw = useIESetting(fsrsWeightsId);

    const data = useTrackerPlugin(async (rp) => {
        const ctx = await rp.widget.getWidgetContext<WidgetLocation.Popup>();
        const cardId = ctx?.contextData?.cardId as string | undefined;
        const remId = ctx?.contextData?.remId as string | undefined;
        if (!cardId && !remId) return null;

        // Resolve the Rem first, then take ALL of its cards. The Ctrl+Shift+H
        // contract is per-Rem — "show the history of them all" — so a cardId
        // coming from the queue narrows nothing; it only says which section to
        // open first.
        let rem = remId ? await rp.rem.findOne(remId) : null;
        if (!rem && cardId) {
            const card = await rp.card.findOne(cardId);
            if (card?.remId) rem = await rp.rem.findOne(card.remId);
        }

        let cards: any[] = [];
        let remName = '';
        let priorityHistory: PriorityHistoryEntry[] = [];
        let hasIncrementalHistory = false;
        let labels = new Map<string, CardLabel>();

        if (rem) {
            const [remCards, name, history, hasInc, hasDismissed] = await Promise.all([
                rem.getCards(),
                // Same renderer the card labels use: rem references resolved
                // in [ ] and reference pins collapsed to 📌, rather than
                // safeRemTextToString's expansion of a pin into the whole rem
                // it points at.
                resolveRemTextForBreadcrumb(rp, rem.text),
                readCardPriorityHistory(rem),
                rem.hasPowerup(powerupCode),
                rem.hasPowerup(dismissedPowerupCode),
            ]);
            cards = remCards || [];
            remName = name;
            priorityHistory = history;
            hasIncrementalHistory = !!hasInc || !!hasDismissed;
            labels = await buildCardLabels(rp, rem, cards);
        } else if (cardId) {
            const card = await rp.card.findOne(cardId);
            if (card) cards = [card];
        }

        return {
            cardId,
            remId: rem?._id ?? remId,
            remName,
            priorityHistory,
            hasIncrementalHistory,
            cards: cards.map((c: any) => ({
                _id: c._id,
                type: c.type,
                label: labels.get(c._id) ?? null,
                createdAt: c.createdAt,
                nextRepetitionTime: c.nextRepetitionTime,
                timesWrongInRow: c.timesWrongInRow,
                history: c.repetitionHistory || [],
            })),
        };
    }, []);

    // Which card sections are open. Undefined until the data lands, so the
    // default below can depend on how many cards there turned out to be.
    const [expanded, setExpanded] = useState<Record<string, boolean> | null>(null);
    // Which card header the keyboard is on. -1 = none, so the arrows can enter
    // the list from the top without a card being pre-selected on open.
    const [selected, setSelected] = useState(-1);

    useEffect(() => {
        if (!data || expanded !== null) return;
        const next: Record<string, boolean> = {};
        for (const card of data.cards) {
            // One card: nothing to choose between, so open it. Several: start
            // collapsed, except the card the queue was actually showing.
            next[card._id] = data.cards.length === 1 || card._id === data.cardId;
        }
        setExpanded(next);
    }, [data, expanded]);

    // FSRS step states, per card, in the same order as data.cards.
    const fsrsData = useMemo(() => {
        if (!data) return null;
        const weights = parseWeightsString(fsrsWeightsRaw);
        return data.cards.map(card => ({
            stepStates: computeFSRSStatesPerReview(card.history, weights),
            finalState: computeFSRSState(card.history, weights),
        }));
    }, [data, fsrsWeightsRaw]);

    // Keyboard driving, the same contract every popup in this plugin honours:
    // ↑/↓ walk the card sections, Enter/Space opens or closes the selected one,
    // Esc closes the popup. Bound on the window rather than on the headers so it
    // works before anything has been clicked — a popup that opens with no focus
    // must still respond to the first arrow key.
    useEffect(() => {
        const cardIds = data?.cards.map((c) => c._id) ?? [];
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                plugin.widget.closePopup();
                return;
            }
            if (cardIds.length === 0) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((cur) => {
                    if (cur < 0) return e.key === 'ArrowDown' ? 0 : cardIds.length - 1;
                    const next = cur + (e.key === 'ArrowDown' ? 1 : -1);
                    return Math.max(0, Math.min(cardIds.length - 1, next));
                });
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                if (selected < 0) return;
                e.preventDefault();
                const id = cardIds[selected];
                setExpanded((prev) => ({ ...(prev || {}), [id]: !prev?.[id] }));
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [plugin, data, selected]);

    if (!data) {
        return (
            <div style={{ padding: 16, color: 'var(--rn-clr-content-secondary)', fontSize: 13 }}>
                No card data available. Ensure you opened this from a flashcard context.
            </div>
        );
    }

    // One pass over the cards, reused by the totals header and by every section:
    // the header's figures must be the sum of exactly what the sections show.
    const statsByCard = data.cards.map((card) => computeCardStats(card));
    const totals = computeRemTotals(statsByCard);

    const allExpanded = data.cards.length > 0 && data.cards.every((c) => expanded?.[c._id]);
    const setAll = (open: boolean) => {
        const next: Record<string, boolean> = {};
        for (const card of data.cards) next[card._id] = open;
        setExpanded(next);
    };

    return (
        <div style={{ padding: 16, maxHeight: '600px', overflow: 'auto', fontSize: 11, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: 14, color: 'var(--rn-clr-content-primary)' }}>
                    📊 Flashcard Repetition History
                </h3>
                {data.cards.length > 1 && (
                    <button style={buttonStyle} onClick={() => setAll(!allExpanded)}>
                        {allExpanded ? 'Collapse all' : 'Expand all'}
                    </button>
                )}
                {data.hasIncrementalHistory && data.remId && (
                    <button
                        style={buttonStyle}
                        title="This Rem is also Incremental — switch to its repetition history"
                        onClick={async () => {
                            // Close first: RemNote shows one popup at a time, and
                            // opening over this one leaves it behind on the stack.
                            await plugin.widget.closePopup();
                            await plugin.widget.openPopup('repetition_history', { remId: data.remId });
                        }}
                    >
                        ♾ Incremental History
                    </button>
                )}
                <button
                    style={{ ...buttonStyle, marginLeft: 'auto' }}
                    onClick={() => plugin.widget.closePopup()}
                    title="Close"
                >
                    ✕
                </button>
            </div>
            <div style={{ marginBottom: 8, color: 'var(--rn-clr-content-tertiary)', fontSize: 10 }}>
                {data.remName && (
                    <span title={data.remName}>
                        <strong>{data.remName.length > 100 ? `${data.remName.substring(0, 100)}…` : data.remName}</strong> ·{' '}
                    </span>
                )}
                {data.cards.length} card{data.cards.length === 1 ? '' : 's'} · Rem ID:{' '}
                <code>{data.remId || '—'}</code>
            </div>

            {data.cards.length > 0 && <RemTotalsHeader totals={totals} />}

            {data.cards.length === 0 && (
                <div style={{ color: 'var(--rn-clr-content-tertiary)', padding: '8px 0' }}>
                    This Rem has no flashcards.
                </div>
            )}

            {data.cards.map((card, ci) => {
                const fsrs = fsrsData?.[ci];
                const stats = statsByCard[ci];
                const isOpen = !!expanded?.[card._id];
                const label = card.label;
                const headerName = label?.typeName
                    ?? (typeof card.type === 'string'
                        ? card.type.charAt(0).toUpperCase() + card.type.slice(1) + ' Card'
                        : `Cloze Card (${card.type?.clozeId})`);

                return (
                    <div key={card._id} style={{ marginBottom: 12 }}>
                        {/* Card header — click anywhere to open/close */}
                        <div
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                                setSelected(ci);
                                setExpanded((prev) => ({ ...(prev || {}), [card._id]: !isOpen }));
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setExpanded((prev) => ({ ...(prev || {}), [card._id]: !isOpen }));
                                }
                            }}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                fontWeight: 600,
                                marginBottom: 4,
                                padding: '4px 8px',
                                backgroundColor: 'var(--rn-clr-background-secondary)',
                                borderRadius: 6,
                                color: 'var(--rn-clr-content-primary)',
                                fontSize: 12,
                                cursor: 'pointer',
                                userSelect: 'none',
                                outline:
                                    selected === ci ? '2px solid var(--rn-clr-content-accent, #3b82f6)' : 'none',
                                outlineOffset: '-1px',
                            }}
                        >
                            <span style={{ width: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                                {isOpen ? '▾' : '▸'}
                            </span>
                            <span style={{ flexShrink: 0 }}>{headerName}</span>
                            {label?.identifier && (
                                <span
                                    title={label.identifier}
                                    style={{
                                        fontWeight: 400,
                                        color: 'var(--rn-clr-content-secondary)',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        minWidth: 0,
                                    }}
                                >
                                    ({label.identifier})
                                </span>
                            )}
                            {card._id === data.cardId && (
                                <span
                                    style={{
                                        padding: '1px 5px',
                                        borderRadius: 4,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                        color: '#3b82f6',
                                    }}
                                    title="The card you were reviewing"
                                >
                                    IN QUEUE
                                </span>
                            )}
                            {stats.isStale && (
                                <span style={{
                                    padding: '1px 5px',
                                    backgroundColor: '#ef4444',
                                    color: 'white',
                                    borderRadius: 4,
                                    fontSize: 9,
                                    fontWeight: 'bold',
                                }}>
                                    STALE
                                </span>
                            )}
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontWeight: 400,
                                    color: 'var(--rn-clr-content-tertiary)',
                                    fontSize: 11,
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {stats.activeHistory.length} rep
                                {stats.activeHistory.length === 1 ? '' : 's'}
                                {stats.lapses > 0 && (
                                    <span
                                        style={{ color: LAPSE_COLOR, marginLeft: 4 }}
                                        title={`${stats.lapses} lapse${stats.lapses === 1 ? '' : 's'} — answers graded “Again”`}
                                    >
                                        ({stats.lapses})
                                    </span>
                                )}{' '}
                                · ⏳ {formatMinutes(stats.totalMinutes)}
                                {stats.retention !== null && (
                                    <>
                                        {' · '}
                                        <span
                                            style={{ color: retentionColor(stats.retention), fontWeight: 600 }}
                                            title="Share of graded answers that were not “Again”"
                                        >
                                            {stats.retention.toFixed(0)}%
                                        </span>
                                    </>
                                )}
                            </span>
                        </div>

                        {/* Collapsed: the four totals, the same tiles RemNote's panel shows. */}
                        {!isOpen && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 2px 4px' }}>
                                <StatTile
                                    label="NEXT PRACTICE"
                                    value={stats.nextRepDate ? formatTimeAgo(stats.nextRepDate.getTime(), Date.now()) : 'New Card'}
                                    sub={stats.nextRepDate ? stats.nextRepDate.toLocaleDateString() : undefined}
                                />
                                <StatTile
                                    label="LAST PRACTICED"
                                    value={stats.lastPracticeDate ? formatTimeAgo(stats.lastPracticeDate.getTime(), Date.now()) : 'Never'}
                                    sub={stats.lastPracticeDate ? stats.lastPracticeDate.toLocaleDateString() : undefined}
                                />
                                <StatTile
                                    label="REPETITIONS"
                                    value={
                                        <RepsWithLapses
                                            reps={stats.activeHistory.length}
                                            lapses={stats.lapses}
                                        />
                                    }
                                    sub={<RetentionText retention={stats.retention} />}
                                />
                                <StatTile
                                    label="TIME SPENT"
                                    value={formatMinutes(stats.totalMinutes)}
                                    sub={stats.firstRepDate ? `${stats.cardAgeText} age` : undefined}
                                />
                            </div>
                        )}

                        {isOpen && (
                            <>
                                <div style={{
                                    padding: '0 8px 4px',
                                    fontSize: 11,
                                    color: 'var(--rn-clr-content-tertiary)',
                                }}>
                                    {stats.activeHistory.length} reviews
                                    {stats.lapses > 0 && (
                                        <span
                                            style={{ color: LAPSE_COLOR }}
                                            title={`${stats.lapses} lapse${stats.lapses === 1 ? '' : 's'} — answers graded “Again”`}
                                        >
                                            {' '}({stats.lapses})
                                        </span>
                                    )}
                                    , <RetentionText retention={stats.retention} />, ⏳{' '}
                                    {stats.totalMinutes} min, {stats.cardAgeText} age
                                    {stats.coverageText}{stats.costText}
                                </div>

                                {/* Dates summary */}
                                <div style={{
                                    padding: '4px 8px',
                                    marginBottom: 4,
                                    fontSize: 11,
                                    color: 'var(--rn-clr-content-secondary)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '2px'
                                }}>
                                    {stats.nextRepDate && (
                                        <div>
                                            <strong>Next repetition scheduled date:</strong> {stats.nextRepDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.nextRepDate.getTime(), Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.lastPracticeDate && fsrs?.finalState?.s && (
                                        <div>
                                            <strong
                                                title="Based on the current FSRS memory models, this is the optimal date you should review things to achive 90% chance of recall. If it's different from the scheduled date, it's either because the original scheduler was not FSRS or had different weights set, or because of fuzz (randomness), load balancing, or RemNote's internal constraints."
                                                style={{ cursor: 'help', textDecoration: 'underline dotted', textUnderlineOffset: '2px' }}
                                            >Optimum Next repetition date:</strong> {new Date(stats.lastPracticeDate.getTime() + fsrs.finalState.s * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.lastPracticeDate.getTime() + fsrs.finalState.s * 24 * 60 * 60 * 1000, Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.staleDate && (
                                        <div>
                                            <strong>Date at which becomes stale:</strong> {stats.staleDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.staleDate.getTime(), Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.lastPracticeDate && (
                                        <div>
                                            <strong>Last practice date:</strong> {stats.lastPracticeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                                            <span style={{ color: 'var(--rn-clr-content-tertiary)' }}> ({formatTimeAgo(stats.lastPracticeDate.getTime(), Date.now())})</span>
                                        </div>
                                    )}
                                    {stats.nextIntervalMs !== null && (
                                        <div>
                                            <strong>Current interval:</strong> {formatInterval(stats.nextIntervalMs)}
                                            {fsrs?.finalState?.s && (
                                                <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                                                    {' '}({Math.round((stats.nextIntervalMs / (1000 * 60 * 60 * 24)) / fsrs.finalState.s * 100)}% of predicted Stability)
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* FSRS summary */}
                                {showFsrsDsr && fsrs?.finalState && (
                                    <div style={{
                                        padding: '4px 8px',
                                        marginBottom: 4,
                                        fontSize: 11,
                                        color: 'var(--rn-clr-content-secondary)',
                                    }}>
                                        <strong>D:</strong> {fsrs.finalState.d.toFixed(2)}
                                        {' · '}
                                        <strong>S:</strong> {fsrs.finalState.s.toFixed(1)}d{formatStabilityDays(fsrs.finalState.s) !== `${fsrs.finalState.s.toFixed(2)}d` ? ` (${formatStabilityDays(fsrs.finalState.s)})` : ''}
                                        {' · '}
                                        <strong>R:</strong>{' '}
                                        <span style={{ color: getRetrievabilityColor(fsrs.finalState.r) }}>
                                            {(fsrs.finalState.r * 100).toFixed(1)}%
                                        </span>
                                        {' · '}
                                        <span title={`SInc (Stability Increase) — how much stability grows after answering.\n\nHard: ×${fsrs.finalState.sInc.hard.toFixed(2)} → ${formatStabilityDays(fsrs.finalState.s * fsrs.finalState.sInc.hard)}\nGood: ×${fsrs.finalState.sInc.good.toFixed(2)} → ${formatStabilityDays(fsrs.finalState.s * fsrs.finalState.sInc.good)}\nEasy: ×${fsrs.finalState.sInc.easy.toFixed(2)} → ${formatStabilityDays(fsrs.finalState.s * fsrs.finalState.sInc.easy)}\n\nHigher = faster learning. 1.0 = no growth.`}
                                            style={{ cursor: 'help' }}
                                        >
                                            <strong>SInc:</strong>{' '}
                                            <span style={{ color: '#f59e0b' }}>×{fsrs.finalState.sInc.hard.toFixed(2)}</span>{' / '}
                                            <span style={{ color: '#22c55e' }}>×{fsrs.finalState.sInc.good.toFixed(2)}</span>{' / '}
                                            <span style={{ color: '#3b82f6' }}>×{fsrs.finalState.sInc.easy.toFixed(2)}</span>
                                        </span>
                                        {' · '}
                                        Next: {card.nextRepetitionTime ? new Date(card.nextRepetitionTime).toLocaleDateString() : '—'}
                                    </div>
                                )}

                                {/* History table */}
                                {stats.sortedHistory.length === 0 ? (
                                    <div style={{ color: 'var(--rn-clr-content-tertiary)', paddingLeft: 8 }}>No repetition history.</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
                                        <thead>
                                            <tr style={{ borderBottom: '2px solid var(--rn-clr-border-primary)', fontSize: 10, color: 'var(--rn-clr-content-tertiary)' }}>
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>#</th>
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>Rating</th>
                                                <th style={{ ...cellStyle, textAlign: 'right' }}>Time</th>
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>Target Date</th>
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>Practice Date</th>
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>Delay</th>
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>Next Interval</th>
                                                {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>D</th>}
                                                {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>S</th>}
                                                {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>R</th>}
                                                {showFsrsDsr && <th style={{ ...cellStyle, textAlign: 'right' }}>SInc</th>}
                                                <th style={{ ...cellStyle, textAlign: 'left' }}>pluginData</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {stats.sortedHistory.map((rep: any, ri: number) => {
                                                const stepState = fsrs?.stepStates[ri];
                                                // Delay: practice date - scheduled date
                                                const delay = rep.scheduled ? rep.date - rep.scheduled : null;
                                                // Next interval: next review's scheduled date - this review's date
                                                let nextInterval: number | null = null;
                                                if (ri < stats.sortedHistory.length - 1) {
                                                    const nextRep = stats.sortedHistory[ri + 1];
                                                    if (nextRep.scheduled) {
                                                        nextInterval = nextRep.scheduled - rep.date;
                                                    }
                                                } else if (card.nextRepetitionTime) {
                                                    nextInterval = card.nextRepetitionTime - rep.date;
                                                }

                                                const isLast = ri === stats.sortedHistory.length - 1;

                                                return (
                                                    <tr key={ri} style={{
                                                        borderBottom: '1px solid var(--rn-clr-border-primary)',
                                                        opacity: isLast ? 1 : 0.9,
                                                        backgroundColor: isLast ? 'var(--rn-clr-background-secondary)' : 'transparent',
                                                    }}>
                                                        <td style={cellStyle}>{ri + 1}</td>
                                                        <td style={{ ...cellStyle, color: scoreColor(rep.score), fontWeight: 600 }}>
                                                            {scoreLabel(rep.score)}
                                                        </td>
                                                        <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                            {rep.responseTime != null ? `${(rep.responseTime / 1000).toFixed(0)}s` : '—'}
                                                        </td>
                                                        <td style={cellStyle}>
                                                            {rep.scheduled ? new Date(rep.scheduled).toLocaleDateString() : '—'}
                                                        </td>
                                                        <td style={cellStyle}>
                                                            {new Date(rep.date).toLocaleDateString()}
                                                        </td>
                                                        <td style={cellStyle}>
                                                            {delay !== null ? formatDelay(delay) : '—'}
                                                        </td>
                                                        <td style={cellStyle}>
                                                            {isLast && card.nextRepetitionTime
                                                                ? formatInterval(card.nextRepetitionTime - rep.date)
                                                                : nextInterval !== null
                                                                    ? formatInterval(nextInterval)
                                                                    : '—'}
                                                        </td>
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState ? stepState.d.toFixed(1) : '—'}
                                                            </td>
                                                        )}
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState ? (() => {
                                                                    const raw = `${stepState.s.toFixed(1)}d`;
                                                                    const friendly = formatStabilityDays(stepState.s);
                                                                    return friendly !== raw ? `${raw} (${friendly})` : raw;
                                                                })() : '—'}
                                                            </td>
                                                        )}
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState?.r != null ? (
                                                                    <span style={{ color: getRetrievabilityColor(stepState.r) }}>
                                                                        {(stepState.r * 100).toFixed(1)}%
                                                                    </span>
                                                                ) : '—'}
                                                            </td>
                                                        )}
                                                        {showFsrsDsr && (
                                                            <td style={{ ...cellStyle, textAlign: 'right' }}>
                                                                {stepState?.sInc != null ? `×${stepState.sInc.toFixed(2)}` : '—'}
                                                            </td>
                                                        )}
                                                        <td style={{ ...cellStyle, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                            {rep.pluginData ? (
                                                                <span title={JSON.stringify(rep.pluginData, null, 2)} style={{ cursor: 'help' }}>
                                                                    {JSON.stringify(rep.pluginData).slice(0, 80)}…
                                                                </span>
                                                            ) : '—'}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                );
            })}

            <PriorityHistorySection entries={data.priorityHistory} />
        </div>
    );
}

renderWidget(FlashcardRepetitionHistory);
