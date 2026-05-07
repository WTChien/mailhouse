import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getClientSyncState, updateClientSyncState, deleteMailbox, MAIL_DOMAIN } from '../lib/api';
import { SavedMailboxItem, readRegistrationDrafts } from './mailboxUtils';

type GitHubAccountStatus = 'unused' | 'active' | 'half' | 'exhausted';

type GitHubAccount = {
  mailboxId: string;
  tag: string;
  username: string;
  password: string;
  resetTime: string;
  status: GitHubAccountStatus;
  showPassword?: boolean;
};

type GitHubAccountPanelProps = {
  onViewMailbox: (mailboxId: string) => void;
  focusMailboxId?: string | null;
  focusRequestId?: string;
};

const GITHUB_ACCOUNT_SETTINGS_KEY = 'mailhouse.githubAccountSettings';
const GITHUB_ACCOUNT_PASSWORDS_KEY = 'mailhouse.githubAccountPasswords';
const GITHUB_ACCOUNT_USERNAMES_KEY = 'mailhouse.githubAccountUsernames';

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeGitHubUsername(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39);
}

function resolveGitHubUsername(candidate: string | undefined, mailboxId: string) {
  const normalized = normalizeGitHubUsername(candidate ?? '');
  if (normalized) {
    return normalized;
  }

  const fallback = normalizeGitHubUsername(mailboxId);
  return fallback || 'github-user';
}

function loadStoredPasswords() {
  if (typeof window === 'undefined') {
    return {} as Record<string, string>;
  }

  try {
    const raw = window.localStorage.getItem(GITHUB_ACCOUNT_PASSWORDS_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveStoredPasswords(passwords: Record<string, string>) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(GITHUB_ACCOUNT_PASSWORDS_KEY, JSON.stringify(passwords));
  } catch (error) {
    console.error('Failed to save passwords:', error);
  }
}

function loadStoredUsernames() {
  if (typeof window === 'undefined') {
    return {} as Record<string, string>;
  }

  try {
    const raw = window.localStorage.getItem(GITHUB_ACCOUNT_USERNAMES_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveStoredUsernames(usernames: Record<string, string>) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(GITHUB_ACCOUNT_USERNAMES_KEY, JSON.stringify(usernames));
  } catch (error) {
    console.error('Failed to save usernames:', error);
  }
}

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
        _account_management_meta: {
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
  const [activeManagementTag, setActiveManagementTag] = useState('github');
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<GitHubAccountStatus | 'all'>('all');
  const [sortOrder, setSortOrder] = useState<'name' | 'status' | 'reset'>('status');
  const [focusOnlyMailboxId, setFocusOnlyMailboxId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deletingMailboxId, setDeletingMailboxId] = useState<string | null>(null);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledFocusRequestIdRef = useRef('');

  const loadAccounts = useCallback(async () => {
    try {
      const cloudData = await getClientSyncState();
      const taggedMailboxes = cloudData.savedMailboxes
        .map((item: SavedMailboxItem) => ({ ...item, tag: normalizeTag(item.tag ?? '') }))
        .filter((item: SavedMailboxItem) => item.tag !== '');

      const persistedSettings = loadStoredAccountSettings();
      const storedPasswords = loadStoredPasswords();
      const storedUsernames = loadStoredUsernames();
      const registrationDrafts = readRegistrationDrafts();
      
      const nextAccounts = taggedMailboxes.map((item) => {
        // Try to get password from: stored cache -> registration draft -> generate default
        let password = storedPasswords[item.mailboxId];
        if (!password) {
          const scope = `mailbox:${item.mailboxId}`;
          const draft = registrationDrafts[scope];
          password = draft?.generatedPassword || `pass_${item.mailboxId}`;
        }
        
        // Try to get username from: stored cache -> registration draft -> generate default
        let username = storedUsernames[item.mailboxId];
        if (!username) {
          const scope = `mailbox:${item.mailboxId}`;
          const draft = registrationDrafts[scope];
          username = draft?.generatedName || item.mailboxId;
        }
        username = resolveGitHubUsername(username, item.mailboxId);
        
        return {
          mailboxId: item.mailboxId,
          tag: item.tag,
          username,
          password,
          resetTime: persistedSettings[item.mailboxId]?.resetTime ?? '',
          status: persistedSettings[item.mailboxId]?.status ?? 'unused',
          showPassword: false,
        };
      }).map((account) => applyResetWhenDue(account));

      setAccounts(nextAccounts);
    } catch (error) {
      console.error('Failed to load GitHub accounts:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

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
    if (loading || !focusMailboxId || !focusRequestId) {
      return;
    }

    // Only apply focus once per requestId
    if (handledFocusRequestIdRef.current === focusRequestId) {
      return;
    }

    const hasTarget = accounts.some((account) => account.mailboxId === focusMailboxId);
    if (!hasTarget) {
      return;
    }

    const target = accounts.find((account) => account.mailboxId === focusMailboxId);

    handledFocusRequestIdRef.current = focusRequestId;
    setActiveManagementTag(target?.tag ?? 'github');
    setStatusFilter('all');
    setSortOrder('name');
    setFocusOnlyMailboxId(focusMailboxId);
    setExpandedIds(new Set([focusMailboxId]));
  }, [focusMailboxId, focusRequestId, loading, accounts]);

  const managementTags = useMemo(() => {
    const uniqueTags = Array.from(new Set(accounts.map((item) => item.tag)));
    uniqueTags.sort((a, b) => {
      if (a.toLowerCase() === 'github') {
        return -1;
      }

      if (b.toLowerCase() === 'github') {
        return 1;
      }

      return a.localeCompare(b, 'zh-Hant');
    });

    return uniqueTags;
  }, [accounts]);

  useEffect(() => {
    if (managementTags.length === 0) {
      return;
    }

    if (managementTags.includes(activeManagementTag)) {
      return;
    }

    const githubTag = managementTags.find((item) => item.toLowerCase() === 'github');
    setActiveManagementTag(githubTag ?? managementTags[0]);
  }, [activeManagementTag, managementTags]);

  const visibleAccounts = useMemo(() => {
    return [...accounts]
      .filter((account) => !focusOnlyMailboxId || account.mailboxId === focusOnlyMailboxId)
      .filter((account) => account.tag === activeManagementTag)
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
  }, [accounts, activeManagementTag, statusFilter, sortOrder, focusOnlyMailboxId]);

  const updateAccount = (mailboxId: string, changes: Partial<Omit<GitHubAccount, 'mailboxId'>>) => {
    const normalizedChanges = { ...changes };
    if (typeof normalizedChanges.username === 'string') {
      normalizedChanges.username = resolveGitHubUsername(normalizedChanges.username, mailboxId);
    }

    setAccounts((prev) => prev.map((account) => (
      account.mailboxId === mailboxId ? { ...account, ...normalizedChanges } : account
    )));
    
    // Persist password changes
    if (normalizedChanges.password) {
      const storedPasswords = loadStoredPasswords();
      storedPasswords[mailboxId] = normalizedChanges.password;
      saveStoredPasswords(storedPasswords);
    }
    
    // Persist username changes
    if (normalizedChanges.username) {
      const storedUsernames = loadStoredUsernames();
      storedUsernames[mailboxId] = normalizedChanges.username;
      saveStoredUsernames(storedUsernames);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const handleViewMailbox = (mailboxId: string) => {
    onViewMailbox(mailboxId);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await loadAccounts();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleDeleteMailbox = async (mailboxId: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`確定刪除信箱 ${mailboxId}@${MAIL_DOMAIN}？`)) {
      return;
    }

    setDeletingMailboxId(mailboxId);
    try {
      await deleteMailbox(mailboxId);
      setAccounts((prev) => prev.filter((account) => account.mailboxId !== mailboxId));
      
      // Update cloud sync state
      const cloudData = await getClientSyncState();
      const updatedMailboxes = cloudData.savedMailboxes.filter((item) => item.mailboxId !== mailboxId);
      await updateClientSyncState({ savedMailboxes: updatedMailboxes });
    } catch (error) {
      console.error('Failed to delete mailbox:', error);
      alert(error instanceof Error ? error.message : '刪除信箱失敗，請稍後再試。');
    } finally {
      setDeletingMailboxId(null);
    }
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
        <h2>{activeManagementTag ? `${activeManagementTag} 帳號管理` : '帳號管理'}</h2>
        <p>依保留信箱標籤分組管理帳號。可直接在這裡自訂名稱與密碼。</p>
      </div>

      {managementTags.length > 0 && !focusOnlyMailboxId ? (
        <div className="account-navbar" role="tablist" aria-label="帳號管理分類">
          {managementTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`account-tab ${activeManagementTag === tag ? 'active' : ''}`}
              onClick={() => {
                setActiveManagementTag(tag);
                setExpandedIds(new Set());
              }}
            >
              {tag}帳號管理
            </button>
          ))}
        </div>
      ) : null}

      {focusOnlyMailboxId ? (
        <div className="saved-list-toolbar">
          <p className="muted">已聚焦顯示：{focusOnlyMailboxId}@gradaide.xyz</p>
          <button
            type="button"
            className="small"
            onClick={() => {
              setFocusOnlyMailboxId(null);
              setExpandedIds(new Set());
            }}
          >
            顯示全部帳號
          </button>
        </div>
      ) : null}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>尚未有任何已標籤的帳號。</p>
          <p>請在保留信箱頁面替信箱設定標籤後回來管理。</p>
        </div>
      ) : visibleAccounts.length === 0 ? (
        <div className="empty-state">
          <p>當前篩選條件未找到任何 {activeManagementTag} 帳號。</p>
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
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
            >
              {isRefreshing ? '同步中...' : '同步帳號'}
            </button>
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
                  <h3
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopy(`${account.mailboxId}@gradaide.xyz`);
                    }}
                    style={{ cursor: 'pointer' }}
                    title="點擊複製"
                  >
                    {account.mailboxId}@gradaide.xyz
                  </h3>
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
                        <input 
                          type="text" 
                          value={account.username} 
                          onChange={(event) => updateAccount(account.mailboxId, { username: event.target.value })}
                          className="copy-input" 
                        />
                        <button type="button" className="small" onClick={() => handleCopy(account.username)}>
                          複製
                        </button>
                      </div>

                      <div className="detail-row">
                        <label>密碼：</label>
                        <input 
                          type={account.showPassword ? 'text' : 'password'} 
                          value={account.password} 
                          onChange={(event) => updateAccount(account.mailboxId, { password: event.target.value })}
                          className="copy-input" 
                        />
                        <button 
                          type="button" 
                          className="small secondary"
                          onClick={() => updateAccount(account.mailboxId, { showPassword: !account.showPassword })}
                          title={account.showPassword ? '隱藏密碼' : '顯示密碼'}
                          aria-label={account.showPassword ? '隱藏密碼' : '顯示密碼'}
                        >
                          {account.showPassword ? '👁️ 隱藏' : '🙈 顯示'}
                        </button>
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
                      <button type="button" onClick={() => handleViewMailbox(account.mailboxId)}>
                        查看信箱
                      </button>
                      <button 
                        type="button" 
                        className="danger"
                        onClick={() => void handleDeleteMailbox(account.mailboxId)}
                        disabled={deletingMailboxId === account.mailboxId}
                      >
                        {deletingMailboxId === account.mailboxId ? '刪除中...' : '刪除信箱'}
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