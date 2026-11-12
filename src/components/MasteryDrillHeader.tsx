/**
 * The Mastery Drill header, shared by the popup drill (widgets/mastery_drill.tsx)
 * and the regular-queue drill's bar (widgets/mastery_drill_queue_bar.tsx).
 *
 * Row 1 manages the drill (counts, card list, Remove, and the Clear group). Row 2
 * is the popup's only: Go to Rem and the editors stand in for what the regular
 * queue gives natively, so its bar has row 1 alone. The Edit Later group (current
 * and previous card) is in both: in row 2 in the popup, in row 1 in the queue bar.
 * Related actions share one segmented group ("Clear: All · Low Priority · Old") so
 * the queue bar fits in one line beside the Beautiful queue's priority badge. The header only renders
 * and collects the Edit Later note and the priority edit: what each action does,
 * and where its panel opens, is up to the widget — the popup swaps its whole
 * window, the queue bar opens a popup.
 */

import React from 'react';
import { CardPriorityInfo } from '../lib/card_priority/types';
import { formatDrillWait } from '../lib/mastery_drill_cooling';
import { InlinePriorityEditor } from './InlineEditors';
import { PriorityBadge } from './PriorityBadge';

export interface MasteryDrillHeaderProps {
  /** 'queue' is the compact form for the strip under the regular queue's top bar. */
  variant: 'popup' | 'queue';
  readyCount: number;
  coolingCount: number;
  firstReadyAt?: number;
  oldCount: number;
  oldThreshold: number;
  onOpenCardList: () => void;
  onClearAll: () => void;
  onClearLowPriority: () => void;
  onClearOld: () => void;
  onRemoveCurrent: () => void;
  /**
   * Tags the card shown before the current one (usually the one just rated) Edit Later
   * with this note, keeping its rating. Omitted: no button.
   */
  onEditLaterPrevious?: (message: string) => Promise<void>;
  /**
   * The queue bar's Edit Later for the card on screen, in row 1. The popup passes its
   * own in cardActions (row 2) instead.
   */
  onEditLaterCurrent?: (message: string) => Promise<void>;
  /** Row 2, popup only. */
  cardActions?: {
    /** The current card's priority, editable in place. */
    priority?: { info: CardPriorityInfo; onSave: (value: number) => Promise<void> } | null;
    onGoToRem: () => void;
    onEditLater: (message: string) => Promise<void>;
    onEditPrevious: () => void;
    onEditCurrent: () => void;
  };
  showDescription?: boolean;
  /** Shown under the rows, e.g. the regular-queue drill's buried-cards hint. */
  notice?: React.ReactNode;
}

const neutral: React.CSSProperties = {
  backgroundColor: 'var(--rn-clr-background-primary)',
  color: 'var(--rn-clr-content-primary)',
  border: '1px solid var(--rn-clr-border-primary)',
};

export function MasteryDrillHeader(props: MasteryDrillHeaderProps) {
  const { variant, readyCount, coolingCount, firstReadyAt, oldCount, oldThreshold, cardActions } = props;
  const priority = cardActions?.priority;
  const compact = variant === 'queue';
  // Which card the open Edit Later note is for; null while closed.
  const [editLaterTarget, setEditLaterTarget] = React.useState<'current' | 'previous' | null>(null);
  const [editLaterMessage, setEditLaterMessage] = React.useState('');
  const [editingPriority, setEditingPriority] = React.useState<number | null>(null);

  const actionSize = 'px-3 py-1.5 text-sm';
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const openEditLater = (target: 'current' | 'previous') => {
    setEditLaterMessage('');
    setEditLaterTarget(target);
  };
  // In the regular queue the note's input holds the focus, which keeps RemNote's own
  // shortcuts (Space, 1-4) from working; hand it back once the note closes.
  const returnFocusToQueue = () => {
    if (!compact) return;
    try {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.parent?.focus();
    } catch (_) {
      /* cross-origin safe */
    }
  };
  const confirmEditLater = async () => {
    if (editLaterTarget === 'previous') await props.onEditLaterPrevious?.(editLaterMessage);
    else await (props.onEditLaterCurrent ?? cardActions?.onEditLater)?.(editLaterMessage);
    setEditLaterTarget(null);
    setEditLaterMessage('');
    returnFocusToQueue();
  };
  const cancelEditLater = () => {
    setEditLaterTarget(null);
    setEditLaterMessage('');
    returnFocusToQueue();
  };

  // "Edit Later: Current · Previous". Current is the popup's cardActions.onEditLater or
  // the queue bar's onEditLaterCurrent; Previous keeps the rating of the card just rated.
  const hasEditLaterCurrent = !!(props.onEditLaterCurrent ?? cardActions?.onEditLater);
  const editLaterGroup = (hasEditLaterCurrent || props.onEditLaterPrevious) && (
    <SegmentedGroup label="Edit Later" large={!compact}>
      {hasEditLaterCurrent && (
        <SegmentButton
          onClick={() => openEditLater('current')}
          tone="accent"
          large={!compact}
          title="Mark the card on screen for Edit Later and remove it from the drill"
        >
          Current
        </SegmentButton>
      )}
      {props.onEditLaterPrevious && (
        <SegmentButton
          onClick={() => openEditLater('previous')}
          tone="accent"
          large={!compact}
          title="Mark the card you just rated for Edit Later, keeping its rating, and remove it from the drill"
        >
          Previous
        </SegmentButton>
      )}
    </SegmentedGroup>
  );

  return (
    <div className={compact ? 'flex flex-col' : 'border-b rn-clr-border-primary flex flex-col'}>
      <style>{DRILL_HEADER_CSS}</style>
      {/* Row 1: the drill as a whole */}
      <div className={`flex items-center flex-wrap ${compact ? 'gap-1.5 px-2 py-1' : 'gap-2 px-2 pt-2 pb-1'}`}>
        <span
          className={`whitespace-nowrap flex-shrink-0 ${compact ? 'font-semibold text-sm' : 'font-bold text-lg'}`}
          style={{ color: 'var(--rn-clr-content-primary)' }}
        >
          {compact ? '🎯 Mastery Drill' : 'Mastery Drill'}
        </span>
        <span
          onClick={props.onOpenCardList}
          className="ie-drill-chip ie-drill-chip--count"
          title={`List every card in the drill${compact ? '' : ' (L)'}`}
        >
          {readyCount} remaining
        </span>
        {coolingCount > 0 && (
          <span
            className="ie-drill-chip"
            title={`${coolingCount} card${plural(coolingCount, ' is', 's are')} still cooling and will appear later${
              firstReadyAt !== undefined ? ` (the first in ${formatDrillWait(firstReadyAt - Date.now())})` : ''
            }`}
          >
            {coolingCount} cooling
          </span>
        )}
        <span className="ie-drill-sep" />
        <button
          onClick={props.onOpenCardList}
          className="ie-drill-btn"
          title={`List every card in the drill and check whether RemNote can show it${compact ? '' : ' (L)'}`}
        >
          List
        </button>
        <button onClick={props.onRemoveCurrent} className="ie-drill-btn ie-drill-btn--danger" title="Remove the card on screen from the Mastery Drill">
          Remove
        </button>
        {compact && editLaterGroup}
        <SegmentedGroup label="Clear">
          <SegmentButton onClick={props.onClearAll} tone="danger" title="Clear all items from the Mastery Drill queue">
            All
          </SegmentButton>
          <SegmentButton onClick={props.onClearLowPriority} tone="danger" title="Remove low priority cards from the Mastery Drill queue">
            Low priority
          </SegmentButton>
          {oldCount > 0 && (
            <SegmentButton
              onClick={props.onClearOld}
              tone="old"
              title={`${oldCount} card${plural(oldCount, ' has', 's have')} been ready to drill for more than ${oldThreshold} days. The Mastery Drill is intended for cards you recently rated Hard or Again — after this much time, the spaced repetition algorithm will handle them at their scheduled date instead. Click to remove them, if you prefer to trust the scheduler rather than drilling them now.`}
            >
              Old · {oldCount} &gt; {oldThreshold}d
            </SegmentButton>
          )}
        </SegmentedGroup>
      </div>

      {/* Row 2: the card on screen (popup only) */}
      {cardActions && (
      <div className="flex items-center gap-2 flex-wrap px-2 pb-2">
        {priority && (
          <div className="cursor-pointer" onClick={() => setEditingPriority(priority.info.priority)} title="Click to change priority">
            <PriorityBadge
              priority={priority.info.priority}
              percentile={priority.info.kbPercentile ?? undefined}
              compact
              useAbsoluteColoring={priority.info.kbPercentile == null}
              source={priority.info.source}
              isCardPriority
            />
          </div>
        )}
        <button
          onClick={cardActions.onGoToRem}
          className={`${actionSize} rounded transition-colors shadow-sm font-medium whitespace-nowrap`}
          style={neutral}
          title="Go to the current Rem (closes popup)"
        >
          Go to Rem
        </button>
        {editLaterGroup}
        <button
          onClick={cardActions.onEditPrevious}
          className={`${actionSize} rounded font-medium transition-colors shadow-sm whitespace-nowrap`}
          style={{ ...neutral, backgroundColor: 'var(--rn-clr-background-secondary)' }}
          title="Edit the card you just rated"
        >
          Edit Previous
        </button>
        <button
          onClick={cardActions.onEditCurrent}
          className={`${actionSize} rounded bg-blue-500 text-white hover:bg-blue-600 font-medium transition-colors shadow-sm whitespace-nowrap`}
          title="Edit the currently visible card"
        >
          Edit Current
        </button>
      </div>
      )}

      {editingPriority !== null && priority && (
        <div className="px-2 pt-1">
          <InlinePriorityEditor
            value={editingPriority}
            onChange={setEditingPriority}
            onSave={async () => {
              await priority.onSave(editingPriority);
              setEditingPriority(null);
            }}
            onCancel={() => setEditingPriority(null)}
          />
        </div>
      )}

      {props.showDescription && (
        <div className="px-4 pb-2 flex items-baseline gap-2 flex-nowrap overflow-hidden">
          <span className="text-sm whitespace-nowrap flex-shrink-0">Deliberately practice again your poorly rated flashcards.</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
            Flashcards you have rated <i>Again</i> or <i>Hard</i> will appear and remain in the Drill until you rate them <i>Good</i> or better.
          </span>
        </div>
      )}

      {editLaterTarget && (
        <EditLaterNote
          label={editLaterTarget === 'previous' ? 'Edit Later note (previous card):' : undefined}
          value={editLaterMessage}
          onChange={setEditLaterMessage}
          onConfirm={confirmEditLater}
          onCancel={cancelEditLater}
          bordered={!compact}
        />
      )}

      {props.notice && (
        <div className="px-3 pb-1 text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {props.notice}
        </div>
      )}
    </div>
  );
}

/** The one-line Edit Later note: Enter sets, Esc cancels. Also used by the card editor. */
export function EditLaterNote({
  label = 'Edit Later note:',
  value,
  onChange,
  onConfirm,
  onCancel,
  bordered = true,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  bordered?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 flex-shrink-0 ${bordered ? 'border-t' : ''}`}
      style={{ borderColor: 'var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-primary)' }}
    >
      <span className="text-xs font-medium" style={{ color: 'var(--rn-clr-content-secondary)' }}>
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onConfirm();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Mastery Drill"
        className="flex-1 text-xs p-1 rounded"
        style={{
          border: '1px solid var(--rn-clr-border-primary)',
          backgroundColor: 'var(--rn-clr-background-secondary)',
          color: 'var(--rn-clr-content-primary)',
        }}
        autoFocus
      />
      <button onClick={onConfirm} className="px-2 py-1 text-xs rounded bg-orange-500 text-white hover:bg-orange-600">
        Set
      </button>
      <button
        onClick={onCancel}
        className="px-2 py-1 text-xs rounded"
        style={{ border: '1px solid var(--rn-clr-border-primary)', color: 'var(--rn-clr-content-secondary)' }}
      >
        Cancel
      </button>
    </div>
  );
}

/*
 * Plain CSS, not Tailwind: the plugin's Tailwind uses the OS colour scheme for `dark:`,
 * which disagrees with RemNote's own theme whenever the two differ (a light RemNote on a
 * dark Mac got the dark fills). RemNote's theme reaches the iframe as --rn-clr-* and
 * as `body.dark`, so the accents key on that.
 */
const DRILL_HEADER_CSS = `
.ie-drill-chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 500; white-space: nowrap; cursor: default;
  color: var(--rn-clr-content-secondary); background: var(--rn-clr-background-secondary);
}
.ie-drill-chip--count { cursor: pointer; color: #be123c; background: rgba(225, 29, 72, 0.08); }
body.dark .ie-drill-chip--count { color: #fda4af; background: rgba(251, 113, 133, 0.14); }
.ie-drill-sep { width: 1px; height: 14px; margin: 0 2px; background: var(--rn-clr-border-primary); flex-shrink: 0; }
.ie-drill-btn {
  display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px;
  font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer;
  color: var(--rn-clr-content-secondary); background: transparent; border: 0;
  transition: background-color 120ms ease, color 120ms ease;
}
.ie-drill-btn:hover { color: var(--rn-clr-content-primary); background: var(--rn-clr-background-secondary); }
.ie-drill-btn--large { height: 30px; padding: 0 11px; font-size: 13px; }
.ie-drill-btn--danger { color: #dc2626; }
.ie-drill-btn--danger:hover { color: #b91c1c; background: rgba(220, 38, 38, 0.07); }
body.dark .ie-drill-btn--danger { color: #f87171; }
body.dark .ie-drill-btn--danger:hover { color: #fca5a5; background: rgba(248, 113, 113, 0.12); }
.ie-drill-btn--accent { color: #c2410c; }
.ie-drill-btn--accent:hover { color: #9a3412; background: rgba(234, 88, 12, 0.08); }
body.dark .ie-drill-btn--accent { color: #fb923c; }
body.dark .ie-drill-btn--accent:hover { color: #fdba74; background: rgba(251, 146, 60, 0.12); }
.ie-drill-btn--old { color: #a16207; background: rgba(234, 179, 8, 0.12); }
.ie-drill-btn--old:hover { color: #854d0e; background: rgba(234, 179, 8, 0.22); }
body.dark .ie-drill-btn--old { color: #facc15; background: rgba(250, 204, 21, 0.12); }
body.dark .ie-drill-btn--old:hover { color: #fde047; background: rgba(250, 204, 21, 0.2); }
.ie-drill-group {
  display: inline-flex; align-items: center; gap: 1px; padding: 2px; flex-shrink: 0;
  border: 1px solid var(--rn-clr-border-primary); border-radius: 8px; white-space: nowrap;
}
.ie-drill-group__label {
  padding: 0 4px 0 6px; font-size: 11px; font-weight: 500; letter-spacing: 0.01em;
  color: var(--rn-clr-content-tertiary);
}
.ie-drill-group .ie-drill-btn { height: 20px; padding: 0 7px; border-radius: 5px; }
.ie-drill-group .ie-drill-btn--large { height: 26px; padding: 0 10px; }
`;

type SegmentTone = 'accent' | 'danger' | 'old';

/** A light outlined strip: a muted "Label" and its buttons. */
function SegmentedGroup({ label, large = false, children }: { label: string; large?: boolean; children: React.ReactNode }) {
  return (
    <div className="ie-drill-group">
      <span className="ie-drill-group__label" style={large ? { fontSize: '12px' } : undefined}>
        {label}
      </span>
      {children}
    </div>
  );
}

function SegmentButton({
  onClick,
  title,
  tone,
  large = false,
  children,
}: {
  onClick: () => void;
  title: string;
  tone?: SegmentTone;
  large?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`ie-drill-btn${tone ? ` ie-drill-btn--${tone}` : ''}${large ? ' ie-drill-btn--large' : ''}`}
    >
      {children}
    </button>
  );
}
