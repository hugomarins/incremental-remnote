import { RNPlugin, BuiltInPowerupCodes, PowerupSlotCodeMap, RemType } from '@remnote/plugin-sdk';

/**
 * Alias structure probe — where does a rem's alias live, and what id does a
 * rem reference use to point at it?
 *
 * Background. A RemNote alias reference is `{ i:'q', _id: <owning rem>,
 * aliasId: <the alias> }`; the renderer shows the alias's text but the link
 * resolves to the owner. The reference picker builds that node by asking
 * `rem.getAliases()` for the alias and reading `_id` off it.
 *
 * That stopped producing an id: the objects `getAliases()` returns still carry
 * readable `.text` (so alias MATCHING still works) but their `_id` is empty —
 * they are hollow rem shells, which is what you'd expect now that built-in
 * powerup data is no longer stored as rems. Rich text written before the
 * overhaul still carries real `aliasId`s and still renders, so the id has not
 * disappeared from the model — only from this read path.
 *
 * This probe asks every route that could still yield the id, on one rem:
 *
 *  A. `getAliases()`                — the broken path; dumps each object's real shape.
 *  B. existing references           — harvest `aliasId`s out of rems that already
 *                                     reference this one. These are ids RemNote
 *                                     itself wrote, so they are ground truth, and
 *                                     resolving one says whether an alias is still
 *                                     addressable as a rem at all.
 *  C. the Aliases powerup property  — `getPowerupProperty`/`getPowerupPropertyAsRem`,
 *                                     where a migrated built-in keeps its value.
 *  D. the rem's own children        — an alias child rem would still show up here.
 *  E. `getOrCreateAliasWithText()`  — "if an equivalent alias already exists, that
 *                                     alias will be returned". This is the lookup
 *                                     RemNote's own picker needs too, so it is the
 *                                     likeliest surviving route to the id. Called
 *                                     with the alias's OWN rich text (not a
 *                                     re-typed string) so "equivalent" holds and
 *                                     nothing new is created; the probe counts
 *                                     aliases before and after to prove it.
 *
 * Whichever route returns a usable id is the one the picker should switch to.
 */

type AliasObjectRow = {
  index: number;
  keys: string[];
  idValue: string;
  idIsUsable: boolean;
  text: string;
  parent: string;
  typeOf: string;
  findOneResolves: boolean | null; // null = not attempted (no id to try)
};

type ReferenceAliasRow = {
  aliasId: string;
  usedByRemId: string;
  resolves: boolean;
  text: string;
  type: string;
  parent: string;
  parentIsTarget: boolean;
  isProperty: boolean | null;
  hasAliasesPowerup: boolean | null;
};

type PropertyRow = {
  call: string;
  outcome: 'value' | 'empty' | 'threw';
  detail: string;
};

type GetOrCreateRow = {
  requestedText: string;
  returned: boolean;
  idValue: string;
  idIsUsable: boolean;
  keys: string[];
  returnedText: string;
  findOneResolves: boolean | null;
  /** True when this id is one an existing reference already uses — ground truth. */
  matchesInUseAliasId: boolean;
  threw: string | null;
};

type ChildRow = {
  id: string;
  text: string;
  type: string;
  isProperty: boolean;
  hasAliasesPowerup: boolean;
  matchesAnAliasText: boolean;
};

export type AliasProbeReport = {
  remId: string;
  remText: string;
  hasAliasesPowerup: boolean | null;
  aliasesPowerupId: string | null;
  aliasSlotCode: string | null;
  // A
  getAliasesCount: number;
  getAliasesThrew: string | null;
  aliasObjects: AliasObjectRow[];
  // B
  referencingRemCount: number;
  referenceAliases: ReferenceAliasRow[];
  // C
  properties: PropertyRow[];
  // D
  children: ChildRow[];
  // E
  getOrCreate: GetOrCreateRow[];
  aliasCountBefore: number;
  aliasCountAfter: number;
  // Conclusion
  resolvedAliases: Array<{ text: string; id: string; via: string }>;
  verdict: string[];
};

const textOf = async (plugin: RNPlugin, rt: any): Promise<string> => {
  try {
    if (!rt) return '';
    return (await plugin.richText.toString(rt)).trim();
  } catch {
    return '';
  }
};

const shortJson = (v: unknown, max = 200): string => {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export const probeAliasStructure = async (
  plugin: RNPlugin,
  remId: string
): Promise<AliasProbeReport> => {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) throw new Error(`No rem found for id ${remId}`);

  const report: AliasProbeReport = {
    remId,
    remText: await textOf(plugin, rem.text),
    hasAliasesPowerup: null,
    aliasesPowerupId: null,
    aliasSlotCode: null,
    getAliasesCount: 0,
    getAliasesThrew: null,
    aliasObjects: [],
    referencingRemCount: 0,
    referenceAliases: [],
    properties: [],
    children: [],
    getOrCreate: [],
    aliasCountBefore: 0,
    aliasCountAfter: 0,
    resolvedAliases: [],
    verdict: [],
  };

  try {
    report.hasAliasesPowerup = await rem.hasPowerup(BuiltInPowerupCodes.Aliases);
  } catch { /* leave null */ }
  try {
    const pu = await plugin.powerup.getPowerupByCode(BuiltInPowerupCodes.Aliases);
    report.aliasesPowerupId = pu?._id ?? null;
  } catch { /* leave null */ }
  const slotFromMap = (PowerupSlotCodeMap as any)?.[BuiltInPowerupCodes.Aliases]?.Aliases;
  report.aliasSlotCode = typeof slotFromMap === 'string' ? slotFromMap : null;

  // --- A. what getAliases() actually hands back ------------------------------
  let aliasObjs: any[] = [];
  try {
    aliasObjs = (await rem.getAliases()) as any[];
    report.getAliasesCount = aliasObjs.length;
  } catch (e) {
    report.getAliasesThrew = String(e);
  }
  for (let i = 0; i < aliasObjs.length; i++) {
    const a: any = aliasObjs[i];
    const idValue = a?._id;
    const usable = typeof idValue === 'string' && idValue.length > 0;
    let findOneResolves: boolean | null = null;
    if (usable) {
      try {
        findOneResolves = !!(await plugin.rem.findOne(idValue));
      } catch {
        findOneResolves = false;
      }
    }
    report.aliasObjects.push({
      index: i,
      // Own enumerable keys AND prototype methods: the shape is the whole point.
      keys: Array.from(
        new Set([...Object.keys(a ?? {}), ...Object.getOwnPropertyNames(Object.getPrototypeOf(a ?? {}) ?? {})])
      ).filter((k) => k !== 'constructor'),
      idValue: shortJson(idValue, 60),
      idIsUsable: usable,
      text: await textOf(plugin, a?.text),
      parent: shortJson(a?.parent, 60),
      typeOf: Object.prototype.toString.call(a),
      findOneResolves,
    });
  }
  const aliasTexts = report.aliasObjects.map((a) => a.text).filter(Boolean);

  // --- B. alias ids RemNote itself wrote into existing references ------------
  // Ground truth: these ids render correctly today, so whatever they point at
  // is what a new reference must point at too.
  try {
    const referencing = await rem.remsReferencingThis();
    report.referencingRemCount = referencing.length;
    const seen = new Set<string>();
    for (const src of referencing) {
      const rt: any[] = Array.isArray(src.text) ? (src.text as any[]) : [];
      for (const node of rt) {
        if (!node || typeof node === 'string') continue;
        if (node.i !== 'q' || node._id !== remId) continue;
        const aliasId = node.aliasId;
        if (typeof aliasId !== 'string' || !aliasId || seen.has(aliasId)) continue;
        seen.add(aliasId);
        const row: ReferenceAliasRow = {
          aliasId,
          usedByRemId: src._id,
          resolves: false,
          text: '',
          type: '?',
          parent: '',
          parentIsTarget: false,
          isProperty: null,
          hasAliasesPowerup: null,
        };
        try {
          const ar = await plugin.rem.findOne(aliasId);
          if (ar) {
            row.resolves = true;
            row.text = await textOf(plugin, ar.text);
            row.type = `${RemType[await ar.getType().catch(() => 0)] ?? '?'}`;
            row.parent = ar.parent ?? '';
            row.parentIsTarget = (ar.parent ?? null) === remId;
            row.isProperty = await ar.isProperty().catch(() => null);
            row.hasAliasesPowerup = await ar.hasPowerup(BuiltInPowerupCodes.Aliases).catch(() => null);
          }
        } catch { /* leave as unresolved */ }
        report.referenceAliases.push(row);
      }
    }
  } catch (e) {
    report.verdict.push(`remsReferencingThis() threw: ${String(e)}`);
  }

  // --- C. the Aliases powerup's own property --------------------------------
  const slotCandidates = Array.from(
    new Set([report.aliasSlotCode, 'Aliases', 'aliases', 'alias', 'l'].filter(Boolean) as string[])
  );
  for (const slot of slotCandidates) {
    try {
      const v = await rem.getPowerupProperty(BuiltInPowerupCodes.Aliases, slot);
      report.properties.push({
        call: `getPowerupProperty('l', '${slot}')`,
        outcome: v === '' || v == null ? 'empty' : 'value',
        detail: v === '' || v == null ? '' : shortJson(v, 300),
      });
    } catch (e) {
      report.properties.push({ call: `getPowerupProperty('l', '${slot}')`, outcome: 'threw', detail: String(e) });
    }
    try {
      const pr = await rem.getPowerupPropertyAsRem(BuiltInPowerupCodes.Aliases, slot);
      report.properties.push({
        call: `getPowerupPropertyAsRem('l', '${slot}')`,
        outcome: pr ? 'value' : 'empty',
        detail: pr ? `_id=${shortJson(pr._id, 60)} text="${await textOf(plugin, pr.text)}"` : '',
      });
    } catch (e) {
      report.properties.push({ call: `getPowerupPropertyAsRem('l', '${slot}')`, outcome: 'threw', detail: String(e) });
    }
  }

  // --- D. children of the rem ------------------------------------------------
  try {
    for (const c of await rem.getChildrenRem()) {
      const t = await textOf(plugin, c.text);
      report.children.push({
        id: c._id,
        text: t,
        type: `${RemType[await c.getType().catch(() => 0)] ?? '?'}`,
        isProperty: await c.isProperty().catch(() => false),
        hasAliasesPowerup: await c.hasPowerup(BuiltInPowerupCodes.Aliases).catch(() => false),
        matchesAnAliasText: aliasTexts.some((at) => at && at === t),
      });
    }
  } catch (e) {
    report.verdict.push(`getChildrenRem() threw: ${String(e)}`);
  }

  // --- E. getOrCreateAliasWithText -------------------------------------------
  // Fed each alias's own rich text, so an equivalent alias exists by definition
  // and the call is a lookup, not a create. aliasCountBefore/After makes that
  // claim falsifiable rather than a hope.
  report.aliasCountBefore = aliasObjs.length;
  const inUseIds = new Set(report.referenceAliases.map((r) => r.aliasId));
  for (const a of aliasObjs) {
    const requestedText = await textOf(plugin, a?.text);
    const row: GetOrCreateRow = {
      requestedText,
      returned: false,
      idValue: '',
      idIsUsable: false,
      keys: [],
      returnedText: '',
      findOneResolves: null,
      matchesInUseAliasId: false,
      threw: null,
    };
    try {
      const res: any = await rem.getOrCreateAliasWithText(a?.text ?? [requestedText]);
      if (res) {
        row.returned = true;
        row.idValue = shortJson(res._id, 60);
        row.idIsUsable = typeof res._id === 'string' && res._id.length > 0;
        row.keys = Object.keys(res ?? {});
        row.returnedText = await textOf(plugin, res.text);
        row.matchesInUseAliasId = row.idIsUsable && inUseIds.has(res._id);
        if (row.idIsUsable) {
          try {
            row.findOneResolves = !!(await plugin.rem.findOne(res._id));
          } catch {
            row.findOneResolves = false;
          }
        }
      }
    } catch (e) {
      row.threw = String(e);
    }
    report.getOrCreate.push(row);
  }
  try {
    report.aliasCountAfter = ((await rem.getAliases()) as any[]).length;
  } catch {
    report.aliasCountAfter = -1;
  }

  // --- Conclusion: for each alias text, the best id we can produce -----------
  for (const at of aliasTexts) {
    const fromGetOrCreate = report.getOrCreate.find((g) => g.requestedText === at && g.idIsUsable);
    const fromGetAliases = report.aliasObjects.find((a) => a.text === at && a.idIsUsable);
    const fromReference = report.referenceAliases.find((r) => r.text === at);
    const fromChild = report.children.find((c) => c.matchesAnAliasText && c.text === at);
    const hit = fromGetAliases
      ? { id: fromGetAliases.idValue, via: 'getAliases()._id' }
      : fromGetOrCreate
        ? { id: fromGetOrCreate.idValue, via: 'getOrCreateAliasWithText()' }
        : fromReference
          ? { id: fromReference.aliasId, via: 'existing reference' }
          : fromChild
            ? { id: fromChild.id, via: 'child rem' }
            : null;
    if (hit) report.resolvedAliases.push({ text: at, ...hit });
  }

  const anyUsableFromGetAliases = report.aliasObjects.some((a) => a.idIsUsable);
  if (report.getAliasesCount === 0) {
    report.verdict.push('getAliases() returned nothing — this rem has no alias, or the read path is fully broken. Run this on a rem you know has one.');
  } else if (anyUsableFromGetAliases) {
    report.verdict.push('getAliases() DOES return usable ids on this rem — the picker can keep reading `_id`.');
  } else {
    report.verdict.push('getAliases() returns alias objects whose `_id` is empty — this is why an inserted reference falls back to the primary name.');
  }
  const resolvingRefAlias = report.referenceAliases.filter((r) => r.resolves);
  if (report.referenceAliases.length === 0) {
    report.verdict.push('No existing reference to this rem carries an aliasId — no ground-truth id to compare against. Point the probe at a rem that already has an alias reference somewhere.');
  } else if (resolvingRefAlias.length === 0) {
    report.verdict.push(`${report.referenceAliases.length} aliasId(s) are in live use but NONE resolve via plugin.rem.findOne() — aliases are no longer addressable as rems, so the id has to come from somewhere other than the rem API.`);
  } else {
    report.verdict.push(`${resolvingRefAlias.length} of ${report.referenceAliases.length} in-use aliasId(s) still resolve as rems (${resolvingRefAlias.map((r) => `"${r.text}"`).join(', ')}) — aliases remain addressable; only getAliases() lost the id.`);
  }
  const propHits = report.properties.filter((p) => p.outcome === 'value');
  if (propHits.length) {
    report.verdict.push(`Aliases powerup property returned a value for: ${propHits.map((p) => p.call).join(', ')} — inspect it for the ids.`);
  } else {
    report.verdict.push('No Aliases powerup property returned a value on any slot code tried.');
  }
  const gocUsable = report.getOrCreate.filter((g) => g.idIsUsable);
  if (report.getOrCreate.length === 0) {
    report.verdict.push('getOrCreateAliasWithText() was not exercised (no alias text to feed it).');
  } else if (gocUsable.length === 0) {
    report.verdict.push(`getOrCreateAliasWithText() returned no usable id either${report.getOrCreate[0].threw ? ` (threw: ${report.getOrCreate[0].threw})` : ''} — no plugin API exposes the alias id; this is a RemNote-side gap to report.`);
  } else {
    const confirmed = gocUsable.filter((g) => g.matchesInUseAliasId);
    report.verdict.push(
      `getOrCreateAliasWithText() DOES return a usable id (${gocUsable.map((g) => `"${g.requestedText}" → ${g.idValue}`).join(', ')})` +
        (confirmed.length
          ? ` and ${confirmed.length} of them match an aliasId already in live use — this is the route the picker should take.`
          : ' — but none match an in-use aliasId, so confirm against a rendered reference before trusting it.')
    );
  }
  if (report.aliasCountAfter !== report.aliasCountBefore) {
    report.verdict.push(`WARNING: alias count changed ${report.aliasCountBefore} → ${report.aliasCountAfter} — getOrCreateAliasWithText CREATED an alias instead of returning the existing one. Delete the duplicate.`);
  }
  const aliasChildren = report.children.filter((c) => c.matchesAnAliasText || c.hasAliasesPowerup);
  report.verdict.push(
    aliasChildren.length
      ? `${aliasChildren.length} child rem(s) look like the alias (${aliasChildren.map((c) => `${c.id} "${c.text}"`).join(', ')}) — usable as a fallback lookup.`
      : 'No child rem corresponds to an alias — the alias is not a child rem any more.'
  );

  return report;
};
