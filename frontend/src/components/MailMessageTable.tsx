import { Fragment, useState } from 'react';
import type { MailMessage } from './mailboxUtils';
import { formatPreview, formatReceivedAt } from './mailboxUtils';

type Props = {
  messages: MailMessage[];
  onMarkRead?: (messageId: string, isRead: boolean) => void | Promise<void>;
  onCleanup?: () => void | Promise<void>;
  cleanupLabel?: string;
};

const WORKER_PLACEHOLDER_SUBJECT = '(forwarded by Cloudflare Worker)';

function extractVerificationCodes(message: MailMessage) {
  const source = `${message.subject ?? ''}\n${message.text ?? ''}`;
  const matches = source.match(/\b[A-Z0-9]{4,8}\b/gi) ?? [];

  return Array.from(new Set(matches.map((value) => value.trim()).filter((value) => /\d/.test(value))));
}

function normalizeSubject(subject?: string) {
  const value = (subject ?? '').trim();
  return value === WORKER_PLACEHOLDER_SUBJECT ? '' : value;
}

export default function MailMessageTable({ messages, onMarkRead, onCleanup, cleanupLabel = '清理已讀郵件' }: Props) {
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);

  const handleCleanupClick = async () => {
    if (!onCleanup || isCleaningUp) {
      return;
    }

    setIsCleaningUp(true);
    try {
      await onCleanup();
    } finally {
      setIsCleaningUp(false);
    }
  };

  const handleMarkReadClick = async (messageId: string, isRead: boolean) => {
    if (!onMarkRead || pendingMessageId) {
      return;
    }

    setPendingMessageId(messageId);
    try {
      await onMarkRead(messageId, isRead);
    } finally {
      setPendingMessageId(null);
    }
  };

  const toggleExpanded = (messageId: string) => {
    setExpandedMessageId((current) => (current === messageId ? null : messageId));
  };

  return (
    <div className="message-section">
      <div className="message-section__header">
        <h3>收到的信件</h3>
        <div className="message-section__actions">
          <span>{messages.length} 封</span>
          {onCleanup ? (
            <button type="button" className="secondary small" onClick={() => void handleCleanupClick()} disabled={isCleaningUp || pendingMessageId !== null}>
              <span className="button-content">
                {isCleaningUp ? <span className="button-spinner" aria-hidden="true" /> : null}
                <span>{isCleaningUp ? '清理中...' : cleanupLabel}</span>
              </span>
            </button>
          ) : null}
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="empty-state">目前尚未收到任何郵件。</div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>時間</th>
                <th>寄件人</th>
                <th>主旨</th>
                <th>內文預覽</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => {
                const isUpdating = pendingMessageId === message.id;
                const isExpanded = expandedMessageId === message.id;
                const possibleCodes = extractVerificationCodes(message);
                const displaySubject = normalizeSubject(message.subject);

                return (
                  <Fragment key={message.id}>
                    <tr className={message.isRead ? 'row-read' : ''}>
                      <td>{formatReceivedAt(message.receivedAt)}</td>
                      <td>{message.from || 'unknown'}</td>
                      <td>{displaySubject || '—'}</td>
                      <td>
                        <div className="message-preview-cell">
                          <span>{formatPreview(message.text, 96)}</span>
                          <button type="button" className="secondary small" onClick={() => toggleExpanded(message.id)}>
                            {isExpanded ? '收起全文' : '查看全文'}
                          </button>
                        </div>
                      </td>
                      <td>
                        <div className="message-row-actions">
                          {onMarkRead ? (
                            <button
                              type="button"
                              className="secondary small"
                              onClick={() => void handleMarkReadClick(message.id, !message.isRead)}
                              disabled={isUpdating || isCleaningUp}
                            >
                              <span className="button-content">
                                {isUpdating ? <span className="button-spinner" aria-hidden="true" /> : null}
                                <span>{isUpdating ? '更新中...' : message.isRead ? '標示未讀' : '標示已讀'}</span>
                              </span>
                            </button>
                          ) : (
                            <span>{message.isRead ? '已讀' : '未讀'}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="message-detail-row">
                        <td colSpan={5}>
                          <div className="message-detail-card">
                            <div className="message-detail-card__header">
                              <strong>完整內容</strong>
                              {possibleCodes.length ? (
                                <div className="message-code-block">
                                  <span>可能驗證碼</span>
                                  <div className="message-code-list">
                                    {possibleCodes.map((code) => (
                                      <button key={code} type="button" className="code-chip" onClick={() => void navigator.clipboard.writeText(code)}>
                                        {code}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                            <div className="message-detail-meta">
                              <span><strong>寄件人：</strong>{message.from || 'unknown'}</span>
                              {displaySubject ? <span><strong>主旨：</strong>{displaySubject}</span> : null}
                            </div>
                            <pre className="message-detail-body">{message.text || '(目前沒有可顯示的完整內文。)'}</pre>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
