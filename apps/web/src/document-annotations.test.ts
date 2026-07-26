import { describe, expect, it } from 'vitest';

import { createAnnotationDraftFromSelectedText, locateAnnotations, normalizeMarkdownVisibleText } from './document-annotations';
import type { DocumentAnnotation } from './api';

describe('document annotation anchors', () => {
  it('creates line, offset, context, and hash anchors from selected text', () => {
    const content = '第一行\n她推开门，发现房间里一片安静。\n第三行';

    const draft = createAnnotationDraftFromSelectedText(content, '她推开门，发现房间里一片安静。');

    expect(draft).toMatchObject({
      selectedText: '她推开门，发现房间里一片安静。',
      startLine: 2,
      endLine: 2,
      startOffset: 4,
      beforeText: '第一行\n',
      afterText: '\n第三行',
    });
    expect(draft?.fileContentHash).toMatch(/^fnv1a-/);
  });

  it('creates anchors from rendered body text when Markdown spacing differs', () => {
    const content = '## 小标题\n\n第一句正文，\n第二句正文。';

    const draft = createAnnotationDraftFromSelectedText(content, '第一句正文， 第二句正文。');

    expect(draft).toMatchObject({
      selectedText: '第一句正文，\n第二句正文。',
      startLine: 3,
      endLine: 4,
    });
  });
  it('creates anchors from rendered multi-paragraph selections', () => {
    const content = '第一段。\n\n第二段。\n\n第三段。';

    const draft = createAnnotationDraftFromSelectedText(content, '第一段。 第二段。');

    expect(draft).toMatchObject({
      selectedText: '第一段。\n\n第二段。',
      startLine: 1,
      endLine: 3,
      startOffset: 0,
      endOffset: 10,
    });
  });

  it('treats stale annotations as active again when the text is locatable', () => {
    const [located] = locateAnnotations('## 2. 关于焦虑本身\n\n正文', [annotationFixture({
      selectedText: '关于焦虑本身',
      startOffset: 6,
      endOffset: 11,
      status: 'stale',
    })]);

    expect(located.effectiveStatus).toBe('open');
    expect(located.currentStartOffset).toBe(6);
  });

  it('normalizes Markdown source selections to rendered visible text', () => {
    expect(normalizeMarkdownVisibleText('第一条\n- 第二条\n> 第三条')).toBe('第一条 第二条 第三条');
  });
  it('creates anchors from rendered multi-line list selections', () => {
    const content = '- 第一条\n- 第二条\n- 第三条';

    const draft = createAnnotationDraftFromSelectedText(content, '第一条\n第二条');

    expect(draft).toMatchObject({
      selectedText: '第一条\n- 第二条',
      startLine: 1,
      endLine: 2,
      startOffset: 2,
      endOffset: 11,
    });
  });
  it('creates anchors for multi-line source selections', () => {
    const content = '第一行\n第二行正文\n第三行正文\n第四行';

    const draft = createAnnotationDraftFromSelectedText(content, '第二行正文\n第三行正文');

    expect(draft).toMatchObject({
      selectedText: '第二行正文\n第三行正文',
      startLine: 2,
      endLine: 3,
      startOffset: 4,
      endOffset: 15,
    });
  });
  it('relocates annotations when text moves with context', () => {
    const annotation = annotationFixture({
      selectedText: '重复文本',
      startOffset: 20,
      endOffset: 24,
      beforeText: '目标前',
      afterText: '目标后',
    });
    const content = '重复文本\n目标前重复文本目标后\n重复文本';

    const [located] = locateAnnotations(content, [annotation]);

    expect(located.effectiveStatus).toBe('open');
    expect(located.currentStartOffset).toBe(content.indexOf('目标前') + '目标前'.length);
  });

  it('marks annotations stale when selected text cannot be found', () => {
    const [located] = locateAnnotations('完全不同的正文', [annotationFixture({ selectedText: '旧文本' })]);

    expect(located.effectiveStatus).toBe('stale');
    expect(located.currentStartOffset).toBeNull();
  });
});

function annotationFixture(input: Partial<DocumentAnnotation>): DocumentAnnotation {
  return {
    id: 'anno-1',
    filePath: '剧本.md',
    selectedText: '选中文本',
    startLine: 1,
    endLine: 1,
    startOffset: 0,
    endOffset: 4,
    beforeText: '',
    afterText: '',
    fileContentHash: 'fnv1a-test',
    comment: '修改',
    status: 'open',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...input,
  };
}
