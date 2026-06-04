import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './api';
import { AssistantStreamBody, collectAgentTraceEvents, streamEventsFromRunEvents, stripAgentTraceBlocks } from './assistant-stream';

describe('assistant stream trace UI', () => {
  it('collects agent trace events and strips trace JSON from visible markdown', () => {
    const content = '改编方案\n```json\n{"type":"agent.step.start","agentId":"adaptation-planner-agent","phase":"改编方案","iteration":1,"maxIterations":5}\n```\n结尾';

    expect(stripAgentTraceBlocks(content)).toBe('改编方案\n\n结尾');
    expect(collectAgentTraceEvents([
      { type: 'agent.step.start', runId: 'run_1', emittedAt: 'now', agentId: 'adaptation-planner-agent', phase: '改编方案', iteration: 1, maxIterations: 5 },
      { type: 'text.delta', runId: 'run_1', emittedAt: 'now', delta: '改编方案', sequence: 1 },
    ])).toHaveLength(1);
  });

  it('renders timeline, rejection reasons, and output path', () => {
    const message: ChatMessage = {
      id: 'message-1',
      role: 'assistant',
      content: '最终改编方案',
      createdAt: '2026-05-25T00:00:00.000Z',
      referencedFiles: [],
      status: 'success',
      events: [],
      streamEvents: [
        { type: 'agent.step.start', runId: 'run_1', emittedAt: 'now', agentId: 'adaptation-planner-agent', phase: '改编方案', iteration: 1, maxIterations: 5 },
        { type: 'agent.review.reject', runId: 'run_1', emittedAt: 'now', targetAgentId: 'adaptation-planner-agent', iteration: 1, maxIterations: 5, reasons: ['原著范围不清晰'] },
        { type: 'agent.workflow.end', runId: 'run_1', emittedAt: 'now', status: 'passed', outputPath: '02 改编方案/01 第一集/单集改编方案.md' },
        { type: 'run.end', runId: 'run_1', emittedAt: 'now', status: 'success', errorMessage: null },
      ],
    };

    const html = renderToStaticMarkup(<AssistantStreamBody message={message} />);

    expect(html).toContain('改编方案');
    expect(html).toContain('当前阶段');
    expect(html).toContain('第 1/5 轮');
    expect(html).toContain('打回 改编方案');
    expect(html).toContain('打回详情');
    expect(html).toContain('原著范围不清晰');
    expect(html).toContain('最终结果');
    expect(html).toContain('未保存内容：无');
    expect(html).toContain('02 改编方案/01 第一集/单集改编方案.md');
    expect(html).toContain('最终改编方案');
  });

  it('converts legacy run events into stream events for the timeline renderer', () => {
    const streamEvents = streamEventsFromRunEvents([
      { type: 'run.start', runId: 'run_1' },
      { type: 'agent.step.start', runId: 'run_1', agentId: 'adaptation-planner-agent', phase: '改编方案', iteration: 1, maxIterations: 5 },
      { type: 'agent.review.reject', runId: 'run_1', targetAgentId: 'adaptation-planner-agent', iteration: 1, maxIterations: 5, reasons: ['原著范围不清晰'] },
      { type: 'agent.workflow.end', runId: 'run_1', status: 'passed', outputPath: '02 改编方案/01 第一集/单集改编方案.md' },
      { type: 'run.end', runId: 'run_1', status: 'success' },
    ]);

    expect(streamEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent.step.start', agentId: 'adaptation-planner-agent', maxIterations: 5 }),
      expect.objectContaining({ type: 'agent.review.reject', maxIterations: 5, reasons: ['原著范围不清晰'] }),
      expect.objectContaining({ type: 'agent.workflow.end', outputPath: '02 改编方案/01 第一集/单集改编方案.md' }),
    ]));
  });
});
