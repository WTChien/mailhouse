import type { MailMessage } from '../components/mailboxUtils';

export type MailboxMode = 'temporary' | 'persistent';

export type MailboxResponse = {
  status: string;
  mailboxId: string;
  email: string;
  mode: MailboxMode;
  expireAt: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  messages?: MailMessage[];
};

export const MAIL_DOMAIN = import.meta.env.VITE_MAIL_DOMAIN ?? 'gradaide.xyz';
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === 'string'
        ? payload
        : payload?.detail || payload?.message || 'API request failed';

    throw new Error(message);
  }

  return payload as T;
}

export async function createTemporaryMailbox() {
  return apiRequest<MailboxResponse>('/api/mailboxes/temp', {
    method: 'POST',
  });
}

export async function createOrLoadPersistentMailbox(mailboxId: string) {
  return apiRequest<MailboxResponse>('/api/mailboxes/persistent', {
    method: 'POST',
    body: JSON.stringify({ mailboxId }),
  });
}

export async function extendTemporaryMailbox(mailboxId: string) {
  return apiRequest<MailboxResponse>(`/api/mailboxes/${mailboxId}/extend`, {
    method: 'POST',
  });
}

export async function getMailboxMessages(mailboxId: string) {
  return apiRequest<MailboxResponse>(`/api/mailboxes/${mailboxId}/messages`);
}

export async function deleteMailbox(mailboxId: string) {
  return apiRequest<{ status: string; mailboxId: string }>(`/api/mailboxes/${mailboxId}`, {
    method: 'DELETE',
  });
}

export async function markMessageRead(mailboxId: string, messageId: string, isRead = true) {
  return apiRequest<{ status: string; mailboxId: string; messageId: string; isRead: boolean }>(
    `/api/mailboxes/${mailboxId}/messages/${messageId}/read`,
    {
      method: 'PATCH',
      body: JSON.stringify({ isRead }),
    },
  );
}

export async function cleanupReadMessages(readRetentionHours = 24) {
  return apiRequest<{ status: string; deletedMessages: number; deletedMailboxes: number; readRetentionHours: number }>(
    `/api/cleanup?read_retention_hours=${readRetentionHours}`,
    {
      method: 'POST',
    },
  );
}
