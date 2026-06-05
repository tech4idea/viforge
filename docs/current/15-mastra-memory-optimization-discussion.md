# Mastra 记忆管理优化讨论

> 状态：讨论中
> 日期：2026-06-05

---

## 一、当前实现总结

### 1.1 存储后端

所有 agent 共享一个 SQLite 文件（`mastra-memory.db`），通过 `@mastra/libsql` 的 `LibSQLStore` 访问。
数据库路径由 `WORKSPACES_ROOT` 推导：

```
~/.viwork/data/<productId>/mastra-memory.db
```

Docker 部署时映射为容器内 `/data/mastra-memory.db`，通过 `./var/api-data` 卷持久化。

每个 agent 创建独立的 `LibSQLStore` 实例（带唯一 `id`），但指向同一个 SQLite 文件。

### 1.2 两类记忆配置

| 配置项 | 系统主 agent | 专家 agent（×5） |
|--------|-------------|-----------------|
| `lastMessages` | 20 | 8 |
| `vector` | false | false |
| `semanticRecall` | false | false |
| `workingMemory.enabled` | true | true |
| `workingMemory.scope` | resource | resource |
| `workingMemory.template` | 结构化模板（用户偏好/项目设定/角色关系/待回收伏笔） | 空字符串 |

### 1.3 线程隔离策略

- **主 agent**：按 session 隔离，`thread = sessionId`
- **专家 agent**：按 `sessionId-agentId` 隔离（如 `session-1-brainstorm-agent`）
- **Working memory**：按 `resource = projectId` 共享，所有 agent 可读写同一项目的长期记忆

### 1.4 Token 安全阀

`TokenLimiterProcessor` 在 100K token 时直接截断（truncate 策略），不做摘要。

### 1.5 依赖版本

```json
"@mastra/core": "^1.37.1",
"@mastra/libsql": "^1.11.1",
"@mastra/memory": "^1.20.0"
```

---

## 二、可优化方向

### 方向 1：开启语义召回 (Semantic Recall)

**现状问题**：完全依赖最近 N 条消息，长对话中早期重要信息会被丢失。

**优化方案**：引入 embedding + 向量检索，让 agent 能够"回忆"起相关的历史片段。

**权衡**：
- 需要选择 embedding 提供商（OpenAI / 本地模型 / 其他）
- 额外成本（API 调用或本地计算资源）
- 向量存储的额外复杂度

**你的想法**：
可以的，embedding提供商不用担心，aigc-hub有集成，向量存储就使用qdrant吧，docker 部署一个就可以


---

### 方向 2：用摘要替代截断 (Summarization over Truncation)

**现状问题**：100K token 上限时直接截断，可能丢失关键上下文。

**优化方案**：在接近上限时触发结构化摘要，保留核心信息而非机械丢弃。

**权衡**：
- 摘要生成需要额外 LLM 调用
- 摘要质量影响后续对话质量
- 需要设计触发时机（阈值 / 定期）

**你的想法**：
设定阈值吧，现在llm上下文动辄都有1M，可以设置大一点

---

### 方向 3：专家 Agent Working Memory 模板定制

**现状问题**：专家 agent 的 working memory 模板是空字符串，缺乏结构化引导。

**优化方案**：为每个专家定制模板：
- **brainstorm agent**：记录"已否决方案"、"灵感关键词"
- **reviewer agent**：记录"高频问题模式"、"质量标准"
- **screenwriter agent**：记录"对白风格"、"场景转换规则"
- 等等

**权衡**：
- 增加配置维护成本
- 模板设计需要结合实际使用效果迭代

**你的想法**：
这个很有必要，配置就统一到packages/shared/src/product-profiles下面进行分别维护

---

### 方向 4：跨 Agent 记忆共享策略

**现状问题**：专家 agent 的 thread 完全隔离，主 agent 看不到专家的历史对话。

**优化方案**：让主 agent 在委派任务后获得一个"专家摘要"写入自己的记忆，而不是完全黑箱。

**权衡**：
- 摘要粒度如何控制（太粗丢失细节，太细污染主上下文）
- 是否需要引入新的"摘要写入"工具

**你的想法**：
需要引入摘要写入工具，不用太细，先试下粗粒度的就可以

---

### 方向 5：记忆 DB 隔离粒度

**现状问题**：所有 agent + 所有项目共享同一个 SQLite 文件。

**优化方案**：
- 按 product 拆分（每个产品独立 DB）
- 按 project 拆分（每个项目独立 DB）
- 或引入连接池 / 更高级的存储后端

**权衡**：
- 拆分增加运维复杂度
- 多产品部署时共享 DB 可能成为瓶颈
- SQLite WAL 模式在写并发上有上限

**你的想法**：
改为postgres作为存储管理吧

---

### 方向 6：记忆生命周期管理

**现状问题**：没有记忆的过期/清理机制，随着项目和对话增多 DB 会持续膨胀。

**优化方案**：
- 基于项目状态（已完成/归档）清理历史记忆
- 设置最大消息条数或最大 DB 大小
- 定期归档旧 thread 到冷存储

**权衡**：
- 需要定义"过期"策略
- 归档后的记忆是否需要可检索

**你的想法**：
先不考虑清理问题

---

### 方向 7：Working Memory 并发写入安全

**现状问题**：多个专家 agent 共享同一个 resource 级别的 working memory，理论上可能并发写入。

**优化方案**：
- 依赖 SQLite WAL 模式（当前已启用）
- 引入应用层写锁或队列
- 或按 agent 拆分 working memory 命名空间

**权衡**：
- WAL 模式在大多数场景下足够
- 额外锁机制增加复杂度
- 拆分命名空间失去共享语义

**你的想法**：
换postgres，并从数据表结构上做好隔离
---

## 三、优先级建议（待讨论）

| 优先级 | 方向 | 理由 |
|--------|------|------|
| P0 | 方向 2：摘要替代截断 | 直接影响对话质量，当前截断会丢失关键信息 |
| P1 | 方向 3：专家模板定制 | 低成本高收益，能快速提升专家 agent 输出质量 |
| P1 | 方向 4：跨 agent 记忆共享 | 提升系统整体协调能力 |
| P2 | 方向 1：语义召回 | 长期价值大，但引入额外依赖和成本 |
| P2 | 方向 5：DB 隔离粒度 | 多产品/多项目部署时需要 |
| P3 | 方向 6：生命周期管理 | 随时间推移会越来越重要 |
| P3 | 方向 7：并发写入安全 | 当前规模下风险较低 |

---

## 四、讨论记录

没有优先级，都要实现
