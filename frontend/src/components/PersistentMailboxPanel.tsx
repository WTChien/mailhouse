import { useEffect, useMemo, useState } from 'react';
import {
  cleanupReadMessages,
  createOrLoadPersistentMailbox,
  deleteMailbox,
  getMailboxMessages,
  MAIL_DOMAIN,
  markMessageRead,
} from '../lib/api';
import MailMessageTable from './MailMessageTable';
import RegistrationHelperPanel from './RegistrationHelperPanel';
import {
  normalizeMailboxId,
  normalizeMailboxTag,
  readSavedMailboxes,
  writeSavedMailboxes,
  type MailMessage,
  type SavedMailboxItem,
} from './mailboxUtils';

type BusyAction = 'open' | 'delete' | null;
type SavedListSort = 'recent' | 'name' | 'tag';

type PersistentMailboxPanelProps = {
  requestedOpenMailboxId?: string;
};

export default function PersistentMailboxPanel({ requestedOpenMailboxId = '' }: PersistentMailboxPanelProps) {
  const [mailboxId, setMailboxId] = useState('');
  const [requestedMailboxId, setRequestedMailboxId] = useState('');
  const [requestedTag, setRequestedTag] = useState('');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState('輸入名稱後即可建立或載入保留信箱');
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [busyMailboxTarget, setBusyMailboxTarget] = useState('');
  const [savedMailboxes, setSavedMailboxes] = useState<SavedMailboxItem[]>(() => readSavedMailboxes());
  const [activeTagNavbar, setActiveTagNavbar] = useState('all');
  const [savedListSort, setSavedListSort] = useState<SavedListSort>('recent');
  const [tagDraftByMailbox, setTagDraftByMailbox] = useState<Record<string, string>>({});

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${MAIL_DOMAIN}` : ''), [mailboxId]);
  const isBusy = busyAction !== null;

  const syncMessages = async (targetMailboxId: string) => {
    try {
      const data = await getMailboxMessages(targetMailboxId);
      setMessages(data.messages ?? []);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '載入信件失敗，請稍後再試。');
    }
  };

  const openPersistentMailbox = async (inputValue?: string, tagValue?: string) => {
    const prefix = normalizeMailboxId(inputValue ?? requestedMailboxId);
    if (prefix.length < 3) {
      setErrorText('保留信箱名稱至少需要 3 個英數字。');
      return;
    }

    const normalizedTag = normalizeMailboxTag(tagValue ?? requestedTag);

    setBusyAction('open');
    setBusyMailboxTarget(prefix);

    try {
      const data = await createOrLoadPersistentMailbox(prefix);
      const nowIso = new Date().toISOString();
      setMailboxId(data.mailboxId);
      setRequestedMailboxId(data.mailboxId);
      setSavedMailboxes((prev) => {
        const existing = prev.find((item) => item.mailboxId === data.mailboxId);
        const resolvedTag = normalizedTag || existing?.tag || '';
        const nextItem: SavedMailboxItem = {
          mailboxId: data.mailboxId,
          tag: resolvedTag,
          createdAt: existing?.createdAt ?? nowIso,
          lastUsedAt: nowIso,
        };

        return [nextItem, ...prev.filter((item) => item.mailboxId !== data.mailboxId)];
      });
      setRequestedTag((prev) => normalizeMailboxTag(normalizedTag || prev));
      setMessages([]);
      setStatusText('保留信箱可用中');
      setErrorText('');
      await syncMessages(data.mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '建立或載入保留信箱失敗。');
    } finally {
      setBusyAction(null);
      setBusyMailboxTarget('');
    }
  };

  const handleDeleteMailbox = async (targetMailboxId = mailboxId) => {
    if (!targetMailboxId) {
      return;
    }

    if (typeof window !== 'undefined' && !window.confirm(`確定刪除保留信箱 ${targetMailboxId}@${MAIL_DOMAIN}？`)) {
      return;
    }

    setBusyAction('delete');
    setBusyMailboxTarget(targetMailboxId);

    try {
      await deleteMailbox(targetMailboxId);
      setSavedMailboxes((prev) => prev.filter((item) => item.mailboxId !== targetMailboxId));

      if (targetMailboxId === mailboxId) {
        setMailboxId('');
        setRequestedMailboxId('');
        setRequestedTag('');
        setMessages([]);
        setStatusText('信箱已刪除');
      }

      setErrorText('');
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '刪除信箱失敗，請稍後再試。');
    } finally {
      setBusyAction(null);
      setBusyMailboxTarget('');
    }
  };

  const handleCopy = async () => {
    if (!emailAddress) {
      return;
    }

    try {
      await navigator.clipboard.writeText(emailAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error(error);
      setErrorText('複製失敗，請手動複製信箱地址。');
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    writeSavedMailboxes(savedMailboxes);
  }, [savedMailboxes]);

  useEffect(() => {
    setTagDraftByMailbox((prev) => {
      const next: Record<string, string> = {};
      savedMailboxes.forEach((item) => {
        next[item.mailboxId] = prev[item.mailboxId] ?? item.tag;
      });
      return next;
    });
  }, [savedMailboxes]);

  const availableTags = useMemo(() => {
    return Array.from(
      new Set(
        savedMailboxes
          .map((item) => normalizeMailboxTag(item.tag))
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  }, [savedMailboxes]);

  useEffect(() => {
    if (activeTagNavbar !== 'all' && !availableTags.includes(activeTagNavbar)) {
      setActiveTagNavbar('all');
    }
  }, [activeTagNavbar, availableTags]);

  const savedMailboxMap = useMemo(() => {
    return new Map(savedMailboxes.map((item) => [item.mailboxId, item]));
  }, [savedMailboxes]);

  useEffect(() => {
    const targetMailboxId = normalizeMailboxId(requestedOpenMailboxId);
    if (!targetMailboxId) {
      return;
    }

    setRequestedMailboxId(targetMailboxId);
    const currentTag = savedMailboxMap.get(targetMailboxId)?.tag ?? '';
    setRequestedTag(currentTag);
    if (currentTag) {
      setActiveTagNavbar(currentTag);
    }

    if (targetMailboxId !== mailboxId) {
      void openPersistentMailbox(targetMailboxId);
    }
  }, [mailboxId, requestedOpenMailboxId, savedMailboxMap]);

  const fallbackMailboxId = useMemo(() => {
    const sorted = [...savedMailboxes].sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
    return sorted[0]?.mailboxId ?? '';
  }, [savedMailboxes]);

  useEffect(() => {
    if (normalizeMailboxId(requestedOpenMailboxId)) {
      return;
    }

    if (!mailboxId && fallbackMailboxId) {
      void openPersistentMailbox(fallbackMailboxId, savedMailboxMap.get(fallbackMailboxId)?.tag ?? '');
    }
  }, [fallbackMailboxId, mailboxId, requestedOpenMailboxId, savedMailboxMap]);

  useEffect(() => {
    if (!mailboxId) {
      return;
    }

    void syncMessages(mailboxId);
    const timer = window.setInterval(() => {
      void syncMessages(mailboxId);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [mailboxId]);

  const handleMarkRead = async (messageId: string, isRead: boolean) => {
    if (!mailboxId) {
      return;
    }

    try {
      await markMessageRead(mailboxId, messageId, isRead);
      await syncMessages(mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '更新已讀狀態失敗。');
    }
  };

  const handleCleanup = async () => {
    try {
      await cleanupReadMessages();
      if (mailboxId) {
        await syncMessages(mailboxId);
      }
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '清理已讀郵件失敗。');
    }
  };

  const normalizedRequestedMailboxId = normalizeMailboxId(requestedMailboxId);
  const isOpeningRequested = busyAction === 'open' && busyMailboxTarget === normalizedRequestedMailboxId;
  const isDeletingCurrent = busyAction === 'delete' && busyMailboxTarget === mailboxId;

  const visibleSavedMailboxes = useMemo(() => {
    const filtered = savedMailboxes.filter((item) => {
      if (activeTagNavbar === 'all') {
        return true;
      }

      return normalizeMailboxTag(item.tag) === activeTagNavbar;
    });

    return [...filtered].sort((a, b) => {
      if (savedListSort === 'name') {
        return a.mailboxId.localeCompare(b.mailboxId, 'en');
      }

      if (savedListSort === 'tag') {
        return (a.tag || '~').localeCompare(b.tag || '~', 'zh-Hant') || a.mailboxId.localeCompare(b.mailboxId, 'en');
      }

      return new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime();
    });
  }, [activeTagNavbar, savedListSort, savedMailboxes]);

  const navbarTabs = useMemo(() => {
    return ['all', ...availableTags];
  }, [availableTags]);

  const handleSaveTag = (targetMailboxId: string) => {
    const nextTag = normalizeMailboxTag(tagDraftByMailbox[targetMailboxId] ?? '');
    setSavedMailboxes((prev) => prev.map((item) => (item.mailboxId === targetMailboxId ? { ...item, tag: nextTag } : item)));

    if (targetMailboxId === mailboxId) {
      setRequestedTag(nextTag);
    }
  };

  const applyTagDraft = (targetMailboxId: string) => {
    handleSaveTag(targetMailboxId);
  };

  return (
    <section className="mail-card">
      <div className="mail-card__header">
        <div>
          <h2>保留信箱</h2>
        </div>
        <span className="status-badge persistent">{statusText}</span>
      </div>

      <div className="mail-insights two-col">
        <article className="insight-card insight-card--accent">
          <span>目前已載入信箱</span>
          <strong>{emailAddress || '尚未載入任何保留信箱'}</strong>
          <p className="muted insight-card__hint">目前查看、收信與清理的都是這個信箱。</p>
        </article>
        <article className="insight-card">
          <span>已保存名稱</span>
          <strong>{savedMailboxes.length} 個</strong>
          <p className="muted insight-card__hint">標籤數：{availableTags.length} 種</p>
        </article>
      </div>

      <div className="account-navbar" role="tablist" aria-label="帳號分類">
        {navbarTabs.map((item) => (
          <button
            key={item}
            type="button"
            className={`account-tab ${activeTagNavbar === item ? 'active' : ''}`}
            onClick={() => {
              setActiveTagNavbar(item);
              if (item !== 'all') {
                setRequestedTag(item);
              }
            }}
          >
            {item === 'all' ? '全部帳號' : item}
          </button>
        ))}
      </div>

      <div className="mode-panel">
        <p className="field-label">建立 / 載入保留信箱（目前分類：{activeTagNavbar === 'all' ? '全部帳號' : activeTagNavbar}）</p>
        <div className="input-row">
          <input
            type="text"
            value={requestedMailboxId}
            placeholder="輸入想保留的名稱，例如 grada01"
            onChange={(event) => setRequestedMailboxId(normalizeMailboxId(event.target.value))}
          />
          <input
            type="text"
            className="tag-input"
            value={requestedTag}
            placeholder="標籤用途，例如 nintendo / 小米 / 社群"
            onChange={(event) => setRequestedTag(normalizeMailboxTag(event.target.value))}
          />
          <button type="button" onClick={() => void openPersistentMailbox()} disabled={isBusy}>
            <span className="button-content">
              {isOpeningRequested ? <span className="button-spinner" aria-hidden="true" /> : null}
              <span>{isOpeningRequested ? '載入中...' : '建立 / 載入'}</span>
            </span>
          </button>
          <button type="button" className="secondary" onClick={handleCopy} disabled={!emailAddress}>
            {copied ? '已複製' : '複製目前信箱'}
          </button>
          <button type="button" className="danger" onClick={() => void handleDeleteMailbox()} disabled={!mailboxId || isBusy}>
            <span className="button-content">
              {isDeletingCurrent ? <span className="button-spinner" aria-hidden="true" /> : null}
              <span>{isDeletingCurrent ? '刪除中...' : '刪除此信箱'}</span>
            </span>
          </button>
        </div>
      </div>

      <RegistrationHelperPanel
        profileScope={activeTagNavbar === 'all' ? 'general' : `tag:${activeTagNavbar}`}
        persistDraft
        defaultCollapsed
        onApplyName={(value) => {
          setRequestedMailboxId(value);
          setErrorText('');
        }}
        onApplyTag={(value) => setRequestedTag(normalizeMailboxTag(value))}
      />

      <div className="saved-mailboxes">
        <div className="message-section__header">
          <h3>{activeTagNavbar === 'all' ? '保留電子郵件清單' : `${activeTagNavbar} 清單`}</h3>
          <span>{visibleSavedMailboxes.length} / {savedMailboxes.length} 個</span>
        </div>

        <div className="saved-list-toolbar">
          <label>
            <span className="field-label">排序</span>
            <select
              value={savedListSort}
              onChange={(event) => setSavedListSort(event.target.value as SavedListSort)}
            >
              <option value="recent">最近載入</option>
              <option value="name">名稱 A-Z</option>
              <option value="tag">標籤 A-Z</option>
            </select>
          </label>
        </div>

        {savedMailboxes.length === 0 ? (
          <div className="empty-state">目前還沒有保存任何保留信箱。</div>
        ) : visibleSavedMailboxes.length === 0 ? (
          <div className="empty-state">目前篩選條件下沒有信箱。</div>
        ) : (
          <div className="saved-list">
            {visibleSavedMailboxes.map((savedMailbox) => {
              const isLoadingSaved = busyAction === 'open' && busyMailboxTarget === savedMailbox.mailboxId;
              const isDeletingSaved = busyAction === 'delete' && busyMailboxTarget === savedMailbox.mailboxId;

              return (
                <div className="saved-chip" key={savedMailbox.mailboxId}>
                  <div className="saved-chip__main">
                    <strong>{savedMailbox.mailboxId}@{MAIL_DOMAIN}</strong>
                    {savedMailbox.tag ? <span className="tag-pill">{savedMailbox.tag}</span> : <span className="muted">未設定標籤</span>}
                  </div>
                  <div className="saved-chip__tag-editor">
                    <input
                      type="text"
                      className="tag-input"
                      value={tagDraftByMailbox[savedMailbox.mailboxId] ?? savedMailbox.tag}
                      placeholder="設定用途標籤"
                      onChange={(event) => {
                        const value = normalizeMailboxTag(event.target.value);
                        setTagDraftByMailbox((prev) => ({ ...prev, [savedMailbox.mailboxId]: value }));
                      }}
                      onBlur={() => applyTagDraft(savedMailbox.mailboxId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          applyTagDraft(savedMailbox.mailboxId);
                        }
                      }}
                    />
                  </div>
                  <div className="saved-chip__actions">
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => void openPersistentMailbox(savedMailbox.mailboxId, savedMailbox.tag)}
                      disabled={isBusy}
                    >
                      <span className="button-content">
                        {isLoadingSaved ? <span className="button-spinner" aria-hidden="true" /> : null}
                        <span>{isLoadingSaved ? '載入中...' : '載入'}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="danger small"
                      onClick={() => void handleDeleteMailbox(savedMailbox.mailboxId)}
                      disabled={isBusy}
                    >
                      <span className="button-content">
                        {isDeletingSaved ? <span className="button-spinner" aria-hidden="true" /> : null}
                        <span>{isDeletingSaved ? '刪除中...' : '刪除'}</span>
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {errorText ? <p className="error-text">{errorText}</p> : null}

      <MailMessageTable
        messages={messages}
        onMarkRead={handleMarkRead}
        onCleanup={handleCleanup}
        cleanupLabel="清理已讀郵件"
      />
    </section>
  );
}
