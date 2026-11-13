import { renderWidget, usePlugin, useTrackerPlugin } from '@remnote/plugin-sdk';
import { withHoverTips } from '../components/HoverTipLayer';
import React from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import { MessageBody } from '../components/MessageBody';
import { noticesKey } from '../lib/consts';
import { dismissNotices, Notice } from '../lib/notice';

const button = (primary: boolean): React.CSSProperties => ({
  background: primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
  color: primary ? 'white' : 'var(--rn-clr-content-primary)',
  border: 'none',
  cursor: 'pointer',
});

const edge = { error: '#EF4444', success: '#10B981', info: '#3B82F6' };

/**
 * The notices of background work (lib/notice.ts), newest first, in a floating card the
 * index opens and closes. It never takes focus: it arrives while the user is typing
 * elsewhere, often in a popup. Esc, once the card has been clicked, dismisses them all.
 */
function NoticeFloat() {
  const plugin = usePlugin();
  const notices = useTrackerPlugin(
    async (rp) => (await rp.storage.getSession<Notice[]>(noticesKey)) || [],
    []
  );
  const list = [...(notices ?? [])].reverse();

  const openRem = async (notice: Notice) => {
    const rem = notice.openRemId ? await plugin.rem.findOne(notice.openRemId) : undefined;
    if (rem) await plugin.window.openRem(rem);
    else await plugin.app.toast('That Rem no longer exists.');
    await dismissNotices(plugin, notice.id);
  };

  if (!list.length) return null;
  return (
    <div
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          void dismissNotices(plugin);
        }
      }}
      className="flex flex-col gap-2"
      style={{ width: 380, maxHeight: 520, overflowY: 'auto', outline: 'none', padding: 4 }}
    >
      {list.length > 1 && (
        <div className="flex items-center justify-between text-xs px-1">
          <span style={{ color: 'var(--rn-clr-content-secondary)' }}>{list.length} notices</span>
          <button
            onClick={() => void dismissNotices(plugin)}
            className="py-0.5 px-2 rounded"
            style={button(false)}
          >
            Dismiss all
          </button>
        </div>
      )}
      {list.map((notice) => (
        <div
          key={notice.id}
          className="flex flex-col gap-2 p-3 rounded"
          style={{
            background: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            border: '1px solid var(--rn-clr-border-primary)',
            borderLeft: `4px solid ${edge[notice.tone ?? 'info']}`,
            boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          }}
        >
          <MessageBody dialog={notice} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>
              {new Date(notice.at).toLocaleTimeString(undefined, { timeStyle: 'short' })}
            </span>
            <div className="flex items-center gap-2">
              {notice.openRemId && (
                <button
                  onClick={() => void openRem(notice)}
                  className="py-1 px-3 text-sm font-medium rounded"
                  style={button(true)}
                >
                  Open Rem
                </button>
              )}
              <button
                onClick={() => void dismissNotices(plugin, notice.id)}
                className="py-1 px-3 text-sm font-medium rounded"
                style={button(!notice.openRemId)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

renderWidget(withHoverTips(NoticeFloat));
