export type MailAttachment = {
  filename?: string;
  mimeType?: string;
  disposition?: 'attachment' | 'inline' | 'unknown';
  contentId?: string;
  size?: number;
  isInline?: boolean;
  isCalendar?: boolean;
  method?: string;
};

export type MailMessage = {
  id: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  calendar?: string;
  attachments?: MailAttachment[];
  receivedAt?: string | null;
  isRead?: boolean;
};

export const TEMP_MAILBOX_MINUTES = 30;
export const TEMP_MAILBOX_MS = TEMP_MAILBOX_MINUTES * 60 * 1000;
export const INITIAL_SECONDS = TEMP_MAILBOX_MINUTES * 60;
export const SAVED_MAILBOXES_KEY = 'mailhouse.savedMailboxes';
export const TEMP_MAILBOX_STATE_KEY = 'mailhouse.temporaryMailbox';

export type TemporaryMailboxState = {
  mailboxId: string;
  expireAt: string;
};

const UPPER_LOWER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LOWER_ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DIGIT_CHARS = '0123456789';

function pickRandomChars(source: string, length: number) {
  return Array.from({ length }, () => source[Math.floor(Math.random() * source.length)]).join('');
}

export function generateStrongPassword() {
  return `${pickRandomChars(UPPER_LOWER_CHARS, 4)}${pickRandomChars(DIGIT_CHARS, 5)}`;
}

export function generateSuggestedMailboxName() {
  return normalizeMailboxId(`${pickRandomChars('abcdefghijklmnopqrstuvwxyz', 3)}${pickRandomChars(LOWER_ALNUM_CHARS, 5)}`);
}

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

export function readTemporaryMailboxState() {
  if (typeof window === 'undefined') {
    return null as TemporaryMailboxState | null;
  }

  try {
    const rawValue = window.localStorage.getItem(TEMP_MAILBOX_STATE_KEY);
    const parsed = rawValue ? (JSON.parse(rawValue) as Partial<TemporaryMailboxState>) : null;
    const mailboxId = normalizeMailboxId(parsed?.mailboxId ?? '');
    const expireAt = typeof parsed?.expireAt === 'string' ? parsed.expireAt : '';
    const expiresAtDate = new Date(expireAt);

    if (!mailboxId || Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
      window.localStorage.removeItem(TEMP_MAILBOX_STATE_KEY);
      return null;
    }

    return { mailboxId, expireAt };
  } catch {
    return null as TemporaryMailboxState | null;
  }
}

export function writeTemporaryMailboxState(state: TemporaryMailboxState) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(TEMP_MAILBOX_STATE_KEY, JSON.stringify(state));
}

export function clearTemporaryMailboxState() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(TEMP_MAILBOX_STATE_KEY);
}

export function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function formatPreview(value = '', maxLength = 72) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value || '(no content)';
}

export function htmlToPlainText(value = '') {
  if (!value) {
    return '';
  }

  if (typeof window !== 'undefined') {
    const parser = new window.DOMParser();
    const doc = parser.parseFromString(value, 'text/html');
    return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function getMessageTextContent(message: MailMessage) {
  const plainText = message.text?.trim() ?? '';
  if (plainText) {
    return plainText;
  }

  return htmlToPlainText(message.html ?? '');
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
