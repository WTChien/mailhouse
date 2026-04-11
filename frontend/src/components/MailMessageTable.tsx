import { useState } from 'react';
import type { MailMessage } from './mailboxUtils';
import { formatPreview, formatReceivedAt } from './mailboxUtils';

type Props = {
  messages: MailMessage[];
  onMarkRead?: (messageId: string, isRead: boolean) => void | Promise<void>;
  onCleanup?: () => void | Promise<void>;
  cleanupLabel?: string;
};

export default function MailMessageTable({ messages, onMarkRead, onCleanup, cleanupLabel = '清理已讀郵件' }: Props) {
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
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
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => {
                const isUpdating = pendingMessageId === message.id;

                return (
                  <tr key={message.id} className={message.isRead ? 'row-read' : ''}>
                    <td>{formatReceivedAt(message.receivedAt)}</td>
                    <td>{message.from || 'unknown'}</td>
                    <td>{message.subject || '(no subject)'}</td>
                    <td>{formatPreview(message.text)}</td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
