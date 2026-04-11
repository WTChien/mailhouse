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
import {
  INITIAL_SECONDS,
  TEMP_MAILBOX_MINUTES,
  clearTemporaryMailboxState,
  formatCountdown,
  readTemporaryMailboxState,
  writeTemporaryMailboxState,
  type MailMessage,
} from './mailboxUtils';

type BusyAction = 'create' | 'extend' | null;

export default function TemporaryMailboxPanel() {
  const initialTemporaryMailbox = readTemporaryMailboxState();
  const [mailboxId, setMailboxId] = useState(initialTemporaryMailbox?.mailboxId ?? '');
  const [expireAt, setExpireAt] = useState<Date | null>(() =>
    initialTemporaryMailbox?.expireAt ? new Date(initialTemporaryMailbox.expireAt) : null,
  );
  const [secondsLeft, setSecondsLeft] = useState(() => {
    if (!initialTemporaryMailbox?.expireAt) {
      return INITIAL_SECONDS;
    }

    return Math.max(0, Math.ceil((new Date(initialTemporaryMailbox.expireAt).getTime() - Date.now()) / 1000));
  });
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState(
    initialTemporaryMailbox?.mailboxId
      ? `已恢復上次的 ${TEMP_MAILBOX_MINUTES} 分鐘信箱`
      : `正在建立 ${TEMP_MAILBOX_MINUTES} 分鐘信箱...`,
  );
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [didAutoReset, setDidAutoReset] = useState(false);

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${MAIL_DOMAIN}` : ''), [mailboxId]);
  const isBusy = busyAction !== null;
  const isCreating = busyAction === 'create';
  const isExtending = busyAction === 'extend';

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
    setBusyAction('create');

    try {
      const data = await createTemporaryMailbox();
      setMailboxId(data.mailboxId);
      setExpireAt(data.expireAt ? new Date(data.expireAt) : null);
      setSecondsLeft(INITIAL_SECONDS);
      setMessages([]);
      setCopied(false);
      setDidAutoReset(false);
      setStatusText(`${TEMP_MAILBOX_MINUTES} 分鐘信箱可用中`);
      setErrorText('');
      await syncMessages(data.mailboxId);
    } catch (error) {
      console.error(error);
      setStatusText('初始化失敗');
      setErrorText(error instanceof Error ? error.message : `建立 ${TEMP_MAILBOX_MINUTES} 分鐘信箱失敗。`);
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    if (!mailboxId) {
      void handleCreateMailbox();
      return;
    }

    setStatusText(`已恢復上次的 ${TEMP_MAILBOX_MINUTES} 分鐘信箱`);
  }, []);

  useEffect(() => {
    if (!mailboxId || !expireAt) {
      clearTemporaryMailboxState();
      return;
    }

    writeTemporaryMailboxState({
      mailboxId,
      expireAt: expireAt.toISOString(),
    });
  }, [expireAt, mailboxId]);

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
        setStatusText(`信箱已到期，正在重建新的 ${TEMP_MAILBOX_MINUTES} 分鐘信箱...`);
      }
    };

    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [expireAt]);

  useEffect(() => {
    if (secondsLeft !== 0 || !mailboxId || isBusy || didAutoReset) {
      return;
    }

    setDidAutoReset(true);
    void handleCreateMailbox();
  }, [didAutoReset, isBusy, mailboxId, secondsLeft]);

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

    setBusyAction('extend');

    try {
      const data = await extendTemporaryMailbox(mailboxId);
      setExpireAt(data.expireAt ? new Date(data.expireAt) : null);
      setDidAutoReset(false);
      setStatusText(`已延長 ${TEMP_MAILBOX_MINUTES} 分鐘`);
      setErrorText('');
      await syncMessages(mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '延長時間失敗，請稍後再試。');
    } finally {
      setBusyAction(null);
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
      await cleanupReadMessages();
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
          <h2>{TEMP_MAILBOX_MINUTES} 分鐘信箱</h2>
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
          <p className="muted">切換 navbar 或重新整理頁面都不會重設信箱，只有到期後或你手動產生新信箱時才會更新。</p>
        </div>
        <div className="mailbox-actions">
          <button type="button" onClick={handleCopy} disabled={!emailAddress}>
            {copied ? '已複製' : '複製信箱'}
          </button>
          <button type="button" className="secondary" onClick={() => void handleCreateMailbox()} disabled={isBusy}>
            <span className="button-content">
              {isCreating ? <span className="button-spinner" aria-hidden="true" /> : null}
              <span>{isCreating ? '產生中...' : '產生新信箱'}</span>
            </span>
          </button>
          <button type="button" className="secondary" onClick={handleExtend} disabled={!mailboxId || isBusy}>
            <span className="button-content">
              {isExtending ? <span className="button-spinner" aria-hidden="true" /> : null}
              <span>{isExtending ? '延長中...' : `延長 ${TEMP_MAILBOX_MINUTES} 分鐘`}</span>
            </span>
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
