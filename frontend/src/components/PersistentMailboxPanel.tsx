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

export default function PersistentMailboxPanel() {
  const [mailboxId, setMailboxId] = useState('');
  const [requestedMailboxId, setRequestedMailboxId] = useState('');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState('輸入名稱後即可建立或載入保留信箱');
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [savedMailboxes, setSavedMailboxes] = useState<string[]>(() => readSavedMailboxes());

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${MAIL_DOMAIN}` : ''), [mailboxId]);

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

    setIsBusy(true);

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
      setIsBusy(false);
    }
  };

  const handleDeleteMailbox = async (targetMailboxId = mailboxId) => {
    if (!targetMailboxId) {
      return;
    }

    setIsBusy(true);

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
      setIsBusy(false);
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
      await cleanupReadMessages(24);
      if (mailboxId) {
        await syncMessages(mailboxId);
      }
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '清理已讀郵件失敗。');
    }
  };

  return (
    <section className="mail-card">
      <div className="mail-card__header">
        <div>
          <h2>保留信箱</h2>
          <p className="muted">由 FastAPI 建立、查詢與刪除，前端不再直接存取 Firestore。</p>
        </div>
        <span className="status-badge persistent">{statusText}</span>
      </div>

      <div className="mail-insights two-col">
        <article className="insight-card">
          <span>目前地址</span>
          <strong>{emailAddress || '尚未選擇'}</strong>
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
            建立 / 載入
          </button>
          <button type="button" className="secondary" onClick={handleCopy} disabled={!emailAddress}>
            {copied ? '已複製' : '複製信箱'}
          </button>
          <button type="button" className="danger" onClick={() => void handleDeleteMailbox()} disabled={!mailboxId || isBusy}>
            刪除此信箱
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
            {savedMailboxes.map((savedMailbox) => (
              <div className="saved-chip" key={savedMailbox}>
                <strong>{savedMailbox}@{MAIL_DOMAIN}</strong>
                <div className="saved-chip__actions">
                  <button type="button" className="secondary small" onClick={() => void openPersistentMailbox(savedMailbox)} disabled={isBusy}>
                    載入
                  </button>
                  <button type="button" className="danger small" onClick={() => void handleDeleteMailbox(savedMailbox)} disabled={isBusy}>
                    刪除
                  </button>
                </div>
              </div>
            ))}
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
