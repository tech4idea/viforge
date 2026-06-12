import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api';
import type { GlobalGitConfig, GitLogEntry, GitSyncResult, Project, ProjectGitStatus } from '../api';

type GitSyncPanelProps = {
  apiClient: ApiClient;
  projects: Project[];
  selectedProjectId: string | null;
};

type ProjectSyncState = {
  status: ProjectGitStatus | null;
  loading: boolean;
  syncing: boolean;
  pulling: boolean;
  error: string | null;
  lastResult: GitSyncResult | null;
  log: GitLogEntry[];
};

type GlobalConfigState = {
  config: GlobalGitConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
};

export function GitSyncPanel({ apiClient, projects, selectedProjectId }: GitSyncPanelProps): JSX.Element {
  const [globalConfig, setGlobalConfig] = useState<GlobalConfigState>({
    config: null,
    loading: true,
    saving: false,
    error: null,
  });
  const [globalTokenInput, setGlobalTokenInput] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);

  const [projectSync, setProjectSync] = useState<Record<string, ProjectSyncState>>({});
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const [remoteUrls, setRemoteUrls] = useState<Record<string, string>>({});
  const [projectTokens, setProjectTokens] = useState<Record<string, string>>({});
  const [projectBranches, setProjectBranches] = useState<Record<string, string>>({});
  const [configuringProject, setConfiguringProject] = useState<string | null>(null);
  const [expandedLog, setExpandedLog] = useState<Set<string>>(new Set());

  const loadGlobalConfig = useCallback(async () => {
    setGlobalConfig((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const config = await apiClient.getGlobalGitConfig();
      setGlobalConfig({ config, loading: false, saving: false, error: null });
    } catch (error) {
      setGlobalConfig((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : 'Failed to load' }));
    }
  }, [apiClient]);

  const loadProjectStatus = useCallback(async (projectId: string) => {
    setProjectSync((prev) => ({ ...prev, [projectId]: { ...prev[projectId] ?? emptySyncState(), loading: true } }));
    try {
      const [status, log] = await Promise.all([
        apiClient.getProjectGitStatus(projectId),
        apiClient.getProjectGitLog(projectId, 20),
      ]);
      setProjectSync((prev) => ({
        ...prev,
        [projectId]: { status, log, loading: false, syncing: false, pulling: false, error: null, lastResult: prev[projectId]?.lastResult ?? null },
      }));
    } catch (error) {
      setProjectSync((prev) => ({
        ...prev,
        [projectId]: { ...prev[projectId] ?? emptySyncState(), loading: false, error: error instanceof Error ? error.message : 'Failed' },
      }));
    }
  }, [apiClient]);

  useEffect(() => {
    void loadGlobalConfig();
  }, [loadGlobalConfig]);

  useEffect(() => {
    for (const project of projects) {
      void loadProjectStatus(project.id);
    }
  }, [projects, loadProjectStatus]);

  async function saveGlobalToken() {
    if (!globalTokenInput.trim()) return;
    setGlobalConfig((prev) => ({ ...prev, saving: true }));
    try {
      const config = await apiClient.setGlobalGitConfig({ accessToken: globalTokenInput.trim() });
      setGlobalConfig({ config, loading: false, saving: false, error: null });
      setGlobalTokenInput('');
      setShowTokenInput(false);
    } catch (error) {
      setGlobalConfig((prev) => ({ ...prev, saving: false, error: error instanceof Error ? error.message : 'Failed to save' }));
    }
  }

  async function configureProjectRemote(projectId: string) {
    const url = remoteUrls[projectId]?.trim();
    if (!url) return;
    try {
      await apiClient.setProjectGitConfig(projectId, {
        remoteUrl: url,
        accessToken: projectTokens[projectId]?.trim() || undefined,
        branch: projectBranches[projectId]?.trim() || 'main',
      });
      setConfiguringProject(null);
      await loadProjectStatus(projectId);
    } catch (error) {
      setProjectSync((prev) => ({
        ...prev,
        [projectId]: { ...prev[projectId] ?? emptySyncState(), error: error instanceof Error ? error.message : 'Failed to configure' },
      }));
    }
  }

  async function syncProject(projectId: string) {
    setProjectSync((prev) => ({ ...prev, [projectId]: { ...prev[projectId] ?? emptySyncState(), syncing: true, error: null } }));
    try {
      const message = commitMessages[projectId]?.trim() || undefined;
      const result = await apiClient.syncProjectToRemote(projectId, message);
      setProjectSync((prev) => ({ ...prev, [projectId]: { ...prev[projectId] ?? emptySyncState(), syncing: false, lastResult: result } }));
      setCommitMessages((prev) => ({ ...prev, [projectId]: '' }));
      await loadProjectStatus(projectId);
    } catch (error) {
      setProjectSync((prev) => ({
        ...prev,
        [projectId]: { ...prev[projectId] ?? emptySyncState(), syncing: false, error: error instanceof Error ? error.message : 'Sync failed' },
      }));
    }
  }

  async function pullProject(projectId: string) {
    setProjectSync((prev) => ({ ...prev, [projectId]: { ...prev[projectId] ?? emptySyncState(), pulling: true, error: null } }));
    try {
      const result = await apiClient.pullProjectFromRemote(projectId);
      setProjectSync((prev) => ({ ...prev, [projectId]: { ...prev[projectId] ?? emptySyncState(), pulling: false, lastResult: result } }));
      await loadProjectStatus(projectId);
    } catch (error) {
      setProjectSync((prev) => ({
        ...prev,
        [projectId]: { ...prev[projectId] ?? emptySyncState(), pulling: false, error: error instanceof Error ? error.message : 'Pull failed' },
      }));
    }
  }

  function toggleLog(projectId: string) {
    setExpandedLog((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  const displayProjects = selectedProjectId
    ? projects.filter((p) => p.id === selectedProjectId).concat(projects.filter((p) => p.id !== selectedProjectId))
    : projects;

  return (
    <div className="git-sync-panel">
      <div className="git-global-section">
        <h3 className="git-section-title">Global Access Token</h3>
        <p className="muted">GitLab 访问令牌，用于所有项目的远端仓库鉴权。可以为每个项目单独设置覆盖令牌。</p>
        {globalConfig.loading ? (
          <p className="muted">Loading...</p>
        ) : globalConfig.config ? (
          <div className="git-token-display">
            <span className="git-token-masked">{globalConfig.config.accessToken}</span>
            <button type="button" onClick={() => setShowTokenInput(!showTokenInput)}>
              {showTokenInput ? '取消' : '修改令牌'}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setShowTokenInput(true)}>配置访问令牌</button>
        )}
        {globalConfig.error ? <p className="inline-error">{globalConfig.error}</p> : null}
        {showTokenInput ? (
          <div className="git-token-form">
            <input
              type="password"
              value={globalTokenInput}
              onChange={(event) => setGlobalTokenInput(event.target.value)}
              placeholder="输入 GitLab Personal Access Token"
            />
            <button type="button" onClick={saveGlobalToken} disabled={globalConfig.saving || !globalTokenInput.trim()}>
              {globalConfig.saving ? '保存中...' : '保存'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="git-projects-section">
        <h3 className="git-section-title">项目版本管理</h3>
        {displayProjects.length === 0 ? <p className="muted">暂无项目</p> : null}
        {displayProjects.map((project) => {
          const sync = projectSync[project.id] ?? emptySyncState();
          const isConfiguring = configuringProject === project.id;
          const hasRemote = project.git?.remoteUrl || sync.status?.hasRemote;

          return (
            <div key={project.id} className="git-project-card">
              <div className="git-project-header">
                <strong>{project.name}</strong>
                {sync.status ? (
                  <span className={`status-pill ${getStatusClass(sync.status)}`}>
                    {getStatusText(sync.status)}
                  </span>
                ) : null}
              </div>

              {sync.loading ? <p className="muted">加载状态中...</p> : null}
              {sync.error ? <p className="inline-error">{sync.error}</p> : null}

              {sync.lastResult ? (
                <p className={`git-result ${sync.lastResult.success ? 'success' : 'error'}`}>
                  {sync.lastResult.message}
                  {sync.lastResult.commitHash ? ` (${sync.lastResult.commitHash})` : ''}
                </p>
              ) : null}

              {!hasRemote && !isConfiguring ? (
                <button type="button" onClick={() => {
                  setConfiguringProject(project.id);
                  setRemoteUrls((prev) => ({ ...prev, [project.id]: project.git?.remoteUrl ?? '' }));
                  setProjectBranches((prev) => ({ ...prev, [project.id]: project.git?.branch ?? 'main' }));
                }}>
                  配置远端仓库
                </button>
              ) : null}

              {isConfiguring ? (
                <div className="git-config-form">
                  <label>
                    远端仓库 URL
                    <input
                      type="text"
                      value={remoteUrls[project.id] ?? ''}
                      onChange={(event) => setRemoteUrls((prev) => ({ ...prev, [project.id]: event.target.value }))}
                      placeholder="https://gitlab.com/group/repo.git"
                    />
                  </label>
                  <label>
                    分支
                    <input
                      type="text"
                      value={projectBranches[project.id] ?? 'main'}
                      onChange={(event) => setProjectBranches((prev) => ({ ...prev, [project.id]: event.target.value }))}
                      placeholder="main"
                    />
                  </label>
                  <label>
                    项目访问令牌 (可选)
                    <input
                      type="password"
                      value={projectTokens[project.id] ?? ''}
                      onChange={(event) => setProjectTokens((prev) => ({ ...prev, [project.id]: event.target.value }))}
                      placeholder="留空则使用全局令牌"
                    />
                  </label>
                  <div className="git-config-actions">
                    <button type="button" onClick={() => configureProjectRemote(project.id)}>保存配置</button>
                    <button type="button" onClick={() => setConfiguringProject(null)}>取消</button>
                  </div>
                </div>
              ) : null}

              {hasRemote ? (
                <div className="git-sync-controls">
                  {project.git?.remoteUrl ? <p className="muted git-remote-url">{project.git.remoteUrl}</p> : null}
                  {sync.status?.lastSyncAt ? (
                    <p className="muted">上次同步: {formatDate(sync.status.lastSyncAt)}</p>
                  ) : null}
                  <div className="git-sync-form">
                    <input
                      type="text"
                      value={commitMessages[project.id] ?? ''}
                      onChange={(event) => setCommitMessages((prev) => ({ ...prev, [project.id]: event.target.value }))}
                      placeholder="提交信息 (可选)"
                    />
                    <button type="button" onClick={() => syncProject(project.id)} disabled={sync.syncing}>
                      {sync.syncing ? '同步中...' : '同步到远端'}
                    </button>
                    <button type="button" onClick={() => pullProject(project.id)} disabled={sync.pulling}>
                      {sync.pulling ? '拉取中...' : '拉取远端'}
                    </button>
                  </div>
                  {sync.status?.changedFiles ? (
                    <p className="muted">{sync.status.changedFiles} 个文件已修改</p>
                  ) : (
                    <p className="muted">工作区干净</p>
                  )}
                  {sync.log.length > 0 ? (
                    <div className="git-log-section">
                      <button type="button" className="git-log-toggle" onClick={() => toggleLog(project.id)}>
                        {expandedLog.has(project.id) ? '收起提交记录' : `查看提交记录 (${sync.log.length})`}
                      </button>
                      {expandedLog.has(project.id) ? (
                        <ul className="git-log-list">
                          {sync.log.map((entry) => (
                            <li key={entry.hash} className="git-log-entry">
                              <span className="git-log-hash">{entry.shortHash}</span>
                              <span className="git-log-message">{entry.message}</span>
                              <span className="git-log-date">{formatDate(entry.date)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function emptySyncState(): ProjectSyncState {
  return { status: null, loading: false, syncing: false, pulling: false, error: null, lastResult: null, log: [] };
}

function getStatusClass(status: ProjectGitStatus): string {
  if (!status.initialized) return '';
  if (!status.hasRemote) return '';
  if (status.changedFiles > 0) return 'warning';
  return 'success';
}

function getStatusText(status: ProjectGitStatus): string {
  if (!status.initialized) return '未初始化';
  if (!status.hasRemote) return '未配置远端';
  if (status.changedFiles > 0) return `${status.changedFiles} 个变更`;
  return '已同步';
}

function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
