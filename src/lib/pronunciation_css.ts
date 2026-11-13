/**
 * The mark of a pronunciation audio Rem ("Add pronunciation"): the Pronunciation
 * powerup's pill shows a speaking-head icon instead of its name, and the Rem's bullet
 * becomes that icon. The bullet carries it too because RemNote shows separate pills
 * only while a Rem has a single tag; with the Extra Card Detail powerup as well, the
 * bar may collapse into a "2 tags" chip (findings/EDITOR_DOM_AND_CSS.md).
 *
 * The pill is matched by its own `data-test` ("Applied Powerup Pill Pronunciation"),
 * so other tags on the Rem keep their names; the bullet by the powerup name's slug
 * in the row's `data-rem-tags` (`pronunciation`). Same technique as the
 * sierra-remnote anchor marks.
 *
 * In the queue, the card's "Extra details" list shows the audio Rem with a bullet of
 * its own, reached through lib/extra_details_css.
 */
import { extraDetailsItem } from './extra_details_css';

export const PRONUNCIATION_POWERUP_NAME = 'Pronunciation';
export const PRONUNCIATION_POWERUP_CODE = 'pronunciation';
export const PRONUNCIATION_CSS_ID = 'pronunciation-mark';

const SLUG = 'pronunciation';

// Material Icons "record_voice_over" (Apache License 2.0): a head speaking.
const speakingHead = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="${fill}">` +
  `<circle cx="9" cy="9" r="4"/>` +
  `<path d="M9 15c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>` +
  `<path d="M16.76 5.36l-1.68 1.69c.84 1.18.84 2.71 0 3.89l1.68 1.69c2.02-2.02 2.02-5.07 0-7.27z"/>` +
  `<path d="M20.07 2l-1.63 1.63c2.77 3.02 2.77 7.56 0 10.74L20.07 16c3.9-3.89 3.91-9.95 0-14z"/>` +
  `</g></svg>`;

const url = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const LIGHT = url(speakingHead('#0f766e'));
const DARK = url(speakingHead('#5eead4'));

const PILL = `.hierarchy-editor__tag-bar__tag[data-test^="Applied Powerup Pill ${PRONUNCIATION_POWERUP_NAME}"]`;
const EDITOR_BULLET = `.rn-editor__rem__body[data-rem-tags~="${SLUG}"] .rem-bullet__container .rem-bullet`;
const EXTRA_DETAILS_BULLET = `${extraDetailsItem(SLUG)} > .rem-bullet__container .rem-bullet`;
/** Both bullets, each with `prefix` and `suffix` added. */
const bullets = (prefix = '', suffix = '') =>
  [EDITOR_BULLET, EXTRA_DETAILS_BULLET].map((b) => `${prefix}${b}${suffix}`).join(',\n');

export const PRONUNCIATION_CSS = `
/* Pronunciation pill: the icon instead of the name. */
${PILL} {
  font-size: 0px;
}
${PILL}:before {
  content: "";
  display: inline-block;
  width: 14px;
  height: 14px;
  vertical-align: -2px;
  background: center / contain no-repeat ${LIGHT};
}
.dark ${PILL}:before {
  background-image: ${DARK};
}

/* The bullet becomes the icon (drawn over it, so RemNote's hover ring stays behind),
   in the editor and in the queue's Extra details. */
${bullets('', ' .rem-bullet__core')} {
  fill: transparent;
}
${bullets('', ':after')} {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 15px;
  height: 15px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  background: center / contain no-repeat ${LIGHT};
}
${bullets('.dark ', ':after')} {
  background-image: ${DARK};
}
`;
