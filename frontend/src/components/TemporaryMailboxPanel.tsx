import { useEffect, useMemo, useState } from 'react';
import {
  MAIL_DOMAIN,
  cleanupReadMessages,
  createTemporaryMailbox,
  deleteAllMailboxMessages,
  getMailboxMessages,
  markMessageRead,
  promoteMailboxToPersistent,
} from '../lib/api';
import MailMessageTable from './MailMessageTable';
import {
  clearTemporaryMailboxState,
  readTemporaryMailboxState,
  writeTemporaryMailboxState,
  readAutoRefreshEnabled,
  writeAutoRefreshEnabled,
  type MailMessage,
} from './mailboxUtils';

type BusyAction = 'create' | 'move' | null;

type TemporaryMailboxPanelProps = {
  isActive?: boolean;
  onMoveToPersistent?: (mailboxId: string) => void;
  savedMailboxes?: Array<{ mailboxId: string; tag?: string }>;
};

export default function TemporaryMailboxPanel({ isActive = true, onMoveToPersistent, savedMailboxes = [] }: TemporaryMailboxPanelProps) {
  const initialTemporaryMailbox = readTemporaryMailboxState();
  const [mailboxId, setMailboxId] = useState(initialTemporaryMailbox?.mailboxId ?? '');
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [statusText, setStatusText] = useState(
    initialTemporaryMailbox?.mailboxId
      ? '已恢復上次的信箱'
      : '正在建立新信箱...',
  );
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${MAIL_DOMAIN}` : ''), [mailboxId]);
  const isBusy = busyAction !== null;
  const isCreating = busyAction === 'create';
  const isMoving = busyAction === 'move';
  const isMailboxReserved = useMemo(() => {
    if (!mailboxId) return false;
    return savedMailboxes.some(item => item.mailboxId === mailboxId);
  }, [mailboxId, savedMailboxes]);

  const syncMessages = async (targetMailboxId: string) => {
    try {
      const data = await getMailboxMessages(targetMailboxId);
      setMessages(data.messages ?? []);
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
      setMessages([]);
      setCopied(false);
      setStatusText('新信箱已建立');
      setErrorText('');
      await syncMessages(data.mailboxId);
    } catch (error) {
      console.error(error);
      setStatusText('初始化失敗');
      setErrorText(error instanceof Error ? error.message : '建立新信箱失敗。');
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    writeAutoRefreshEnabled(autoRefreshEnabled);
  }, [autoRefreshEnabled]);

  useEffect(() => {
    // Initialize auto refresh enabled state from localStorage
    setAutoRefreshEnabled(readAutoRefreshEnabled());
  }, []);

  useEffect(() => {
    if (!mailboxId) {
      void handleCreateMailbox();
      return;
    }

    setStatusText('已恢復上次的信箱');
  }, []);

  useEffect(() => {
    if (!mailboxId) {
      clearTemporaryMailboxState();
      return;
    }

    writeTemporaryMailboxState({
      mailboxId,
      expireAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // Store expireAt for compatibility
    });
  }, [mailboxId]);

  useEffect(() => {
    if (!isActive || !mailboxId) {
      return;
    }

    // Sync messages immediately when tab becomes active
    void syncMessages(mailboxId);

    if (!autoRefreshEnabled) {
      return;
    }

    const timer = window.setInterval(() => {
      void syncMessages(mailboxId);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [autoRefreshEnabled, isActive, mailboxId]);

  const handleRefreshNow = async () => {
    if (!mailboxId || isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    await syncMessages(mailboxId);
    setIsRefreshing(false);
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

  const handleMoveToPersistent = async () => {
    if (!mailboxId) {
      return;
    }

    setBusyAction('move');

    try {
      const data = await promoteMailboxToPersistent(mailboxId);
      setStatusText('已移至保留信箱');
      setErrorText('');
      await syncMessages(data.mailboxId);
      onMoveToPersistent?.(data.mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '移至保留信箱失敗，請稍後再試。');
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

  const handleDeleteAll = async () => {
    if (!mailboxId) {
      return;
    }

    try {
      await deleteAllMailboxMessages(mailboxId);
      await syncMessages(mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '刪除全部郵件失敗。');
    }
  };

  return (
    <section className="mail-card">
      <div className="mail-card__header">
        <div>
          <h2>新增信箱</h2>
        </div>
        <span className="status-badge active">{statusText}</span>
      </div>

      <div className="mail-insights two-col">
        <article className="insight-card">
          <span>目前地址</span>
          <strong
            onClick={() => emailAddress && void handleCopy()}
            style={{ cursor: emailAddress ? 'pointer' : 'default' }}
            title={emailAddress ? '點擊即複製' : ''}
          >
            {emailAddress || '建立中...'}
          </strong>
          {emailAddress && (
            <p className="muted insight-card__hint">
              ✓ 點擊即複製
              {copied && <span> (已複製)</span>}
            </p>
          )}
        </article>
      </div>

      <div className="mailbox-box">
        <div>
          <p className="field-label">操作</p>
        </div>
        <div className="mailbox-actions mailbox-actions-new-layout">
          <button type="button" className="secondary tiny" onClick={() => void handleCreateMailbox()} disabled={isBusy}>
            <span className="button-content">
              {isCreating ? <span className="button-spinner" aria-hidden="true" /> : null}
              <span>{isCreating ? '產生中...' : '產生新信箱'}</span>
            </span>
          </button>
          {!isMailboxReserved && (
            <button type="button" className="secondary tiny" onClick={handleMoveToPersistent} disabled={!mailboxId || isBusy}>
              <span className="button-content">
                {isMoving ? <span className="button-spinner" aria-hidden="true" /> : null}
                <span>{isMoving ? '移動中...' : '移至保留信箱'}</span>
              </span>
            </button>
          )}
          <button 
            type="button" 
            className="secondary tiny refresh-arrow" 
            onClick={() => void handleRefreshNow()} 
            disabled={!mailboxId || isRefreshing}
            title="刷新"
          >
            <span className="button-content">
              {isRefreshing ? <span className="button-spinner" aria-hidden="true" /> : <span aria-hidden="true">↻</span>}
            </span>
          </button>
        </div>
      </div>

      {errorText ? <p className="error-text">{errorText}</p> : null}

      <MailMessageTable
        messages={messages}
        onMarkRead={handleMarkRead}
        onCleanup={handleCleanup}
        onDeleteAll={handleDeleteAll}
        cleanupLabel="清理已讀 + 過期郵件"
        deleteAllLabel="刪除全部郵件"
        defaultCollapsed={true}
        onCollapsedChange={(isCollapsed) => {
          setAutoRefreshEnabled(!isCollapsed);
        }}
      />
    </section>
  );
}
