import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MAIL_DOMAIN,
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
  type MailMessage,
} from './mailboxUtils';

type BusyAction = 'create' | 'move' | null;
const ACCOUNT_NAME_BUILDER_KEY = 'mailhouse.accountNameBuilder';
type NameBuilderRow = {
  id: 'name' | 'account' | 'password';
  label: string;
  left: string;
  number: string;
  right: string;
};
const DEFAULT_NAME_BUILDER_ROWS: NameBuilderRow[] = [
  { id: 'name', label: '名稱', left: 'r', number: '11', right: 'm4000' },
  { id: 'account', label: '帳號', left: 'R', number: '11', right: 'm-0400' },
  { id: 'password', label: '密碼', left: 'pass', number: '11', right: '!' },
];

type TemporaryMailboxPanelProps = {
  isActive?: boolean;
  activeDomain: string;
  onMoveToPersistent?: (mailboxId: string) => void;
  savedMailboxes?: Array<{ mailboxId: string; domain?: string; tag?: string }>;
};

export default function TemporaryMailboxPanel({ isActive = true, activeDomain, onMoveToPersistent, savedMailboxes = [] }: TemporaryMailboxPanelProps) {
  const initialTemporaryMailbox = readTemporaryMailboxState();
  const initialNameBuilder = (() => {
    if (typeof window === 'undefined') {
      return DEFAULT_NAME_BUILDER_ROWS;
    }

    try {
      const parsed = JSON.parse(window.localStorage.getItem(ACCOUNT_NAME_BUILDER_KEY) || '[]') as unknown;
      if (!Array.isArray(parsed)) {
        return DEFAULT_NAME_BUILDER_ROWS;
      }

      return DEFAULT_NAME_BUILDER_ROWS.map((fallback) => {
        const storedRow = parsed.find((item) => item && typeof item === 'object' && (item as Partial<NameBuilderRow>).id === fallback.id) as Partial<NameBuilderRow> | undefined;
        return {
          ...fallback,
          left: typeof storedRow?.left === 'string' ? storedRow.left : fallback.left,
          number: typeof storedRow?.number === 'string' ? storedRow.number : fallback.number,
          right: typeof storedRow?.right === 'string' ? storedRow.right : fallback.right,
        };
      });
    } catch {
      return DEFAULT_NAME_BUILDER_ROWS;
    }
  })();
  const [mailboxId, setMailboxId] = useState(
    (initialTemporaryMailbox?.domain || DEFAULT_MAIL_DOMAIN) === activeDomain ? initialTemporaryMailbox?.mailboxId ?? '' : '',
  );
  const [nameRows, setNameRows] = useState<NameBuilderRow[]>(initialNameBuilder);
  const [copiedNameRow, setCopiedNameRow] = useState<NameBuilderRow['id'] | null>(null);
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
  const [messagesCollapsed, setMessagesCollapsed] = useState(true);
  const messagePollInFlightRef = useRef(false);

  const emailAddress = useMemo(() => (mailboxId ? `${mailboxId}@${activeDomain}` : ''), [activeDomain, mailboxId]);
  const isBusy = busyAction !== null;
  const isCreating = busyAction === 'create';
  const isMoving = busyAction === 'move';
  const isMailboxReserved = useMemo(() => {
    if (!mailboxId) return false;
    return savedMailboxes.some(item => item.mailboxId === mailboxId && (item.domain || DEFAULT_MAIL_DOMAIN) === activeDomain);
  }, [activeDomain, mailboxId, savedMailboxes]);

  const syncMessages = async (targetMailboxId: string) => {
    if (messagePollInFlightRef.current) {
      return;
    }

    messagePollInFlightRef.current = true;
    try {
      const data = await getMailboxMessages(targetMailboxId, activeDomain);
      setMessages(data.messages ?? []);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '載入信件失敗，請稍後再試。');
    } finally {
      messagePollInFlightRef.current = false;
    }
  };

  const getNextPollMs = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return 30000;
    }

    return messagesCollapsed ? 10000 : 4000;
  };

  const handleCreateMailbox = async () => {
    setBusyAction('create');

    try {
      const data = await createTemporaryMailbox(activeDomain);
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
    const storedMailbox = readTemporaryMailboxState();
    if (storedMailbox && (storedMailbox.domain || DEFAULT_MAIL_DOMAIN) === activeDomain) {
      setMailboxId(storedMailbox.mailboxId);
      return;
    }

    setMailboxId('');
    setMessages([]);
    clearTemporaryMailboxState();
  }, [activeDomain]);

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
      domain: activeDomain,
      expireAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // Store expireAt for compatibility
    });
  }, [activeDomain, mailboxId]);

  useEffect(() => {
    if (!isActive || !mailboxId) {
      return;
    }

    let disposed = false;
    let timerId = 0;

    const poll = async () => {
      await syncMessages(mailboxId);
      if (disposed) {
        return;
      }

      timerId = window.setTimeout(() => {
        void poll();
      }, getNextPollMs());
    };

    const wakeAndSyncNow = () => {
      if (disposed) {
        return;
      }

      window.clearTimeout(timerId);
      void poll();
    };

    void poll();
    window.addEventListener('focus', wakeAndSyncNow);
    document.addEventListener('visibilitychange', wakeAndSyncNow);

    return () => {
      disposed = true;
      window.clearTimeout(timerId);
      window.removeEventListener('focus', wakeAndSyncNow);
      document.removeEventListener('visibilitychange', wakeAndSyncNow);
    };
  }, [isActive, mailboxId, messagesCollapsed]);

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

  const updateNameRow = (rowId: NameBuilderRow['id'], field: 'left' | 'number' | 'right', value: string) => {
    setNameRows((prev) => prev.map((row) => (
      row.id === rowId
        ? { ...row, [field]: field === 'number' ? value.replace(/[^0-9]/g, '') : value }
        : row
    )));
  };

  const getNameRowResult = (row: NameBuilderRow) => `${row.left}${row.number}${row.right}`;

  const handleCopyNameRow = async (row: NameBuilderRow) => {
    const result = getNameRowResult(row);
    if (!result) {
      return;
    }

    try {
      await navigator.clipboard.writeText(result);
      setCopiedNameRow(row.id);
      window.setTimeout(() => setCopiedNameRow(null), 1500);
    } catch (error) {
      console.error(error);
      setErrorText('帳號名稱複製失敗');
    }
  };

  const incrementNameNumber = () => {
    setNameRows((prev) => prev.map((row) => {
      const trimmedNumber = row.number.trim();
      const currentNumber = Number.parseInt(trimmedNumber || '0', 10);
      const nextNumber = Number.isNaN(currentNumber) ? 1 : currentNumber + 1;
      const shouldPad = /^0\d+$/.test(trimmedNumber);
      return {
        ...row,
        number: shouldPad ? String(nextNumber).padStart(trimmedNumber.length, '0') : String(nextNumber),
      };
    }));
  };

  const handleMoveToPersistent = async () => {
    if (!mailboxId) {
      return;
    }

    setBusyAction('move');

    try {
      const data = await promoteMailboxToPersistent(mailboxId, activeDomain);
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
      await markMessageRead(mailboxId, messageId, isRead, activeDomain);
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
      await deleteAllMailboxMessages(mailboxId, activeDomain);
      await syncMessages(mailboxId);
    } catch (error) {
      console.error(error);
      setErrorText(error instanceof Error ? error.message : '刪除全部郵件失敗。');
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(ACCOUNT_NAME_BUILDER_KEY, JSON.stringify(nameRows));
  }, [nameRows]);

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

      <section className="name-builder">
        <div className="name-builder__header">
          <div>
            <h3>帳號命名器</h3>
            <p className="muted">固定左右字元，中間數字按 +1 自動遞增。</p>
          </div>
          <button type="button" className="secondary tiny" onClick={incrementNameNumber}>
            +1
          </button>
        </div>

        <div className="name-builder__table">
          <div className="name-builder__table-head" aria-hidden="true">
            <span>類型</span>
            <span>左側</span>
            <span>數字</span>
            <span>右側</span>
            <span>結果</span>
            <span></span>
          </div>
          {nameRows.map((row) => {
            const result = getNameRowResult(row);
            return (
              <div className="name-builder__row" key={row.id}>
                <strong>{row.label}</strong>
                <input
                  type="text"
                  value={row.left}
                  onChange={(event) => updateNameRow(row.id, 'left', event.target.value)}
                  aria-label={`${row.label}左側固定`}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={row.number}
                  onChange={(event) => updateNameRow(row.id, 'number', event.target.value)}
                  aria-label={`${row.label}中間數字`}
                />
                <input
                  type="text"
                  value={row.right}
                  onChange={(event) => updateNameRow(row.id, 'right', event.target.value)}
                  aria-label={`${row.label}右側固定`}
                />
                <code>{result || '尚未輸入'}</code>
                <button type="button" className="secondary tiny" onClick={() => void handleCopyNameRow(row)} disabled={!result}>
                  {copiedNameRow === row.id ? '已複製' : '複製'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {errorText ? <p className="error-text">{errorText}</p> : null}

      <MailMessageTable
        messages={messages}
        onMarkRead={handleMarkRead}
        onCleanup={handleCleanup}
        onDeleteAll={handleDeleteAll}
        cleanupLabel="清理已讀 + 過期郵件"
        deleteAllLabel="刪除全部郵件"
        defaultCollapsed={true}
        onCollapsedChange={setMessagesCollapsed}
      />
    </section>
  );
}
