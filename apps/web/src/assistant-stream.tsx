import { memo, useMemo } from 'react';

import type { AgentTraceEvent, ChatMessage, RunEvent, StreamEvent } from './api';
import { MarkdownReadPreview } from './viewer-components';

type TraceSnapshot = {
  phase: string;
  agentId: string;
  status: 'running' | 'passed' | 'rejected' | 'failed' | 'stopped';
  iteration?: number;
  maxIterations?: number;
};

export const AssistantStreamBody = memo(function AssistantStreamBody({ message }: { message: ChatMessage }): JSX.Element {
  const traceEvents = useMemo(() => collectAgentTraceEvents(message.streamEvents), [message.streamEvents]);
  const displayContent = useMemo(() => stripAgentTraceBlocks(message.content), [message.content]);
  const thinking = useMemo(() => collectThinkingBlocks(message.streamEvents), [message.streamEvents]);
  const tools = useMemo(() => collectToolCalls(message.streamEvents), [message.streamEvents]);

  if (message.streamEvents.length === 0) {
    return (
      <div className="chat-markdown">
        <MarkdownReadPreview content={displayContent || (message.status === 'running' ? '正在思考...' : '')} />
      </div>
    );
  }

  return (
    <div className="assistant-stream">
      {traceEvents.length > 0 ? <AgentTraceTimeline events={traceEvents} /> : null}
      {thinking.map((block) => (
        <details key={block.sequence} className="thinking-block" open={message.status === 'running'}>
          <summary>思考过程</summary>
          <div>{block.text || '正在思考...'}</div>
        </details>
      ))}
      {tools.length > 0 ? (
        <div className="tool-call-list">
          {tools.map((toolCall) => (
            <details key={toolCall.id} className="tool-call-card">
              <summary>
                <span>{toolCall.name}</span>
                <em>{toolCall.status}</em>
              </summary>
              {toolCall.input ? <pre>{toolCall.input}</pre> : null}
              {toolCall.output ? <pre>{toolCall.output}</pre> : null}
            </details>
          ))}
        </div>
      ) : null}
      <div className="chat-markdown">
        <MarkdownReadPreview content={displayContent || (message.status === 'running' ? '正在生成...' : '')} />
      </div>
    </div>
  );
});

function AgentTraceTimeline({ events }: { events: AgentTraceEvent[] }): JSX.Element {
  const snapshot = currentTraceSnapshot(events);
  const timelineEvents = events.filter((event): event is Extract<AgentTraceEvent, { type: 'agent.step.start' | 'agent.step.end' | 'agent.review.reject' }> =>
    event.type === 'agent.step.start' || event.type === 'agent.step.end' || event.type === 'agent.review.reject',
  );
  const rejections = events.filter((event): event is Extract<AgentTraceEvent, { type: 'agent.review.reject' }> =>
    event.type === 'agent.review.reject',
  );
  const workflowEnd = [...events].reverse().find((event): event is Extract<AgentTraceEvent, { type: 'agent.workflow.end' }> =>
    event.type === 'agent.workflow.end',
  );

  return (
    <div className="agent-trace">
      {snapshot ? (
        <div className="agent-trace__summary">
          <span>
            <small>当前阶段</small>
            <strong>{snapshot.phase}</strong>
          </span>
          <span>
            <small>当前 agent</small>
            <strong>{agentLabel(snapshot.agentId)}</strong>
          </span>
          <span>
            <small>状态</small>
            <strong>{statusLabel(snapshot.status)}</strong>
          </span>
          <span>
            <small>返工轮次</small>
            <strong>{iterationLabel(snapshot.iteration, snapshot.maxIterations)}</strong>
          </span>
        </div>
      ) : null}
      <div className="agent-trace__timeline">
        {timelineEvents.map((event, index) => {
          if (event.type === 'agent.review.reject') {
            return (
              <span
                key={`${event.type}-${event.targetAgentId}-${event.iteration}-${index}`}
                className="agent-trace__node agent-trace__node--rejected"
                title={event.reasons.join('；')}
              >
                <strong>打回 {agentLabel(event.targetAgentId)}</strong>
                <em>{iterationLabel(event.iteration, event.maxIterations)} · {event.reasons[0] ?? '未说明原因'}</em>
              </span>
            );
          }
          return (
            <span key={`${event.type}-${event.agentId}-${event.phase}-${event.iteration}-${index}`} className={`agent-trace__node agent-trace__node--${event.type === 'agent.step.start' ? 'running' : event.status}`}>
              <strong>{agentLabel(event.agentId)}</strong>
              <em>{event.phase} · {iterationLabel(event.iteration, event.maxIterations)}</em>
            </span>
          );
        })}
        {workflowEnd ? (
          <span className={`agent-trace__node agent-trace__node--${workflowEnd.status === 'passed' ? 'passed' : 'stopped'}`}>
            <strong>{workflowEnd.status === 'passed' ? '已通过' : '已停止'}</strong>
            {workflowEnd.outputPath ? <em>{workflowEnd.outputPath}</em> : null}
          </span>
        ) : null}
      </div>
      {workflowEnd ? (
        <div className="agent-trace__result">
          <strong>最终结果</strong>
          <span>{workflowEnd.outputPath ? `已写入：${workflowEnd.outputPath}` : '未写入正式文件'}</span>
          <span>未保存内容：{workflowEnd.status === 'passed' && workflowEnd.outputPath ? '无' : '需要人工确认'}</span>
        </div>
      ) : null}
      {rejections.length > 0 ? (
        <details className="agent-trace__rejects">
          <summary>打回详情</summary>
          {rejections.map((event) => (
            <div key={`${event.targetAgentId}-${event.iteration}`} className="agent-trace__reject">
              <strong>{iterationLabel(event.iteration, event.maxIterations)} 打回 {agentLabel(event.targetAgentId)}</strong>
              <ul>
                {event.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function currentTraceSnapshot(events: AgentTraceEvent[]): TraceSnapshot | null {
  return events.reduce<TraceSnapshot | null>((snapshot, event) => {
    if (event.type === 'agent.step.start') {
      return { phase: event.phase, agentId: event.agentId, status: 'running', iteration: event.iteration, maxIterations: event.maxIterations };
    }
    if (event.type === 'agent.step.end') {
      return { phase: event.phase, agentId: event.agentId, status: event.status, iteration: event.iteration, maxIterations: event.maxIterations };
    }
    if (event.type === 'agent.review.reject') {
      return { phase: '审稿打回', agentId: event.targetAgentId, status: 'rejected', iteration: event.iteration, maxIterations: event.maxIterations };
    }
    if (event.type === 'agent.workflow.end') {
      return {
        phase: '保存结果',
        agentId: 'system',
        status: event.status,
        iteration: snapshot?.iteration,
        maxIterations: snapshot?.maxIterations,
      };
    }
    return snapshot;
  }, null);
}

export function collectAgentTraceEvents(events: StreamEvent[]): AgentTraceEvent[] {
  return events.filter((event): event is AgentTraceEvent => event.type.startsWith('agent.'));
}

export function streamEventsFromRunEvents(events: RunEvent[]): StreamEvent[] {
  const toolIdsByName = new Map<string, string[]>();
  let textSequence = 0;
  let toolSequence = 0;
  let toolDeltaSequence = 0;

  return events.flatMap((event): StreamEvent[] => {
    const emittedAt = new Date().toISOString();
    switch (event.type) {
      case 'run.start':
        return [{ type: 'run.start', runId: event.runId, emittedAt }];
      case 'text.delta':
      case 'text.message':
        return [{ type: 'text.delta', runId: event.runId, emittedAt, delta: event.text, sequence: ++textSequence }];
      case 'agent.step.start':
        return [{ ...event, emittedAt }];
      case 'agent.step.end':
        return [{ ...event, emittedAt }];
      case 'agent.review.reject':
        return [{ ...event, emittedAt }];
      case 'agent.workflow.end':
        return [{ ...event, emittedAt }];
      case 'tool.use': {
        const toolCallId = `${event.runId}-tool-${++toolSequence}`;
        toolIdsByName.set(event.name, [...(toolIdsByName.get(event.name) ?? []), toolCallId]);
        const streamEvents: StreamEvent[] = [
          { type: 'tool_use.start', runId: event.runId, emittedAt, toolCallId, toolName: event.name },
        ];
        if (event.input !== undefined) {
          streamEvents.push({
            type: 'tool_use.delta',
            runId: event.runId,
            emittedAt,
            toolCallId,
            stream: 'input',
            delta: JSON.stringify(event.input),
            sequence: ++toolDeltaSequence,
          });
        }
        return streamEvents;
      }
      case 'tool.result': {
        const toolCallId = toolIdsByName.get(event.name)?.shift() ?? `${event.runId}-tool-${++toolSequence}`;
        return [{
          type: 'tool_use.end',
          runId: event.runId,
          emittedAt,
          toolCallId,
          status: 'succeeded',
          outputText: event.output === undefined ? null : JSON.stringify(event.output),
          errorMessage: null,
        }];
      }
      case 'file.changed':
        return [{ type: 'file.changed', runId: event.runId, emittedAt, path: event.path, change: event.change }];
      case 'run.end':
        return [{
          type: 'run.end',
          runId: event.runId,
          emittedAt,
          status: event.status === 'error' ? 'error' : event.status === 'cancelled' ? 'cancelled' : 'success',
          errorMessage: event.error ?? null,
        }];
    }
  });
}

export function stripAgentTraceBlocks(content: string): string {
  return content
    .replace(/```json\s*\{\s*"type"\s*:\s*"agent\.[\s\S]*?```/g, '')
    .trim();
}

function collectThinkingBlocks(events: StreamEvent[]): Array<{ sequence: number; text: string }> {
  const blocks = new Map<number, string>();

  for (const event of events) {
    if (event.type === 'thinking.delta') {
      blocks.set(event.sequence, (blocks.get(event.sequence) ?? '') + event.delta);
    }
    if (event.type === 'thinking.end') {
      blocks.set(event.sequence, event.text);
    }
  }

  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sequence, text]) => ({ sequence, text }));
}

function collectToolCalls(events: StreamEvent[]): Array<{
  id: string;
  name: string;
  input: string;
  output: string;
  status: string;
}> {
  const toolCalls = new Map<string, { id: string; name: string; input: string; output: string; status: string }>();

  for (const event of events) {
    if (event.type === 'tool_use.start') {
      toolCalls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        input: '',
        output: '',
        status: 'running',
      });
    }
    if (event.type === 'tool_use.delta') {
      const toolCall = toolCalls.get(event.toolCallId);
      if (!toolCall) continue;
      if (event.stream === 'input') {
        toolCall.input += event.delta;
      } else {
        toolCall.output += event.delta;
      }
    }
    if (event.type === 'tool_use.end') {
      const toolCall = toolCalls.get(event.toolCallId) ?? {
        id: event.toolCallId,
        name: event.toolCallId,
        input: '',
        output: '',
        status: event.status,
      };
      toolCall.status = event.status;
      toolCall.output = event.outputText ?? toolCall.output;
      if (event.errorMessage) {
        toolCall.output = event.errorMessage;
      }
      toolCalls.set(event.toolCallId, toolCall);
    }
  }

  return [...toolCalls.values()];
}

function agentLabel(agentId: string): string {
  const labels: Record<string, string> = {
    system: 'system',
    'brainstorm-agent': '脑暴',
    'source-analyst-agent': '原著分析',
    'adaptation-planner-agent': '改编方案',
    'screenwriter-agent': '编剧',
    'reviewer-agent': '审稿',
  };
  return labels[agentId] ?? agentId;
}

function statusLabel(status: TraceSnapshot['status']): string {
  const labels: Record<TraceSnapshot['status'], string> = {
    running: '运行中',
    passed: '通过',
    rejected: '打回',
    failed: '失败',
    stopped: '已停止',
  };
  return labels[status];
}

function iterationLabel(iteration?: number, maxIterations?: number): string {
  if (!iteration) {
    return '无';
  }
  return maxIterations ? `第 ${iteration}/${maxIterations} 轮` : `第 ${iteration} 轮`;
}
