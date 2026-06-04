export type ViewerKind = 'markdown' | 'sheet' | 'image' | 'pdf' | 'html' | 'code' | 'binary';

export function detectViewerKind(filePath: string): ViewerKind {
  const lower = filePath.toLowerCase();

  if (/\.(md|markdown)$/i.test(lower)) return 'markdown';
  if (/\.(xlsx|xls|csv)$/i.test(lower)) return 'sheet';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) return 'image';
  if (/\.pdf$/i.test(lower)) return 'pdf';
  if (/\.(html|htm)$/i.test(lower)) return 'html';
  if (/\.(txt|toml|json|js|jsx|ts|tsx|css|pug|yml|yaml|xml|sql|sh)$/i.test(lower)) return 'code';
  return 'binary';
}
