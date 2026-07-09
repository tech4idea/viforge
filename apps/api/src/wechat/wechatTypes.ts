export type WechatRouteState = {
  scope: 'project' | 'temporary';
  projectId: string | null;
  projectName: string | null;
  lastCommandAt: string | null;
};

export type PendingSessionOption = {
  index: number;
  type: 'session' | 'new_session';
  projectId: string;
  projectName: string;
  sessionId?: string;
  sessionTitle: string;
};

export type PendingSessionAction =
  | { type: 'new_session'; projectName: string; projectId: string | null; originalPrompt: string }
  | {
    type: 'switch_session';
    projectName: string;
    projectId: string;
    originalPrompt: string;
    sessionId?: string;
    sessionTitle?: string;
    sessionOptions?: PendingSessionOption[];
  };

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
