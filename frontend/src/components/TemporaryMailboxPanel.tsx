import { useEffect, useMemo, useState } from 'react';
import {
  MAIL_DOMAIN,
  cleanupReadMessages,
  createTemporaryMailbox,
  extendTemporaryMailbox,
  getMailboxMessages,
  markMessageRead,
} from '../lib/api';
import MailMessageTable from './MailMessageTable';
import { INITIAL_SECONDS, formatCountdown, type MailMessage } from './mailboxUtils';

export default function TemporaryMailboxPanel() {
  const [mailboxId, setMailboxId] = useState('');
  const [expireAt, setExpireAt] = useState<Date | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(INITIAL_SECONDS);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState('正在建立十分鐘信箱...');
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${MAIL_DOMAIN}` : ''), [mailboxId]);

  const syncMessages = async (targetMailboxId: string) => {
    try {
      const data = await getMailboxMessages(targetMailboxId);
      setMessages(data.messages ?? []);
      setExpireAt(data.expireAt ? new Date(data.expireAt) : null);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '載入信件失敗，請稍後再試。');
    }
  };

  const handleCreateMailbox = async () => {
    setIsBusy(true);

    try {
      const data = await createTemporaryMailbox();
      setMailboxId(data.mailboxId);
      setExpireAt(data.expireAt ? new Date(data.expireAt) : null);
      setSecondsLeft(INITIAL_SECONDS);
      setMessages([]);
      setStatusText('十分鐘信箱可用中');
      setErrorText('');
      await syncMessages(data.mailboxId);
    } catch (error) {
      console.error(error);
      setStatusText('初始化失敗');
      setErrorText(error instanceof Error ? error.message : '建立十分鐘信箱失敗。');
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    void handleCreateMailbox();
  }, []);

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

  useEffect(() => {
    if (!expireAt) {
      return;
    }

    const updateRemaining = () => {
      const remaining = Math.max(0, Math.ceil((expireAt.getTime() - Date.now()) / 1000));
      setSecondsLeft(remaining);

      if (remaining === 0) {
        setStatusText('信箱已過期');
      }
    };

    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [expireAt]);

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

  const handleExtend = async () => {
    if (!mailboxId) {
      return;
    }

    setIsBusy(true);

    try {
      const data = await extendTemporaryMailbox(mailboxId);
      setExpireAt(data.expireAt ? new Date(data.expireAt) : null);
      setStatusText('已延長 10 分鐘');
      setErrorText('');
      await syncMessages(mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '延長時間失敗，請稍後再試。');
    } finally {
      setIsBusy(false);
    }
  };

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

  const isExpired = secondsLeft === 0;

  return (
    <section className="mail-card">
      <div className="mail-card__header">
        <div>
          <h2>十分鐘信箱</h2>
          <p className="muted">由 FastAPI 建立與查詢，前端只向後端要求資料。</p>
        </div>
        <span className={`status-badge ${isExpired ? 'expired' : 'active'}`}>{statusText}</span>
      </div>

      <div className="mail-insights two-col">
        <article className="insight-card">
          <span>目前地址</span>
          <strong>{emailAddress || '建立中...'}</strong>
        </article>
        <article className="insight-card">
          <span>剩餘時間</span>
          <strong>{formatCountdown(secondsLeft)}</strong>
        </article>
      </div>

      <div className="mailbox-box">
        <div>
          <p className="field-label">操作</p>
          <p className="muted">你可以隨時產生新的暫時信箱，或延長目前信箱 10 分鐘。</p>
        </div>
        <div className="mailbox-actions">
          <button type="button" onClick={handleCopy} disabled={!emailAddress}>
            {copied ? '已複製' : '複製信箱'}
          </button>
          <button type="button" className="secondary" onClick={() => void handleCreateMailbox()} disabled={isBusy}>
            產生新信箱
          </button>
          <button type="button" className="secondary" onClick={handleExtend} disabled={!mailboxId || isBusy}>
            延長 10 分鐘
          </button>
        </div>
      </div>

      {errorText ? <p className="error-text">{errorText}</p> : null}

      <MailMessageTable
        messages={messages}
        onMarkRead={handleMarkRead}
        onCleanup={handleCleanup}
        cleanupLabel="清理已讀 + 過期郵件"
      />
    </section>
  );
}
