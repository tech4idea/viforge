import { DiagConsoleLogger, DiagLogLevel, diag, trace, SpanStatusCode, type Span, type SpanOptions } from '@opentelemetry/api';
import { register } from '@arizeai/phoenix-otel';
import { LangChainInstrumentation, isPatched as isLangChainInstrumentationPatched } from '@arizeai/openinference-instrumentation-langchain';
import * as CallbackManagerModule from '@langchain/core/callbacks/manager';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { PHOENIX_COLLECTOR_ENDPOINT, PHOENIX_PROJECT_NAME, PHOENIX_SERVICE_NAME } from '../env';
import { appendJsonLog } from '../logger';

let provider: NodeTracerProvider | null = null;
let initializationErrorLogged = false;
let shutdownHandlersRegistered = false;

export function initializePhoenixTracing(): boolean {
  if (!PHOENIX_COLLECTOR_ENDPOINT) return false;
  if (provider) return true;

  try {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

    provider = register({
      projectName: PHOENIX_PROJECT_NAME,
      url: PHOENIX_COLLECTOR_ENDPOINT,
      headers: { 'project-name': PHOENIX_PROJECT_NAME },
      batch: false,
      global: true,
    }) as NodeTracerProvider;

    const instrumentation = new LangChainInstrumentation({ tracerProvider: provider });
    instrumentation.manuallyInstrument(CallbackManagerModule);
    registerFlushHandlers(provider);

    appendJsonLog('api.log', {
      scope: 'phoenix',
      stage: 'tracing.enabled',
      endpoint: PHOENIX_COLLECTOR_ENDPOINT,
      projectName: PHOENIX_PROJECT_NAME,
      serviceName: PHOENIX_SERVICE_NAME,
      langChainPatched: isLangChainInstrumentationPatched(),
    });
    console.info('[phoenix] tracing enabled', {
      endpoint: PHOENIX_COLLECTOR_ENDPOINT,
      projectName: PHOENIX_PROJECT_NAME,
      serviceName: PHOENIX_SERVICE_NAME,
      langChainPatched: isLangChainInstrumentationPatched(),
    });
    return true;
  } catch (error) {
    if (!initializationErrorLogged) {
      initializationErrorLogged = true;
      const message = error instanceof Error ? error.message : String(error);
      appendJsonLog('api.error.log', { scope: 'phoenix', stage: 'tracing.init_error', error: message });
      console.error('[phoenix] tracing init failed', error);
    }
    return false;
  }
}

export function isPhoenixTracingEnabled(): boolean {
  return Boolean(provider) || initializePhoenixTracing();
}

export async function flushPhoenixTracing(): Promise<void> {
  if (!provider) return;
  try {
    appendJsonLog('api.log', { scope: 'phoenix', stage: 'tracing.force_flush.start', projectName: PHOENIX_PROJECT_NAME });
    await provider.forceFlush();
    appendJsonLog('api.log', { scope: 'phoenix', stage: 'tracing.force_flush.success', projectName: PHOENIX_PROJECT_NAME });
    console.info('[phoenix] force flush complete', { projectName: PHOENIX_PROJECT_NAME });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendJsonLog('api.error.log', { scope: 'phoenix', stage: 'tracing.flush_error', error: message });
    console.error('[phoenix] force flush failed', error);
  }
}

export async function withPhoenixSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const enabled = isPhoenixTracingEnabled();
  const tracer = trace.getTracer('viwork-api');
  const span = tracer.startSpan(name, {
    ...options,
    attributes: enabled ? sanitizeAttributes(projectAttributes(attributes)) : undefined,
  });
  appendJsonLog('api.log', {
    scope: 'phoenix',
    stage: 'span.start',
    name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    projectName: PHOENIX_PROJECT_NAME,
  });

  try {
    return await fn(span);
  } catch (error) {
    recordException(span, error);
    throw error;
  } finally {
    span.end();
    appendJsonLog('api.log', {
      scope: 'phoenix',
      stage: 'span.end',
      name,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      projectName: PHOENIX_PROJECT_NAME,
    });
  }
}

export function createPhoenixCallbackHandler(): null {
  return null;
}

function recordException(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean | string[] | number[] | boolean[]> {
  const sanitized: Record<string, string | number | boolean | string[] | number[] | boolean[]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      sanitized[key] = value;
    } else {
      sanitized[key] = preview(value);
    }
  }
  return sanitized;
}

function projectAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    ...attributes,
    'project.name': PHOENIX_PROJECT_NAME,
    'phoenix.project.name': PHOENIX_PROJECT_NAME,
    'service.name': PHOENIX_SERVICE_NAME,
  };
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function registerFlushHandlers(activeProvider: NodeTracerProvider): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  const flush = () => {
    void activeProvider.forceFlush().catch((error) => {
      appendJsonLog('api.error.log', {
        scope: 'phoenix',
        stage: 'tracing.flush_error',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  process.once('beforeExit', flush);
  process.once('SIGINT', flush);
  process.once('SIGTERM', flush);
}
