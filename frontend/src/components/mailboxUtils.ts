export type MailMessage = {
  id: string;
  from?: string;
  subject?: string;
  text?: string;
  receivedAt?: string | null;
  isRead?: boolean;
};

export const TEN_MINUTES_MS = 10 * 60 * 1000;
export const INITIAL_SECONDS = 10 * 60;
export const SAVED_MAILBOXES_KEY = 'mailhouse.savedMailboxes';

export function normalizeMailboxId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}

export function readSavedMailboxes() {
  if (typeof window === 'undefined') {
    return [] as string[];
  }

  try {
    const rawValue = window.localStorage.getItem(SAVED_MAILBOXES_KEY);
    const parsed = rawValue ? (JSON.parse(rawValue) as unknown) : [];

    if (!Array.isArray(parsed)) {
      return [] as string[];
    }

    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => normalizeMailboxId(item))
      .filter(Boolean);
  } catch {
    return [] as string[];
  }
}

export function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function formatPreview(value = '', maxLength = 72) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value || '(no content)';
}

export function formatReceivedAt(value?: string | null) {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }

  return new Intl.DateTimeFormat('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}
