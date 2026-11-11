import { PluginCommandMenuLocation, ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  priorityShieldHistoryMenuItemId,
  currentSubQueueIdKey,
  noIncRemMenuItemId,
  noIncRemTimerKey,
  incRemDisabledDeviceKey,
} from '../lib/consts';
import { safeRemTextToString } from '../lib/pdfUtils';
import {
  openDocumentHub,
  openPdfControlPanel,
  openPriorityQueue,
  openSetPriority,
  toggleIncrementalRem,
} from '../lib/document_menu_actions';

export async function registerMenus(plugin: ReactRNPlugin) {
  plugin.app.registerMenuItem({
    id: 'sorting_criteria_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Sorting Criteria',
    action: async () => {
      await plugin.widget.openPopup('sorting_criteria');
    },
  });

  plugin.app.registerMenuItem({
    id: priorityShieldHistoryMenuItemId,
    name: 'Priority Shield History',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      const subQueueId = await plugin.storage.getSession<string | null>(currentSubQueueIdKey);
      console.log('Opening Priority Shield Graph with subQueueId:', subQueueId);

      await plugin.widget.openPopup('priority_shield_graph', {
        subQueueId,
      });
    },
  });

  plugin.app.registerMenuItem({
    id: 'tag_rem_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Toggle Incremental Rem',
    action: async (args: { remId: string }) => toggleIncrementalRem(plugin, args.remId),
  });
  plugin.app.registerMenuItem({
    id: 'set_priority_document_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Set Priority',
    action: async (args: { remId: string }) => openSetPriority(plugin, args.remId),
  });
  plugin.app.registerMenuItem({
    id: noIncRemMenuItemId,
    name: 'No Inc Rem for 15 min',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      const currentTimer = await plugin.storage.getSynced<number>(noIncRemTimerKey);
      if (currentTimer && currentTimer > Date.now()) {
        const remainingMinutes = Math.ceil((currentTimer - Date.now()) / 60000);
        await plugin.app.toast(`Timer already active: ${remainingMinutes} minutes remaining`);
        return;
      }

      const endTime = Date.now() + 15 * 60 * 1000;
      await plugin.storage.setSynced(noIncRemTimerKey, endTime);

      await plugin.app.toast('Incremental rems disabled for 15 minutes. Only flashcards will be shown.');

      await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
    },
  });

  plugin.app.registerMenuItem({
    id: 'toggle-inc-rem-device',
    name: 'Toggle Inc Rems in this device',
    location: PluginCommandMenuLocation.QueueMenu,
    action: async () => {
      const isCurrentlyDisabled = await plugin.storage.getLocal<boolean>(incRemDisabledDeviceKey);
      const newState = !isCurrentlyDisabled;
      
      await plugin.storage.setLocal(incRemDisabledDeviceKey, newState);
      
      if (newState) {
        await plugin.app.toast('🚫 Incremental Rems disabled on this device.');
      } else {
        await plugin.app.toast('✅ Incremental Rems enabled on this device.');
      }

      await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
    },
  });

  plugin.app.registerMenuItem({
    id: 'create_priority_review_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Priority Queue',
    action: async (args: { remId: string }) => openPriorityQueue(plugin, args.remId),
  });
  plugin.app.registerMenuItem({
    id: 'pdf_control_panel_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'PDF Control Panel',
    action: async (args: { remId: string }) => openPdfControlPanel(plugin, args.remId),
  });

  // RemNote lists plugin menu items flat and can't nest them, so the rest of the
  // Document menu's actions live in the Document Hub floating panel.
  plugin.app.registerMenuItem({
    id: 'document_hub_menuitem',
    location: PluginCommandMenuLocation.DocumentMenu,
    name: 'Incremental RemNote…',
    action: async (args: { remId: string }) => openDocumentHub(plugin, args.remId),
  });
  plugin.app.registerMenuItem({
    id: 'create_priority_review_queue_menuitem',
    location: PluginCommandMenuLocation.QueueMenu,
    name: 'Priority Queue',
    action: async () => {
      const subQueueId = await plugin.storage.getSession<string>(currentSubQueueIdKey);

      if (subQueueId) {
        const rem = await plugin.rem.findOne(subQueueId);
        const remName = rem ? await safeRemTextToString(plugin, rem.text) : 'Queue Scope';

        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: subQueueId,
          scopeName: remName,
        });
      } else {
        await plugin.storage.setSession('reviewDocContext', {
          scopeRemId: null,
          scopeName: 'Full KB',
        });
      }

      await plugin.widget.openPopup('priority_queue_popup');
    },
  });
}
