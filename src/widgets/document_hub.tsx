import {
  AppEvents,
  renderWidget,
  useAPIEventListener,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  documentHubActiveIdKey,
  documentHubDefaultPosition,
  documentHubPositionKey,
  documentHubTargetKey,
  powerupCode,
} from '../lib/consts';
import { FloatingPosition, useFloatingWidgetDrag } from '../lib/floating_widget_drag';
import { safeRemTextToString } from '../lib/pdfUtils';
import { showMessageDialog } from '../lib/message_dialog';
import {
  openBatchCardPriority,
  openBatchPriority,
  openCardEnablementAudit,
  openPdfControlPanel,
  openPriorityQueue,
  openPriorityShieldHistory,
  openSetPriority,
  toggleIncrementalRem,
} from '../lib/document_menu_actions';

/**
 * The Document Hub: the Document menu's plugin actions in one floating panel.
 *
 * RemNote draws plugin menu items as a flat list and has no way to nest them,
 * so the Document menu keeps a few direct items plus "Incremental RemNote…",
 * which opens this. It stays open beside the editor (no close on an outside
 * click) and acts on the document of the focused pane, following it as the
 * user moves around; the menu item points it at the document it came from.
 * Drag it by the header; ✕ or Esc (with the panel focused) closes it.
 */

type Target = { remId: string; at: number; source?: 'menu' | 'pane' };

type HubAction = {
  id: string;
  label: string;
  group: string;
  run: (plugin: ReturnType<typeof usePlugin>, remId: string) => Promise<void>;
};

const ACTIONS: HubAction[] = [
  { id: 'toggle', label: 'Toggle Incremental Rem', group: 'Incremental Rem', run: toggleIncrementalRem },
  { id: 'priority', label: 'Set Priority', group: 'Incremental Rem', run: openSetPriority },
  { id: 'batch', label: 'Batch Priority Change', group: 'Incremental Rem', run: openBatchPriority },
  { id: 'queue', label: 'Priority Queue', group: 'Queue', run: openPriorityQueue },
  { id: 'shield', label: 'Priority Shield History', group: 'Queue', run: openPriorityShieldHistory },
  {
    id: 'card-priority',
    label: 'Batch Card Priority (tagged / referencing)',
    group: 'Flashcards',
    run: openBatchCardPriority,
  },
  {
    id: 'audit',
    label: 'Audit Card Enablement',
    group: 'Flashcards',
    run: openCardEnablementAudit,
  },
  { id: 'pdf', label: 'PDF Control Panel', group: 'PDF', run: openPdfControlPanel },
];

const ring: React.CSSProperties = {
  outline: '2px solid var(--rn-clr-border-accent, #3B82F6)',
  outlineOffset: '-2px',
};

function DocumentHub() {
  const plugin = usePlugin();
  const containerRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<FloatingPosition | null>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
      positionRef.current =
        (await plugin.storage.getSession<FloatingPosition>(documentHubPositionKey)) ||
        documentHubDefaultPosition;
      setWidgetId(ctx?.floatingWidgetId ?? null);
    })().catch((e) => console.error('[DocumentHub] init error', e));
  }, [plugin]);

  const target = useTrackerPlugin(
    (rp) => rp.storage.getSession<Target>(documentHubTargetKey),
    []
  );
  const remId = target?.remId;

  const docName = useTrackerPlugin(
    async (rp) => {
      if (!remId) return null;
      const rem = await rp.rem.findOne(remId);
      return rem ? (await safeRemTextToString(rp as any, rem.text)) || 'Untitled' : null;
    },
    [remId]
  );
  const isIncremental = useTrackerPlugin(
    async (rp) => {
      if (!remId) return false;
      const rem = await rp.rem.findOne(remId);
      return !!rem && (await rem.hasPowerup(powerupCode));
    },
    [remId]
  );

  // Follow the focused pane's document, as the Document menu would. A pane
  // with no Rem (the queue, a plugin page) keeps the last document.
  const followPane = useCallback(async () => {
    try {
      const paneRemId = await plugin.window.getOpenPaneRemId(await plugin.window.getFocusedPaneId());
      if (!paneRemId) return;
      const current = await plugin.storage.getSession<Target>(documentHubTargetKey);
      if (current?.remId === paneRemId) return;
      await plugin.storage.setSession(documentHubTargetKey, {
        remId: paneRemId,
        at: Date.now(),
        source: 'pane',
      } satisfies Target);
    } catch (e) {
      console.error('[DocumentHub] follow pane error', e);
    }
  }, [plugin]);
  useAPIEventListener(AppEvents.URLChange, undefined, followPane);
  useAPIEventListener(AppEvents.FocusedPaneChange, undefined, followPane);
  useAPIEventListener(AppEvents.CurrentWindowTreeChange, undefined, followPane);

  // Take the keyboard when opened, and again when the menu item points the open
  // hub at a document (the user just asked for it) — but not when it merely
  // follows a pane, which would pull focus out of the editor. The retry loop
  // wins against RemNote settling focus after the float mounts.
  const focusTrigger = target && target.source !== 'pane' ? target.at : 0;
  useEffect(() => {
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      containerRef.current?.focus();
      if (document.activeElement !== containerRef.current && attemptsLeft > 0) {
        setTimeout(() => tryFocus(attemptsLeft - 1), 50);
      }
    };
    tryFocus(8);
    return () => {
      cancelled = true;
    };
  }, [focusTrigger]);

  const close = useCallback(async () => {
    await plugin.storage.setSession(documentHubActiveIdKey, undefined);
    if (widgetId) await plugin.window.closeFloatingWidget(widgetId);
  }, [plugin, widgetId]);

  const run = useCallback(
    async (index: number) => {
      const action = ACTIONS[index];
      if (!action || !remId || busy) return;
      setSelected(index);
      setBusy(action.id);
      try {
        await action.run(plugin, remId);
      } catch (e) {
        console.error(`[DocumentHub] ${action.id} failed`, e);
        await showMessageDialog(plugin, {
          title: `${action.label} failed`,
          message: e instanceof Error ? e.message : String(e),
          tone: 'error',
        });
      } finally {
        setBusy(null);
      }
    },
    [plugin, remId, busy]
  );

  // Keys on the container, never on the buttons: a focused button would fire
  // its native Enter click and this handler both.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if ((e.target as HTMLElement)?.tagName === 'BUTTON') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((i) => (i + step + ACTIONS.length) % ACTIONS.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(selected);
      return;
    }
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= ACTIONS.length) {
      e.preventDefault();
      run(digit - 1);
    }
  };

  const onDragEnd = useCallback(
    (position: FloatingPosition) => {
      plugin.storage.setSession(documentHubPositionKey, position).catch(() => {});
    },
    [plugin]
  );
  const onHeaderPointerDown = useFloatingWidgetDrag(plugin, widgetId, positionRef, onDragEnd);

  const labelFor = (action: HubAction) =>
    action.id === 'toggle'
      ? isIncremental
        ? 'Remove Incremental Rem tag'
        : 'Make Incremental Rem'
      : action.label;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        border: '1px solid var(--rn-clr-border-primary)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        fontSize: 13,
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        style={{
          cursor: 'move',
          userSelect: 'none',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px 6px 12px',
          borderBottom: '1px solid var(--rn-clr-border-primary)',
          background: 'var(--rn-clr-background-secondary)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Incremental RemNote</div>
          <div
            title={docName ?? undefined}
            style={{
              fontSize: 11,
              color: 'var(--rn-clr-content-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {remId ? `📄 ${docName ?? '…'}` : 'Open a document to act on it'}
          </div>
        </div>
        <button
          onClick={close}
          onMouseDown={(e) => e.preventDefault()}
          title="Close (Esc)"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--rn-clr-content-secondary)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '2px 6px',
            borderRadius: 4,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: '4px 0' }}>
        {ACTIONS.map((action, i) => {
          const showGroup = i === 0 || ACTIONS[i - 1].group !== action.group;
          return (
            <React.Fragment key={action.id}>
              {showGroup && (
                <div
                  style={{
                    padding: '6px 12px 2px',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    color: 'var(--rn-clr-content-tertiary)',
                  }}
                >
                  {action.group}
                </div>
              )}
              <button
                onClick={() => run(i)}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!remId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 12px',
                  border: 'none',
                  borderRadius: 0,
                  background:
                    i === selected ? 'var(--rn-clr-background-tertiary)' : 'transparent',
                  color: remId ? 'var(--rn-clr-content-primary)' : 'var(--rn-clr-content-tertiary)',
                  cursor: remId ? 'pointer' : 'default',
                  fontSize: 13,
                  ...(i === selected ? ring : {}),
                }}
              >
                <span
                  style={{
                    width: 14,
                    fontSize: 11,
                    color: 'var(--rn-clr-content-tertiary)',
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{labelFor(action)}</span>
                {busy === action.id && <span style={{ fontSize: 11 }}>…</span>}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      <div
        style={{
          padding: '6px 12px',
          fontSize: 11,
          color: 'var(--rn-clr-content-tertiary)',
          borderTop: '1px solid var(--rn-clr-border-primary)',
        }}
      >
        ↑↓ choose · Enter or 1–{ACTIONS.length} run · Esc close
      </div>
    </div>
  );
}

renderWidget(withHoverTips(DocumentHub));
