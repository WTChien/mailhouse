import { useEffect, useState } from 'react';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeySummary } from '../lib/api';


type Props = {
  onClose: () => void;
};

function formatDateTime(value?: string | null) {
  if (!value) return '尚未使用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export default function ApiSettingsModal({ onClose }: Props) {
  const [adminKey, setAdminKey] = useState('');
  const [keyName, setKeyName] = useState('ADB automation');
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [generatedKey, setGeneratedKey] = useState('');
  const [errorText, setErrorText] = useState('');
  const [statusText, setStatusText] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const loadKeys = async () => {
    if (!adminKey.trim()) {
      setErrorText('請先輸入後端設定的管理密鑰。');
      return;
    }

    setIsLoading(true);
    setErrorText('');
    try {
      const result = await listApiKeys(adminKey.trim());
      setApiKeys(result.api_keys ?? []);
      setStatusText('使用量已更新');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '無法載入 API Keys。');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!adminKey.trim() || !keyName.trim()) {
      setErrorText('請輸入管理密鑰及 API Key 名稱。');
      return;
    }

    setIsLoading(true);
    setErrorText('');
    setGeneratedKey('');
    try {
      const result = await createApiKey(keyName.trim(), adminKey.trim());
      setGeneratedKey(result.api_key);
      setApiKeys((current) => [result.key, ...current.filter((item) => item.id !== result.key.id)]);
      setStatusText('API Key 已建立。請立即複製，關閉後無法再次查看完整內容。');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '建立 API Key 失敗。');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevoke = async (item: ApiKeySummary) => {
    if (!window.confirm(`確定要停用「${item.name}」嗎？停用後外部專案將立即無法使用此 Key。`)) return;
    setIsLoading(true);
    setErrorText('');
    try {
      await revokeApiKey(item.id, adminKey.trim());
      await loadKeys();
      setStatusText('API Key 已停用');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '停用 API Key 失敗。');
      setIsLoading(false);
    }
  };

  const copyGeneratedKey = async () => {
    if (!generatedKey) return;
    await navigator.clipboard.writeText(generatedKey);
    setStatusText('API Key 已複製');
  };

  return (
    <div className="api-settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="api-settings-modal" role="dialog" aria-modal="true" aria-labelledby="api-settings-title">
        <div className="api-settings-header">
          <div>
            <p className="eyebrow">External API</p>
            <h2 id="api-settings-title">API Key 設定</h2>
          </div>
          <button type="button" className="secondary small" onClick={onClose} aria-label="關閉 API 設定">關閉</button>
        </div>

        <p className="muted api-settings-note">
          管理密鑰只保留在這個視窗的記憶體中，不會寫入 localStorage。後端只保存 API Key 的雜湊值。
        </p>

        <div className="api-settings-auth">
          <label>
            <span className="field-label">管理密鑰（TEMP_MAIL_ADMIN_KEY）</span>
            <input
              type="password"
              value={adminKey}
              onChange={(event) => setAdminKey(event.target.value)}
              autoComplete="off"
              placeholder="輸入後端環境變數中的管理密鑰"
            />
          </label>
          <button type="button" className="secondary" onClick={() => void loadKeys()} disabled={isLoading}>載入／更新使用量</button>
        </div>

        <div className="api-settings-create">
          <label>
            <span className="field-label">Key 名稱</span>
            <input value={keyName} onChange={(event) => setKeyName(event.target.value)} maxLength={80} />
          </label>
          <button type="button" onClick={() => void handleCreate()} disabled={isLoading}>生成 API Key</button>
        </div>

        {generatedKey ? (
          <div className="generated-api-key">
            <strong>完整 API Key（只顯示這一次）</strong>
            <code>{generatedKey}</code>
            <button type="button" className="secondary small" onClick={() => void copyGeneratedKey()}>複製</button>
          </div>
        ) : null}

        {errorText ? <p className="api-settings-error" role="alert">{errorText}</p> : null}
        {statusText ? <p className="api-settings-status">{statusText}</p> : null}

        <div className="api-key-list">
          <div className="api-key-list-header">
            <h3>已建立的 Keys</h3>
            <span>{apiKeys.length} 組</span>
          </div>
          {apiKeys.length === 0 ? <p className="muted">輸入管理密鑰後載入，或建立第一組 API Key。</p> : null}
          {apiKeys.map((item) => (
            <article className={`api-key-item ${item.revoked_at ? 'revoked' : ''}`} key={item.id}>
              <div className="api-key-item-title">
                <div>
                  <strong>{item.name}</strong>
                  <code>{item.prefix}</code>
                </div>
                <span className={`api-key-state ${item.revoked_at ? 'revoked' : 'active'}`}>
                  {item.revoked_at ? '已停用' : '使用中'}
                </span>
              </div>
              <div className="api-usage-grid">
                <span><b>{item.usage.total}</b>總請求</span>
                <span><b>{item.usage.create}</b>建立信箱</span>
                <span><b>{item.usage.code}</b>查詢驗證碼</span>
                <span><b>{item.usage.delete}</b>刪除信箱</span>
              </div>
              <div className="api-key-meta">
                <span>建立：{formatDateTime(item.created_at)}</span>
                <span>最後使用：{formatDateTime(item.last_used_at)}</span>
              </div>
              {!item.revoked_at ? (
                <button type="button" className="danger tiny" onClick={() => void handleRevoke(item)} disabled={isLoading}>停用</button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
