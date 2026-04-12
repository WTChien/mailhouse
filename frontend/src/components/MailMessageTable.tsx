import { Fragment, useState } from 'react';
import DOMPurify from 'dompurify';
import type { MailMessage } from './mailboxUtils';
import { formatPreview, formatReceivedAt, getMessageTextContent } from './mailboxUtils';

type Props = {
  messages: MailMessage[];
  onMarkRead?: (messageId: string, isRead: boolean) => void | Promise<void>;
  onCleanup?: () => void | Promise<void>;
  cleanupLabel?: string;
};

type MessageViewMode = 'html' | 'text';

function formatBytes(value?: number) {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const WORKER_PLACEHOLDER_SUBJECT = '(forwarded by Cloudflare Worker)';

function extractVerificationCodes(message: MailMessage) {
  const source = `${message.subject ?? ''}\n${getMessageTextContent(message)}`;
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
  const [expandedMode, setExpandedMode] = useState<MessageViewMode>('text');
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

  const toggleExpanded = (message: MailMessage) => {
    setExpandedMessageId((current) => {
      if (current === message.id) {
        return null;
      }

      setExpandedMode(message.html?.trim() ? 'html' : 'text');
      return message.id;
    });
  };

  const sanitizeEmailHtml = (value: string) => {
    if (!value) {
      return '';
    }

    return DOMPurify.sanitize(value, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onmouseenter'],
      ALLOW_DATA_ATTR: false,
    });
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
                const bodyText = getMessageTextContent(message);
                const hasHtmlBody = Boolean(message.html?.trim());
                const safeHtml = hasHtmlBody ? sanitizeEmailHtml(message.html ?? '') : '';
                const calendarText = (message.calendar ?? '').trim();
                const attachments = message.attachments ?? [];

                return (
                  <Fragment key={message.id}>
                    <tr className={message.isRead ? 'row-read' : ''}>
                      <td>{formatReceivedAt(message.receivedAt)}</td>
                      <td>{message.from || 'unknown'}</td>
                      <td>{displaySubject || '—'}</td>
                      <td>
                        <div className="message-preview-cell">
                          <span>{formatPreview(bodyText, 96)}</span>
                          <button type="button" className="secondary small" onClick={() => toggleExpanded(message)}>
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
                            <div className="message-detail-view-switch">
                              {hasHtmlBody ? (
                                <button
                                  type="button"
                                  className={`secondary small ${expandedMode === 'html' ? 'active-view-mode' : ''}`}
                                  onClick={() => setExpandedMode('html')}
                                >
                                  HTML 檢視
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className={`secondary small ${expandedMode === 'text' ? 'active-view-mode' : ''}`}
                                onClick={() => setExpandedMode('text')}
                              >
                                文字檢視
                              </button>
                            </div>
                            {hasHtmlBody && expandedMode === 'html' ? (
                              <div className="message-html-preview" dangerouslySetInnerHTML={{ __html: safeHtml }} />
                            ) : (
                              <pre className="message-detail-body">{bodyText || '(目前沒有可顯示的完整內文。)'}</pre>
                            )}
                            {calendarText ? (
                              <div className="message-extra-block">
                                <strong>行事曆內容 (text/calendar)</strong>
                                <pre className="message-calendar-body">{calendarText}</pre>
                              </div>
                            ) : null}
                            {attachments.length ? (
                              <div className="message-extra-block">
                                <strong>附件 / MIME Parts</strong>
                                <ul className="attachment-list">
                                  {attachments.map((item, index) => (
                                    <li key={`${message.id}-attachment-${index}`}>
                                      <span className="attachment-name">{item.filename || '(unnamed)'}</span>
                                      <span>{item.mimeType || 'application/octet-stream'}</span>
                                      <span>{item.disposition || 'unknown'}</span>
                                      <span>{formatBytes(item.size)}</span>
                                      {item.isInline || item.contentId ? <span>inline</span> : null}
                                      {item.isCalendar ? <span>calendar</span> : null}
                                      {item.method ? <span>{item.method}</span> : null}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
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
