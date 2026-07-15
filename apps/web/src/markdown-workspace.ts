function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function normalizeWorkspacePath(path: string): string {
  const parts: string[] = [];
  for (const rawPart of path.replace(/\\/g, '/').split('/')) {
    const part = rawPart.trim();
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function isExternalUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url) || /^(?:mailto|tel):/i.test(url) || url.startsWith('#') || url.startsWith('data:');
}

export function resolveMarkdownWorkspacePath(currentPath: string, rawTarget: string): string | null {
  const cleanTarget = rawTarget.split('#')[0]?.split('?')[0] ?? '';
  if (!cleanTarget.trim() || isExternalUrl(cleanTarget)) return null;

  let decoded = cleanTarget;
  try {
    decoded = decodeURIComponent(cleanTarget);
  } catch {
    // Keep the raw target when the Markdown contains a partial escape sequence.
  }

  return normalizeWorkspacePath(decoded.startsWith('/') ? decoded : `${dirname(currentPath)}/${decoded}`);
}

export function buildMarkdownRawUrl(rawPreviewUrl: string, currentPath: string, targetPath: string): string {
  const queryStart = rawPreviewUrl.search(/[?#]/);
  const rawPath = queryStart === -1 ? rawPreviewUrl : rawPreviewUrl.slice(0, queryStart);
  const rawSuffix = queryStart === -1 ? '' : rawPreviewUrl.slice(queryStart);
  const suffix = encodeURIComponent(currentPath).replace(/%2F/g, '/');
  const encodedTarget = encodeURIComponent(targetPath).replace(/%2F/g, '/');

  if (rawPath.endsWith(suffix)) {
    return `${rawPath.slice(0, -suffix.length)}${encodedTarget}${rawSuffix}`;
  }

  const rawMarker = '/raw/';
  const rawStart = rawPath.indexOf(rawMarker);
  if (rawStart !== -1) {
    return `${rawPath.slice(0, rawStart + rawMarker.length)}${encodedTarget}${rawSuffix}`;
  }

  return rawPreviewUrl;
}