import type { DocumentAnnotation, DocumentAnnotationStatus } from './api';

export type CreateDocumentAnnotationDraft = {
  selectedText: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  beforeText: string;
  afterText: string;
  fileContentHash: string;
};

export type LocatedDocumentAnnotation = DocumentAnnotation & {
  effectiveStatus: DocumentAnnotationStatus;
  currentStartOffset: number | null;
  currentEndOffset: number | null;
  currentStartLine: number | null;
  currentEndLine: number | null;
};

export type AnnotatedTextSegment = {
  key: string;
  text: string;
  annotationIds: string[];
  status?: DocumentAnnotationStatus;
};

const CONTEXT_CHARS = 80;

export function createAnnotationDraftFromOffsets(content: string, startOffset: number, endOffset: number): CreateDocumentAnnotationDraft | null {
  const start = Math.max(0, Math.min(startOffset, endOffset, content.length));
  const end = Math.max(0, Math.min(Math.max(startOffset, endOffset), content.length));
  const selectedText = content.slice(start, end);
  if (!selectedText.trim()) return null;
  return buildDraft(content, start, end, selectedText);
}

export function createAnnotationDraftFromSelectedText(content: string, selectedText: string): CreateDocumentAnnotationDraft | null {
  const selection = selectedText.trim();
  if (!selection) return null;
  const start = content.indexOf(selection);
  if (start >= 0) return buildDraft(content, start, start + selection.length, selection);
  return createAnnotationDraftFromApproximateSelectedText(content, selection);
}

export function normalizeMarkdownVisibleText(value: string): string {
  return normalizeMarkdownVisibleTextWithOffsetMap(value).text;
}
export function createAnnotationDraftFromApproximateSelectedText(content: string, selectedText: string): CreateDocumentAnnotationDraft | null {
  const target = compactVisibleText(selectedText);
  if (!target) return null;

  const normalizedContent = normalizeMarkdownVisibleTextWithOffsetMap(content);
  const matches = findAllNormalizedRanges(normalizedContent.text, target)
    .map((match) => {
      const start = normalizedContent.offsetMap[match.start];
      const endBase = normalizedContent.offsetMap[match.end - 1];
      return typeof start === 'number' && typeof endBase === 'number'
        ? { start, end: endBase + 1 }
        : null;
    })
    .filter((match): match is { start: number; end: number } => Boolean(match));

  if (matches.length !== 1) return null;
  const match = matches[0];
  return buildDraft(content, match.start, match.end, content.slice(match.start, match.end));
}
export function locateAnnotations(content: string, annotations: DocumentAnnotation[]): LocatedDocumentAnnotation[] {
  return annotations.map((annotation) => {
    const located = locateAnnotation(content, annotation);
    return {
      ...annotation,
      effectiveStatus: located ? annotation.status === 'stale' ? 'open' : annotation.status : 'stale',
      currentStartOffset: located?.start ?? null,
      currentEndOffset: located?.end ?? null,
      currentStartLine: located ? lineNumberAtOffset(content, located.start) : null,
      currentEndLine: located ? lineNumberAtOffset(content, located.end) : null,
    };
  });
}

export function buildAnnotatedTextSegments(content: string, annotations: LocatedDocumentAnnotation[]): AnnotatedTextSegment[] {
  const ranges = annotations
    .filter((annotation) => annotation.effectiveStatus !== 'stale' && annotation.currentStartOffset !== null && annotation.currentEndOffset !== null)
    .map((annotation) => ({
      id: annotation.id,
      status: annotation.effectiveStatus,
      start: annotation.currentStartOffset!,
      end: annotation.currentEndOffset!,
    }))
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: AnnotatedTextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      segments.push({ key: `plain-${cursor}-${range.start}`, text: content.slice(cursor, range.start), annotationIds: [] });
    }
    segments.push({ key: `annotation-${range.id}`, text: content.slice(range.start, range.end), annotationIds: [range.id], status: range.status });
    cursor = range.end;
  }
  if (cursor < content.length) {
    segments.push({ key: `plain-${cursor}-${content.length}`, text: content.slice(cursor), annotationIds: [] });
  }
  return segments.length > 0 ? segments : [{ key: 'plain-0', text: content, annotationIds: [] }];
}

export function hashDocumentContent(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function buildDraft(content: string, start: number, end: number, selectedText: string): CreateDocumentAnnotationDraft {
  return {
    selectedText,
    startLine: lineNumberAtOffset(content, start),
    endLine: lineNumberAtOffset(content, end),
    startOffset: start,
    endOffset: end,
    beforeText: content.slice(Math.max(0, start - CONTEXT_CHARS), start),
    afterText: content.slice(end, Math.min(content.length, end + CONTEXT_CHARS)),
    fileContentHash: hashDocumentContent(content),
  };
}

function locateAnnotation(content: string, annotation: DocumentAnnotation): { start: number; end: number } | null {
  if (!annotation.selectedText) return null;
  if (content.slice(annotation.startOffset, annotation.endOffset) === annotation.selectedText) {
    return { start: annotation.startOffset, end: annotation.endOffset };
  }

  const matches = findAll(content, annotation.selectedText);
  if (matches.length === 0) return null;
  if (matches.length === 1) return { start: matches[0], end: matches[0] + annotation.selectedText.length };

  const scored = matches
    .map((start) => ({ start, score: contextScore(content, start, annotation) }))
    .sort((left, right) => right.score - left.score || Math.abs(left.start - annotation.startOffset) - Math.abs(right.start - annotation.startOffset));

  if (scored[0].score <= 0) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return { start: scored[0].start, end: scored[0].start + annotation.selectedText.length };
}

function contextScore(content: string, start: number, annotation: DocumentAnnotation): number {
  const end = start + annotation.selectedText.length;
  let score = 0;
  if (annotation.beforeText && content.slice(Math.max(0, start - annotation.beforeText.length), start) === annotation.beforeText) score += 2;
  if (annotation.afterText && content.slice(end, end + annotation.afterText.length) === annotation.afterText) score += 2;
  score += Math.max(0, 1 - Math.abs(start - annotation.startOffset) / Math.max(content.length, 1));
  return score;
}

function findAll(content: string, needle: string): number[] {
  const matches: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    matches.push(index);
    offset = index + Math.max(needle.length, 1);
  }
  return matches;
}

function compactVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdownVisibleTextWithOffsetMap(content: string): { text: string; offsetMap: number[] } {
  let text = '';
  const offsetMap: number[] = [];
  let index = 0;
  let atLineStart = true;

  while (index < content.length) {
    if (atLineStart) {
      const skipped = markdownLinePrefixLength(content, index);
      if (skipped > 0) {
        index += skipped;
        atLineStart = false;
        continue;
      }
    }

    const char = content[index];
    if (/\s/.test(char)) {
      if (text && !text.endsWith(' ')) {
        text += ' ';
        offsetMap.push(index);
      }
      atLineStart = char === '\n' || char === '\r';
      index += 1;
      continue;
    }

    text += char;
    offsetMap.push(index);
    atLineStart = false;
    index += 1;
  }

  const trimmedLength = text.trimEnd().length;
  return { text: text.slice(0, trimmedLength), offsetMap: offsetMap.slice(0, trimmedLength) };
}

function markdownLinePrefixLength(content: string, lineStart: number): number {
  const lineEnd = content.indexOf('\n', lineStart);
  const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
  const match = /^(\s*)(?:(?:#{1,6}|>{1,6})\s+|(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?)/.exec(line);
  return match ? match[0].length : 0;
}

function findAllNormalizedRanges(content: string, needle: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    matches.push({ start: index, end: index + needle.length });
    offset = index + Math.max(needle.length, 1);
  }
  return matches;
}
function lineNumberAtOffset(content: string, offset: number): number {
  const clipped = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  for (let index = 0; index < clipped; index += 1) {
    if (content[index] === '\n') line += 1;
  }
  return line;
}
