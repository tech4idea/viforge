import type { WechatIlinkClient } from './wechatIlinkClient';
import type { WechatStore } from './wechatStore';

const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 3_000;

export type WechatPoller = {
  start(): void;
  stop(): Promise<void>;
  status(): { running: boolean; lastPollAt: string | null; error: string | null };
};

export type WechatMessageHandler = (update: {
  fromUserId: string;
  fromDisplayName: string;
  text: string;
  contextToken: string;
  messageId: string;
}) => Promise<void>;

export function createWechatPoller(
  ilinkClient: WechatIlinkClient,
  wechatStore: WechatStore,
  onMessage: WechatMessageHandler,
): WechatPoller {
  let running = false;
  let lastPollAt: string | null = null;
  let pollError: string | null = null;
  let runningPromise: Promise<void> | null = null;

  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        const cursor = await wechatStore.getIlinkPollCursor();
        const result = await ilinkClient.getUpdates(cursor ?? '');

        lastPollAt = new Date().toISOString();
        pollError = null;

        if (result.updates.length > 0) {
          console.info('[wechat-poller] updates received', {
            count: result.updates.length,
            previousCursor: cursor ?? '',
            nextCursor: result.cursor,
          });
        }

        if (result.cursor) {
          await wechatStore.setIlinkPollCursor(result.cursor);
        }

        for (const update of result.updates) {
          try {
            console.info('[wechat-poller] dispatch message', {
              fromUserId: update.fromUserId,
              messageId: update.updateId,
              textLength: update.text.length,
              hasContextToken: Boolean(update.contextToken),
            });
            await onMessage({
              fromUserId: update.fromUserId,
              fromDisplayName: update.fromDisplayName,
              text: update.text,
              contextToken: update.contextToken,
              messageId: update.updateId,
            });
          } catch (err) {
            console.error('[wechat-poller] msg handler error', err);
          }
        }
      } catch (err) {
        pollError = err instanceof Error ? err.message : 'Poll failed';
        console.error('[wechat-poller] poll error, retrying in', RETRY_DELAY_MS, 'ms', err);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      pollError = null;
      console.info('[wechat-poller] started');
      runningPromise = pollLoop();
    },

    async stop() {
      if (!running) return;
      running = false;
      if (runningPromise) {
        await runningPromise.catch(() => {});
        runningPromise = null;
      }
      console.info('[wechat-poller] stopped');
    },

    status() {
      return { running, lastPollAt, error: pollError };
    },
  };
}
