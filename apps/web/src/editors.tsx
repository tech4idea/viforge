import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/core';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { nord } from '@milkdown/theme-nord';
import { $prose, getMarkdown, replaceAll } from '@milkdown/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@milkdown/kit/prose/view';
import { Workbook } from '@fortune-sheet/react';
import type { Sheet } from '@fortune-sheet/core';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import '@milkdown/theme-nord/style.css';
import '@fortune-sheet/react/dist/index.css';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { buildAnnotatedTextSegments, normalizeMarkdownVisibleText, type LocatedDocumentAnnotation } from './document-annotations';
import { buildMarkdownRawUrl, resolveMarkdownWorkspacePath } from './markdown-workspace';

const SOURCE_ANNOTATION_PADDING_TOP_PX = 16;
const SOURCE_ANNOTATION_LINE_HEIGHT_PX = 22.3;
const TRANSIENT_SELECTION_ANNOTATION_ID = '__current-selection__';
const ANNOTATION_POPOVER_WIDTH_PX = 360;
const ANNOTATION_POPOVER_HEIGHT_PX = 320;
const ANNOTATION_POPOVER_EDGE_GAP_PX = 12;
const ANNOTATION_POPOVER_TARGET_GAP_PX = 16;
const ANNOTATION_POPOVER_CLOSE_DELAY_MS = 420;

export function MarkdownEditor({
  filePath,
  value,
  rawPreviewUrl,
  mode = 'wysiwyg',
  annotations = [],
  activeAnnotationId = null,
  onSelectAnnotation,
  onDeleteAnnotation,
  onUpdateAnnotationComment,
  onChange,
}: {
  filePath: string;
  value: string;
  rawPreviewUrl?: string;
  mode?: 'source' | 'wysiwyg';
  annotations?: LocatedDocumentAnnotation[];
  annotationState?: 'idle' | 'loading' | 'error';
  annotationError?: string | null;
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (annotationId: string) => void;
  onDeleteAnnotation?: (annotationId: string) => void;
  onUpdateAnnotationComment?: (annotationId: string, comment: string) => Promise<void> | void;
  onChange: (content: string) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverCloseTimerRef = useRef<number | null>(null);
  const [popover, setPopover] = useState<AnnotationPopoverState | null>(null);
  const popoverAnnotation = annotations.find((annotation) => annotation.id === popover?.annotationId) ?? null;

  const clearAnnotationPopoverCloseTimer = useCallback(() => {
    if (popoverCloseTimerRef.current === null) return;
    window.clearTimeout(popoverCloseTimerRef.current);
    popoverCloseTimerRef.current = null;
  }, []);

  const closeAnnotationPopover = useCallback(() => {
    clearAnnotationPopoverCloseTimer();
    setPopover(null);
  }, [clearAnnotationPopoverCloseTimer]);

  const scheduleAnnotationPopoverClose = useCallback(() => {
    clearAnnotationPopoverCloseTimer();
    popoverCloseTimerRef.current = window.setTimeout(() => {
      setPopover((current) => current?.pinned ? current : null);
      popoverCloseTimerRef.current = null;
    }, ANNOTATION_POPOVER_CLOSE_DELAY_MS);
  }, [clearAnnotationPopoverCloseTimer]);

  useEffect(() => () => clearAnnotationPopoverCloseTimer(), [clearAnnotationPopoverCloseTimer]);

  useEffect(() => {
    if (!popover?.pinned) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeAnnotationPopover();
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('.markdown-annotation-popover, [data-document-annotation-id]')) return;
      closeAnnotationPopover();
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [closeAnnotationPopover, popover?.pinned]);

  const showAnnotationPopover = useCallback((annotationId: string, rect: DOMRect, pinned = false) => {
    if (!pinned && popover?.pinned) return;
    clearAnnotationPopoverCloseTimer();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const position = calculateAnnotationPopoverPosition(rect, containerRect, window.innerWidth, window.innerHeight);
    setPopover({
      annotationId,
      pinned,
      left: position.left,
      top: position.top,
    });
    onSelectAnnotation?.(annotationId);
  }, [clearAnnotationPopoverCloseTimer, onSelectAnnotation, popover?.pinned]);

  const moveAnnotationPopover = useCallback((deltaX: number, deltaY: number) => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const containerWidth = containerRect?.width ?? window.innerWidth;
    const containerHeight = containerRect?.height ?? window.innerHeight;
    setPopover((current) => current ? {
      ...current,
      left: clampNumber(current.left + deltaX, ANNOTATION_POPOVER_EDGE_GAP_PX, Math.max(ANNOTATION_POPOVER_EDGE_GAP_PX, containerWidth - ANNOTATION_POPOVER_WIDTH_PX - ANNOTATION_POPOVER_EDGE_GAP_PX)),
      top: clampNumber(current.top + deltaY, ANNOTATION_POPOVER_EDGE_GAP_PX, Math.max(ANNOTATION_POPOVER_EDGE_GAP_PX, containerHeight - ANNOTATION_POPOVER_HEIGHT_PX - ANNOTATION_POPOVER_EDGE_GAP_PX)),
    } : current);
  }, []);

  const commonOverlay = (
    <>

      <MarkdownAnnotationPopover
        annotation={popoverAnnotation}
        top={popover?.top ?? 0}
        left={popover?.left ?? 0}
        onClose={closeAnnotationPopover}
        onDeleteAnnotation={onDeleteAnnotation}
        onUpdateAnnotationComment={onUpdateAnnotationComment}
        onKeepOpen={clearAnnotationPopoverCloseTimer}
        onRequestClose={scheduleAnnotationPopoverClose}
        onMove={moveAnnotationPopover}
        pinned={popover?.pinned ?? false}
      />
    </>
  );

  if (mode === 'source') {
    return (
      <div ref={containerRef} className="markdown-editor-viewer markdown-editor-viewer--source">
        <SourceMarkdownEditor
          value={value}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          onChange={onChange}
          onActivateAnnotation={showAnnotationPopover}
        />
        {commonOverlay}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="markdown-editor-viewer markdown-editor-viewer--wysiwyg" data-color-mode="light">
      <MilkdownProvider>
        <MilkdownEditorInner
          filePath={filePath}
          value={value}
          rawPreviewUrl={rawPreviewUrl}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          onActivateAnnotation={showAnnotationPopover}
          onChange={onChange}
        />
      </MilkdownProvider>
      {commonOverlay}
    </div>
  );
}

export type AnnotationPopoverPosition = { left: number; top: number };

type AnnotationAnchorRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;

export function calculateAnnotationPopoverPosition(
  anchorRect: AnnotationAnchorRect,
  containerRect?: AnnotationAnchorRect | null,
  viewportWidth = 0,
  viewportHeight = 0,
): AnnotationPopoverPosition {
  const containerWidth = containerRect?.width ?? viewportWidth;
  const containerHeight = containerRect?.height ?? viewportHeight;
  const containerLeft = containerRect?.left ?? 0;
  const containerTop = containerRect?.top ?? 0;
  const popoverWidth = Math.min(ANNOTATION_POPOVER_WIDTH_PX, Math.max(0, containerWidth - ANNOTATION_POPOVER_EDGE_GAP_PX * 2));
  const popoverHeight = Math.min(ANNOTATION_POPOVER_HEIGHT_PX, Math.max(0, containerHeight - ANNOTATION_POPOVER_EDGE_GAP_PX * 2));
  const anchor = {
    left: anchorRect.left - containerLeft,
    right: anchorRect.right - containerLeft,
    top: anchorRect.top - containerTop,
    bottom: anchorRect.bottom - containerTop,
  };
  const minLeft = ANNOTATION_POPOVER_EDGE_GAP_PX;
  const maxLeft = Math.max(minLeft, containerWidth - popoverWidth - ANNOTATION_POPOVER_EDGE_GAP_PX);
  const minTop = ANNOTATION_POPOVER_EDGE_GAP_PX;
  const maxTop = Math.max(minTop, containerHeight - popoverHeight - ANNOTATION_POPOVER_EDGE_GAP_PX);
  const rightLeft = anchor.right + ANNOTATION_POPOVER_TARGET_GAP_PX;
  const leftLeft = anchor.left - popoverWidth - ANNOTATION_POPOVER_TARGET_GAP_PX;
  const left = rightLeft + popoverWidth <= containerWidth - ANNOTATION_POPOVER_EDGE_GAP_PX
    ? rightLeft
    : leftLeft >= ANNOTATION_POPOVER_EDGE_GAP_PX
      ? leftLeft
      : clampNumber(rightLeft, minLeft, maxLeft);
  let top = clampNumber(anchor.top - 8, minTop, maxTop);

  if (rectsOverlap({ left, top, right: left + popoverWidth, bottom: top + popoverHeight }, anchor)) {
    const belowTop = anchor.bottom + ANNOTATION_POPOVER_TARGET_GAP_PX;
    const aboveTop = anchor.top - popoverHeight - ANNOTATION_POPOVER_TARGET_GAP_PX;
    if (belowTop + popoverHeight <= containerHeight - ANNOTATION_POPOVER_EDGE_GAP_PX) {
      top = belowTop;
    } else if (aboveTop >= ANNOTATION_POPOVER_EDGE_GAP_PX) {
      top = aboveTop;
    } else {
      top = anchor.top < containerHeight / 2 ? belowTop : aboveTop;
    }
  }

  return { left, top };
}

function rectsOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
type AnnotationPopoverState = {
  annotationId: string;
  left: number;
  top: number;
  pinned: boolean;
};

function SourceMarkdownEditor({
  value,
  annotations,
  activeAnnotationId,
  onChange,
  onActivateAnnotation,
}: {
  value: string;
  annotations: LocatedDocumentAnnotation[];
  activeAnnotationId?: string | null;
  onChange: (content: string) => void;
  onActivateAnnotation: (annotationId: string, rect: DOMRect, pinned?: boolean) => void;
}): JSX.Element {
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const segments = useMemo(() => buildAnnotatedTextSegments(value, annotations), [annotations, value]);
  const annotationsById = useMemo(() => new Map(annotations.map((annotation) => [annotation.id, annotation])), [annotations]);
  const lineMarkers = useMemo(() => annotations.filter(shouldRenderAnnotationLineMarker), [annotations]);

  return (
    <div className="markdown-source-annotation-shell">
      <pre
        className="markdown-source-annotation-layer"
        aria-hidden="true"
        style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
      >
        {segments.map((segment) => {
          if (segment.annotationIds.length === 0) return <span key={segment.key}>{segment.text}</span>;
          const annotationId = segment.annotationIds[0];
          const transient = isTransientSelectionAnnotation(annotationId);
          return (
            <mark
              key={segment.key}
              {...(transient ? {} : { id: 'annotation-highlight-' + annotationId, 'data-document-annotation-id': annotationId })}
              className={annotationHighlightClass(segment.status ?? 'open', activeAnnotationId === annotationId, transient)}
              title={annotationsById.get(annotationId)?.comment}
              onDoubleClick={transient ? undefined : (event) => onActivateAnnotation(annotationId, event.currentTarget.getBoundingClientRect(), true)}
            >{segment.text}</mark>
          );
        })}
      </pre>
      <div
        className="markdown-source-annotation-marker-layer"
        style={{ transform: `translateY(${-scroll.top}px)` }}
      >
        {lineMarkers.map((annotation) => (
          <button
            key={annotation.id}
            id={'annotation-highlight-' + annotation.id}
            type="button"
            data-document-annotation-id={annotation.id}
            className={annotationLineMarkerClass(annotation.effectiveStatus, activeAnnotationId === annotation.id)}
            style={{ top: sourceAnnotationLineTop(annotation, value) }}
            title={annotation.comment}
            onDoubleClick={(event) => onActivateAnnotation(annotation.id, event.currentTarget.getBoundingClientRect(), true)}
          >批注</button>
        ))}
      </div>
      <textarea
        className="markdown-source-editor"
        value={value}
        onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function MilkdownEditorInner({
  filePath,
  value,
  rawPreviewUrl,
  annotations,
  activeAnnotationId,
  onActivateAnnotation,
  onChange,
}: {
  filePath: string;
  value: string;
  rawPreviewUrl?: string;
  annotations: LocatedDocumentAnnotation[];
  activeAnnotationId?: string | null;
  onActivateAnnotation: (annotationId: string, rect: DOMRect, pinned?: boolean) => void;
  onChange: (content: string) => void;
}): JSX.Element {
  const latestOnChange = useRef(onChange);
  const lastSyncedValue = useRef(value);
  const skipNextMarkdownUpdate = useRef(false);
  latestOnChange.current = onChange;

  const editor = useEditor((root) =>
    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, value);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { class: 'milkdown-editor', spellcheck: 'false' },
        }));
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          lastSyncedValue.current = md;
          if (skipNextMarkdownUpdate.current) {
            skipNextMarkdownUpdate.current = false;
            return;
          }
          latestOnChange.current(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(markdownWorkspaceImageView(filePath, rawPreviewUrl))
      .use(markdownAnnotationPlugin(value, annotations, activeAnnotationId, onActivateAnnotation))
      .use(listener), [filePath, rawPreviewUrl, annotations, activeAnnotationId, onActivateAnnotation]);

  useEffect(() => {
    const instance = editor.get();
    if (!instance) {
      lastSyncedValue.current = value;
      return;
    }
    if (value === lastSyncedValue.current) return;

    const currentMarkdown = instance.action(getMarkdown());
    if (currentMarkdown === value) {
      lastSyncedValue.current = value;
      return;
    }

    skipNextMarkdownUpdate.current = true;
    lastSyncedValue.current = value;
    instance.action(replaceAll(value, true));
  }, [editor, value]);

  return (
    <div className="markdown-rich-scroll">
      <Milkdown />
    </div>
  );
}

function markdownAnnotationPlugin(
  sourceMarkdown: string,
  annotations: LocatedDocumentAnnotation[],
  activeAnnotationId: string | null | undefined,
  onActivateAnnotation: (annotationId: string, rect: DOMRect, pinned?: boolean) => void,
) {
  return $prose(() => new Plugin({
    props: {
      decorations(state) {
        return DecorationSet.create(state.doc, buildMarkdownAnnotationDecorations(state.doc, sourceMarkdown, annotations, activeAnnotationId));
      },
      handleDOMEvents: {
        dblclick: (_, event) => {
          const element = annotationElementFromEvent(event);
          if (!element) return false;
          onActivateAnnotation(element.dataset.documentAnnotationId ?? '', element.getBoundingClientRect(), true);
          return false;
        },
      },
    },
  }));
}

function buildMarkdownAnnotationDecorations(
  doc: ProseMirrorNode,
  sourceMarkdown: string,
  annotations: LocatedDocumentAnnotation[],
  activeAnnotationId: string | null | undefined,
) {
  const chunks: RenderedTextChunk[] = [];
  let flatText = '';
  let previousTextEndPosition: number | null = null;
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return true;
    if (previousTextEndPosition !== null && position > previousTextEndPosition && flatText && !/\s$/.test(flatText)) {
      flatText += '\n';
    }
    chunks.push({ from: position, flatStart: flatText.length, flatEnd: flatText.length + node.text.length, text: node.text });
    flatText += node.text;
    previousTextEndPosition = position + node.text.length;
    return true;
  });

  const decorations = annotations.flatMap((annotation) => {
    if (!shouldRenderAnnotationLineMarker(annotation) && annotation.selectedText) {
      const range = findRenderedAnnotationRange(flatText, chunks, annotation);
      if (range) {
        return [Decoration.inline(range.from, range.to, annotationDecorationAttrs(annotation, annotation.id === activeAnnotationId))];
      }
    }

    const position = findRenderedLineMarkerPosition(sourceMarkdown, flatText, chunks, annotation) ?? 1;
    return [Decoration.widget(position, () => createAnnotationLineMarkerElement(annotation, annotation.id === activeAnnotationId), {
      key: 'annotation-line-marker-' + annotation.id,
      side: -1,
    })];
  });
  return decorations;
}

function shouldRenderAnnotationLineMarker(annotation: LocatedDocumentAnnotation): boolean {
  return annotation.effectiveStatus === 'stale' || annotation.currentStartOffset === null || annotation.currentEndOffset === null;
}

function sourceAnnotationLineTop(annotation: LocatedDocumentAnnotation, content: string): string {
  const line = sourceAnnotationAnchorLine(annotation, content);
  return `${SOURCE_ANNOTATION_PADDING_TOP_PX + (line - 1) * SOURCE_ANNOTATION_LINE_HEIGHT_PX}px`;
}

function sourceAnnotationAnchorLine(annotation: LocatedDocumentAnnotation, content: string): number {
  const totalLines = Math.max(1, content.split('\n').length);
  const preferredLine = annotation.currentStartLine ?? annotation.startLine;
  return clampNumber(preferredLine, 1, totalLines);
}
function annotationLineMarkerClass(status: LocatedDocumentAnnotation['effectiveStatus'], active: boolean): string {
  return `annotation-line-marker annotation-line-marker--${status}${active ? ' annotation-line-marker--active' : ''}`;
}

function createAnnotationLineMarkerElement(annotation: LocatedDocumentAnnotation, active: boolean): HTMLElement {
  const marker = document.createElement('span');
  if (!isTransientSelectionAnnotation(annotation.id)) {
    marker.id = 'annotation-highlight-' + annotation.id;
    marker.dataset.documentAnnotationId = annotation.id;
  }
  marker.className = annotationLineMarkerClass(annotation.effectiveStatus, active);
  marker.title = annotation.comment;
  marker.contentEditable = 'false';
  marker.textContent = '批注';
  return marker;
}

function findRenderedLineMarkerPosition(
  sourceMarkdown: string,
  flatText: string,
  chunks: Array<{ from: number; flatStart: number; flatEnd: number; text: string }>,
  annotation: LocatedDocumentAnnotation,
): number | null {
  if (chunks.length === 0) return 1;
  const sourceOffset = sourceLineStartOffset(sourceMarkdown, annotation.currentStartLine ?? annotation.startLine);
  const ratio = sourceMarkdown.length > 0 ? sourceOffset / sourceMarkdown.length : 0;
  const flatOffset = Math.max(0, Math.min(flatText.length, Math.round(flatText.length * ratio)));
  return renderedOffsetToDocPosition(chunks, flatOffset) ?? chunks[0].from;
}
function isTransientSelectionAnnotation(annotationId: string): boolean {
  return annotationId === TRANSIENT_SELECTION_ANNOTATION_ID;
}

function annotationDecorationAttrs(annotation: LocatedDocumentAnnotation, active: boolean): Record<string, string> {
  const transient = isTransientSelectionAnnotation(annotation.id);
  const attrs: Record<string, string> = {
    class: annotationHighlightClass(annotation.effectiveStatus, active, transient),
    title: annotation.comment,
  };
  if (!transient) {
    attrs.id = 'annotation-highlight-' + annotation.id;
    attrs['data-document-annotation-id'] = annotation.id;
  }
  return attrs;
}

type RenderedTextChunk = { from: number; flatStart: number; flatEnd: number; text: string };

function findRenderedAnnotationRange(
  flatText: string,
  chunks: RenderedTextChunk[],
  annotation: LocatedDocumentAnnotation,
): { from: number; to: number } | null {
  const visibleSelectedText = normalizeMarkdownVisibleText(annotation.selectedText);
  const directMatches = findAllTextOffsets(flatText, visibleSelectedText || annotation.selectedText);
  const normalizedMatches = directMatches.length > 0 ? [] : findNormalizedTextOffsets(flatText, annotation.selectedText);
  const matches = directMatches.length > 0 ? directMatches : normalizedMatches;
  if (matches.length === 0) return null;

  const match = matches.length === 1
    ? matches[0]
    : matches
        .map((range) => ({ range, score: renderedContextScore(flatText, range, annotation) }))
        .sort((left, right) => right.score - left.score)[0].range;
  const from = renderedOffsetToDocPosition(chunks, match.start, 1);
  const to = renderedOffsetToDocPosition(chunks, match.end, -1);
  return from !== null && to !== null && from < to ? { from, to } : null;
}

function renderedContextScore(flatText: string, range: { start: number; end: number }, annotation: LocatedDocumentAnnotation): number {
  const { start, end } = range;
  let score = 0;
  const before = normalizeMarkdownVisibleText(annotation.beforeText);
  const after = normalizeMarkdownVisibleText(annotation.afterText);
  const flatBefore = compactText(flatText.slice(Math.max(0, start - before.length - 40), start));
  const flatAfter = compactText(flatText.slice(end, Math.min(flatText.length, end + after.length + 40)));
  if (before && flatBefore.endsWith(before.slice(-Math.min(before.length, 40)))) score += 2;
  if (after && flatAfter.startsWith(after.slice(0, Math.min(after.length, 40)))) score += 2;
  return score;
}

function renderedOffsetToDocPosition(
  chunks: RenderedTextChunk[],
  offset: number,
  bias: -1 | 1 = 1,
): number | null {
  const chunk = chunks.find((item) => offset >= item.flatStart && offset <= item.flatEnd);
  if (!chunk) {
    const fallback = bias < 0
      ? [...chunks].reverse().find((item) => item.flatEnd < offset)
      : chunks.find((item) => item.flatStart > offset);
    if (!fallback) return null;
    return bias < 0 ? fallback.from + fallback.text.length : fallback.from;
  }
  return chunk.from + Math.min(offset - chunk.flatStart, chunk.text.length);
}

function findAllTextOffsets(content: string, needle: string): Array<{ start: number; end: number }> {
  const offsets: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) break;
    offsets.push({ start: index, end: index + needle.length });
    cursor = index + Math.max(needle.length, 1);
  }
  return offsets;
}

function findNormalizedTextOffsets(content: string, needle: string): Array<{ start: number; end: number }> {
  const normalizedContent = normalizeTextWithOffsetMap(content);
  const normalizedNeedle = normalizeMarkdownVisibleText(needle);
  if (!normalizedNeedle) return [];
  return findAllTextOffsets(normalizedContent.text, normalizedNeedle)
    .map((match) => {
      const start = normalizedContent.offsetMap[match.start];
      const endBase = normalizedContent.offsetMap[match.end - 1];
      return typeof start === 'number' && typeof endBase === 'number'
        ? { start, end: endBase + 1 }
        : null;
    })
    .filter((match): match is { start: number; end: number } => Boolean(match));
}
function annotationElementFromEvent(event: Event): HTMLElement | null {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const element = target?.closest<HTMLElement>('[data-document-annotation-id]') ?? null;
  return element?.dataset.documentAnnotationId ? element : null;
}

function MarkdownAnnotationPopover({
  annotation,
  top,
  left,
  onClose,
  onDeleteAnnotation,
  onUpdateAnnotationComment,
  onKeepOpen,
  onRequestClose,
  onMove,
  pinned,
}: {
  annotation: LocatedDocumentAnnotation | null;
  top: number;
  left: number;
  onClose: () => void;
  onDeleteAnnotation?: (annotationId: string) => void;
  onUpdateAnnotationComment?: (annotationId: string, comment: string) => Promise<void> | void;
  onKeepOpen: () => void;
  onRequestClose: () => void;
  onMove: (deltaX: number, deltaY: number) => void;
  pinned: boolean;
}): JSX.Element | null {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dragLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(annotation?.comment ?? '');
    setEditing(false);
    setSaving(false);
    setError(null);
  }, [annotation?.id, annotation?.comment]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.select();
    });
  }, [editing]);

  if (!annotation) return null;

  const save = async () => {
    const nextComment = draft.trim();
    if (!nextComment || !onUpdateAnnotationComment) return;
    setSaving(true);
    setError(null);
    try {
      await onUpdateAnnotationComment(annotation.id, nextComment);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '批注保存失败');
    } finally {
      setSaving(false);
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pinned || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onKeepOpen();
    dragLastPointRef.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const lastPoint = dragLastPointRef.current;
    if (!lastPoint) return;
    event.preventDefault();
    event.stopPropagation();
    onMove(event.clientX - lastPoint.x, event.clientY - lastPoint.y);
    dragLastPointRef.current = { x: event.clientX, y: event.clientY };
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragLastPointRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragLastPointRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className={`markdown-annotation-popover${pinned ? ' is-pinned' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ top, left }}
      onMouseEnter={onKeepOpen}
      onMouseLeave={() => {
        if (!pinned && !editing && !dragLastPointRef.current) onRequestClose();
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" className="markdown-annotation-popover__close" onClick={onClose} aria-label="关闭批注">×</button>
      <div
        className="markdown-annotation-popover__meta markdown-annotation-popover__drag-handle"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >{formatAnnotationLine(annotation)} · {statusLabel(annotation.effectiveStatus)}</div>
      {editing ? (
        <textarea
          ref={editorRef}
          className="annotation-comment-textarea markdown-annotation-popover__editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(annotation.comment);
              setEditing(false);
              return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void save();
            }
          }}
        />
      ) : (
        <div className="markdown-annotation-popover__comment">{annotation.comment}</div>
      )}
      {error ? <p className="markdown-annotation-popover__error">{error}</p> : null}
      {pinned ? (
        <div className="markdown-annotation-popover__actions">
          {editing ? (
            <>
              <button type="button" className="button-ghost" disabled={saving} onClick={() => { setDraft(annotation.comment); setEditing(false); }}>取消</button>
              <button type="button" disabled={saving || !draft.trim()} onClick={() => void save()}>保存</button>
            </>
          ) : (
            <>
              {onUpdateAnnotationComment ? <button type="button" className="button-ghost" onClick={() => setEditing(true)}>修改</button> : null}
              <button type="button" className="button-ghost button-danger" onClick={() => onDeleteAnnotation?.(annotation.id)}>删除</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MarkdownAnnotationSummary({
  annotations,
  annotationState,
  annotationError,
  activeAnnotationId,
  onSelectAnnotation,
  onDeleteAnnotation,
}: {
  annotations: LocatedDocumentAnnotation[];
  annotationState: 'idle' | 'loading' | 'error';
  annotationError: string | null;
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (annotationId: string) => void;
  onDeleteAnnotation?: (annotationId: string) => void;
}): JSX.Element | null {
  if (annotations.length === 0 && annotationState === 'idle' && !annotationError) return null;
  const openCount = annotations.filter((annotation) => annotation.status === 'open').length;
  const staleCount = annotations.filter((annotation) => annotation.effectiveStatus === 'stale').length;

  return (
    <details className="markdown-annotation-summary">
      <summary>
        <span>批注 {annotations.length}</span>
        <small>{annotationState === 'loading' ? '读取中' : `${openCount} 待处理${staleCount ? ` / ${staleCount} 失效` : ''}`}</small>
      </summary>
      {annotationError ? <p className="markdown-annotation-summary__error">批注读取失败：{annotationError}</p> : null}
      {annotations.length > 0 ? (
        <div className="markdown-annotation-summary__list">
          {annotations.map((annotation) => (
            <article key={annotation.id} className={`markdown-annotation-summary__item${annotation.id === activeAnnotationId ? ' is-active' : ''}`}>
              <button type="button" onClick={() => onSelectAnnotation?.(annotation.id)}>
                <span>{formatAnnotationLine(annotation)} · {statusLabel(annotation.effectiveStatus)}</span>
                <strong>{annotation.comment}</strong>
              </button>
              <div>
                <button type="button" className="button-ghost button-danger" onClick={() => onDeleteAnnotation?.(annotation.id)}>删除</button>
              </div>
            </article>
          ))}

        </div>
      ) : null}
    </details>
  );
}

function annotationHighlightClass(status: LocatedDocumentAnnotation['effectiveStatus'], active: boolean, transient = false): string {
  return `annotation-highlight annotation-highlight--${status}${transient ? ' annotation-highlight--transient' : ''}${active ? ' annotation-highlight--active' : ''}`;
}

function formatAnnotationLine(annotation: LocatedDocumentAnnotation): string {
  const start = annotation.currentStartLine ?? annotation.startLine;
  const end = annotation.currentEndLine ?? annotation.endLine;
  return start === end ? `第 ${start} 行` : `第 ${start}-${end} 行`;
}

function statusLabel(status: LocatedDocumentAnnotation['effectiveStatus']): string {
  if (status === 'resolved') return '已归档';
  if (status === 'stale') return '位置待确认';
  return '待处理';
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeTextWithOffsetMap(value: string): { text: string; offsetMap: number[] } {
  let text = '';
  const offsetMap: number[] = [];
  let pendingWhitespaceOffset: number | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      if (text && !text.endsWith(' ') && pendingWhitespaceOffset === null) pendingWhitespaceOffset = index;
      continue;
    }
    if (pendingWhitespaceOffset !== null) {
      text += ' ';
      offsetMap.push(pendingWhitespaceOffset);
      pendingWhitespaceOffset = null;
    }
    text += char;
    offsetMap.push(index);
  }

  const trimmedLength = text.trimEnd().length;
  return { text: text.slice(0, trimmedLength), offsetMap: offsetMap.slice(0, trimmedLength) };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function sourceLineStartOffset(content: string, lineNumber: number): number {
  const targetLine = Math.max(1, lineNumber);
  if (targetLine === 1) return 0;
  let line = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue;
    line += 1;
    if (line === targetLine) return index + 1;
  }
  return content.length;
}
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function markdownWorkspaceImageView(filePath: string, rawPreviewUrl?: string) {
  return $prose(() => new Plugin({
    props: {
      nodeViews: {
        image: (node, view, getPos) => new WorkspaceImageNodeView(node, view, getPos, filePath, rawPreviewUrl),
      },
    },
  }));
}

class WorkspaceImageNodeView implements NodeView {
  dom: HTMLElement;
  private image: HTMLImageElement;
  private input: HTMLInputElement;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: (() => number | undefined) | boolean,
    private readonly filePath: string,
    private readonly rawPreviewUrl?: string,
  ) {
    this.node = node;
    this.dom = document.createElement('figure');
    this.dom.className = 'markdown-image-node-view';
    this.dom.contentEditable = 'false';

    this.image = document.createElement('img');
    this.image.draggable = false;
    this.image.addEventListener('click', () => {
      this.input.focus();
      this.input.select();
    });

    this.input = document.createElement('input');
    this.input.className = 'markdown-image-node-view__src';
    this.input.type = 'text';
    this.input.setAttribute('aria-label', 'Markdown 图片路径');
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitSrc();
        this.view.focus();
      }
      if (event.key === 'Escape') {
        this.input.value = this.rawSrc();
        this.view.focus();
      }
    });
    this.input.addEventListener('blur', () => this.commitSrc());

    this.dom.append(this.image, this.input);
    this.syncDom();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncDom();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.input;
  }

  ignoreMutation(): boolean {
    return true;
  }

  private syncDom(): void {
    const src = this.rawSrc();
    this.image.src = this.displaySrc(src);
    this.image.alt = typeof this.node.attrs.alt === 'string' ? this.node.attrs.alt : '';
    this.image.title = src;
    if (document.activeElement !== this.input) this.input.value = src;
  }

  private rawSrc(): string {
    return typeof this.node.attrs.src === 'string' ? this.node.attrs.src : '';
  }

  private displaySrc(src: string): string {
    const targetPath = resolveMarkdownWorkspacePath(this.filePath, src);
    return targetPath && this.rawPreviewUrl
      ? buildMarkdownRawUrl(this.rawPreviewUrl, this.filePath, targetPath)
      : src;
  }

  private commitSrc(): void {
    if (typeof this.getPos !== 'function') return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const nextSrc = this.input.value.trim();
    if (!nextSrc || nextSrc === this.rawSrc()) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      src: nextSrc,
    }));
  }
}

export function SheetEditor({
  filePath,
  content,
  onChange,
}: {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const data = useMemo(() => parseSheetContent(filePath, content), [content, filePath]);

  return (
    <div className="sheet-editor-viewer">
      <Workbook
        data={data}
        onChange={(next) => onChange(serializeSheet(next))}
        allowEdit={true}
        showToolbar={true}
        showFormulaBar={true}
        showSheetTabs={true}
      />
    </div>
  );
}

export function CodeEditor({
  content,
  filePath,
  onChange,
}: {
  content: string;
  filePath: string;
  onChange: (content: string) => void;
}): JSX.Element {
  const language = detectLanguage(filePath);
  const [highlighted, setHighlighted] = useState(
    () => hljs.highlight(content || '', { language, ignoreIllegals: true }).value,
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setHighlighted(hljs.highlight(content || '', { language, ignoreIllegals: true }).value);
    }, 150);
    return () => clearTimeout(timer);
  }, [content, language]);

  return (
    <div className="code-editor-viewer">
      <textarea value={content} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      <pre className="code-editor-preview">
        <span className="code-preview-label">{language.toUpperCase()}</span>
        <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    toml: 'toml',
    css: 'css',
    html: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    txt: 'plaintext',
    pug: 'haml',
  };
  return map[ext] ?? 'plaintext';
}

function parseSheetContent(filePath: string, content: string): Sheet[] {
  if (/\.csv$/i.test(filePath)) {
    const rows = content.split('\n').map((line) => line.split(','));
    return [{
      id: 'sheet-1',
      name: 'Sheet1',
      celldata: rows.flatMap((cells, row) =>
        cells.map((value, column) => ({
          r: row,
          c: column,
          v: { v: value, m: value, ct: { fa: 'General', t: 'g' } },
        })),
      ),
      order: 0,
      status: 1,
      row: rows.length,
      column: Math.max(...rows.map((row) => row.length), 1),
    } as unknown as Sheet];
  }

  try {
    return JSON.parse(content) as Sheet[];
  } catch {
    return [{
      id: 'sheet-1',
      name: 'Sheet1',
      celldata: [],
      order: 0,
      status: 1,
      row: 20,
      column: 8,
    } as unknown as Sheet];
  }
}

function serializeSheet(sheets: Sheet[]): string {
  return JSON.stringify(sheets);
}
