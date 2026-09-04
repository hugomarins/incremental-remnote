// lib/card_labels.ts
//
// Naming the individual cards of one Rem.
//
// A Rem with eight cards shows eight histories, and "Cloze Card", "Cloze Card",
// "Cloze Card"… tells the reader nothing about which is which. RemNote's own
// metadata panel solves it by putting the distinguishing text in parentheses
// after the type — `Cloze (the pressure differences)`, `Forward Card` — and
// this produces the same labels so the plugin's history popup reads like the
// panel next to it.
//
// The distinguishing text per card type:
//   forward  — the Rem's FRONT (what the card asks)
//   backward — the Rem's BACK  (what the card asks)
//   cloze    — the words inside that specific cloze, found by matching the
//              card's `type.clozeId` against the `cId` markup in the rich text.
//              This is the only one that needs a lookup: `collectClozeTexts` in
//              card_analytics_export returns the texts but not which id each
//              belongs to, and without the id a Rem's five clozes are again
//              indistinguishable.

import { RNPlugin } from '@remnote/plugin-sdk';
import { safeRemTextToString } from './pdfUtils';

/** Longest identifier text kept inline; the full text stays in the tooltip. */
export const CARD_LABEL_MAX_CHARS = 70;

export interface CardLabel {
  /** 'forward' | 'backward' | 'cloze' | whatever the card reports. */
  kind: string;
  /** Type name as shown: "Forward Card", "Cloze". */
  typeName: string;
  /** The distinguishing text, already trimmed. Empty when there is none. */
  identifier: string;
  /** typeName plus the identifier in parentheses — the one-line label. */
  full: string;
}

/**
 * Cloze id → the text inside it.
 *
 * Cloze markup rides on the rich-text elements themselves (`cId`), so a cloze's
 * words are that element's own `text`. A cloze split across several elements
 * (partly bolded, say) contributes each fragment, joined in document order.
 */
export function collectClozeTextsById(richText: any): Map<string, string> {
  const parts = new Map<string, string[]>();
  const add = (id: unknown, text: string) => {
    if (typeof id !== 'string' || !id || !text) return;
    const bucket = parts.get(id);
    if (bucket) bucket.push(text);
    else parts.set(id, [text]);
  };
  const visit = (node: any, depth: number) => {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const text = typeof node.text === 'string' ? node.text : '';
    if (text) {
      if (Array.isArray(node.cId)) node.cId.forEach((id: unknown) => add(id, text));
      else add(node.cId, text);
    }
    if (Array.isArray(node.blocks)) visit(node.blocks, depth + 1);
    if (Array.isArray(node.text)) visit(node.text, depth + 1);
  };
  visit(richText, 0);
  const out = new Map<string, string>();
  for (const [id, fragments] of parts) out.set(id, fragments.join('').trim());
  return out;
}

function titleCase(kind: string): string {
  if (!kind) return 'Card';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function truncateLabel(text: string, max = CARD_LABEL_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Labels for every card of one Rem, keyed by card id.
 *
 * Takes the Rem's front/back text once and reuses it across the cards, so a
 * Rem with eight cards costs two text conversions rather than sixteen.
 */
export async function buildCardLabels(
  plugin: RNPlugin,
  rem: { text?: any; backText?: any } | null,
  cards: { _id: string; type?: any }[]
): Promise<Map<string, CardLabel>> {
  const [frontText, backText] = await Promise.all([
    rem?.text ? safeRemTextToString(plugin, rem.text) : Promise.resolve(''),
    rem?.backText ? safeRemTextToString(plugin, rem.backText) : Promise.resolve(''),
  ]);
  const clozeTexts = rem?.text ? collectClozeTextsById(rem.text) : new Map<string, string>();
  // Clozes can live on the back of a Rem too (RemNote's panel labels them the
  // same way), so fold the back's markup in as well.
  if (rem?.backText) {
    for (const [id, text] of collectClozeTextsById(rem.backText)) {
      if (!clozeTexts.has(id)) clozeTexts.set(id, text);
    }
  }

  const out = new Map<string, CardLabel>();
  for (const card of cards) {
    const type = card.type;
    const isCloze = !!type && typeof type === 'object' && 'clozeId' in type;

    if (isCloze) {
      const clozeId = String((type as any).clozeId);
      const identifier = truncateLabel(clozeTexts.get(clozeId) ?? '');
      out.set(card._id, {
        kind: 'cloze',
        typeName: 'Cloze',
        identifier,
        // A cloze whose markup was edited away has no text left to show; fall
        // back to a short id so the row is still distinguishable from its
        // siblings rather than collapsing into a bare "Cloze".
        full: identifier ? `Cloze (${identifier})` : `Cloze (#${clozeId.slice(0, 6)})`,
      });
      continue;
    }

    const kind = typeof type === 'string' ? type : 'card';
    const identifier = truncateLabel(
      kind === 'backward' ? backText : kind === 'forward' ? frontText : frontText
    );
    const typeName = `${titleCase(kind)} Card`;
    out.set(card._id, {
      kind,
      typeName,
      identifier,
      full: identifier ? `${typeName} (${identifier})` : typeName,
    });
  }
  return out;
}
