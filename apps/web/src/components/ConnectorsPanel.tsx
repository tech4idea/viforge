import { memo } from 'react';
import { RefreshCw } from './icons';
import { resolveApiUrl, type BrowserConnectorStatus, type WechatStatus, type WechatSetupSession } from '../api';

const PLAYWRITER_EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe';

export const ConnectorsPanel = memo(function ConnectorsPanel({
  browserStatus,
  browserLoading,
  onRefreshBrowser,
  wechatStatus,
  wechatSetup,
  wechatLoading,
  onCreateWechatSetup,
  onDisconnectWechat,
}: {
  browserStatus: BrowserConnectorStatus | null;
  browserLoading: boolean;
  onRefreshBrowser: () => void;
  wechatStatus: WechatStatus | null;
  wechatSetup: WechatSetupSession | null;
  wechatLoading: boolean;
  onCreateWechatSetup: () => void;
  onDisconnectWechat: () => Promise<unknown>;
}): JSX.Element {
  const isBrowserConnected = browserStatus?.relayReachable && (browserStatus.connectedBrowsers ?? 0) > 0;
  const isWechatConnected = wechatStatus?.state === 'connected';

  return (
    <div className="connectors-panel">
      <section className="connector-section">
        <div className="connector-section-header">
          <h3>浏览器连接器</h3>
          <button
            type="button"
            className="connector-refresh-btn"
            onClick={onRefreshBrowser}
            disabled={browserLoading}
            title="刷新状态"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {browserLoading && !browserStatus ? (
          <p className="muted">正在检查浏览器连接状态...</p>
        ) : browserStatus?.portConflict ? (
          <div className="connector-port-conflict">
            <p className="connector-port-conflict-title">浏览器连接服务启动失败</p>
            <p className="connector-port-conflict-text">
              端口 19988 已被其他程序占用，后台浏览器连接服务无法启动。
              {browserStatus.portConflictDetail ? ` (${browserStatus.portConflictDetail})` : ''}
            </p>
            <p className="connector-port-conflict-text">请关闭占用该端口的程序后点击刷新重试。</p>
          </div>
        ) : isBrowserConnected ? (
          <div className="connector-connected">
            <p className="status-pill success">已连接</p>

            <div className="connector-detail-card connector-browser-card">
              <p className="connector-detail-line">
                浏览器已连接 · {formatBrowserConnectionSummary(browserStatus!)}
              </p>

              {browserStatus!.tabs.length > 0 ? (
                <div className="connector-tab-list">
                  {browserStatus!.tabs.map((tab) => (
                    <div className="connector-tab-item" key={tab.id}>
                      <p className="connector-tab-title">{tab.title || '未命名标签页'}</p>
                      {tab.url ? <p className="connector-tab-url">{tab.url}</p> : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">已授权标签页：{browserStatus!.connectedBrowsers} 个</p>
              )}

              <p className="muted connector-disconnect-hint">
                如需断开连接，请在对应浏览器标签页点击 Playwriter 扩展图标取消授权。
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="status-pill idle">未连接</p>
            {browserStatus?.relayError ? (
              <p className="muted" style={{ marginBottom: 8 }}>
                {browserStatus.relayError}
              </p>
            ) : null}
            <ol className="connector-steps">
              <li>
                <a className="connector-link" href={PLAYWRITER_EXTENSION_URL} target="_blank" rel="noreferrer">
                  安装 Playwriter Chrome 扩展
                </a>
              </li>
              {(browserStatus?.installSteps.slice(1) ?? []).map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </>
        )}
        <div className="connector-boundary-note">
          <h4>安全边界提醒</h4>
          <p className="muted">
            浏览器工具仅能访问您通过 Playwriter 扩展授权的标签页。登录、发布、删除、付款、授权等高风险操作需要您在浏览器中手动确认。
          </p>
        </div>
      </section>

      <section className="connector-section">
        <h3>微信连接器</h3>

        {wechatLoading && !wechatStatus ? (
          <p className="muted">正在读取微信接入状态...</p>
        ) : null}

        <p className={`status-pill ${isWechatConnected ? 'success' : 'idle'}`}>
          {isWechatConnected ? `已连接：${wechatStatus!.connection?.displayName}` : '未连接'}
        </p>

        {isWechatConnected ? (
          <div className="connector-detail-card">
            <p className="muted">
              微信已连接 · 用户: {wechatStatus!.connection?.displayName}
              <br />
              连接时间: {wechatStatus!.connection?.connectedAt ? new Date(wechatStatus!.connection!.connectedAt).toLocaleString() : '-'}
            </p>
            <button
              type="button"
              className="wechat-small-btn"
              style={{ marginTop: 8 }}
              onClick={() => void onDisconnectWechat()}
            >
              解绑微信
            </button>
          </div>
        ) : (
          <div className="connector-detail-card">
            <button type="button" onClick={onCreateWechatSetup}>
              生成连接码
            </button>
            {wechatSetup ? (
              <div className="wechat-qr-wrap">
                <img
                  src={resolveApiUrl(`/api/wechat/setup-sessions/${encodeURIComponent(wechatSetup.sessionId)}/qr`)}
                  alt="微信扫码连接"
                  width={200}
                  height={200}
                />
                <p className="muted" style={{ fontSize: '0.7rem', marginTop: 6 }}>
                  请用微信扫描二维码，等待自动连接
                </p>
              </div>
            ) : null}
          </div>
        )}
        <p className="muted">扫码后自动完成绑定。微信入站消息会自动通过创作助手处理。</p>
      </section>
    </div>
  );
});

function formatBrowserConnectionSummary(status: BrowserConnectorStatus): string {
  const firstConnection = status.connections[0];
  const profile = firstConnection?.profile?.email || firstConnection?.profile?.id;
  const tabs = status.tabs.length > 0 ? status.tabs.length : status.connectedBrowsers;
  return `${profile ? `${profile} · ` : ''}${tabs} 个授权标签页`;
}
