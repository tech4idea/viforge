# 前端工作台与交互

## 主界面

前端主文件是 [apps/web/src/main.tsx](../../apps/web/src/main.tsx)。当前 UI 是三栏工作台：

- 左侧：工作区文件树。
- 中间：编辑/预览区。
- 右侧：创作助手。

布局样式在 [apps/web/src/styles.css](../../apps/web/src/styles.css) 的 `.workspace-grid` 附近。

产品文案来自 [apps/web/src/product-profile.ts](../../apps/web/src/product-profile.ts)。该文件读取 `VIWORK_PRODUCT`，从 [packages/shared/src/productProfiles.ts](../../packages/shared/src/productProfiles.ts) 解析 active profile，供页面标题、默认项目名、工作区分组、输入框 placeholder 和 agent timeline label 使用。未配置时默认 `novel-adaptation`。Vite 通过 [apps/web/vite.config.ts](../../apps/web/vite.config.ts) 把同名环境变量注入前端构建。

## 三栏可调宽

`workspace-grid` 使用 CSS Grid，列定义由 `workspaceGridColumns()` 动态生成：

```ts
function workspaceGridColumns() {
  if (collapsedPanels.workspace) {
    return `0 0 minmax(520px, 1fr) 8px ${panelWidths.chat}px`;
  }

  return `${panelWidths.workspace}px 8px minmax(420px, 1fr) 8px ${panelWidths.chat}px`;
}
```

拖拽条由 `.panel-resizer` 表示。拖拽入口是 `startPanelResize(event, targetPanel)`。

注意：工作区折叠时第一条 resizer 不能 `display: none`，否则 grid 子项会错位，编辑区会进入 0 宽列。当前实现只把它 `opacity: 0` 且 `pointer-events: none`。

## 工作区折叠

状态：

```ts
const [collapsedPanels, setCollapsedPanels] = useState({ workspace: false, editor: false, chat: false });
```

当前只有 `workspace` 折叠被 UI 使用。折叠按钮在工作区标题栏，展开按钮是 `.workspace-expand-button`。

## 文件树显示

树过滤逻辑在 [apps/web/src/workspace-tree.ts](../../apps/web/src/workspace-tree.ts)：

- `buildCollapsedDirectoryPaths(entries, revealPath)`
- `filterVisibleWorkspaceEntries(entries, collapsedDirectoryPaths)`
- `toggleCollapsedPath(currentPaths, path)`

默认加载后目录折叠，选中或新建目标路径时用 `revealPath` 展开祖先目录。

全局树和工作区分组标题不在前端硬编码，来自 active product profile 的 `globalTree` 和 `workspaceSections`。

## 刷新后的选择恢复

前端会把最近一次工作区选择写入浏览器 localStorage：

```text
viwork.workspaceSelection.v1
```

记录内容包括当前工作区范围、项目文件路径、全局文件路径、临时工作目录 projectId 和临时文件路径。页面刷新后先恢复路径，再从后端重新读取文件树和文件正文；如果路径已不存在，就回退到第一个可编辑文本文件。这里不缓存完整文件正文，避免展示过期内容。

## 右键菜单

当前有三种右键菜单：

- 文件树右键：`SidebarContextMenu`
- 会话 tab 右键：`ChatSessionContextMenu`
- 编辑区选中文本右键：`SelectedTextContextMenu`

它们分别由这些函数打开/关闭：

- `openSidebarContextMenu` / `closeSidebarContextMenu`
- `openChatSessionContextMenu` / `closeChatSessionContextMenu`
- `openSelectedTextContextMenu` / `closeSelectedTextContextMenu`

右键菜单定位使用 `clientX/clientY`，并按视口边界夹紧，避免底部菜单被遮挡。

## 选中文本引用到对话

编辑/预览区容器 `.editor-scroll` 绑定 `onContextMenu={openSelectedTextContextMenu}`。

逻辑：

1. `getSelectedTextFromEvent(event)` 从 textarea/input 或浏览器 selection 获取选中文本。
2. 非空时显示“引用到对话”菜单。
3. `quoteSelectedTextToComposer()` 把选中文本转换为 Markdown blockquote，追加到创作助手输入框。
4. 当前文件自动加入 `referencedFiles` chips。

这使用户可从剧本、设定、预览文本中快速引用片段给创作助手。

## 创作助手阅读模式

状态：

```ts
const [chatReadingMode, setChatReadingMode] = useState(() => readStoredChatReadingMode());
```

标题栏 `Aa` 按钮切换阅读模式。阅读模式只放大对话正文和输入框，工具调用/执行详情仍保持紧凑。选择写入 localStorage key：

```ts
viwork.chatReadingMode.v1
```
