import { randomUUID } from 'node:crypto';

import type {
  DocumentAnnotation,
  DocumentAnnotationFile,
  DocumentAnnotationStatus,
  DocumentAnnotationSummary,
} from '@viforge/shared';

import type { WorkspaceStore } from './workspaceStore';

export type CreateDocumentAnnotationInput = {
  filePath: string;
  selectedText: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  beforeText: string;
  afterText: string;
  fileContentHash: string;
  comment: string;
};

export type UpdateDocumentAnnotationInput = {
  filePath: string;
  comment?: string;
  status?: DocumentAnnotationStatus;
  selectedText?: string;
  startLine?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;
  beforeText?: string;
  afterText?: string;
  fileContentHash?: string;
};

export type DocumentAnnotationStore = {
  annotationPathForFile(filePath: string): string;
  listAnnotationSummaries(projectId: string, filePath?: string): Promise<DocumentAnnotationSummary[]>;
  readAnnotations(projectId: string, filePath: string): Promise<DocumentAnnotationFile>;
  createAnnotation(projectId: string, input: CreateDocumentAnnotationInput): Promise<DocumentAnnotationFile>;
  updateAnnotation(projectId: string, annotationId: string, input: UpdateDocumentAnnotationInput): Promise<DocumentAnnotationFile>;
  deleteAnnotation(projectId: string, filePath: string, annotationId: string): Promise<DocumentAnnotationFile>;
  clearAnnotations(projectId: string, filePath: string): Promise<DocumentAnnotationFile>;
  moveAnnotations(projectId: string, sourceFilePath: string, targetFilePath: string): Promise<DocumentAnnotationFile>;
};

export function createDocumentAnnotationStore(workspaceStore: WorkspaceStore): DocumentAnnotationStore {
  function annotationPathForFile(filePath: string): string {
    const normalized = normalizeWorkspacePath(filePath);
    assertMarkdownPath(normalized);
    const slashIndex = normalized.lastIndexOf('/');
    const directory = slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
    const baseName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
    const annotationName = `.${baseName}.annotations.json`;
    return directory ? `${directory}/${annotationName}` : annotationName;
  }

  async function readAnnotations(projectId: string, filePath: string): Promise<DocumentAnnotationFile> {
    const normalized = normalizeWorkspacePath(filePath);
    assertMarkdownPath(normalized);
    const annotationPath = annotationPathForFile(normalized);

    try {
      const file = await workspaceStore.readWorkspaceFile(projectId, annotationPath);
      return normalizeAnnotationFile(JSON.parse(file.content), normalized);
    } catch (error) {
      if (isNotFoundError(error)) {
        return emptyAnnotationFile(normalized);
      }
      if (error instanceof SyntaxError) {
        throw new Error('Invalid annotation file');
      }
      throw error;
    }
  }

  async function writeAnnotations(projectId: string, annotationFile: DocumentAnnotationFile): Promise<DocumentAnnotationFile> {
    const normalized = normalizeWorkspacePath(annotationFile.filePath);
    const now = new Date().toISOString();
    const next: DocumentAnnotationFile = {
      version: 1,
      filePath: normalized,
      updatedAt: now,
      annotations: annotationFile.annotations.map((annotation) => ({ ...annotation, filePath: normalized })),
    };
    const annotationPath = annotationPathForFile(normalized);

    if (next.annotations.length === 0) {
      try {
        await workspaceStore.deleteWorkspaceEntry(projectId, annotationPath);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      return next;
    }

    await workspaceStore.writeWorkspaceFile(projectId, annotationPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  return {
    annotationPathForFile,

    async listAnnotationSummaries(projectId, filePath) {
      if (filePath) {
        const annotationFile = await readAnnotations(projectId, filePath);
        return annotationFile.annotations.length > 0 ? [summaryFromAnnotationFile(annotationFile, annotationPathForFile(annotationFile.filePath))] : [];
      }

      const entries = await workspaceStore.listWorkspaceEntries(projectId, { query: '' });
      const annotationEntries = entries.filter((entry) => entry.type === 'file' && isDocumentAnnotationPath(entry.path));
      const summaries = await Promise.all(annotationEntries.map(async (entry) => {
        try {
          const file = await workspaceStore.readWorkspaceFile(projectId, entry.path);
          const parsed = normalizeAnnotationFile(JSON.parse(file.content), filePathFromAnnotationPath(entry.path));
          return summaryFromAnnotationFile(parsed, entry.path);
        } catch {
          return null;
        }
      }));
      return summaries.filter((summary): summary is DocumentAnnotationSummary => Boolean(summary));
    },

    readAnnotations,

    async createAnnotation(projectId, input) {
      const normalized = normalizeWorkspacePath(input.filePath);
      assertMarkdownPath(normalized);
      await workspaceStore.readWorkspaceFile(projectId, normalized);
      const current = await readAnnotations(projectId, normalized);
      const now = new Date().toISOString();
      const annotation: DocumentAnnotation = {
        id: `anno-${randomUUID()}`,
        filePath: normalized,
        selectedText: input.selectedText,
        startLine: input.startLine,
        endLine: input.endLine,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        beforeText: input.beforeText,
        afterText: input.afterText,
        fileContentHash: input.fileContentHash,
        comment: input.comment,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      return writeAnnotations(projectId, { ...current, annotations: [...current.annotations, annotation] });
    },

    async updateAnnotation(projectId, annotationId, input) {
      const normalized = normalizeWorkspacePath(input.filePath);
      assertMarkdownPath(normalized);
      const current = await readAnnotations(projectId, normalized);
      let found = false;
      const now = new Date().toISOString();
      const annotations = current.annotations.map((annotation) => {
        if (annotation.id !== annotationId) return annotation;
        found = true;
        return {
          ...annotation,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.selectedText !== undefined ? { selectedText: input.selectedText } : {}),
          ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
          ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
          ...(input.startOffset !== undefined ? { startOffset: input.startOffset } : {}),
          ...(input.endOffset !== undefined ? { endOffset: input.endOffset } : {}),
          ...(input.beforeText !== undefined ? { beforeText: input.beforeText } : {}),
          ...(input.afterText !== undefined ? { afterText: input.afterText } : {}),
          ...(input.fileContentHash !== undefined ? { fileContentHash: input.fileContentHash } : {}),
          updatedAt: now,
        };
      });
      if (!found) throw new Error('Annotation not found');
      return writeAnnotations(projectId, { ...current, annotations });
    },

    async deleteAnnotation(projectId, filePath, annotationId) {
      const normalized = normalizeWorkspacePath(filePath);
      const current = await readAnnotations(projectId, normalized);
      const annotations = current.annotations.filter((annotation) => annotation.id !== annotationId);
      if (annotations.length === current.annotations.length) throw new Error('Annotation not found');
      return writeAnnotations(projectId, { ...current, annotations });
    },

    async clearAnnotations(projectId, filePath) {
      const normalized = normalizeWorkspacePath(filePath);
      assertMarkdownPath(normalized);
      return writeAnnotations(projectId, emptyAnnotationFile(normalized));
    },

    async moveAnnotations(projectId, sourceFilePath, targetFilePath) {
      const source = normalizeWorkspacePath(sourceFilePath);
      const target = normalizeWorkspacePath(targetFilePath);
      assertMarkdownPath(source);
      assertMarkdownPath(target);
      const current = await readAnnotations(projectId, source);
      if (current.annotations.length === 0) return emptyAnnotationFile(target);

      const now = new Date().toISOString();
      const moved = await writeAnnotations(projectId, {
        ...current,
        filePath: target,
        annotations: current.annotations.map((annotation) => ({
          ...annotation,
          filePath: target,
          updatedAt: now,
        })),
      });
      await writeAnnotations(projectId, emptyAnnotationFile(source));
      return moved;
    },
  };
}

export function isDocumentAnnotationPath(filePath: string): boolean {
  const normalized = normalizeWorkspacePath(filePath);
  const baseName = normalized.split('/').pop() ?? '';
  return /^\..+\.(?:md|markdown)\.annotations\.json$/i.test(baseName);
}

function filePathFromAnnotationPath(annotationPath: string): string {
  const normalized = normalizeWorkspacePath(annotationPath);
  const slashIndex = normalized.lastIndexOf('/');
  const directory = slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
  const baseName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const sourceName = baseName.replace(/^\./, '').replace(/\.annotations\.json$/i, '');
  return directory ? `${directory}/${sourceName}` : sourceName;
}

function summaryFromAnnotationFile(annotationFile: DocumentAnnotationFile, annotationPath: string): DocumentAnnotationSummary {
  const counts = annotationFile.annotations.reduce((acc, annotation) => {
    acc[annotation.status] += 1;
    return acc;
  }, { open: 0, stale: 0, resolved: 0 });
  return {
    filePath: annotationFile.filePath,
    annotationPath,
    count: annotationFile.annotations.length,
    openCount: counts.open,
    staleCount: counts.stale,
    resolvedCount: counts.resolved,
    updatedAt: annotationFile.updatedAt,
  };
}

function normalizeAnnotationFile(value: unknown, fallbackFilePath: string): DocumentAnnotationFile {
  const record = value as Partial<DocumentAnnotationFile>;
  const filePath = normalizeWorkspacePath(typeof record.filePath === 'string' ? record.filePath : fallbackFilePath);
  assertMarkdownPath(filePath);
  const annotations = Array.isArray(record.annotations)
    ? record.annotations.map((item) => normalizeAnnotation(item, filePath)).filter((item): item is DocumentAnnotation => Boolean(item))
    : [];
  return {
    version: 1,
    filePath,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    annotations,
  };
}

function normalizeAnnotation(value: unknown, filePath: string): DocumentAnnotation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<DocumentAnnotation>;
  if (typeof record.id !== 'string' || typeof record.selectedText !== 'string' || typeof record.comment !== 'string') return null;
  const status = record.status === 'stale' || record.status === 'resolved' ? record.status : 'open';
  return {
    id: record.id,
    filePath,
    selectedText: record.selectedText,
    startLine: numberField(record.startLine),
    endLine: numberField(record.endLine),
    startOffset: numberField(record.startOffset),
    endOffset: numberField(record.endOffset),
    beforeText: typeof record.beforeText === 'string' ? record.beforeText : '',
    afterText: typeof record.afterText === 'string' ? record.afterText : '',
    fileContentHash: typeof record.fileContentHash === 'string' ? record.fileContentHash : '',
    comment: record.comment,
    status,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  };
}

function emptyAnnotationFile(filePath: string): DocumentAnnotationFile {
  return {
    version: 1,
    filePath,
    updatedAt: new Date().toISOString(),
    annotations: [],
  };
}

function normalizeWorkspacePath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').split('/').filter((segment) => segment.length > 0).join('/');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error('Invalid workspace path');
  }
  return normalized;
}

function assertMarkdownPath(filePath: string): void {
  if (!/\.(?:md|markdown)$/i.test(filePath)) {
    throw new Error('Annotation target must be a Markdown file');
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

