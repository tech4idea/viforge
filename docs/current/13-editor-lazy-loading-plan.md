# 前端性能优化：重型编辑器按需加载

## 背景

前端工作台在流式对话期间存在明显卡顿。经分析，主要瓶颈已完成第一轮优化：

| 已完成优化 | 效果 |
|-----------|------|
| SSE 事件 100ms 节流批量刷新 | 重渲染频率从"每事件一次"降至 ~10 次/秒 |
| 流式事件数组拼接替代逐个拷贝 | 长对话从 O(n²) 降至 O(n) |
| `onOpenAttachment` ref 稳定化 | `ChatMessageItem` 的 `memo` 对历史消息生效 |
| `AgentTraceTimeline` 加 `memo` | 避免 trace 事件未变时的冗余 filter/reduce |
| `CodeEditor` highlight.js 150ms 防抖 | 减少输入时主线程阻塞 |

当前构建产物（`pnpm --filter @viwork/web build`）仍是单个 JS bundle：

```
dist/assets/index-*.js   3,302 KB (gzip 884 KB)
```

其中 Milkdown（ProseMirror 内核 + 8 个插件包）、FortuneSheet（完整电子表格引擎）和 highlight.js 被所有用户无条件加载，即使用户只使用对话功能和纯文本编辑。

本文档描述按需加载这些重型编辑器的实施方案。

## 目标

1. 首屏 JS 体积减少 50%+，将 Milkdown、FortuneSheet 拆入独立 chunk，仅在用户打开对应类型文件时加载。
2. highlight.js CSS（`github.css`）随 `CodeEditor` 按需加载，不污染首屏 CSS bundle。
3. 不破坏现有 `viewer-components.test.ts` 的断言逻辑。
4. 加载期间展示骨架/占位 UI，不阻塞工作台其它区域交互。

## 当前架构

```
viewer-components.tsx
├── CSS 侧效果导入（顶层，模块加载即执行）
│   ├── highlight.js/styles/github.css
│   ├── @milkdown/theme-nord/style.css
│   └── @fortune-sheet/react/dist/index.css
├── 库导入（顶层，模块加载即执行）
│   ├── @milkdown/core, preset-commonmark, preset-gfm, plugin-listener, react, theme-nord
│   ├── @fortune-sheet/react (Workbook), @fortune-sheet/core (Sheet)
│   └── highlight.js/lib/common (hljs)
├── renderEditorViewer()         ← main.tsx 调用，按 ViewerKind 分发
├── ViewerPreviewLabel()         ← 轻量，只返回 ViewerKind 字符串
├── buildMarkdownInstanceKey()   ← 轻量纯函数
├── MarkdownEditor()             ← 重型（Milkdown）
├── MilkdownEditorInner()        ← 重型（Milkdown useEditor）
├── SheetEditor()                ← 重型（FortuneSheet Workbook）
├── CodeEditor()                 ← 中型（highlight.js）
├── detectLanguage()             ← 轻量纯函数
├── parseSheetContent()          ← 轻量纯函数
├── serializeSheet()             ← 轻量纯函数
└── MarkdownReadPreview          ← memo 组件，用于聊天气泡渲染 react-markdown
```

`renderEditorViewer` 在 `main.tsx` 的编辑面板中被调用。`main.tsx` 通过 `import { renderEditorViewer } from './viewer-components'` 在模块顶部静态导入，因此 `viewer-components.tsx` 的所有顶层副作用（CSS 导入、库导入）在应用启动时立即执行。

`viewer-components.test.ts` 导入 `renderEditorViewer`、`buildMarkdownInstanceKey` 和 `detectLanguage`，并对 `renderEditorViewer` 的返回值做类型断言：

```ts
expect((viewer.type as { name?: string }).name).toBe('CodeEditor');
```

这个断言直接检查组件函数的 `name` 属性，`React.lazy` 包装后该属性会变化，需要同步调整测试。

## 实施方案

### 步骤一：拆分文件

将 `viewer-components.tsx` 拆为两个模块：

**`apps/web/src/viewer-components.tsx`**（轻量主模块，首屏加载）：
- `renderEditorViewer()` — 使用 `React.lazy` 引用重型编辑器
- `ViewerPreviewLabel()` — 不变
- `buildMarkdownInstanceKey()` — 不变
- `MarkdownReadPreview` — 不变（对话流渲染依赖，必须首屏可用）
- `ViewerKind` / `detectViewerKind` 的重导出 — 不变

**`apps/web/src/editors.tsx`**（重型编辑器模块，按需加载）：
- 所有 CSS 导入（highlight.js/styles/github.css, milkdown/theme-nord, fortune-sheet）
- 所有重型库导入（milkdown, fortune-sheet, highlight.js）
- `MarkdownEditor` + `MilkdownEditorInner`
- `SheetEditor` + `parseSheetContent` + `serializeSheet`
- `CodeEditor` + `detectLanguage`

纯函数 `detectLanguage`、`parseSheetContent`、`serializeSheet`、`buildMarkdownInstanceKey` 体积可忽略（总计 < 50 行），但 `CodeEditor` 依赖 `detectLanguage`、`SheetEditor` 依赖 `parseSheetContent`/`serializeSheet`，所以跟随重型模块一起拆分更简洁。`buildMarkdownInstanceKey` 被 `renderEditorViewer` 调用生成 key prop，必须留在主模块。

### 步骤二：修改 renderEditorViewer 使用 React.lazy

```tsx
// viewer-components.tsx
import { lazy, Suspense } from 'react';

const LazyEditors = lazy(() => import('./editors'));

function EditorFallback({ label }: { label: string }): JSX.Element {
  return <div className="editor-empty">正在加载{label}...</div>;
}

export function renderEditorViewer(props: EditorViewerProps): JSX.Element {
  const kind = detectViewerKind(props.entry.path);

  if (kind === 'image') {
    return <img className="asset-preview" src={props.rawPreviewUrl} alt={props.entry.name} />;
  }

  if (kind === 'pdf' || kind === 'html') {
    return <iframe className="document-preview" src={props.rawPreviewUrl} title={props.entry.name} />;
  }

  if (kind === 'markdown') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="Markdown 文档" />;
    }
    return (
      <Suspense fallback={<EditorFallback label="Markdown 编辑器" />}>
        <LazyEditors.MarkdownEditor
          key={buildMarkdownInstanceKey(props.entry.path, props.savedContent)}
          filePath={props.entry.path}
          value={props.fileContent}
          onChange={props.onChange}
        />
      </Suspense>
    );
  }

  if (kind === 'sheet') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="表格文件" />;
    }
    return (
      <Suspense fallback={<EditorFallback label="表格编辑器" />}>
        <LazyEditors.SheetEditor
          filePath={props.entry.path}
          content={props.fileContent}
          onChange={props.onChange}
        />
      </Suspense>
    );
  }

  if (kind === 'code') {
    if (props.fileState === 'loading') {
      return <EditorFallback label="文本文件" />;
    }
    return (
      <Suspense fallback={<EditorFallback label="代码编辑器" />}>
        <LazyEditors.CodeEditor
          content={props.fileContent}
          filePath={props.entry.path}
          onChange={props.onChange}
        />
      </Suspense>
    );
  }

  return <div className="editor-empty">该素材可以保存在项目中，但当前没有可视预览。</div>;
}
```

注意 `React.lazy` 要求目标模块使用 `export default` 或命名导出。这里 `editors.tsx` 使用命名导出（`export function MarkdownEditor`），`LazyEditors.MarkdownEditor` 可直接访问。Vite 的 tree-shaking 会在 production build 中把未使用的导出移除。

### 步骤三：editors.tsx 的导出结构

```tsx
// apps/web/src/editors.tsx
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { Workbook } from '@fortune-sheet/react';
import type { Sheet } from '@fortune-sheet/core';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import '@milkdown/theme-nord/style.css';
import '@fortune-sheet/react/dist/index.css';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkspaceEntry } from './api';

export function MarkdownEditor({ filePath, value, onChange }: { ... }): JSX.Element { ... }
function MilkdownEditorInner({ ... }): JSX.Element { ... }
export function SheetEditor({ ... }): JSX.Element { ... }
export function CodeEditor({ ... }): JSX.Element { ... }
export function detectLanguage(filePath: string): string { ... }
function parseSheetContent(filePath: string, content: string): Sheet[] { ... }
function serializeSheet(sheets: Sheet[]): string { ... }
```

`parseSheetContent` 和 `serializeSheet` 不导出（仅 `SheetEditor` 内部使用）。`detectLanguage` 导出是因为 `viewer-components.test.ts` 需要直接测试它。

### 步骤四：调整测试

`viewer-components.test.ts` 当前断言：

```ts
expect((viewer.type as { name?: string }).name).toBe('CodeEditor');
```

`React.lazy` 包装后，`renderEditorViewer` 对 code 类型返回的 JSX 是 `<Suspense><LazyEditors.CodeEditor /></Suspense>`。`viewer.type` 变为 `Suspense` 组件（React 内置），不再是 `CodeEditor` 函数。

调整方案：改为断言返回的 JSX 结构中包含 Suspense 和 lazy 组件，或改为只测试纯函数（`detectLanguage`、`buildMarkdownInstanceKey`），将 `renderEditorViewer` 的组件选择测试改为集成测试或用 `React Test Renderer` 渲染后检查输出。

推荐方案 — 简化为纯函数测试 + 渲染输出断言：

```ts
import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import { buildMarkdownInstanceKey, renderEditorViewer } from './viewer-components';

describe('buildMarkdownInstanceKey', () => {
  // ... 保持不变
});

describe('text editor viewer selection', () => {
  it('wraps code editor in Suspense for lazy loading', () => {
    const viewer = renderEditorViewer({
      entry: { name: 'config.toml', path: 'agent/config.toml', type: 'file', size: 18 },
      selectedProjectId: 'global',
      fileContent: 'model = "gpt-5"',
      savedContent: 'model = "gpt-5"',
      fileState: 'idle',
      fileError: null,
      rawPreviewUrl: '/raw/agent/config.toml',
      onChange: () => undefined,
    });

    expect(viewer.type).toBe('Suspense');
    // 内部子组件是 lazy 包装的 CodeEditor
  });

  it('maps toml to toml syntax highlighting', () => {
    const { detectLanguage } = await import('./editors');
    expect(detectLanguage('agent/config.toml')).toBe('toml');
  });
});
```

`detectLanguage` 的测试改为动态导入 `editors.tsx`，避免测试文件在顶层静态导入时拉入所有重型依赖。

### 步骤五：Vite 构建配置调整

当前 `chunkSizeWarningLimit: 3500` 是为了压制单 bundle 过大警告。拆分后主 chunk 预计降至 ~1500 KB，可以调回默认值（500）或设为 1500：

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1500,
  },
  // ...
});
```

无需手动配置 `rollupOptions.output.manualChunks`。`React.lazy` + `import()` 会自动在 Vite/Rollup 中产生独立 chunk。Vite 会生成：

```
dist/assets/index-*.js          主 bundle（不含 Milkdown/FortuneSheet/hljs）
dist/assets/editors-*.js        重型编辑器 chunk
dist/assets/index-*.css         主 CSS（不含编辑器 CSS）
dist/assets/editors-*.css       编辑器 CSS（由 chunk 的 CSS 导入自动生成）
```

### 步骤六：验证清单

1. `pnpm --filter @viwork/web typecheck` 通过
2. `pnpm --filter @viwork/web test` 通过
3. `pnpm --filter @viwork/web build` 通过，确认产出两个 JS chunk + 两个 CSS chunk
4. `pnpm --filter @viwork/api test` 通过（无前端变更影响，作为回归确认）
5. 手动验证：
   - 启动 dev server（`pnpm --filter @viwork/web dev`）
   - 打开浏览器 DevTools Network 面板，刷新页面，确认 `editors-*.js` 未加载
   - 在项目文件树中点击 `.md` 文件，确认 Milkdown chunk 加载并正常渲染
   - 点击 `.csv` 文件，确认 FortuneSheet chunk 加载并正常渲染
   - 点击 `.txt` / `.json` 文件，确认 CodeEditor 正常（highlight.js 随 chunk 加载）
   - 在代码编辑器中输入，确认 highlight.js 防抖正常工作
   - 发起一次 agent 流式对话，确认聊天面板不卡顿

## 预期效果

| 指标 | 优化前 | 优化后（预估） |
|------|--------|---------------|
| 首屏 JS bundle | 3,302 KB | ~1,500 KB |
| 首屏 CSS bundle | 103 KB | ~70 KB |
| Milkdown + ProseMirror | 首屏加载 | 打开 .md 文件时加载 |
| FortuneSheet | 首屏加载 | 打开 .xlsx/.csv 文件时加载 |
| highlight.js + CSS | 首屏加载 | 打开代码文件时加载 |

## 其它可跟进优化

以下为更低优先级的优化点，可在此方案完成后酌情推进：

### App 组件拆分

`main.tsx` 的 `App` 组件超过 4000 行、持有 70+ `useState`。每次状态变更都触发整棵 JSX 树的协调。可拆分为：

- **WorkspaceSidebar** — 文件树、右键菜单、拖拽状态
- **EditorPanel** — 文件编辑/预览
- **ChatPanel** — 对话、流式渲染、composer
- **AppShell** — 布局、panel resize、theme

每个子组件持有自己的 state，通过 props 或 Context 传递跨面板数据。配合 `React.memo` 可大幅减少无关面板的重渲染。

### 流式 Markdown 渲染节流

`MarkdownReadPreview`（`react-markdown`）在每个批量刷新周期都重新解析完整 Markdown。长对话中 content 持续增长，解析开销线性增加。可以考虑：

- 对流式消息只渲染增量内容（将已渲染部分缓存，只 re-parse 新增 text delta）
- 或使用 `useDeferredValue` 降低渲染优先级，让输入响应优先

### 临时会话树过滤 memo 化

`main.tsx` 中 `temporaryChatSessions.map()` 的渲染循环内直接调用 `filterVisibleWorkspaceEntries`（每个 session 每次渲染都执行 O(n*m) 过滤）。可改为 `useMemo` 缓存每个 session 的可见条目。
