import type { WorkspaceEntry } from './api';

export type FileReference = {
  path: string;
  label: string;
};

export type ReferenceSuggestion = FileReference & {
  score: number;
};

export function getActiveReferenceQuery(text: string, caret: number): { query: string; start: number; end: number } | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const beforeCaret = text.slice(0, safeCaret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret);

  if (!match || match.index === undefined) {
    return null;
  }

  const start = match.index + match[0].lastIndexOf('@');
  return {
    query: match[1] ?? '',
    start,
    end: safeCaret,
  };
}

export function buildReferenceSuggestions(entries: WorkspaceEntry[], query: string, existing: FileReference[]): ReferenceSuggestion[] {
  const normalized = query.trim().toLowerCase();
  const existingPaths = new Set(existing.map((item) => item.path));

  return entries
    .filter((entry) => entry.type === 'file' && !existingPaths.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      label: entry.name,
      score: scoreEntry(entry, normalized),
    }))
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 8);
}

export function insertReference(text: string, caret: number, reference: FileReference): { nextText: string; nextCaret: number } {
  const match = getActiveReferenceQuery(text, caret);
  if (!match) {
    return { nextText: text, nextCaret: caret };
  }

  const suffix = text.slice(match.end);
  const spacer = suffix.startsWith(' ') || suffix.length === 0 ? '' : ' ';
  const nextText = `${text.slice(0, match.start)}@${reference.label}${spacer}${suffix}`;
  const nextCaret = match.start + reference.label.length + 2;
  return { nextText, nextCaret };
}

function scoreEntry(entry: WorkspaceEntry, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return entry.path.split('/').length === 1 ? 100 : 80;
  }

  const lowerName = entry.name.toLowerCase();
  const lowerPath = entry.path.toLowerCase();

  if (lowerName === normalizedQuery) return 400;
  if (lowerName.startsWith(normalizedQuery)) return 320;
  if (lowerPath.startsWith(normalizedQuery)) return 280;
  if (lowerName.includes(normalizedQuery)) return 220;
  if (lowerPath.includes(normalizedQuery)) return 160;
  return Number.NEGATIVE_INFINITY;
}
