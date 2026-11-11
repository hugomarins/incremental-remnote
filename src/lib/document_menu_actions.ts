import { ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import {
  powerupCode,
  pageRangeWidgetId,
  cardEnablementAnchorKey,
  documentHubWidgetId,
  documentHubTargetKey,
  documentHubActiveIdKey,
  documentHubPositionKey,
  documentHubDefaultPosition,
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
 * Open the Document Hub on a document, or point the open one at it.
 *
 * The hub stays open (no close on outside click) so it can sit beside the
 * editor; openFloatingWidget takes no context data, so the document goes
 * through session storage, which the hub tracks.
 */
export async function openDocumentHub(plugin: Plugin, remId: string) {
  await plugin.storage.setSession(documentHubTargetKey, { remId, at: Date.now() });

  const activeId = await plugin.storage.getSession<string>(documentHubActiveIdKey);
  if (activeId && (await plugin.window.isFloatingWidgetOpen(activeId).catch(() => false))) return;

  const position =
    (await plugin.storage.getSession<typeof documentHubDefaultPosition>(documentHubPositionKey)) ||
    documentHubDefaultPosition;
  const id = await plugin.window.openFloatingWidget(documentHubWidgetId, position, undefined, false);
  await plugin.storage.setSession(documentHubActiveIdKey, id);
}
