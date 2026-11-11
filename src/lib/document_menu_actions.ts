import { PaneRemWindowTree, ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import {
  powerupCode,
  pageRangeWidgetId,
  cardEnablementAnchorKey,
  documentHubWidgetId,
  documentHubTargetKey,
  documentHubActiveIdKey,
  documentHubAnchorPosition,
} from './consts';
import { safeRemTextToString, getActivePdfForIncRem, getAllPDFsInRem } from './pdfUtils';
import { initIncrementalRem } from './incremental_rem';
import { confirmNoDuplicateSource } from './duplicate_source';
import { markRemsAsFreshlyCreated } from './incRemHelpers';

// The actions of the Document menu ("..." at the top right of a document), each
// taking the document's Rem id. RemNote lists plugin menu items flat and can't
// nest them (findings/PLUGIN_BRIDGE_AND_SDK.md, "Commands and UI"), so most of
// them live in the Document Hub floating widget instead, behind one
// "Incremental RemNote…" menu item. Both the menu and the hub call these.

type Plugin = RNPlugin | ReactRNPlugin;

export async function toggleIncrementalRem(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  if (await rem.hasPowerup(powerupCode)) {
    await rem.removePowerup(powerupCode);
    // CSS handles the styling cleanup when the tag is removed.
    await plugin.app.toast('❌ Removed Incremental tag');
    return;
  }
  if (!(await confirmNoDuplicateSource(plugin as ReactRNPlugin, [rem])).length) return;
  await initIncrementalRem(plugin as ReactRNPlugin, rem);
  await plugin.app.toast('✅ Tagged as Incremental Rem');
  // Clear stale session storage to prevent a race with the widget context.
  await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
  await markRemsAsFreshlyCreated(plugin as ReactRNPlugin, [rem._id]);
  await plugin.widget.openPopup('priority_interval', { remId: rem._id });
}

export async function openSetPriority(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    await plugin.app.toast('Could not find a Rem to set priority for.');
    return;
  }
  await plugin.storage.setSession('priorityPopupTargetRemId', undefined);
  await plugin.widget.openPopup('priority', { remId: rem._id });
}

export async function openBatchPriority(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;
  await plugin.storage.setSession('batchPriorityFocusedRem', remId);
  await plugin.widget.openPopup('batch_priority', { remId });
}

export async function openBatchCardPriority(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    await plugin.app.toast('Could not find the rem');
    return;
  }
  // Allow opening if this rem is used as a tag OR is referenced by other rems.
  const [taggedRems, referencingRems] = await Promise.all([
    rem.taggedRem(),
    rem.remsReferencingThis(),
  ]);
  if (!taggedRems?.length && !referencingRems?.length) {
    await plugin.app.toast('No rems are tagged with or referencing this rem.');
    return;
  }
  await plugin.storage.setSession('batchCardPriorityTagRem', rem._id);
  await plugin.widget.openPopup('batch_card_priority');
}

export async function openCardEnablementAudit(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    await plugin.app.toast('Could not find the rem');
    return;
  }
  await plugin.storage.setSession(cardEnablementAnchorKey, rem._id);
  await plugin.widget.openPopup('card_enablement_audit');
}

export async function openPriorityShieldHistory(plugin: Plugin, remId: string) {
  // From a document, the document IS the scope (subQueueId).
  await plugin.widget.openPopup('priority_shield_graph', { subQueueId: remId });
}

export async function openPriorityQueue(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;
  await plugin.storage.setSession('reviewDocContext', {
    scopeRemId: rem._id,
    scopeName: await safeRemTextToString(plugin as ReactRNPlugin, rem.text),
  });
  await plugin.widget.openPopup('priority_queue_popup');
}

export async function openPdfControlPanel(plugin: Plugin, remId: string) {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  const pdfRem = await getActivePdfForIncRem(plugin as ReactRNPlugin, rem);
  if (!pdfRem) {
    await plugin.app.toast('No PDF found in this rem or its sources');
    return;
  }

  // From an IncRem document (rather than the PDF itself), pass the IncRem id.
  // Otherwise the widget falls back to findIncrementalRemForPDFFast, which
  // returns the *first* IncRem on that PDF — the wrong one when a book's
  // chapters all share the textbook. Pre-filling allPdfRemIds also lets the
  // PDF selector render at once.
  const isIncRem = await rem.hasPowerup(powerupCode);
  await plugin.storage.setSession('pageRangeContext', {
    pdfRemId: pdfRem._id,
    incrementalRemId: isIncRem ? rem._id : null, // null only from a non-IncRem doc
    totalPages: 0,
    currentPage: 1,
    allPdfRemIds: isIncRem
      ? (await getAllPDFsInRem(plugin as ReactRNPlugin, rem)).map((p) => p.rem._id)
      : undefined,
  });
  await plugin.storage.setSession('pageRangePopupOpen', true);
  await plugin.widget.openPopup(pageRangeWidgetId);
}

/**
 * Open the Document Hub on a document, or point the open one at it, placed
 * just below the "…" button the menu was opened from.
 *
 * A menu action gets only the document's id, never the click, and a plugin
 * can't measure the host's DOM. So the hub opens at a marker position
 * (documentHubAnchorPosition) that a host CSS rule recognises in the float
 * wrapper's inline style and replaces with CSS anchor positioning: below the
 * "…" (`.rn-doc-header__rem-options-btn`) of the pane showing the document,
 * or near the top right of that pane when it has no such button. The hub
 * then reads where it landed (getDimensions) and moves itself there with
 * setFloatingWidgetPosition; the inline style no longer matches the marker,
 * the rule lets go, and dragging works on plain coordinates again.
 *
 * Must run in the index iframe: registerCSS only works there. Menu actions do.
 * The hub stays open (no close on outside click); the document goes through
 * session storage, since openFloatingWidget takes no context data.
 */
export async function openDocumentHub(plugin: Plugin, remId: string) {
  const paneId = await paneShowing(plugin, remId);
  await plugin.app.registerCSS('document-hub-anchor', documentHubAnchorCss(paneId));

  const activeId = await plugin.storage.getSession<string>(documentHubActiveIdKey);
  const open = !!activeId && (await plugin.window.isFloatingWidgetOpen(activeId).catch(() => false));
  if (open) {
    // Back to the marker, so the open hub jumps to this menu too.
    await plugin.window.setFloatingWidgetPosition(activeId!, documentHubAnchorPosition);
  }
  // Written after the move: the hub re-measures when this changes.
  await plugin.storage.setSession(documentHubTargetKey, { remId, at: Date.now(), source: 'menu' });
  if (open) return;

  const id = await plugin.window.openFloatingWidget(
    documentHubWidgetId,
    documentHubAnchorPosition,
    undefined,
    false
  );
  await plugin.storage.setSession(documentHubActiveIdKey, id);
}

function paneLeaves(tree: PaneRemWindowTree | null | undefined): { remId: string; paneId: string }[] {
  if (!tree) return [];
  if ('paneId' in tree) return [tree];
  return [...paneLeaves(tree.first as PaneRemWindowTree), ...paneLeaves(tree.second as PaneRemWindowTree)];
}

/** The pane showing the document: the focused one if it does, else the first. */
async function paneShowing(plugin: Plugin, remId: string): Promise<string | undefined> {
  const [focused, tree] = await Promise.all([
    plugin.window.getFocusedPaneId().catch(() => undefined),
    plugin.window.getCurrentWindowTree().catch(() => undefined),
  ]);
  const showing = paneLeaves(tree).filter((p) => p.remId === remId).map((p) => p.paneId);
  if (focused && showing.includes(focused)) return focused;
  return showing[0] ?? focused;
}

function documentHubAnchorCss(paneId: string | undefined): string {
  const { top, left } = documentHubAnchorPosition;
  // The float wrapper is `<div class="absolute z-50" style="top: 1px; left: 1px;">`.
  const wrapper =
    `div.absolute.z-50[style*="top: ${top}px"][style*="left: ${left}px"]` +
    `:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=${documentHubWidgetId}"])`;
  const pane = paneId ? `.pane-id-${CSS.escape(paneId)}` : null;
  const button = pane ? `${pane} .rn-doc-header__rem-options-btn` : null;
  const anchored = pane
    ? `
  ${pane} { anchor-name: --ie-document-hub-pane; }
  ${button} { anchor-name: --ie-document-hub-button; }
  body:has(${button}) ${wrapper} {
    position: fixed !important;
    top: calc(anchor(--ie-document-hub-button bottom, 48px) + 6px) !important;
    right: anchor(--ie-document-hub-button right, 24px) !important;
    left: auto !important;
  }
  body:not(:has(${button})) ${wrapper} {
    position: fixed !important;
    top: calc(anchor(--ie-document-hub-pane top, 0px) + 48px) !important;
    right: calc(anchor(--ie-document-hub-pane right, 0px) + 16px) !important;
    left: auto !important;
  }`
    : `
  ${wrapper} { top: 56px !important; left: auto !important; right: 24px !important; }`;
  // RemNote's own menus open in #controlled-popup-portal (z 30), under a float's
  // z-50: lift it while the hub is open, or the "…" menu opens behind the hub.
  return `${anchored}
  @media (pointer: fine) {
    body:has(iframe[data-plugin-id="incremental-everything"][src*="widgetName=${documentHubWidgetId}"]) #controlled-popup-portal {
      position: relative;
      z-index: 60;
    }
  }
`;
}
