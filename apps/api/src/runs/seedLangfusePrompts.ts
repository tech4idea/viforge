import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { WORKSPACES_ROOT, PRODUCT_PROFILE } from '../env';
import { createLangfusePrompt, isPromptStoreAvailable } from './langfusePromptStore';

const GLOBAL_WORKSPACE = path.join(WORKSPACES_ROOT, '_global');
const SKILLS_DIR = path.join(GLOBAL_WORKSPACE, 'Agent 配置', 'skills');

function stripYamlFrontmatter(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;
  let end = 1;
  while (end < lines.length && lines[end]?.trim() !== '---') end++;
  return lines.slice(end + 1).join('\n').trim();
}

function readSkillFile(agentId: string): string | null {
  const skillPath = path.join(SKILLS_DIR, agentId, 'SKILL.md');
  try {
    const raw = readFileSync(skillPath, 'utf-8');
    return stripYamlFrontmatter(raw);
  } catch {
    return null;
  }
}

function discoverSkillDirs(): string[] {
  try {
    return readdirSync(SKILLS_DIR)
      .filter((name) => {
        try {
          return statSync(path.join(SKILLS_DIR, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .filter((name) => {
        try {
          readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8');
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function readAgentsProtocol(): string | null {
  return PRODUCT_PROFILE.mastra.fallbackProtocol || null;
}

const WORKING_MEMORY_TEMPLATES: Record<string, string> = {
  'brainstorm-agent': ['# 脑暴记忆', '- 已探索方向：', '- 已否决方案及原因：', '- 灵感关键词：', '- 用户偏好倾向：'].join('\n'),
  'character-agent': ['# 人物设定记忆', '- 角色表层目标：', '- 角色隐藏需求：', '- 喜剧缺点与行为边界：', '- 角色关系压力：'].join('\n'),
  'continuity-agent': ['# 连续性记忆', '- 已确认项目事实：', '- 已发生剧情事件：', '- 角色关系变化：', '- 不可违背设定：', '- 可回收包袱：'].join('\n'),
  'source-analyst-agent': ['# 原著分析记忆', '- 核心主题与母题：', '- 关键人物关系：', '- 重要场景资产：', '- 改编边界与风险：'].join('\n'),
  'adaptation-planner-agent': ['# 改编方案记忆', '- 全季结构规划：', '- 单集节拍设计：', '- 原著到剧本映射：', '- 已确定的改编决策：'].join('\n'),
  'screenwriter-agent': ['# 编剧记忆', '- 对白风格约束：', '- 场景转换规则：', '- 角色声音特征：', '- 已完成的场次：'].join('\n'),
  'reviewer-agent': ['# 审稿记忆', '- 高频问题模式：', '- 质量标准要点：', '- 已通过项：', '- 待修复项：'].join('\n'),
};

const SPECIALIST_DELEGATION_TEMPLATE = [
  '# Specialist 子任务',
  '{{task}}',
  '{{#context}}# 主 agent 提供的上下文\n\n{{context}}{{/context}}',
  '# 输出要求',
  '只完成该子任务。需要写入正式产物时使用 workspace tools；否则直接返回可供主 agent 综合的结果。',
].join('\n\n');

const SYSTEM_AGENT_INSTRUCTIONS = [
  PRODUCT_PROFILE.mastra.fallbackProtocol,
  '## 主 agent 调度原则',
  '你是默认工作的主 agent，目标是提供自然的创作协作体验。',
  '普通问候、解释问题、读取资料、轻量修改、整理已有内容、保存用户明确指定的小改动，都由你直接完成。',
  '不要先做固定流程分类，不要因为用户提到剧本、方案或故事就自动启动完整流水线。',
  '当用户明确要求生成、绘制、出图、生成角色图/场景图/剧照/分镜图/海报时，使用 generate_project_image 工具生成图片并保存到项目工作区。',
  '调用 generate_project_image 时只填写 prompt、aspectRatio、count；不要尝试填写或猜测模型名，图片模型由系统配置自动注入。',
  '如果用户只是要人物视觉描述、绘图提示词或图片生成建议，不要调用 generate_project_image，直接输出文本。',
  '系统只自动保留最近几轮短期对话；语义检索和长期记忆更新由你按任务需要主动调用工具。',
  '当当前上下文不足以确认早期设定、用户偏好、角色关系、伏笔、已否决方案或审稿标准时，调用 recall_project_memory。',
  '当需要查看或合并结构化项目长期记忆时，调用 read_project_memory；写回完整 Markdown 时调用 update_project_memory。',
  '当本轮产生了未来仍有复用价值的稳定事实、偏好、角色规则、连续性约束、已否决方向或质量标准时，调用 remember_project_memory 写入精选语义记忆。',
  '不要把一次性过程、临时推理、工具流水账、未经确认的猜测或整段对话写入长期记忆。',
  '只有当任务明确需要专业判断或专业产物时，才使用 delegate_to_specialist_agent 委派给 specialist agent。',
  '可委派的 specialist agent：brainstorm-agent、character-agent、continuity-agent、source-analyst-agent、adaptation-planner-agent、screenwriter-agent、reviewer-agent；如果对应 skill 未安装，工具会返回未找到。',
  '委派时只拆出必要的子任务，并把当前上下文、已读取文件摘要、用户目标和期望输出传给 specialist。',
  '收到 specialist 结果后，由你继续综合、解释、决定是否写入文件，并向用户给出最终答复。',
  '如果用户只是要求”帮我改一句/润色一段/解释这个文件/打个招呼”，不要委派。',
  '在情景剧故事创作中，如果人物动机、角色关系或角色行为边界不清，先委派 character-agent；如果涉及多集历史、固定设定或上一集状态，先委派 continuity-agent。',
  '如果用户明确要求”脑暴方向/完善人物/检查连续性/做原著分析/制定改编方案/写正式故事或剧本/严格审稿”，再委派给对应 specialist。',
].join('\n\n');

async function main() {
  if (!isPromptStoreAvailable()) {
    console.error('Error: Langfuse credentials not configured. Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL.');
    process.exit(1);
  }

  console.log(`Product profile: ${PRODUCT_PROFILE.id}`);
  console.log(`Global workspace: ${GLOBAL_WORKSPACE}`);
  console.log();

  const results: Array<{ name: string; status: 'created' | 'skipped' | 'error'; message?: string }> = [];

  const skillDirs = discoverSkillDirs();
  console.log(`Found ${skillDirs.length} skill directories`);

  for (const agentId of skillDirs) {
    const promptName = `${agentId}-skill`;
    const content = readSkillFile(agentId);
    if (!content) {
      results.push({ name: promptName, status: 'skipped', message: 'SKILL.md not found or empty' });
      continue;
    }
    try {
      await createLangfusePrompt(promptName, content, ['production']);
      results.push({ name: promptName, status: 'created' });
      console.log(`  ✓ ${promptName} (${content.length} chars)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: promptName, status: 'error', message });
      console.error(`  ✗ ${promptName}: ${message}`);
    }
  }

  const protocol = readAgentsProtocol();
  if (protocol) {
    try {
      await createLangfusePrompt('system-agent-protocol', protocol, ['production']);
      results.push({ name: 'system-agent-protocol', status: 'created' });
      console.log(`  ✓ system-agent-protocol (${protocol.length} chars)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: 'system-agent-protocol', status: 'error', message });
      console.error(`  ✗ system-agent-protocol: ${message}`);
    }
  }

  try {
    await createLangfusePrompt('system-agent-instructions', SYSTEM_AGENT_INSTRUCTIONS, ['production']);
    results.push({ name: 'system-agent-instructions', status: 'created' });
    console.log(`  ✓ system-agent-instructions (${SYSTEM_AGENT_INSTRUCTIONS.length} chars)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name: 'system-agent-instructions', status: 'error', message });
    console.error(`  ✗ system-agent-instructions: ${message}`);
  }

  for (const [agentId, template] of Object.entries(WORKING_MEMORY_TEMPLATES)) {
    const promptName = `${agentId}-working-memory`;
    try {
      await createLangfusePrompt(promptName, template, ['production']);
      results.push({ name: promptName, status: 'created' });
      console.log(`  ✓ ${promptName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: promptName, status: 'error', message });
      console.error(`  ✗ ${promptName}: ${message}`);
    }
  }

  try {
    await createLangfusePrompt('specialist-delegation', SPECIALIST_DELEGATION_TEMPLATE, ['production']);
    results.push({ name: 'specialist-delegation', status: 'created' });
    console.log(`  ✓ specialist-delegation`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name: 'specialist-delegation', status: 'error', message });
    console.error(`  ✗ specialist-delegation: ${message}`);
  }

  const created = results.filter((r) => r.status === 'created').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`\nDone: ${created} created, ${errors} errors, ${skipped} skipped`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
