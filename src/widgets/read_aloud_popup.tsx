import '../lib/stall_diagnostics';
import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import React, { useEffect, useRef, useState } from 'react';
import '../style.css';
import '../App.css';
import '../rn_theme_vars.css';
import {
  getTtsTask,
  insertAudio,
  planTts,
  ReadAloudContext,
  startTts,
  TtsEngine,
  TtsPlan,
} from '../lib/read_aloud';

const POLL_MS = 1500;
const PLAN_DEBOUNCE_MS = 500;

type Phase =
  | { kind: 'editing' }
  | { kind: 'running'; stage: string; elapsed: number }
  | { kind: 'inserting' }
  | { kind: 'error'; message: string };

const muted = { color: 'var(--rn-clr-content-secondary)' };

const SKIP_LABELS: Record<string, string> = {
  images: 'image',
  formulas: 'formula',
  tables: 'table',
  code: 'code block',
  pins: 'pin',
  audio: 'audio',
  drawings: 'drawing',
  embeds: 'embed',
  properties: 'property',
};

/** en-US-AndrewMultilingualNeural → Andrew; Kore → Kore. */
const voiceLabel = (v: string) =>
  v.match(/^[a-z]{2}-[A-Z]{2}-(.+?)(?:Multilingual)?Neural$/)?.[1] ?? v;

const minutes = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${r.toString().padStart(2, '0')} s` : `${r} s`;
};

function Button({
  label,
  onClick,
  primary,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      className="py-1.5 px-3 text-sm font-medium rounded"
      style={{
        background: primary ? '#3B82F6' : 'var(--rn-clr-background-secondary)',
        color: primary ? 'white' : 'var(--rn-clr-content-primary)',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

const fieldStyle: React.CSSProperties = {
  border: '1px solid var(--rn-clr-border-primary)',
  background: 'var(--rn-clr-background-primary)',
  color: 'var(--rn-clr-content-primary)',
};

/**
 * Read aloud: the script built from the rem tree (lib/read_aloud.ts), editable, with
 * the helper's free estimate; Generate synthesises it (/tts) and adds the audio rem.
 */
export function ReadAloudPopup() {
  const plugin = usePlugin();
  const [context, setContext] = useState<ReadAloudContext | null>(null);
  const [script, setScript] = useState('');
  const [engine, setEngine] = useState('auto');
  const [voice, setVoice] = useState('');
  const [plan, setPlan] = useState<TtsPlan | null>(null);
  // The helper's engine list, kept while the script has errors (those plans list none).
  const [engines, setEngines] = useState<TtsEngine[]>([]);
  const [lastPlanned, setLastPlanned] = useState('auto');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const run = useRef(0);

  useEffect(() => {
    (async () => {
      const ctx = await plugin.widget.getWidgetContext<WidgetLocation.Popup>();
      const data = (ctx?.contextData as ReadAloudContext) ?? null;
      setContext(data);
      setScript(data?.script ?? '');
    })();
    return () => {
      run.current++; // stop polling when the popup closes
    };
  }, []);

  // The helper's estimate, refreshed as the script or engine changes.
  useEffect(() => {
    if (!script.trim()) {
      setPlan(null);
      return;
    }
    const timer = setTimeout(() => {
      planTts(script, engine, voice || null)
        .then((p) => {
          setPlan(p);
          if (p.engines?.length) setEngines(p.engines);
          if (p.engine) setLastPlanned(p.engine);
        })
        .catch((err) => setPlan({ ok: false, errors: [String(err)] }));
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [script, engine, voice]);

  const close = () => plugin.widget.closePopup();

  const generate = async () => {
    if (!context || !plan?.ok || !plan.ready || !plan.engine) return;
    const mine = ++run.current;
    setPhase({ kind: 'running', stage: 'starting', elapsed: 0 });
    try {
      // The engine the estimate was made for (the suggestion, when left on automatic).
      const taskId = await startTts(
        script,
        plan.engine,
        voice || null,
        context.remId,
        context.title
      );
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (mine !== run.current) return;
        const task = await getTtsTask(taskId);
        if (mine !== run.current) return;
        if (task.status === 'done') {
          const result = task.result ?? { ok: false, message: 'no result' };
          if (!result.ok) {
            setPhase({ kind: 'error', message: result.message ?? 'failed' });
            return;
          }
          setPhase({ kind: 'inserting' });
          const { warning } = await insertAudio(plugin, context, result);
          const cost = result.costUsd != null ? `, ~US$${result.costUsd.toFixed(2)}` : '';
          await plugin.app.toast(
            `Audio added (${result.voiceLabel}, ${minutes(result.seconds ?? 0)}${cost})` +
              (warning ? ` — ${warning}` : '')
          );
          close();
          return;
        }
        setPhase({ kind: 'running', stage: task.stage, elapsed: task.elapsed });
      }
    } catch (err) {
      if (mine === run.current) setPhase({ kind: 'error', message: String(err) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && phase.kind !== 'running') {
      e.preventDefault();
      void generate();
    }
  };

  const busy = phase.kind === 'running' || phase.kind === 'inserting';
  const stats = context?.stats;
  const skipped = Object.entries(stats?.skipped ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${SKIP_LABELS[k] ?? k}${n === 1 ? '' : 's'}`);
  const voices = plan?.ok ? (plan.voices ?? []) : [];
  const planned = engines.find((e) => e.id === plan?.engine);
  const canGenerate = !busy && !!plan?.ok && !!plan.ready;

  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 p-4"
      style={{
        outline: 'none',
        color: 'var(--rn-clr-content-primary)',
        height: '100vh',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <div className="text-base font-semibold">Read aloud</div>
        <div className="text-xs" style={muted}>
          {context?.title || 'Untitled rem'}
          {stats ? ` — ${stats.rems} rem${stats.rems === 1 ? '' : 's'} read` : ''}
          {skipped.length ? `; skipped ${skipped.join(', ')}` : ''}
          {stats?.truncated ? ' (stopped at 3000 rems)' : ''}
        </div>
      </div>

      <div className="text-xs" style={{ ...muted, flexShrink: 0 }}>
        The script below is what will be spoken. Edit it freely: <code>[pt]</code> starts a
        Portuguese line, <code>&lt;en&gt;term&lt;/en&gt;</code> /{' '}
        <code>&lt;pt&gt;termo&lt;/pt&gt;</code> mark a foreign term, <code>[pause]</code> on its own
        line leaves time to answer.
      </div>

      <textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        disabled={busy}
        spellCheck={false}
        className="text-sm rounded px-2 py-1"
        style={{
          ...fieldStyle,
          flex: 1,
          minHeight: 0,
          resize: 'none',
          fontFamily: 'ui-monospace, monospace',
        }}
      />

      <div className="flex flex-wrap items-center gap-3 text-xs" style={{ flexShrink: 0 }}>
        <label className="flex items-center gap-1">
          Engine
          <select
            value={engine === 'auto' ? lastPlanned : engine}
            onChange={(e) => {
              setEngine(e.target.value);
              setVoice('');
            }}
            disabled={busy || !engines.length}
            className="rounded px-1 py-0.5"
            style={fieldStyle}
          >
            {!engines.some((e) => e.id === lastPlanned) && engine === 'auto' && (
              <option value="auto">Automatic</option>
            )}
            {engines.map((e) => (
              <option
                key={e.id}
                value={e.id}
                disabled={!e.available}
                title={
                  e.available ? e.note : `missing ${e.missing.join(', ')} in the helper's .env`
                }
              >
                {e.label}
                {e.id === plan?.suggested ? ' (suggested)' : ''}
                {e.available ? '' : ' — no key'}
              </option>
            ))}
          </select>
        </label>
        {voices.length > 1 && (
          <label className="flex items-center gap-1">
            Voice
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={busy}
              className="rounded px-1 py-0.5"
              style={fieldStyle}
            >
              <option value="">Random</option>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </select>
          </label>
        )}
        {plan?.ok && (
          <span style={muted}>
            {voices.length === 1 ? `${voiceLabel(voices[0])} · ` : ''}
            {plan.words} words · about {minutes(plan.estSeconds ?? 0)} · ~US$
            {(plan.estCostUsd ?? 0).toFixed(2)}
            {(plan.estSeconds ?? 0) > 12 * 60 ? ' · long: consider a summary' : ''}
          </span>
        )}
      </div>

      {plan?.ok && (plan.note || !plan.ready) && (
        <div className="text-xs" style={{ ...muted, flexShrink: 0 }}>
          {plan.ready
            ? `${planned?.label ?? plan.engine}: ${plan.note}.`
            : `${planned?.label ?? plan.engine} has no key: add ${(plan.missing ?? []).join(', ')} to the helper's .env.`}
          {plan.ready && plan.engine !== plan.suggested && plan.suggested
            ? ` The suggestion was ${engines.find((e) => e.id === plan.suggested)?.label ?? plan.suggested}.`
            : ''}
        </div>
      )}

      {plan && !plan.ok && (
        <div
          className="rounded px-3 py-2 text-xs"
          style={{
            flexShrink: 0,
            maxHeight: 120,
            overflowY: 'auto',
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.5)',
          }}
        >
          {(plan.errors ?? []).map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {phase.kind === 'error' && (
        <div
          className="rounded px-3 py-2 text-sm"
          style={{
            flexShrink: 0,
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.5)',
          }}
        >
          {phase.message}
        </div>
      )}

      <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
        <span className="text-sm" style={{ ...muted, flex: 1 }}>
          {phase.kind === 'running' &&
            `${phase.stage[0]?.toUpperCase()}${phase.stage.slice(1)}… ${phase.elapsed} s — keep this window open`}
          {phase.kind === 'inserting' && 'Storing the audio in RemNote…'}
        </span>
        <Button label={busy ? 'Stop waiting' : 'Cancel'} onClick={close} />
        <Button
          label={phase.kind === 'error' ? 'Try again' : 'Generate'}
          primary
          disabled={!canGenerate}
          title="⌘↵"
          onClick={() => void generate()}
        />
      </div>
    </div>
  );
}

renderWidget(ReadAloudPopup);
