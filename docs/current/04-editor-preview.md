# 文件预览与编辑

## 入口

文件预览和编辑组件位于 [apps/web/src/viewer-components.tsx](../../apps/web/src/viewer-components.tsx)。

文件类型检测位于 [apps/web/src/viewers.ts](../../apps/web/src/viewers.ts)：

```ts
export type ViewerKind = 'markdown' | 'sheet' | 'image' | 'pdf' | 'html' | 'code' | 'binary';
```

`detectViewerKind(filePath)` 根据扩展名选择 viewer。

## 支持类型

- Markdown：`.md`, `.markdown`
- 表格：`.xlsx`, `.xls`, `.csv`
- 图片：`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`
- PDF：`.pdf`
- HTML：`.html`, `.htm`
- 代码/文本：`.txt`, `.toml`, `.json`, `.js`, `.jsx`, `.ts`, `.tsx`, `.css`, `.pug`, `.yml`, `.yaml`, `.xml`, `.sql`, `.sh`
- 其它二进制：只提示可保存但无可视预览

## Markdown 编辑

Markdown 使用 Milkdown：

- `@milkdown/core`
- `@milkdown/preset-commonmark`
- `@milkdown/preset-gfm`
- `@milkdown/plugin-listener`
- `@milkdown/react`

组件：

- `MarkdownEditor`
- `MilkdownEditorInner`

`buildMarkdownInstanceKey(filePath, savedContent)` 基于路径和已保存内容生成 key，避免切换文件时编辑器内部状态复用错误。

## 表格编辑

表格使用 `@fortune-sheet/react` 的 `Workbook`。

组件：

- `SheetEditor`
- `parseSheetContent`
- `serializeSheet`

CSV 会按逗号和换行解析为单 sheet。非 CSV 文件尝试按 Fortune Sheet JSON 解析，失败时创建空表。

## 代码/文本编辑

代码类型使用左右分栏：

- 左侧 textarea 可编辑原文。
- 右侧 `highlight.js` 高亮预览。

组件：

- `CodeEditor`
- `detectLanguage`

注意：`.toml`、`.json`、`.txt` 等走 code/text viewer，不走 Markdown 预览。

## 静态资源预览

- 图片使用 `<img className="asset-preview">`
- PDF/HTML 使用 `<iframe className="document-preview">`
- 资源 URL 由前端根据当前 scope 生成：
  - 全局：`/api/global/raw/<path>`
  - 项目：`/api/projects/:projectId/raw/<path>`

## 保存流程

主状态在 `apps/web/src/main.tsx`：

- `fileContent`
- `lastSavedContent`
- `fileState`
- `saveState`
- `saveError`

保存入口：

- `saveFile()`

它根据 `activeWorkspaceScope` 调用：

- `apiClient.writeGlobalWorkspaceFile`
- `apiClient.writeWorkspaceFile`

保存成功后更新 `fileContent` 和 `lastSavedContent`。


## Markdown 批注

Markdown 文档支持在标题或正文中选中文本后添加批注，选区可以跨多行。批注不写入正文，而是由 API 持久化为原文同目录隐藏文件：`.<原文件名>.annotations.json`。前端文件树隐藏 `**/.*.annotations.json`，但 Agent 可以通过专用 annotation 工具读取。

前端保存每条批注的 `selectedText`、起止行号、起止 offset、`beforeText`、`afterText` 和 `fileContentHash`。文档变化后会重新定位批注；能定位的批注直接在原 Markdown 编辑器中高亮，悬浮或点击高亮文本时显示批注气泡；无法可靠定位到原文时，会在保存的起始行号处显示“批注”标记，点击后同样查看、修改或删除。会话输入框上方显示待处理批注折叠栏，用于打开原文档、复制全部批注内容，或一键把批注文档引用到输入框并填入“根据批注进行修改”。Agent 执行完修改不会自动清除批注，用户需要手动删除、清空或标记完成。
