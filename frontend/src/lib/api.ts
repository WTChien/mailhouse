import type { MailMessage } from '../components/mailboxUtils';
import type { RegistrationDraft, SavedMailboxItem, TagFieldConfigMap } from '../components/mailboxUtils';

export type MailboxMode = 'temporary' | 'persistent';

export type MailboxResponse = {
  status: string;
  mailboxId: string;
  domain?: string;
  email: string;
  mode: MailboxMode;
  expireAt: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  messages?: MailMessage[];
};

export type ClientSyncState = {
  status: string;
  savedMailboxes: SavedMailboxItem[];
  tagFieldConfigs: TagFieldConfigMap;
  registrationDrafts: Record<string, RegistrationDraft>;
  registrationRuntimeDraft: RegistrationDraft | null;
  updatedAt?: string | null;
};

export const MAIL_DOMAINS = (import.meta.env.VITE_MAIL_DOMAINS ?? import.meta.env.VITE_MAIL_DOMAIN ?? 'gradaide.xyz')
  .split(',')
  .map((domain: string) => domain.trim().toLowerCase())
  .filter(Boolean);
export const DEFAULT_MAIL_DOMAIN = import.meta.env.VITE_DEFAULT_MAIL_DOMAIN ?? MAIL_DOMAINS[0] ?? 'gradaide.xyz';
export const MAIL_DOMAIN = DEFAULT_MAIL_DOMAIN;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
let activeMailDomain = DEFAULT_MAIL_DOMAIN;

export function getActiveMailDomain() {
  return activeMailDomain;
}

export function setActiveMailDomain(domain: string) {
  activeMailDomain = MAIL_DOMAINS.includes(domain) ? domain : DEFAULT_MAIL_DOMAIN;
}

function domainQuery(domain = activeMailDomain) {
  return `domain=${encodeURIComponent(domain)}`;
}

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

export async function createTemporaryMailbox(domain = activeMailDomain) {
  return apiRequest<MailboxResponse>(`/api/mailboxes/temp?${domainQuery(domain)}`, {
    method: 'POST',
  });
}

export async function createOrLoadPersistentMailbox(mailboxId: string, domain = activeMailDomain) {
  return apiRequest<MailboxResponse>('/api/mailboxes/persistent', {
    method: 'POST',
    body: JSON.stringify({ mailboxId, domain }),
  });
}

export async function promoteMailboxToPersistent(mailboxId: string, domain = activeMailDomain) {
  return apiRequest<MailboxResponse>(`/api/mailboxes/${mailboxId}/promote?${domainQuery(domain)}`, {
    method: 'POST',
  });
}

export async function extendTemporaryMailbox(mailboxId: string, domain = activeMailDomain) {
  return apiRequest<MailboxResponse>(`/api/mailboxes/${mailboxId}/extend?${domainQuery(domain)}`, {
    method: 'POST',
  });
}

export async function getMailboxMessages(mailboxId: string, domain = activeMailDomain) {
  return apiRequest<MailboxResponse>(`/api/mailboxes/${mailboxId}/messages?${domainQuery(domain)}`);
}

export async function deleteMailbox(mailboxId: string, domain = activeMailDomain) {
  return apiRequest<{ status: string; mailboxId: string }>(`/api/mailboxes/${mailboxId}?${domainQuery(domain)}`, {
    method: 'DELETE',
  });
}

export async function markMessageRead(mailboxId: string, messageId: string, isRead = true, domain = activeMailDomain) {
  return apiRequest<{ status: string; mailboxId: string; messageId: string; isRead: boolean }>(
    `/api/mailboxes/${mailboxId}/messages/${messageId}/read?${domainQuery(domain)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ isRead }),
    },
  );
}

export async function deleteAllMailboxMessages(mailboxId: string, domain = activeMailDomain) {
  return apiRequest<{ status: string; mailboxId: string; deletedMessages: number }>(`/api/mailboxes/${mailboxId}/messages?${domainQuery(domain)}`, {
    method: 'DELETE',
  });
}

export async function cleanupReadMessages(readRetentionHours = 0) {
  return apiRequest<{ status: string; deletedMessages: number; deletedMailboxes: number; readRetentionHours: number }>(
    `/api/cleanup?read_retention_hours=${readRetentionHours}`,
    {
      method: 'POST',
    },
  );
}

export async function getClientSyncState() {
  return apiRequest<ClientSyncState>('/api/client-sync');
}

export async function updateClientSyncState(payload: Partial<Pick<ClientSyncState, 'savedMailboxes' | 'tagFieldConfigs' | 'registrationDrafts' | 'registrationRuntimeDraft'>>) {
  return apiRequest<ClientSyncState>('/api/client-sync', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
