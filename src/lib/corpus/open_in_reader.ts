import { BuiltInPowerupCodes, ReactRNPlugin } from '@remnote/plugin-sdk';
import { ancestorIds, selectedOrFocusedRems } from '../pdf_source_pins';
import { getPdfInfoFromHighlight, safeRemTextToString } from '../pdfUtils';
import { CorpusUnavailableError, corpusRequest, getCorpusStatus } from './index';

/**
 * Open in Corpus Reader: the corpus provider (docs/Corpus-Provider.md) may come with a
 * reader of its own, a page in the browser showing the library's books. This asks it
 * where the focused Rem's passage is (`open-in-reader`) and opens the address it answers.
 * The plugin knows nothing about the reader: any provider can offer the capability.
 */
export const OPEN_IN_READER = 'open-in-reader';

const MAX_TEXT = 300;
const TIMEOUT_MS = 20_000;

interface OpenInReaderAnswer {
  /** An http(s) address the browser can open. */
  url?: string | null;
  /** One or two words on how the place was found, for the toast ("by the notes"). */
  how?: string | null;
  /** Why there is no address. */
  reason?: string | null;
}

function openInBrowser(url: string) {
  const opened = window.open(url, '_blank');
  if (opened && !opened.closed) return;
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => document.body.removeChild(link), 100);
}

export async function openInCorpusReader(plugin: ReactRNPlugin) {
  const rem = (await selectedOrFocusedRems(plugin))[0];
  if (!rem) {
    await plugin.app.toast('Open in Corpus Reader: put the cursor in a Rem first.');
    return;
  }
  const text = (await safeRemTextToString(plugin, rem.text)).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const payload: Record<string, unknown> = { remId: rem._id, ancestors: await ancestorIds(rem), text };
  if (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
    const { pdfRemId, pageIndex } = await getPdfInfoFromHighlight(plugin, rem);
    if (pdfRemId) payload.sourceRemId = pdfRemId;
    if (pageIndex) payload.page = pageIndex;
  } else if (await rem.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
    payload.sourceRemId = rem._id;
  }

  let answer: OpenInReaderAnswer;
  try {
    answer = await corpusRequest<OpenInReaderAnswer>(plugin, OPEN_IN_READER, payload, { timeoutMs: TIMEOUT_MS });
  } catch (e) {
    const why = e instanceof CorpusUnavailableError ? e.message : (e as Error).message;
    await plugin.app.toast(`Open in Corpus Reader: ${why}`);
    return;
  }
  const url = typeof answer.url === 'string' ? answer.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) {
    await plugin.app.toast(`Open in Corpus Reader: ${answer.reason || 'the provider has no place for this Rem.'}`);
    return;
  }
  openInBrowser(url);
  const name = (await getCorpusStatus(plugin)).name ?? 'the reader';
  await plugin.app.toast(`Opened in ${name}${answer.how ? ` (${answer.how})` : ''}`);
}
