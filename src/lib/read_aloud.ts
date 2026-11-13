/**
 * "Read aloud": the focused rem and its descendants, in tree order, become a spoken
 * script; the Local Media Bridge helper turns it into an mp3 (POST /tts, which runs
 * scripts/media_bridge/tts.py: Gemini TTS one call per language block, or Azure's
 * multilingual voice when the script has many inline foreign terms); the mp3 is
 * stored in RemNote as an audio rem, first child of the read rem.
 *
 * The plugin only reads and inserts. The API keys stay in the helper's .env; the
 * popup (widgets/read_aloud_popup) shows the script for editing and the helper's
 * free estimate (POST /tts/plan) before anything is paid for.
 *
 * Reading rules (plans/AI_STUDY_TOOLS_PLAN.md, Phase A): powerup properties and
 * slots, images, drawings, audio, embeds, pins and tags are skipped; a reference
 * reads the text it shows (its alias when it points at one); a formula is skipped
 * with "formula omitted"; a table with "table omitted"; existing audio rems and
 * everything under them are never read; italic words in the other language get
 * inline language marks (<en>…</en> in a Portuguese line, <pt>…</pt> in an English
 * one), which is also what sends a script to the multilingual voice.
 */
import { ReactRNPlugin, RNPlugin, SelectionType } from '@remnote/plugin-sdk';
import { mediaBridgeEnabledId, READ_ALOUD_POPUP, readAloudTagId } from './consts';
import { MEDIA_BRIDGE_URL } from './media_bridge';
import { runAudio } from './media_bridge_ops';
import { showMessageDialog } from './message_dialog';
import { buildReadAloudScript, Lang, ReadAloudStats } from './read_aloud_script';
import { getIESetting } from './settings';

export type { Lang, ReadAloudStats };

/** The helper version whose /tts/plan lists the engines. */
const MIN_HELPER_VERSION = 9;
export interface ReadAloudContext {
  remId: string;
  title: string;
  lang: Lang;
  script: string;
  stats: ReadAloudStats;
}

/** One TTS engine as the helper reports it: available = its API keys are set. */
export interface TtsEngine {
  id: string;
  label: string;
  available: boolean;
  missing: string[];
  voices: string[];
  /** How it treats the <pt>/<en> marks ('' when the script has none). */
  note: string;
  estSeconds: number;
  estCostUsd: number;
}

export interface TtsPlan {
  ok: boolean;
  errors?: string[];
  /** The planned engine: the requested one, or the suggestion for 'auto'. */
  engine?: string;
  suggested?: string | null;
  engines?: TtsEngine[];
  /** The planned engine's keys are set. */
  ready?: boolean;
  missing?: string[];
  note?: string;
  voice?: string | null;
  voices?: string[];
  characters?: number;
  words?: number;
  inlineTerms?: number;
  calls?: number;
  answerPauses?: number[];
  estSeconds?: number;
  estCostUsd?: number;
  title?: string;
}

export interface TtsResult {
  ok: boolean;
  message?: string;
  engine?: string;
  voice?: string;
  voiceLabel?: string;
  seconds?: number;
  characters?: number;
  audioTokens?: number;
  costUsd?: number;
  url?: string;
  saved?: string;
}

export interface TtsTask {
  id: string;
  status: 'running' | 'done';
  stage: string;
  elapsed: number;
  result: TtsResult | null;
}

// --- helper -------------------------------------------------------------------------

async function helperProblem(): Promise<string | undefined> {
  try {
    const res = await fetch(`${MEDIA_BRIDGE_URL}/health`);
    const health = await res.json();
    if ((health?.version ?? 1) < MIN_HELPER_VERSION) {
      return (
        `The media-bridge helper running on this computer is version ${health?.version ?? 1}; ` +
        `Read aloud needs ${MIN_HELPER_VERSION}. Restart it: ` +
        'launchctl kickstart -k gui/$(id -u)/com.incrementalremnote.media-bridge'
      );
    }
    return undefined;
  } catch {
    return (
      `The media-bridge helper is not reachable at ${MEDIA_BRIDGE_URL}. Start it with ` +
      'scripts/media_bridge/media_bridge.py start (or load its launchd agent).'
    );
  }
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `helper answered ${res.status}`);
  return json as T;
}

export const planTts = (script: string, engine: string, voice: string | null = null) =>
  postJSON<TtsPlan>('/tts/plan', { script, engine, voice });

export async function startTts(
  script: string,
  engine: string,
  voice: string | null,
  remId: string,
  subject: string
): Promise<string> {
  const body = await postJSON<{ taskId?: string }>('/tts', {
    script,
    engine,
    voice,
    remId,
    subject,
  });
  if (!body.taskId) throw new Error('the helper started no task');
  return body.taskId;
}

export async function getTtsTask(taskId: string): Promise<TtsTask> {
  const res = await fetch(`${MEDIA_BRIDGE_URL}/tts/${taskId}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `helper answered ${res.status}`);
  return body as TtsTask;
}

// --- insert -------------------------------------------------------------------------

/** Store the mp3 in RemNote as the first child of the read rem, and tag it if the setting says so. */
export async function insertAudio(
  plugin: RNPlugin,
  context: ReadAloudContext,
  result: TtsResult
): Promise<{ remId?: string; warning?: string }> {
  if (!result.url) throw new Error('No audio file came back.');
  const word = context.lang === 'pt' ? 'Áudio' : 'Audio';
  const caption = `🔊 ${word} (${result.voiceLabel ?? result.voice ?? 'TTS'})`;
  // runAudio only uses RNPlugin calls; it is typed for the bridge's ReactRNPlugin.
  const placed = await runAudio(plugin as ReactRNPlugin, {
    id: `read-aloud-${Date.now()}`,
    op: 'audio',
    remIds: [context.remId],
    url: result.url,
    caption,
    position: 'first',
  });
  const remId = typeof placed.remId === 'string' ? placed.remId : undefined;
  if (!placed.ok && !remId) throw new Error(placed.summary);
  let warning = placed.ok ? undefined : placed.summary;

  const tagName = String((await getIESetting(plugin, readAloudTagId)) ?? '').trim();
  if (tagName && remId) {
    try {
      let tag = await plugin.rem.findByName([tagName], null);
      if (!tag) {
        tag = await plugin.rem.createRem();
        await tag?.setText([tagName]);
      }
      const audioRem = await plugin.rem.findOne(remId);
      if (tag && audioRem) await audioRem.addTag(tag._id);
    } catch (err) {
      warning = `${warning ? `${warning}; ` : ''}tag “${tagName}” not added (${String(err)})`;
    }
  }
  return { remId, warning };
}

// --- the command --------------------------------------------------------------------

export async function openReadAloud(plugin: RNPlugin) {
  if (!(await getIESetting(plugin, mediaBridgeEnabledId))) {
    await showMessageDialog(plugin, {
      title: 'Read aloud needs the Local Media Bridge',
      message:
        'Turn on the setting "Local Media Bridge" in Incremental Everything. The speech is made by ' +
        'its helper program on this computer, with your own Gemini or Azure key.',
      tone: 'info',
    });
    return;
  }
  const selection = await plugin.editor.getSelection();
  const rem =
    selection?.type === SelectionType.Rem
      ? await plugin.rem.findOne(selection.remIds[0])
      : await plugin.focus.getFocusedRem();
  if (!rem) {
    await plugin.app.toast('No focused rem — place your cursor in the rem (or document) to read.');
    return;
  }
  const problem = await helperProblem();
  if (problem) {
    await showMessageDialog(plugin, {
      title: 'Cannot read aloud',
      message: problem,
      tone: 'error',
    });
    return;
  }
  await plugin.app.toast('Reading the rem tree…');
  const built = await buildReadAloudScript(plugin, rem);
  if (!built.script.trim()) {
    await plugin.app.toast('Nothing to read in this rem.');
    return;
  }
  const context: ReadAloudContext = { remId: rem._id, ...built };
  await plugin.widget.openPopup(READ_ALOUD_POPUP, context);
}
