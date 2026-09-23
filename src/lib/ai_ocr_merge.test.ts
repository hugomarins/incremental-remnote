/**
 * Fixture tests for merging an area highlight into a text highlight. Run with `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAreaIntoText, pickMergeTarget } from './ai_ocr_merge';

const W = 580.32;
const H = 837.24;
const rect = (x1: number, y1: number, x2: number, y2: number, page = 57, w = W, h = H) => ({
  x1, y1, x2, y2, width: w, height: h, pageNumber: page,
});

/** The SNAME case from page 57: two text lines, then the equations the text layer misses. */
const textHighlight = (lines = [rect(45, 647, 279, 660), rect(30, 659, 107, 672)]) => ({
  content: { text: 'Empregando a notação SNAME, essas funções lineares são representadas por' },
  position: { boundingRect: rect(30, 647, 279, 672), rects: lines, pageNumber: 57 },
  id: '1',
  temp: false,
});
const areaHighlight = (box = rect(25, 680, 285, 752)) => ({
  content: { imageUrl: '%LOCAL_FILE%x.png' },
  position: { boundingRect: box, rects: [], pageNumber: box.pageNumber },
  id: '2',
  temp: false,
});

describe('pickMergeTarget', () => {
  it('picks the text highlight right above the area', () => {
    const text = { remId: 't', data: textHighlight() };
    const picked = pickMergeTarget(areaHighlight(), [text]);
    assert.equal(picked?.target.remId, 't');
    assert.equal(picked?.side, 'below');
  });

  it('sees an area drawn above the text', () => {
    const text = { remId: 't', data: textHighlight() };
    assert.equal(pickMergeTarget(areaHighlight(rect(25, 580, 285, 640)), [text])?.side, 'above');
  });

  it('ignores highlights too far away, in another column, on another page, or areas', () => {
    const far = { remId: 'far', data: textHighlight([rect(45, 400, 279, 412)]) };
    const otherColumn = { remId: 'col', data: textHighlight([rect(310, 650, 560, 670)]) };
    const otherPage = { remId: 'page', data: textHighlight([rect(45, 647, 279, 672, 58)]) };
    const area = { remId: 'area', data: areaHighlight(rect(25, 600, 285, 670)) };
    assert.equal(pickMergeTarget(areaHighlight(), [far, otherColumn, otherPage, area]), undefined);
  });

  it('picks the closest of two', () => {
    const near = { remId: 'near', data: textHighlight() };
    const farther = { remId: 'farther', data: textHighlight([rect(45, 620, 279, 640)]) };
    assert.equal(pickMergeTarget(areaHighlight(), [farther, near])?.target.remId, 'near');
  });

  it('compares boxes stored at different viewport scales', () => {
    const doubled = { remId: 't', data: textHighlight([rect(90, 1294, 558, 1344, 57, W * 2, H * 2)]) };
    assert.equal(pickMergeTarget(areaHighlight(), [doubled])?.target.remId, 't');
  });
});

describe('mergeAreaIntoText', () => {
  it('adds the area box as a rect and grows the bounding rect', () => {
    const merged = mergeAreaIntoText(textHighlight(), areaHighlight());
    assert.equal(merged.position.rects.length, 3);
    assert.deepEqual(merged.position.rects[2], rect(25, 680, 285, 752));
    assert.deepEqual(merged.position.boundingRect, rect(25, 647, 285, 752));
    assert.equal(merged.content.text, textHighlight().content.text);
    assert.equal(merged.id, '1');
  });

  it('keeps the original box visible when the text highlight had no rects', () => {
    const text = textHighlight();
    text.position.rects = [];
    const merged = mergeAreaIntoText(text, areaHighlight());
    assert.deepEqual(merged.position.rects, [rect(30, 647, 279, 672), rect(25, 680, 285, 752)]);
  });

  it('converts the area into the bounding rect scale', () => {
    const text = textHighlight();
    text.position.boundingRect = rect(60, 1294, 558, 1344, 57, W * 2, H * 2);
    const merged = mergeAreaIntoText(text, areaHighlight());
    assert.deepEqual(merged.position.boundingRect, rect(50, 1294, 570, 1504, 57, W * 2, H * 2));
  });
});
