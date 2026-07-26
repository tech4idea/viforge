export type ToolDescriptionSpec = {
  description: string;
  parameters: Record<string, string>;
  output: string;
};

export const DEFAULT_TOOL_DESCRIPTION_SPECS = {
  list_workspace_entries: {
    description: [
      '列出当前项目工作区中的文件和目录。',
      '默认只列出顶层条目；传入 path 可浏览子目录；传入 query 可模糊搜索所有文件。',
      '文件较多时优先用 path 或 query 缩小范围，避免一次性加载全部列表。',
    ].join('\n'),
    parameters: {
      path: '要列出的子目录路径（相对工作区根），不传则列顶层。',
      query: '按文件名或路径模糊搜索，支持子序列匹配。',
    },
    output: '返回匹配的工作区条目列表，包含文件/目录路径、类型和基础元数据。',
  },
  read_workspace_file: {
    description: '读取当前项目工作区中的 UTF-8 文本文件。图片、PDF 等二进制文件只返回元数据摘要，不返回内容。',
    parameters: {
      path: '要读取的文件路径，相对当前项目工作区根目录。',
    },
    output: '文本文件返回 path 和 content；二进制文件返回 path、mimeType、size 和不可读提示。',
  },
  write_workspace_file: {
    description: '在项目工作区中写入一个 UTF-8 文本文件。用于输出分析、方案、剧本等工作成果。',
    parameters: {
      path: '要写入的文件路径，相对当前项目工作区根目录。',
      content: '完整文件内容；会覆盖同路径现有文本文件。',
    },
    output: '返回写入后的文件元数据，并发布 file.changed 事件。',
  },
  delete_workspace_file: {
    description: '删除当前项目工作区中的文件或目录。用于清理不再需要的工作成果。',
    parameters: {
      path: '要删除的文件或目录路径，相对当前项目工作区根目录。',
    },
    output: '返回删除结果，并发布 file.changed 事件。',
  },
  move_workspace_entry: {
    description: [
      '移动或重命名当前项目工作区中的文件或目录。',
      'source 与 target 都是相对项目工作区根目录的路径，如 "03 剧本/01 第一集/定稿剧本.md"。',
      'target 已存在时会拒绝，避免覆盖；如需改名，请换一个不冲突的 target 路径。',
      '典型用途：整理目录结构、把生成图片归档到 "分镜/第1集/" 等子目录、给文档改名。',
    ].join('\n'),
    parameters: {
      source: '工作区中当前存在的路径（文件或目录）。',
      target: '希望移动/重命名到的新路径；目录不存在会自动创建，但目标路径不能已存在。',
    },
    output: '成功时返回移动后的条目元数据；失败时返回 error，并发布对应 file.changed 事件。',
  },
  run_bash: {
    description: [
      '在当前项目工作区目录下执行 shell 命令（bash）。',
      '适合批量处理文件、用脚本提取内容、搜索大文件、格式转换等 read_workspace_file 不便处理的场景。',
      '命令的工作目录就是项目工作区根目录；默认超时 120 秒，可按需要调整；输出超过 8000 字符会被截断。',
      '不要执行需要交互输入的命令，不要安装系统级软件包，不要访问工作区之外的路径。',
    ].join('\n'),
    parameters: {
      command: '要执行的 bash 命令。',
      timeout: '超时秒数，默认 120，最大 300。',
    },
    output: '返回 exitCode、stdout、stderr；过长输出会被截断，超时返回 exitCode -1。',
  },
  sync_to_remote: {
    description: [
      '将当前项目工作区的所有改动提交并推送到远端 Git 仓库。',
      '在完成一轮有实质产出的工作后（如写完剧本、完成分析），主动调用此工具备份成果。',
      '不需要手动执行 git add/commit，工具会自动处理。',
      'message 是提交说明，应简要概括本次改动内容。',
    ].join('\n'),
    parameters: {
      message: '提交说明，概括本次改动内容。',
    },
    output: '返回 Git 提交和推送结果；未配置远端、分支或访问令牌时返回 error。',
  },
  read_global_file: {
    description: '读取全局工作区中的 UTF-8 文本文件，如知识库、模板或 Agent 配置。',
    parameters: {
      path: '全局工作区中的文件路径。',
    },
    output: '返回全局文件内容和元数据。',
  },
  browser_status: {
    description: '检查 Playwriter 浏览器连接状态。Playwriter 连接到用户已登录的真实浏览器标签页，适合读取当前网页、导航、搜索和整理资料。',
    parameters: {},
    output: '返回 Playwriter 是否启用、relay 是否可达、已连接浏览器数量和错误信息。',
  },
  browser_use_install: {
    description: [
      '当用户有网页访问需求但 Playwriter 未安装、relay 未启动或浏览器标签页未授权时，调用此工具生成安装与连接指引。',
      '该工具不会访问网页，只返回当前检测状态和用户需要执行的步骤。',
    ].join('\n'),
    parameters: {},
    output: '返回浏览器连接检测状态和安装/授权步骤。',
  },
  browser_navigate: {
    description: [
      '通过 Playwriter 在用户授权的真实浏览器标签页中打开 URL。',
      '适合访问用户已登录页面或需要浏览器环境的网页。只在用户要求浏览网页、搜索资料或读取页面时使用。',
    ].join('\n'),
    parameters: {
      url: '要打开的网址。缺少协议时会自动补 https://。',
      sessionId: '可选 Playwriter session id；默认使用环境变量或 1。',
    },
    output: '返回导航结果、当前 URL 或错误信息。',
  },
  browser_snapshot: {
    description: [
      '读取当前 Playwriter 浏览器标签页的可访问性快照，返回页面文字、链接、按钮、输入框和 aria-ref 定位信息。',
      '需要理解网页内容、选择可点击元素或整理资料时优先使用，不要用截图 OCR 替代。',
    ].join('\n'),
    parameters: {
      sessionId: '可选 Playwriter session id；默认使用环境变量或 1。',
    },
    output: '返回页面可访问性快照、URL、标题、元素引用或错误信息。',
  },
  browser_evaluate: {
    description: [
      '在 Playwriter stateful sandbox 中执行一段受控 Playwright JavaScript。作用域包含 page、context、state、require。',
      '用于点击 aria-ref 元素、填写表单、读取标题/URL、等待响应、提取页面结构等浏览器操作。',
      '不要读取本地文件、不要访问工作区外路径、不要执行与浏览器任务无关的 Node.js 代码。对登录、提交、购买、删除、发布等敏感操作必须先让用户确认。',
    ].join('\n'),
    parameters: {
      code: '要执行的 Playwright JavaScript，建议用 console.log(JSON.stringify(result)) 输出结构化结果。',
      sessionId: '可选 Playwriter session id；默认使用环境变量或 1。',
      timeoutMs: '执行超时毫秒数，默认 30000，范围 1000-120000。',
    },
    output: '返回脚本执行结果、console 输出或错误信息。',
  },
  read_project_memory: {
    description: [
      '读取当前项目的结构化长期记忆。',
      '当需要确认用户偏好、项目长期设定、角色关系、伏笔、质量标准等稳定信息时使用。',
      '不要把它当作普通聊天历史；普通短期上下文已经由系统保留。',
    ].join('\n'),
    parameters: {},
    output: '返回项目结构化长期记忆 Markdown；Repro 评测模式下来自 fixture。',
  },
  update_project_memory: {
    description: [
      '更新当前项目的结构化长期记忆。',
      '只写入跨轮次仍然有价值的稳定信息，例如用户明确偏好、已确认设定、角色关系变化、伏笔、审稿标准。',
      '不要写入一次性过程、临时推理、工具调用流水账或未经确认的猜测。',
      'content 应该是完整的 Markdown 记忆正文；如需增量更新，先调用 read_project_memory 再合并。',
    ].join('\n'),
    parameters: {
      content: '完整的项目结构化长期记忆 Markdown 正文。',
      reason: '本次更新的原因，便于审计和追踪。',
    },
    output: '返回更新结果、原因、写入字节数和 usage；评测模式可 mock 写入。',
  },
  recall_project_memory: {
    description: [
      '按语义检索当前项目中由 agent 主动写入的精选长期记忆。',
      '适合在当前任务需要找回早期关键设定、用户偏好、角色关系、已否决方案、审稿结论时使用。',
      '普通问候、短问题、当前上下文已经足够时不要调用。',
    ].join('\n'),
    parameters: {
      query: '用于语义检索的自然语言查询，写清要找回的信息类型。',
      topK: '最多返回的记忆条数，默认 6，范围 1-12。',
    },
    output: '返回 query、matches 和 usage；Repro 评测模式下结果来自 fixture。',
  },
  remember_project_memory: {
    description: [
      '把一条精选长期记忆写入语义索引，供 recall_project_memory 未来检索。',
      '只保存对后续创作有复用价值的信息，例如已确认设定、角色规则、用户偏好、已否决方向、审稿结论。',
      '每条 memory 应简洁、可独立理解，并包含必要上下文；不要保存整段对话或临时分析。',
    ].join('\n'),
    parameters: {
      memory: '要长期保存并建立语义索引的记忆条目。',
      category: '记忆分类，如 user_preference、project_fact、character、continuity、quality_standard 等。',
      reason: '为什么这条信息值得长期记住。',
    },
    output: '返回 remembered、category、messageId 和 usage；评测模式可 mock 写入。',
  },
  retrieve_knowledge_cards: {
    description: [
      '从全局知识库索引中检索可复用的创作机制卡、观点卡或笑点模式卡。',
      '检索结果只用于启发，不要复制具体台词、完整桥段、人物身份或受版权保护的表达。',
      '知识库索引优先读取 知识库/index.yaml；如果没有索引，会退化为扫描 知识库 下的 Markdown 文件。',
    ].join('\n'),
    parameters: {
      query: '检索意图，例如“业主群误会升级机制”。',
      tags: '可选标签过滤。',
      topK: '最多返回的知识卡数量，默认 5，范围 1-12。',
    },
    output: '返回 query 和 matches；Repro 评测模式下结果来自 fixture。',
  },
  generate_project_image: {
    description: [
      '通过 AIGC Hub 生成图片，并保存到当前项目工作区的”生成图片/”目录。',
      '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时使用。',
      '普通视觉描述或提示词整理不需要调用此工具。',
    ].join('\n'),
    parameters: {
      prompt: '图片生成提示词，描述主体、场景、风格、构图和限制。',
      aspectRatio: '图片比例，可选 1:1、3:4、4:3、9:16、16:9，默认 1:1。',
      count: '生成数量，默认 1，范围 1-4。',
      outputDir: '可选。图片保存的相对目录，缺省为 "生成图片/"。',
      fileName: '可选。图片文件主名（不含扩展名），缺省使用时间戳。',
    },
    output: '返回生成图片的工作区路径、mimeType、模型和 revisedPrompt，并发布 image.generated 事件。',
  },
  edit_project_image: {
    description: [
      '修改工作区中已有的图片。读取指定图片作为参考，结合文字描述生成修改后的新图片。',
      '当用户要求修改、调整、优化某张已有图片时使用。',
      '缺省保存到 "生成图片/" 目录并以时间戳 + "-edit" 命名；可通过 outputDir / fileName 自定义保存位置和文件主名。',
      '不要猜测或填写模型名；工具会自动使用配置的图片模型。',
    ].join('\n'),
    parameters: {
      imagePath: '工作区中待修改图片的路径，可通过 list_workspace_entries 查看。',
      prompt: '图片修改描述，说明需要如何修改原图。',
      aspectRatio: '图片比例，可选 1:1、3:4、4:3、9:16、16:9，默认 1:1。',
      count: '生成数量，默认 1，范围 1-4。',
      outputDir: '可选。图片保存的相对目录，缺省为 "生成图片/"。',
      fileName: '可选。图片文件主名（不含扩展名），缺省使用时间戳 + "-edit" 后缀。',
    },
    output: '返回修改后图片的工作区路径、mimeType、模型、revisedPrompt 和 sourceImagePath。',
  },
  send_wechat_message: {
    description: [
      '立即向已绑定的用户微信发送一条文本消息。',
      '只在本次运行中需要马上发送当前正文时使用，例如用户要求现在把摘要、通知或结果发到微信。',
      '本工具不会创建未来或周期性任务；如果用户要求定时、每天、每周或隔一段时间发送，必须使用 create_scheduled_task。',
      '由你根据当前上下文生成最终要发送的正文，再调用本工具发送；不要让外层系统替你发送。',
    ].join('\n'),
    parameters: {
      message: '要发送到微信的最终文本正文。',
    },
    output: '返回 sent、channel 和 textLength。',
  },
  send_wechat_file: {
    description: [
      '将项目工作区中的文件发送给用户微信。',
      '当用户说"把xxx发给我"、"发送文件给我"、"发一下这个文件"等要求发送工作区文件时使用。',
      '支持图片、PDF、文本、视频、音频等任意文件类型。',
    ].join('\n'),
    parameters: {
      path: '工作区中的文件路径，可通过 list_workspace_entries 查看可用文件。',
    },
    output: '返回 sent、path 和 mimeType，并发布 wechat.file_sent 事件。',
  },
  create_scheduled_task: {
    description: [
      '创建绑定当前会话的定时任务。',
      '仅当用户明确要求在未来某个时间、周期性、每天、每周、每隔一段时间执行提醒或通知时调用。',
      '本工具只负责创建任务，不会立即发送微信消息；任务到期后会启动一次 schedule 来源的 agent run。',
      '当前 MVP 的任务动作是在执行时实时生成一条微信消息，并由执行 run 调用 send_wechat_message 发送给已绑定微信。',
      '不要在创建任务时提前写死将来要发送的正文。',
      '如果用户没有给出可执行时间或实时生成内容的要求，先追问，不要创建任务。',
    ].join('\n'),
    parameters: {
      title: '任务标题，简短描述该提醒任务。',
      sourcePrompt: '用户原始请求或你归纳的创建依据。',
      nextRunAt: '下一次执行时间，ISO 8601 格式。北京时间需换算为 UTC ISO。',
      schedule: '执行频率、间隔、本地时间、星期和时区配置。',
      messagePrompt: '任务执行时用于实时生成微信消息的要求，不是最终固定正文。',
    },
    output: '返回创建后的 ScheduledTask。',
  },
  delegate_to_specialist_agent: {
    description: [
      '将明确的子任务委派给一个 specialist agent，并等待其返回结果。',
      '只在任务需要专业判断或专业产物时使用；简单润色、解释、问候或当前 agent 已能直接完成时不要委派。',
      '委派时必须写清目标、上下文、已读取材料摘要和期望输出。',
    ].join('\n'),
    parameters: {
      agentId: '要委派的 specialist agent ID。',
      task: '明确、可执行的子任务说明。',
      context: '必要上下文、已读取材料摘要、用户目标和期望输出。',
    },
    output: '返回 specialist 的文本结果；若 agent 未启用或不存在，返回错误。',
  },
} as const satisfies Record<string, ToolDescriptionSpec>;

export const DEFAULT_TOOL_DESCRIPTIONS = Object.fromEntries(
  Object.entries(DEFAULT_TOOL_DESCRIPTION_SPECS).map(([toolId, spec]) => [toolId, spec.description]),
) as { [K in keyof typeof DEFAULT_TOOL_DESCRIPTION_SPECS]: (typeof DEFAULT_TOOL_DESCRIPTION_SPECS)[K]['description'] };

export type DefaultToolId = keyof typeof DEFAULT_TOOL_DESCRIPTION_SPECS;
