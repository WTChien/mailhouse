import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cleanupReadMessages,
  createOrLoadPersistentMailbox,
  deleteMailbox,
  getClientSyncState,
  getMailboxMessages,
  MAIL_DOMAIN,
  markMessageRead,
  updateClientSyncState,
} from '../lib/api';
import MailMessageTable from './MailMessageTable';
import RegistrationHelperPanel from './RegistrationHelperPanel';
import {
  normalizeMailboxId,
  normalizeMailboxTag,
  type MailMessage,
  type RegistrationDraft,
  type SavedMailboxItem,
} from './mailboxUtils';

type BusyAction = 'open' | 'delete' | null;
type SavedListSort = 'recent' | 'name' | 'tag';

export type PersistentPromotionRequest = {
  mailboxId: string;
  registrationDraft: RegistrationDraft | null;
  requestId: string;
};

type PersistentMailboxPanelProps = {
  requestedPromotion?: PersistentPromotionRequest | null;
};

export default function PersistentMailboxPanel({ requestedPromotion = null }: PersistentMailboxPanelProps) {
  const [mailboxId, setMailboxId] = useState('');
  const [requestedMailboxId, setRequestedMailboxId] = useState('');
  const [requestedTag, setRequestedTag] = useState('');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState('輸入名稱後即可建立或載入保留信箱');
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [busyMailboxTarget, setBusyMailboxTarget] = useState('');
  const [savedMailboxes, setSavedMailboxes] = useState<SavedMailboxItem[]>([]);
  const [activeTagNavbar, setActiveTagNavbar] = useState('all');
  const [savedListSort, setSavedListSort] = useState<SavedListSort>('recent');
  const [tagDraftByMailbox, setTagDraftByMailbox] = useState<Record<string, string>>({});
  const [promotionMailboxId, setPromotionMailboxId] = useState('');
  const [promotionTagDraft, setPromotionTagDraft] = useState('');
  const [promotionDraftOverride, setPromotionDraftOverride] = useState<RegistrationDraft | null>(null);
  const [promotionDraftKey, setPromotionDraftKey] = useState('');
  const [lastSyncedMailboxes, setLastSyncedMailboxes] = useState<string>('');
  const handledPromotionRequestIdRef = useRef('');

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${MAIL_DOMAIN}` : ''), [mailboxId]);
  const isBusy = busyAction !== null;

  useEffect(() => {
    let disposed = false;

    const loadCloudSavedMailboxes = async () => {
      try {
        const cloudData = await getClientSyncState();
        if (!disposed) {
          setSavedMailboxes(cloudData.savedMailboxes ?? []);
          setLastSyncedMailboxes(JSON.stringify(cloudData.savedMailboxes ?? []));
        }
      } catch (error) {
        console.error('Failed to load saved mailboxes from cloud:', error);
      }
    };

    void loadCloudSavedMailboxes();

    const handleOnline = () => {
      console.log('Network restored, retrying sync...');
      void loadCloudSavedMailboxes();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      disposed = true;
      window.removeEventListener('online', handleOnline);
    };
  }, []);

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
      return false;
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
      return true;
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '建立或載入保留信箱失敗。');
      return false;
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
    const currentState = JSON.stringify(savedMailboxes);
    if (currentState === lastSyncedMailboxes) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void updateClientSyncState({ savedMailboxes }).then(() => {
        setLastSyncedMailboxes(JSON.stringify(savedMailboxes));
        console.log('Saved mailboxes synced to cloud');
      }).catch((error) => {
        console.error('Failed to sync saved mailboxes:', error);
      });
    }, 1500);

    return () => window.clearTimeout(timerId);
  }, [savedMailboxes, lastSyncedMailboxes]);

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
    if (
      activeTagNavbar !== 'all'
      && activeTagNavbar !== normalizeMailboxTag(requestedTag)
      && !availableTags.includes(activeTagNavbar)
    ) {
      setActiveTagNavbar('all');
    }
  }, [activeTagNavbar, availableTags, requestedTag]);

  const savedMailboxMap = useMemo(() => {
    return new Map(savedMailboxes.map((item) => [item.mailboxId, item]));
  }, [savedMailboxes]);

  useEffect(() => {
    if (!requestedPromotion?.requestId || handledPromotionRequestIdRef.current === requestedPromotion.requestId) {
      return;
    }

    const targetMailboxId = normalizeMailboxId(requestedPromotion.mailboxId);
    if (!targetMailboxId) {
      return;
    }

    handledPromotionRequestIdRef.current = requestedPromotion.requestId;

    setRequestedMailboxId(targetMailboxId);
    const currentTag = savedMailboxMap.get(targetMailboxId)?.tag ?? '';
    setRequestedTag(currentTag);
    setActiveTagNavbar(currentTag || 'all');
    setPromotionMailboxId(targetMailboxId);
    setPromotionTagDraft(currentTag);
    setPromotionDraftOverride(requestedPromotion.registrationDraft ?? null);
    setPromotionDraftKey(requestedPromotion.requestId);
    setStatusText('已移至保留信箱，請確認是否套用標籤');
    setErrorText('');
  }, [requestedPromotion, savedMailboxMap]);

  const fallbackMailboxId = useMemo(() => {
    const sorted = [...savedMailboxes].sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
    return sorted[0]?.mailboxId ?? '';
  }, [savedMailboxes]);

  useEffect(() => {
    if (promotionMailboxId) {
      return;
    }

    if (!mailboxId && fallbackMailboxId) {
      void openPersistentMailbox(fallbackMailboxId, savedMailboxMap.get(fallbackMailboxId)?.tag ?? '');
    }
  }, [fallbackMailboxId, mailboxId, promotionMailboxId, savedMailboxMap]);

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

  const handleConfirmPromotion = async (tagValue = promotionTagDraft) => {
    if (!promotionMailboxId) {
      return;
    }

    const nextTag = normalizeMailboxTag(tagValue);
    setRequestedTag(nextTag);
    setActiveTagNavbar(nextTag || 'all');
    const didOpen = await openPersistentMailbox(promotionMailboxId, nextTag);

    if (didOpen) {
      setPromotionMailboxId('');
      setPromotionTagDraft(nextTag);
      setStatusText(nextTag ? `已移至保留信箱，標籤：${nextTag}` : '已移至保留信箱');
    }
  };

  const registrationProfileScope = activeTagNavbar === 'all' ? 'general' : `tag:${activeTagNavbar}`;

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
              setRequestedTag(item === 'all' ? '' : item);
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
        profileScope={registrationProfileScope}
        persistDraft
        defaultCollapsed
        maskPassword
        draftOverride={promotionDraftOverride}
        draftOverrideKey={promotionDraftKey}
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

      {promotionMailboxId ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="promotion-tag-title">
            <div className="message-section__header">
              <h3 id="promotion-tag-title">加入保留信箱前設定標籤</h3>
              <span>{promotionMailboxId}@{MAIL_DOMAIN}</span>
            </div>

            <p className="muted modal-copy">這個信箱已經移到保留信箱。你現在可以直接沿用既有標籤、輸入新標籤，或先不加標籤。</p>

            {availableTags.length > 0 ? (
              <div className="modal-tag-list" role="list" aria-label="既有標籤">
                {availableTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`secondary small tag-choice ${normalizeMailboxTag(promotionTagDraft) === tag ? 'active' : ''}`}
                    onClick={() => setPromotionTagDraft(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="input-row modal-actions-row">
              <input
                type="text"
                value={promotionTagDraft}
                placeholder="輸入新標籤，例如 nintendo / 小米 / 社群"
                onChange={(event) => setPromotionTagDraft(normalizeMailboxTag(event.target.value))}
              />
            </div>

            <div className="modal-actions-row">
              <button type="button" onClick={() => void handleConfirmPromotion()} disabled={isBusy}>
                <span className="button-content">
                  {busyAction === 'open' && busyMailboxTarget === promotionMailboxId ? <span className="button-spinner" aria-hidden="true" /> : null}
                  <span>{busyAction === 'open' && busyMailboxTarget === promotionMailboxId ? '套用中...' : '套用並開啟'}</span>
                </span>
              </button>
              <button type="button" className="secondary" onClick={() => void handleConfirmPromotion('')} disabled={isBusy}>
                先不加標籤
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPromotionMailboxId('');
                  setPromotionTagDraft('');
                }}
                disabled={isBusy}
              >
                稍後再說
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
