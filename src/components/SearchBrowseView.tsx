/**
 * Search & Browse — an Anki-Browser-like table over the Search Engine
 * (plans/SEARCH_ENGINE_PLAN.md, phase 4). Every row and column comes from the AI
 * helper in one call per page (scripts/rem_browse.py); this view renders them, sorts
 * by asking again, and runs the bulk actions in lib/search_browse.ts.
 *
 * Keyboard (house rule: keys on the container, never on buttons): in the box, Enter
 * searches and ↓ enters the table; in the table ↑/↓ move, Space selects, Enter opens
 * the Rem, Shift+Enter opens it in a new pane, / returns to the box; Esc closes.
 */
import { usePlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  BrowseMode,
  BrowseRow,
  BrowseSort,
  browseViaHelper,
} from '../lib/rem_search_client';
import {
  SavedSearch,
  SEARCH_QUEUE_LIMIT,
  deleteSavedSearch,
  loadSavedSearches,
  practiceDocument,
  reEnableCardsForRems,
  refreshSearchQueue,
  saveSearch,
  setCardPriorityForRems,
} from '../lib/search_browse';
import { openRemInNewPane } from '../lib/remHelpers';

const PAGE = 100;
const RING = '2px solid var(--rn-clr-border-accent, #3B82F6)';

const CAUSE_LABEL: Record<string, string> = {
  paused: 'paused deck',
  ancestor: 'ancestor off',
  rem: 'off on Rem',
  table: 'table',
  direction: 'direction off',
  cloze: 'cloze off',
  removed: 'text removed',
  other: 'other',
  missing: 'Rem gone',
};

function days(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'today';
  return n > 0 ? `in ${n} d` : `${-n} d ago`;
}

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(Math.round(n * 10) / 10);
}

interface Column {
  key: string;
  label: string;
  sort?: BrowseSort;
  width?: string;
  modes?: BrowseMode[];
  render: (r: BrowseRow) => React.ReactNode;
  title?: string;
}

const COLUMNS: Column[] = [
  {
    key: 'text',
    label: 'Rem',
    sort: 'text',
    render: (r) => (
      <div style={{ minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.text || <em style={{ opacity: 0.6 }}>(no text)</em>}
          {r.back ? <span style={{ color: 'var(--rn-clr-content-secondary)' }}> → {r.back}</span> : null}
        </div>
        <div
          style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={r.path.join(' / ')}
        >
          {r.path.length > 3 ? [r.path[0], '…', ...r.path.slice(-2)].join(' / ') : r.path.join(' / ')}
        </div>
      </div>
    ),
  },
  {
    key: 'kind',
    label: 'Card',
    width: '70px',
    modes: ['cards'],
    render: (r) => r.kind ?? '',
  },
  {
    key: 'type',
    label: 'Kind',
    width: '96px',
    render: (r) =>
      [r.isDocument ? 'doc' : '', r.type, r.incremental ? 'IncRem' : '', r.dismissed ? 'dismissed' : '']
        .filter(Boolean)
        .join(' · '),
  },
  { key: 'tags', label: 'Tags', width: '140px', render: (r) => r.tags.join(', ') },
  { key: 'priority', label: 'Card pri.', sort: 'priority', width: '70px', render: (r) => num(r.priority), title: 'Card priority' },
  {
    key: 'inc',
    label: 'IncRem',
    sort: 'incpriority',
    width: '96px',
    render: (r) => (r.incPriority !== null || r.incDue !== null ? `${num(r.incPriority)} · ${days(r.incDue)}` : ''),
    title: 'IncRem priority · next date',
  },
  { key: 'due', label: 'Due', sort: 'due', width: '80px', render: (r) => days(r.due), title: 'Next review (rem mode: its earliest card)' },
  { key: 'ivl', label: 'Ivl', sort: 'ivl', width: '50px', render: (r) => (r.ivl === null ? '' : `${r.ivl} d`), title: 'Interval' },
  { key: 'reps', label: 'Reps', sort: 'reps', width: '50px', render: (r) => num(r.reps) },
  { key: 'lapses', label: 'Lapses', sort: 'lapses', width: '56px', render: (r) => num(r.lapses) },
  { key: 'ml', label: 'Mastery', width: '86px', modes: ['cards'], render: (r) => r.ml ?? '' },
  {
    key: 'suppressed',
    label: 'Hidden',
    width: '110px',
    render: (r) => r.suppressed.map((c) => CAUSE_LABEL[c] ?? c).join(', '),
    title: 'Why RemNote won’t show its cards',
  },
];

const rowKey = (r: BrowseRow) => r.cardId ?? r.remId;

export function SearchBrowse() {
  const plugin = usePlugin();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const reqRef = React.useRef(0);

  const [query, setQuery] = React.useState('');
  const [mode, setMode] = React.useState<BrowseMode>('rems');
  const [sort, setSort] = React.useState<BrowseSort>('relevance');
  const [desc, setDesc] = React.useState(false);
  const [rows, setRows] = React.useState<BrowseRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [ran, setRan] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [focus, setFocus] = React.useState(-1); // -1 = the search box
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [saved, setSaved] = React.useState<SavedSearch[]>([]);
  const [activeSaved, setActiveSaved] = React.useState<string>('');
  const [priority, setPriority] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    loadSavedSearches(plugin).then(setSaved);
    let tries = 0;
    const grab = () => {
      inputRef.current?.focus();
      if (document.activeElement !== inputRef.current && ++tries < 8) setTimeout(grab, 50);
    };
    grab();
  }, [plugin]);

  const run = React.useCallback(
    async (opts?: { append?: boolean; q?: string; m?: BrowseMode; s?: BrowseSort; d?: boolean }) => {
      const q = (opts?.q ?? query).trim();
      if (!q) return;
      const m = opts?.m ?? mode;
      const s = opts?.s ?? sort;
      const d = opts?.d ?? desc;
      const offset = opts?.append ? rows.length : 0;
      const req = ++reqRef.current;
      setLoading(true);
      const res = await browseViaHelper(plugin, { query: q, mode: m, sort: s, desc: d, offset, limit: PAGE });
      if (req !== reqRef.current) return;
      setLoading(false);
      if (res.status === 'ok') {
        setRows(opts?.append ? [...rows, ...res.rows] : res.rows);
        setTotal(res.total);
        setRan(q);
        setMessage(null);
        if (!opts?.append) setSelected(new Set());
      } else if (res.status === 'query-error') {
        setMessage({ text: res.error.message, tone: res.error.kind === 'index-building' ? 'info' : 'error' });
      } else if (res.status === 'unpaired') {
        setMessage({ text: 'The AI helper is running but not paired: paste its token in the plugin settings (AI Helper Pairing Token).', tone: 'error' });
      } else {
        setMessage({ text: 'Search & Browse needs the AI helper running on this computer (see the Search Engine page of the manual).', tone: 'error' });
      }
    },
    [plugin, query, mode, sort, desc, rows]
  );

  const changeSort = (s: BrowseSort) => {
    const d = s === sort ? !desc : false;
    setSort(s);
    setDesc(d);
    run({ s, d });
  };

  const changeMode = (m: BrowseMode) => {
    setMode(m);
    if (ran) run({ m });
  };

  const selectedRows = React.useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected]);
  const targetRemIds = React.useMemo(() => {
    const pool = selectedRows.length ? selectedRows : focus >= 0 && rows[focus] ? [rows[focus]] : [];
    return Array.from(new Set(pool.map((r) => r.remId)));
  }, [selectedRows, rows, focus]);

  const toggle = (r: BrowseRow) => {
    const next = new Set(selected);
    const k = rowKey(r);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };

  const openRow = async (r: BrowseRow | undefined, newPane: boolean) => {
    if (!r) return;
    await plugin.widget.closePopup();
    if (newPane) await openRemInNewPane(plugin, r.remId);
    else {
      const rem = await plugin.rem.findOne(r.remId);
      if (rem) await plugin.window.openRem(rem);
    }
  };

  const loadSaved = (id: string) => {
    setActiveSaved(id);
    const s = saved.find((x) => x.id === id);
    if (!s) return;
    setQuery(s.query);
    setMode(s.mode);
    setSort(s.sort);
    setDesc(s.desc);
    run({ q: s.query, m: s.mode, s: s.sort, d: s.desc });
  };

  const [naming, setNaming] = React.useState<string | null>(null);

  const doPractise = async () => {
    let s = saved.find((x) => x.id === activeSaved);
    if (!s) return;
    if (s.query !== query.trim() || s.mode !== mode || s.sort !== sort || s.desc !== desc) {
      const list = await saveSearch(plugin, { name: s.name, query: query.trim(), mode, sort, desc });
      setSaved(list);
      s = list.find((x) => x.id === s!.id) ?? s;
    }
    setBusy('Filling the Search Queue…');
    try {
      const { doc, count, total: all } = await refreshSearchQueue(plugin, s, (d, t) =>
        setBusy(`Filling the Search Queue… ${d} / ${t}`)
      );
      setSaved(await loadSavedSearches(plugin));
      await plugin.app.toast(
        `${count} Rem(s) in “🔎 ${s.name}”` + (all > count ? ` (the first ${SEARCH_QUEUE_LIMIT} of ${all})` : '') + '. Opening practice…'
      );
      await plugin.widget.closePopup();
      await practiceDocument(plugin, doc);
    } catch (e: any) {
      setMessage({ text: e?.message || String(e), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const doPriority = async () => {
    const p = Number(priority);
    if (!Number.isFinite(p) || p < 0 || p > 100 || !targetRemIds.length) return;
    setBusy(`Setting card priority… 0 / ${targetRemIds.length}`);
    const res = await setCardPriorityForRems(plugin, targetRemIds, Math.round(p), (d, t) =>
      setBusy(`Setting card priority… ${d} / ${t}`)
    );
    setBusy(null);
    await plugin.app.toast(`Card priority ${Math.round(p)} set on ${res.done} Rem(s)` + (res.failed.length ? `, ${res.failed.length} failed` : ''));
    run();
  };

  const doReEnable = async () => {
    if (!targetRemIds.length) return;
    setBusy(`Switching cards on… 0 / ${targetRemIds.length}`);
    const res = await reEnableCardsForRems(plugin, targetRemIds, (d, t) => setBusy(`Switching cards on… ${d} / ${t}`));
    setBusy(null);
    await plugin.app.toast(`Cards switched on for ${res.enabled} Rem(s)` + (res.failed.length ? `, ${res.failed.length} failed` : ''));
    run();
  };

  const doCopy = async () => {
    const ids = selectedRows.length ? selectedRows.map((r) => r.cardId ?? r.remId) : targetRemIds;
    const text = ids.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      await plugin.app.toast(`Copied ${ids.length} id(s)`);
    } catch {
      setMessage({ text: `Copy failed; the ids: ${text.slice(0, 400)}`, tone: 'info' });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || (target.tagName === 'INPUT' && target !== inputRef.current) || target.tagName === 'SELECT') {
      if (e.key === 'Escape') plugin.widget.closePopup();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      plugin.widget.closePopup();
      return;
    }
    if (focus < 0) {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      } else if (e.key === 'ArrowDown' && rows.length) {
        e.preventDefault();
        setFocus(0);
        containerRef.current?.focus();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(Math.min(rows.length - 1, focus + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focus === 0) {
        setFocus(-1);
        inputRef.current?.focus();
      } else setFocus(focus - 1);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (rows[focus]) toggle(rows[focus]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRow(rows[focus], e.shiftKey);
    } else if (e.key === '/') {
      e.preventDefault();
      setFocus(-1);
      inputRef.current?.focus();
    }
  };

  React.useEffect(() => {
    if (focus >= 0) document.getElementById(`sb-row-${focus}`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const columns = COLUMNS.filter((c) => !c.modes || c.modes.includes(mode));
  const grid = `28px ${columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' ')}`;
  const btn: React.CSSProperties = {
    padding: '5px 10px',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid var(--rn-clr-border-opaque, #d1d5db)',
    background: 'var(--rn-clr-background-secondary)',
    color: 'var(--rn-clr-content-primary)',
    cursor: 'pointer',
  };
  const noSteal = (e: React.MouseEvent) => e.preventDefault();
  const active = saved.find((x) => x.id === activeSaved);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        boxSizing: 'border-box',
        padding: '14px 16px',
        gap: '10px',
        background: 'var(--rn-clr-background-primary)',
        color: 'var(--rn-clr-content-primary)',
        fontSize: '13px',
        outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: '15px' }}>Search &amp; Browse</div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['rems', 'cards'] as BrowseMode[]).map((m) => (
            <button
              key={m}
              onMouseDown={noSteal}
              onClick={() => changeMode(m)}
              style={{ ...btn, fontWeight: mode === m ? 700 : 400, borderColor: mode === m ? 'var(--rn-clr-border-accent, #3B82F6)' : undefined }}
            >
              {m === 'rems' ? 'Rems' : 'Cards'}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <select
          value={activeSaved}
          onChange={(e) => loadSaved(e.target.value)}
          style={{ ...btn, maxWidth: '260px' }}
          title="Saved searches"
        >
          <option value="">Saved searches…</option>
          {saved.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {active && (
          <button
            onMouseDown={noSteal}
            onClick={async () => {
              setSaved(await deleteSavedSearch(plugin, active.id));
              setActiveSaved('');
            }}
            style={btn}
            title="Forget this saved search (its Search Queue document stays)"
          >
            Delete
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocus(-1)}
          placeholder='bow weather · tag:anki* is:due · in:"PSCPP" suppressed:rem · prop:lapses>3'
          style={{
            flex: 1,
            padding: '8px 10px',
            fontSize: '13px',
            borderRadius: '6px',
            border: '1px solid var(--rn-clr-border)',
            background: 'var(--rn-clr-background-secondary)',
            color: 'var(--rn-clr-content-primary)',
            outline: focus < 0 ? RING : 'none',
            outlineOffset: '1px',
          }}
        />
        <button onMouseDown={noSteal} onClick={() => run()} style={btn}>
          {loading ? 'Searching…' : 'Search'}
        </button>
        {naming === null ? (
          <button onMouseDown={noSteal} onClick={() => setNaming(active?.name ?? query.trim().slice(0, 40))} style={btn} disabled={!query.trim()}>
            Save…
          </button>
        ) : (
          <span style={{ display: 'flex', gap: '4px' }}>
            <input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={async (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && naming.trim()) {
                  const list = await saveSearch(plugin, { name: naming.trim(), query: query.trim(), mode, sort, desc });
                  setSaved(list);
                  setActiveSaved(list.find((x) => x.name.toLowerCase() === naming.trim().toLowerCase())?.id ?? '');
                  setNaming(null);
                  inputRef.current?.focus();
                } else if (e.key === 'Escape') {
                  setNaming(null);
                  inputRef.current?.focus();
                }
              }}
              placeholder="Name, then Enter"
              style={{ ...btn, width: '180px', cursor: 'text' }}
            />
          </span>
        )}
        <button
          onMouseDown={noSteal}
          onClick={doPractise}
          style={{ ...btn, opacity: active ? 1 : 0.5 }}
          disabled={!active || !!busy}
          title={active ? `Fill “🔎 ${active.name}” with up to ${SEARCH_QUEUE_LIMIT} of these Rems and practise it` : 'Save the search first'}
        >
          ▶ Practise
        </button>
      </div>

      {(message || busy) && (
        <div style={{ fontSize: '12px', color: message?.tone === 'error' && !busy ? 'var(--rn-clr-red, #c0392b)' : 'var(--rn-clr-content-secondary)' }}>
          {busy ?? message?.text}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          border: '1px solid var(--rn-clr-background-tertiary)',
          borderRadius: '8px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            gap: '8px',
            padding: '6px 10px',
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: 'var(--rn-clr-background-secondary)',
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--rn-clr-content-secondary)',
          }}
        >
          <span />
          {columns.map((c) => (
            <span
              key={c.key}
              title={c.title ?? (c.sort ? 'Sort' : undefined)}
              onMouseDown={noSteal}
              onClick={() => c.sort && changeSort(c.sort)}
              style={{ cursor: c.sort ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden' }}
            >
              {c.label}
              {c.sort && sort === c.sort ? (desc ? ' ▼' : ' ▲') : ''}
            </span>
          ))}
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '16px', color: 'var(--rn-clr-content-tertiary)', fontSize: '12px' }}>
            {ran
              ? 'No matches.'
              : 'Type a search and press Enter. Every key of Find Rem works here; Rems lists each Rem once, Cards lists the cards the search matched. Click a column title to sort.'}
          </div>
        ) : (
          rows.map((r, i) => {
            const isSel = selected.has(rowKey(r));
            return (
              <div
                id={`sb-row-${i}`}
                key={rowKey(r)}
                onMouseEnter={() => focus >= 0 && setFocus(i)}
                onMouseDown={noSteal}
                onClick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? toggle(r) : setFocus(i))}
                onDoubleClick={() => openRow(r, false)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  gap: '8px',
                  padding: '5px 10px',
                  alignItems: 'center',
                  borderTop: '1px solid var(--rn-clr-background-tertiary)',
                  background: isSel ? 'var(--rn-clr-background-accent, rgba(59,130,246,0.12))' : undefined,
                  outline: focus === i ? RING : 'none',
                  outlineOffset: '-2px',
                  cursor: 'default',
                }}
              >
                <input type="checkbox" checked={isSel} onChange={() => toggle(r)} tabIndex={-1} />
                {columns.map((c) => (
                  <div key={c.key} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: c.key === 'text' ? undefined : 'nowrap', fontSize: c.key === 'text' ? '13px' : '12px' }}>
                    {c.render(r)}
                  </div>
                ))}
              </div>
            );
          })
        )}
        {rows.length > 0 && rows.length < total && (
          <div style={{ padding: '8px 10px' }}>
            <button onMouseDown={noSteal} onClick={() => run({ append: true })} style={btn}>
              Load {Math.min(PAGE, total - rows.length)} more ({rows.length} of {total.toLocaleString()})
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {ran ? `${total.toLocaleString()} ${mode === 'rems' ? 'Rems' : 'cards'}` : ''}
          {selected.size ? ` · ${selected.size} selected` : ''}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--rn-clr-content-secondary)' }}>
          {targetRemIds.length ? `${targetRemIds.length} Rem(s):` : 'Select rows to act on them'}
        </span>
        <input
          value={priority}
          onChange={(e) => setPriority(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0–100"
          style={{ ...btn, width: '56px', cursor: 'text' }}
          title="Card priority to set"
        />
        <button onMouseDown={noSteal} onClick={doPriority} style={btn} disabled={!targetRemIds.length || !priority || !!busy}>
          Set card priority
        </button>
        <button onMouseDown={noSteal} onClick={doReEnable} style={btn} disabled={!targetRemIds.length || !!busy} title="Switch the Rems' cards back on (their Enable Cards toggle)">
          Switch cards on
        </button>
        <button onMouseDown={noSteal} onClick={doCopy} style={btn} disabled={!targetRemIds.length}>
          Copy ids
        </button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
        Enter search / open · ↓↑ move · Space select · Shift+Enter open in new pane · / back to the box · Esc close · Ctrl/Cmd+click select
      </div>
    </div>
  );
}

