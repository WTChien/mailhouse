import { useEffect, useMemo, useRef, useState } from 'react';
import { getClientSyncState, updateClientSyncState } from '../lib/api';
import { SavedMailboxItem } from './mailboxUtils';

type GitHubAccountStatus = 'unused' | 'active' | 'half' | 'exhausted';

type GitHubAccount = {
  mailboxId: string;
  username: string;
  password: string;
  resetTime: string;
  status: GitHubAccountStatus;
};

type GitHubAccountPanelProps = {
  onViewMailbox: () => void;
  focusMailboxId?: string | null;
  focusRequestId?: string;
};

const GITHUB_ACCOUNT_SETTINGS_KEY = 'mailhouse.githubAccountSettings';
const FIRESTORE_COLLECTION = 'github_accounts';

const STATUS_LABELS: Record<GitHubAccountStatus, string> = {
  unused: '未使用',
  active: '使用中',
  half: '半上限',
  exhausted: '已用完',
};

const STATUS_ORDER: Record<GitHubAccountStatus, number> = {
  unused: 0,
  active: 1,
  half: 2,
  exhausted: 3,
};

function applyResetWhenDue(account: GitHubAccount, nowTimestamp = Date.now()) {
  const resetTimestamp = new Date(account.resetTime).getTime();
  const hasValidResetTime = !Number.isNaN(resetTimestamp) && account.resetTime.trim() !== '';
  const isDue = hasValidResetTime && resetTimestamp <= nowTimestamp;

  if (!isDue) {
    return account;
  }

  const shouldResetStatus = account.status === 'half' || account.status === 'exhausted';

  return {
    ...account,
    status: shouldResetStatus ? 'unused' : account.status,
    resetTime: '',
  };
}

function loadStoredAccountSettings() {
  if (typeof window === 'undefined') {
    return {} as Record<string, { status: GitHubAccountStatus; resetTime: string }>;
  }

  try {
    const raw = window.localStorage.getItem(GITHUB_ACCOUNT_SETTINGS_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, { status?: GitHubAccountStatus; resetTime?: string }>;
    return Object.entries(parsed).reduce<Record<string, { status: GitHubAccountStatus; resetTime: string }>>((acc, [mailboxId, value]) => {
      if (!value || typeof value !== 'object') {
        return acc;
      }

      const status = ['unused', 'active', 'half', 'exhausted'].includes(value.status as string)
        ? (value.status as GitHubAccountStatus)
        : 'unused';
      const resetTime = typeof value.resetTime === 'string' && !Number.isNaN(new Date(value.resetTime).getTime())
        ? value.resetTime
        : '';

      acc[mailboxId] = { status, resetTime };
      return acc;
    }, {});
  } catch {
    return {} as Record<string, { status: GitHubAccountStatus; resetTime: string }>;
  }
}

function formatDateTimeLocal(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const tzOffset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - tzOffset * 60000);
  return local.toISOString().slice(0, 16);
}

function parseDateTimeLocal(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function syncAccountSettingsToFirestore(accounts: GitHubAccount[]) {
  try {
    const payload = accounts.reduce<Record<string, { status: GitHubAccountStatus; resetTime: string }>>((acc, account) => {
      acc[account.mailboxId] = { status: account.status, resetTime: account.resetTime };
      return acc;
    }, {});

    // Save to Firestore via the backend endpoint
    // Note: This stores the settings in registrationDrafts temporarily until a dedicated API is created
    await updateClientSyncState({
      registrationDrafts: {
        _github_accounts_meta: {
          generatedName: JSON.stringify(payload),
          generatedPassword: 'meta',
          updatedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    console.error('Failed to sync to Firestore:', error);
  }
}

export default function GitHubAccountPanel({
  onViewMailbox,
  focusMailboxId = null,
  focusRequestId = '',
}: GitHubAccountPanelProps) {
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<GitHubAccountStatus | 'all'>('all');
  const [sortOrder, setSortOrder] = useState<'name' | 'status' | 'reset'>('status');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const loadAccounts = async () => {
      try {
        const cloudData = await getClientSyncState();
        const githubMailboxes = cloudData.savedMailboxes.filter(
          (item: SavedMailboxItem) => item.tag === 'github'
        );

        const persistedSettings = loadStoredAccountSettings();
        const nextAccounts = githubMailboxes.map((item) => ({
          mailboxId: item.mailboxId,
          username: `user_${item.mailboxId}`,
          password: `pass_${item.mailboxId}`,
          resetTime: persistedSettings[item.mailboxId]?.resetTime ?? '',
          status: persistedSettings[item.mailboxId]?.status ?? 'unused',
        })).map((account) => applyResetWhenDue(account));

        setAccounts(nextAccounts);
      } catch (error) {
        console.error('Failed to load GitHub accounts:', error);
      } finally {
        setLoading(false);
      }
    };

    void loadAccounts();
  }, []);

  // Save to localStorage immediately (for fast local access)
  useEffect(() => {
    if (loading || typeof window === 'undefined') {
      return;
    }

    const stored = accounts.reduce<Record<string, { status: GitHubAccountStatus; resetTime: string }>>((acc, account) => {
      acc[account.mailboxId] = { status: account.status, resetTime: account.resetTime };
      return acc;
    }, {});

    window.localStorage.setItem(GITHUB_ACCOUNT_SETTINGS_KEY, JSON.stringify(stored));
  }, [accounts, loading]);

  useEffect(() => {
    if (loading) {
      return;
    }

    const runResetCheck = () => {
      setAccounts((prev) => {
        const now = Date.now();
        let hasChanges = false;
        const next = prev.map((account) => {
          const updated = applyResetWhenDue(account, now);
          if (updated !== account) {
            hasChanges = true;
          }
          return updated;
        });

        return hasChanges ? next : prev;
      });
    };

    runResetCheck();
    const timer = window.setInterval(runResetCheck, 30000);
    return () => window.clearInterval(timer);
  }, [loading]);

  // Debounce sync to Firestore (every 2 seconds of inactivity)
  useEffect(() => {
    if (loading) {
      return;
    }

    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }

    syncTimeoutRef.current = setTimeout(() => {
      void syncAccountSettingsToFirestore(accounts);
    }, 2000);

    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [accounts, loading]);

  useEffect(() => {
    if (loading || !focusMailboxId) {
      return;
    }

    const hasTarget = accounts.some((account) => account.mailboxId === focusMailboxId);
    if (!hasTarget) {
      return;
    }

    setStatusFilter('all');
    setSortOrder('name');
    setExpandedIds(new Set([focusMailboxId]));
  }, [accounts, focusMailboxId, focusRequestId, loading]);

  const visibleAccounts = useMemo(() => {
    return [...accounts]
      .filter((account) => statusFilter === 'all' || account.status === statusFilter)
      .sort((a, b) => {
        if (sortOrder === 'name') {
          return a.mailboxId.localeCompare(b.mailboxId, 'en');
        }

        if (sortOrder === 'status') {
          const diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          return diff !== 0 ? diff : a.mailboxId.localeCompare(b.mailboxId, 'en');
        }

        const aHasReset = a.resetTime.trim() !== '';
        const bHasReset = b.resetTime.trim() !== '';

        if (aHasReset !== bHasReset) {
          return aHasReset ? -1 : 1;
        }

        if (!aHasReset && !bHasReset) {
          return a.mailboxId.localeCompare(b.mailboxId, 'en');
        }

        return new Date(a.resetTime).getTime() - new Date(b.resetTime).getTime();
      });
  }, [accounts, statusFilter, sortOrder]);

  const updateAccount = (mailboxId: string, changes: Partial<Omit<GitHubAccount, 'mailboxId'>>) => {
    setAccounts((prev) => prev.map((account) => (
      account.mailboxId === mailboxId ? { ...account, ...changes } : account
    )));
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const handleViewMailbox = () => {
    onViewMailbox();
  };

  const toggleExpanded = (mailboxId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(mailboxId)) {
        next.delete(mailboxId);
      } else {
        next.add(mailboxId);
      }
      return next;
    });
  };

  if (loading) {
    return <div className="panel-loading">載入 GitHub 帳號中...</div>;
  }

  return (
    <div className="github-accounts-panel">
      <div className="panel-header">
        <h2>GitHub 帳號管理</h2>
        <p>管理標籤為 GitHub 的帳號清單</p>
      </div>

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>尚未有任何 GitHub 帳號。</p>
          <p>請在保留信箱頁面新增標籤為 "github" 的信箱。</p>
        </div>
      ) : visibleAccounts.length === 0 ? (
        <div className="empty-state">
          <p>當前篩選條件未找到任何 GitHub 帳號。</p>
          <p>請調整狀態篩選或排序。</p>
        </div>
      ) : (
        <>
          <div className="saved-list-toolbar">
            <label>
              <span className="field-label">狀態篩選</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as GitHubAccountStatus | 'all')}
              >
                <option value="all">全部</option>
                <option value="unused">未使用</option>
                <option value="active">使用中</option>
                <option value="half">半上限</option>
                <option value="exhausted">已用完</option>
              </select>
            </label>
            <label>
              <span className="field-label">排序</span>
              <select
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as 'name' | 'status' | 'reset')}
              >
                <option value="status">狀態</option>
                <option value="name">名稱 A-Z</option>
                <option value="reset">重置時間</option>
              </select>
            </label>
            <button
              type="button"
              className="small"
              onClick={() => setAccounts((prev) => prev.map((a) => ({ ...a, resetTime: '' })))}
            >
              清空所有重置時間
            </button>
          </div>

          <div className="accounts-list">
            {visibleAccounts.map((account) => {
              const isExpanded = expandedIds.has(account.mailboxId);
              return (
              <div key={account.mailboxId} className="account-card">
                <div
                  className="account-header collapsible"
                  onClick={() => toggleExpanded(account.mailboxId)}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  <h3>{account.mailboxId}@gradaide.xyz</h3>
                  <span className={`status-badge ${account.status}`}>
                    {STATUS_LABELS[account.status]}
                  </span>
                  <span className="collapse-arrow">{isExpanded ? '▲' : '▼'}</span>
                </div>

                {isExpanded && (
                  <>
                    <div className="account-details">
                      <div className="detail-row">
                        <label>信箱：</label>
                        <input
                          type="text"
                          value={`${account.mailboxId}@gradaide.xyz`}
                          readOnly
                          className="copy-input"
                        />
                        <button type="button" className="small" onClick={() => handleCopy(`${account.mailboxId}@gradaide.xyz`)}>
                          複製
                        </button>
                      </div>

                      <div className="detail-row">
                        <label>重置時間：</label>
                        <input
                          type="datetime-local"
                          value={formatDateTimeLocal(account.resetTime)}
                          onChange={(event) => updateAccount(account.mailboxId, { resetTime: parseDateTimeLocal(event.target.value) })}
                        />
                      </div>

                      <div className="detail-row">
                        <label>使用者名稱：</label>
                        <input type="text" value={account.username} readOnly className="copy-input" />
                        <button type="button" className="small" onClick={() => handleCopy(account.username)}>
                          複製
                        </button>
                      </div>

                      <div className="detail-row">
                        <label>密碼：</label>
                        <input type="password" value={account.password} readOnly className="copy-input" />
                        <button type="button" className="small" onClick={() => handleCopy(account.password)}>
                          複製
                        </button>
                      </div>

                      <div className="detail-row">
                        <label>狀態：</label>
                        <select
                          value={account.status}
                          onChange={(event) => updateAccount(account.mailboxId, { status: event.target.value as GitHubAccountStatus })}
                        >
                          <option value="unused">未使用</option>
                          <option value="active">使用中</option>
                          <option value="half">半上限</option>
                          <option value="exhausted">已用完</option>
                        </select>
                      </div>
                    </div>

                    <div className="account-actions">
                      <button type="button" onClick={handleViewMailbox}>
                        查看信箱
                      </button>
                    </div>
                  </>
                )}
              </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}