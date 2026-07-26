# Markdown 文档批注功能设计

## 背景

用户在审阅 Markdown 文档时，需要对局部内容提出修改意见，并在审阅完成后让 Agent 根据这些意见统一修改文档。现有“选中文本引用到对话”只适合单次提问，不适合在一篇或多篇文档中持续积累批注。

本功能提供原地批注能力：用户选中文档内容后添加评论，系统把批注持久化为与文档同目录的隐藏文件。用户之后可以在对话中要求 Agent “根据批注修改这些文档”，Agent 通过专用 annotation 工具读取批注和原文后执行修改。

## 目标

- 支持 Markdown 文档选中文本后添加批注。
- 批注与原文片段、行号、字符位置和上下文锚点关联。
- 支持同一文档多条批注，也支持多个文档分别维护批注。
- 批注文件持久化保存，刷新页面后仍保留。
- 批注文件不在前端工作区文件树中展示。
- Agent 可以通过专用 annotation 工具读取批注，不需要猜测或扫描隐藏文件路径。
- 文档变更后，系统尽量重新定位批注；无法可靠定位时标记为失效。
- Agent 执行完修改后不自动清除批注，清除必须由用户确认或手动触发。

## 非目标

- 批注永远不写入 Markdown 正文。
- 第一版不实现多人协作、评论回复线程或权限控制。
- 第一版不实现复杂版本 diff 审阅系统。
- 第一版不要求 Agent 自动判断批注是否已经被完整处理并清除。

## 批注文件规则

每个 Markdown 文档对应一个隐藏批注文件，批注文件与原文放在同一目录。

命名规则：

```text
<dir>/<name>.md
<dir>/.<name>.md.annotations.json
```

示例：

```text
03 剧本/01 第一集/剧本.md
03 剧本/01 第一集/.剧本.md.annotations.json
```

根目录文件示例：

```text
README.md
.README.md.annotations.json
```

前端文件树必须隐藏：

```text
**/.*.annotations.json
```

隐藏只影响 UI 展示。后端 annotation 工具仍可以读取这些批注，便于 Agent 在用户需要时按文档获取批注列表和内容。

## 批注数据结构

共享合同定义：

```ts
export type DocumentAnnotationStatus = 'open' | 'stale' | 'resolved';

export type DocumentAnnotation = {
  id: string;
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
  status: DocumentAnnotationStatus;
  createdAt: string;
  updatedAt: string;
};

export type DocumentAnnotationFile = {
  version: 1;
  filePath: string;
  updatedAt: string;
  annotations: DocumentAnnotation[];
};
```

批注文件示例：

```json
{
  "version": 1,
  "filePath": "03 剧本/01 第一集/剧本.md",
  "updatedAt": "2026-07-19T00:00:00.000Z",
  "annotations": [
    {
      "id": "anno-123",
      "filePath": "03 剧本/01 第一集/剧本.md",
      "selectedText": "她推开门，发现房间里一片安静。",
      "startLine": 12,
      "endLine": 12,
      "startOffset": 230,
      "endOffset": 248,
      "beforeText": "走廊尽头只剩一盏灯。",
      "afterText": "她下意识屏住呼吸。",
      "fileContentHash": "sha256-...",
      "comment": "这里缺少悬念，可以增加一个反常细节。",
      "status": "open",
      "createdAt": "2026-07-19T00:00:00.000Z",
      "updatedAt": "2026-07-19T00:00:00.000Z"
    }
  ]
}
```

## 空批注文件处理

当某个文档的批注集合为空时，对应批注文件需要清空。

约定语义：删除对应的 `.annotations.json` 文件。

原因：

- 避免 Agent 读到空文件后误判该文档仍有待处理批注。
- 避免工作区留下大量无意义隐藏文件。
- 删除文件比维护空 JSON 更符合“没有批注”的状态。

## 文档变化后的定位策略

批注定位不能只依赖行号。文档被用户或 Agent 修改后，行号和原文位置都可能漂移，所以每条批注必须保存多锚点信息。

重新定位顺序：

1. 优先使用 `startOffset/endOffset` 检查当前位置内容是否仍等于 `selectedText`。
2. 如果不匹配，在全文中搜索 `selectedText`。
3. 如果 `selectedText` 出现多次，用 `beforeText/afterText` 计算最可能的位置。
4. 如果无法唯一定位，把批注标记为 `stale`。

状态含义：

- `open`：批注仍待处理，且当前可以定位。
- `stale`：文档已变化，批注位置无法可靠定位。
- `resolved`：用户确认该批注已经处理完成。

高亮规则：

- 能定位时，在正文中高亮当前定位到的文本。
- 位置漂移但能重新定位时，高亮新位置，并在 UI 中展示更新后的行号。
- 无法定位时，不在正文中高亮，在编辑器内的批注入口中显示“位置可能已失效”。

Agent 处理规则：

```md
line range 仅供参考。修改时优先根据 selectedText、beforeText、afterText 在当前文档中定位。
如果无法确认批注对应位置，不要猜测修改；应向用户说明该批注已失效或需要确认。
```

## 后端 API

新增项目级批注 API。批注仍以隐藏文件保存，API 负责读写、校验和空文件清理。

```text
GET    /api/projects/:projectId/annotations?filePath=<path>
POST   /api/projects/:projectId/annotations
PATCH  /api/projects/:projectId/annotations/:annotationId
DELETE /api/projects/:projectId/annotations/:annotationId?filePath=<path>
DELETE /api/projects/:projectId/annotations?filePath=<path>
```

行为：

- `GET` 返回指定 Markdown 文档的批注文件；不存在时返回空批注集合。
- `POST` 新增批注，并写入同目录隐藏批注文件。
- `PATCH` 更新批注评论或状态。
- 单条 `DELETE` 删除指定批注；删除后如果集合为空，则删除批注文件。
- 文件级 `DELETE` 清空当前文档所有批注，并删除批注文件。

路径安全要求：

- 只允许对项目工作区内相对路径创建批注。
- 目标 `filePath` 必须是 Markdown 文件。
- 批注文件路径由后端根据 `filePath` 计算，前端不能直接指定任意隐藏路径。

## 前端交互

### 添加批注

用户在 Markdown 文档标题或正文中选中文本后，右键菜单出现。选区可以跨多行：

- 引用到对话
- 添加批注

点击“添加批注”后，在选区附近显示输入浮层。用户填写评论后保存。

保存时前端需要计算：

- `selectedText`
- `startLine/endLine`
- `startOffset/endOffset`
- `beforeText/afterText`
- `fileContentHash`

### 展示批注

编辑/预览区在原 Markdown 编辑器内显示当前文档批注，不重复渲染一份原文：

- 能定位的批注直接在原文对应文本上高亮。
- 鼠标悬浮或点击高亮文本时，在原处显示批注气泡，展示原文摘要、行号、评论和状态，并可修改、完成或删除。
- 会话输入框上方提供待处理批注折叠栏，用于查看有待处理批注的文档。
- 折叠栏内不重复展示原文和批注详情；点击文档直接打开原 Markdown 文档，在原文档高亮或行首标记中查看、修改、完成或删除单条批注。
- 批注折叠栏支持一键复制全部待处理批注内容，也支持把全部或单个批注文档作为 `@` 引用加入输入框，并自动填入“根据批注进行修改”。
- `stale` 批注不做文本级高亮，但仍在保存的起始行号处显示特殊“批注”标记，点击后可以查看、修改、完成或删除。

### 清除批注

用户可以：

- 删除单条批注。
- 清空当前文档批注。
- 将批注标记为已解决。

Agent 执行完成后不自动清除批注。清除动作必须由用户确认或手动触发。

## Agent 使用方式

用户不需要把批注内容复制进对话。用户可以直接在对话中说：

```text
根据批注修改这几个文档。
```

Agent 不通过每次 run prompt 注入批注列表或批注正文，也不使用关键词判断是否注入批注上下文。批注能力通过专用工具暴露给 Agent。

系统提示词中只注入固定工具规则：

```md
当任务上下文明示需要根据文档批注、评论或修改意见处理 Markdown 文档时，使用 annotation 工具查询批注。不要猜测批注文件路径，也不要直接扫描隐藏批注文件。
读取批注后，根据 filePath、selectedText、beforeText、afterText、line range 和 comment 修改原文。
line range 仅供参考，selectedText 和上下文锚点优先。
如果批注状态是 stale 或无法确认位置，不要猜测修改，应向用户说明需要确认。
Agent 执行完修改后不要自动删除、清空或标记 resolved，除非用户明确要求。
```

## Agent 批注工具

在 LangGraph workspace tools 中新增批注工具。工具由后端封装同目录隐藏批注文件的存储细节，Agent 不需要知道具体路径计算规则。

工具接口：

```text
list_document_annotations({ filePath?: string })
read_document_annotations({ filePath: string })
```

`list_document_annotations` 返回轻量索引，不返回批注正文：

```json
[
  {
    "filePath": "03 剧本/01 第一集/剧本.md",
    "annotationPath": "03 剧本/01 第一集/.剧本.md.annotations.json",
    "count": 3,
    "openCount": 2,
    "staleCount": 1,
    "resolvedCount": 0,
    "updatedAt": "2026-07-19T00:00:00.000Z"
  }
]
```

`read_document_annotations` 返回指定文档的完整批注：

```json
{
  "version": 1,
  "filePath": "03 剧本/01 第一集/剧本.md",
  "updatedAt": "2026-07-19T00:00:00.000Z",
  "annotations": []
}
```

可选清理工具：

```text
update_document_annotation_status({ filePath, annotationId, status })
clear_document_annotations({ filePath })
```

清理工具必须在描述中声明：只有用户明确要求“清除批注”“标记已完成”“删除批注”时才能调用。Agent 根据批注完成文档修改后，不能自行清除或标记 resolved。

这种方式的优点：

- 不需要每次 run 注入批注列表。
- 不依赖关键词判断。
- 批注正文不会挤占上下文。
- 后端统一封装隐藏文件路径规则。
- 后续批注存储从隐藏 JSON 改为数据库时，不影响 Agent 工具接口。
## 涉及代码范围

共享合同：

- `packages/shared/src/contracts.ts`

后端：

- `apps/api/src/storage/workspaceStore.ts`
- 新增或扩展批注存储 helper
- `apps/api/src/routes/projects.ts` 或新增 `apps/api/src/routes/annotations.ts`
- `apps/api/src/runs/langGraphRunService.ts` 如需注入固定系统提示词规则
- `apps/api/src/runs/langGraphAgents.ts` 新增 annotation 工具和工具说明

前端：

- `apps/web/src/api.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/viewer-components.tsx`
- `apps/web/src/workspace-tree.ts`
- `apps/web/src/styles.css`

测试：

- API：批注路径计算、CRUD、空批注文件删除、隐藏文件读写安全。
- Web：批注路径隐藏、选区定位、批注格式、stale 状态。
- Agent tools：批注列表/读取工具可用，且工具描述限制自动清理行为。

## 第一版实施范围

第一版实现：

- 仅支持 Markdown 文件。
- 批注文件与原文同目录隐藏保存。
- 前端文件树隐藏 `**/.*.annotations.json`。
- 添加、展示、删除、清空当前文档批注。
- 正文高亮和点击批注定位。
- 保存 `selectedText + beforeText + afterText + offset + line + fileContentHash`。
- 文档变化后重新定位，无法定位则标记 `stale`。
- 系统提示词注入 annotation 工具使用规则，不向每次 run prompt 注入批注索引或正文。
- Agent 执行后不自动清除批注。
