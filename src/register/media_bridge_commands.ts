import { ReactRNPlugin } from '@remnote/plugin-sdk';
import { mediaBridgeEnabledId, readAloudCommandId, upscaleImageCommandId } from '../lib/consts';
import { openReadAloud } from '../lib/read_aloud';
import { getIESetting } from '../lib/settings';
import { openUpscaleImage } from '../lib/upscale_image';

let registered = false;

/**
 * The commands that need the Local Media Bridge helper ("Upscale image with ChatGPT",
 * "Read aloud") exist only while its setting is on, so users without the helper never
 * see them: registered at startup when the setting is on, or the moment it is turned
 * on. The SDK cannot unregister a command, so turning the setting off hides them from
 * the next reload on (until then they explain that the setting is off).
 * Call once from the index widget.
 */
export function registerMediaBridgeCommands(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    if (registered || !(await getIESetting(rp, mediaBridgeEnabledId))) return;
    registered = true;
    await plugin.app.registerCommand({
      id: upscaleImageCommandId,
      name: 'Upscale image with ChatGPT',
      description:
        "Regenerate the focused rem's image at a higher resolution (Local Media Bridge + Codex CLI), compare, replace.",
      quickCode: 'upi',
      action: async () => openUpscaleImage(plugin),
    });
    await plugin.app.registerCommand({
      id: readAloudCommandId,
      name: 'Read aloud',
      description:
        'Read the focused rem and its descendants aloud (Gemini or Azure TTS through the Local Media Bridge) and add the audio as its first child.',
      quickCode: 'ra',
      action: async () => openReadAloud(plugin),
    });
  });
}
