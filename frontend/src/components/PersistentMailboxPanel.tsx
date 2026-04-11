import { useEffect, useMemo, useState } from 'react';
import {
  MAIL_DOMAIN,
  cleanupReadMessages,
  createOrLoadPersistentMailbox,
  deleteMailbox,
  getMailboxMessages,
  markMessageRead,
} from '../lib/api';
import MailMessageTable from './MailMessageTable';
import { SAVED_MAILBOXES_KEY, normalizeMailboxId, readSavedMailboxes, type MailMessage } from './mailboxUtils';

type BusyAction = 'open' | 'delete' | null;

export default function PersistentMailboxPanel() {
  const [mailboxId, setMailboxId] = useState('');
  const [requestedMailboxId, setRequestedMailboxId] = useState('');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState('輸入名稱後即可建立或載入保留信箱');
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [busyMailboxTarget, setBusyMailboxTarget] = useState('');
  const [savedMailboxes, setSavedMailboxes] = useState<string[]>(() => readSavedMailboxes());

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

  const openPersistentMailbox = async (inputValue?: string) => {
    const prefix = normalizeMailboxId(inputValue ?? requestedMailboxId);
    if (prefix.length < 3) {
      setErrorText('保留信箱名稱至少需要 3 個英數字。');
      return;
    }

    setBusyAction('open');
    setBusyMailboxTarget(prefix);

    try {
      const data = await createOrLoadPersistentMailbox(prefix);
      setMailboxId(data.mailboxId);
      setRequestedMailboxId(data.mailboxId);
      setSavedMailboxes((prev) => Array.from(new Set([data.mailboxId, ...prev])));
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

    setBusyAction('delete');
    setBusyMailboxTarget(targetMailboxId);

    try {
      await deleteMailbox(targetMailboxId);
      setSavedMailboxes((prev) => prev.filter((item) => item !== targetMailboxId));

      if (targetMailboxId === mailboxId) {
        setMailboxId('');
        setRequestedMailboxId('');
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

    window.localStorage.setItem(SAVED_MAILBOXES_KEY, JSON.stringify(savedMailboxes));
  }, [savedMailboxes]);

  useEffect(() => {
    if (!mailboxId && savedMailboxes.length > 0) {
      void openPersistentMailbox(savedMailboxes[0]);
    }
  }, [mailboxId, savedMailboxes]);

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
        </article>
      </div>

      <div className="mode-panel">
        <p className="field-label">建立 / 載入保留信箱</p>
        <div className="input-row">
          <input
            type="text"
            value={requestedMailboxId}
            placeholder="輸入想保留的名稱，例如 grada01"
            onChange={(event) => setRequestedMailboxId(normalizeMailboxId(event.target.value))}
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

      <div className="saved-mailboxes">
        <div className="message-section__header">
          <h3>保留電子郵件清單</h3>
          <span>{savedMailboxes.length} 個</span>
        </div>

        {savedMailboxes.length === 0 ? (
          <div className="empty-state">目前還沒有保存任何保留信箱。</div>
        ) : (
          <div className="saved-list">
            {savedMailboxes.map((savedMailbox) => {
              const isLoadingSaved = busyAction === 'open' && busyMailboxTarget === savedMailbox;
              const isDeletingSaved = busyAction === 'delete' && busyMailboxTarget === savedMailbox;

              return (
                <div className="saved-chip" key={savedMailbox}>
                  <strong>{savedMailbox}@{MAIL_DOMAIN}</strong>
                  <div className="saved-chip__actions">
                    <button type="button" className="secondary small" onClick={() => void openPersistentMailbox(savedMailbox)} disabled={isBusy}>
                      <span className="button-content">
                        {isLoadingSaved ? <span className="button-spinner" aria-hidden="true" /> : null}
                        <span>{isLoadingSaved ? '載入中...' : '載入'}</span>
                      </span>
                    </button>
                    <button type="button" className="danger small" onClick={() => void handleDeleteMailbox(savedMailbox)} disabled={isBusy}>
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
