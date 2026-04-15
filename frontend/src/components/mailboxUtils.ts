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
export const REGISTRATION_DRAFTS_KEY = 'mailhouse.registrationDrafts';
export const REGISTRATION_RUNTIME_DRAFT_KEY = 'mailhouse.registrationRuntimeDraft';

export type SavedMailboxItem = {
  mailboxId: string;
  tag: string;
  createdAt: string;
  lastUsedAt: string;
};

export type TemporaryMailboxState = {
  mailboxId: string;
  expireAt: string;
};

export type RegistrationDraft = {
  generatedName: string;
  generatedPassword: string;
  updatedAt: string;
};

const UPPER_LOWER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LOWER_ALNUM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DIGIT_CHARS = '0123456789';

function pickRandomChars(source: string, length: number) {
  return Array.from({ length }, () => source[Math.floor(Math.random() * source.length)]).join('');
}

export function normalizeRegistrationDraft(value?: Partial<RegistrationDraft> | null) {
  if (!value) {
    return null as RegistrationDraft | null;
  }

  if (typeof value.generatedName !== 'string' || typeof value.generatedPassword !== 'string') {
    return null as RegistrationDraft | null;
  }

  return {
    generatedName: value.generatedName,
    generatedPassword: value.generatedPassword,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  } satisfies RegistrationDraft;
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

export function normalizeMailboxTag(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 28);
}

function normalizeSavedMailboxItem(item: Partial<SavedMailboxItem>, fallbackNow: string) {
  const mailboxId = normalizeMailboxId(item.mailboxId ?? '');
  if (!mailboxId) {
    return null;
  }

  const createdAtValue = typeof item.createdAt === 'string' ? item.createdAt : fallbackNow;
  const lastUsedAtValue = typeof item.lastUsedAt === 'string' ? item.lastUsedAt : createdAtValue;
  const createdAt = Number.isNaN(new Date(createdAtValue).getTime()) ? fallbackNow : createdAtValue;
  const lastUsedAt = Number.isNaN(new Date(lastUsedAtValue).getTime()) ? createdAt : lastUsedAtValue;

  return {
    mailboxId,
    tag: normalizeMailboxTag(item.tag ?? ''),
    createdAt,
    lastUsedAt,
  } satisfies SavedMailboxItem;
}

export function readSavedMailboxes() {
  if (typeof window === 'undefined') {
    return [] as SavedMailboxItem[];
  }

  try {
    const rawValue = window.localStorage.getItem(SAVED_MAILBOXES_KEY);
    const parsed = rawValue ? (JSON.parse(rawValue) as unknown) : [];
    const nowIso = new Date().toISOString();

    if (!Array.isArray(parsed)) {
      return [] as SavedMailboxItem[];
    }

    const normalizedItems = parsed
      .map((item) => {
        if (typeof item === 'string') {
          const mailboxId = normalizeMailboxId(item);
          if (!mailboxId) {
            return null;
          }

          return {
            mailboxId,
            tag: '',
            createdAt: nowIso,
            lastUsedAt: nowIso,
          } satisfies SavedMailboxItem;
        }

        if (!item || typeof item !== 'object') {
          return null;
        }

        return normalizeSavedMailboxItem(item as Partial<SavedMailboxItem>, nowIso);
      })
      .filter((item): item is SavedMailboxItem => Boolean(item));

    const deduped = new Map<string, SavedMailboxItem>();
    normalizedItems.forEach((item) => {
      const existing = deduped.get(item.mailboxId);
      if (!existing) {
        deduped.set(item.mailboxId, item);
        return;
      }

      const createdAt = new Date(existing.createdAt).getTime() <= new Date(item.createdAt).getTime()
        ? existing.createdAt
        : item.createdAt;
      const lastUsedAt = new Date(existing.lastUsedAt).getTime() >= new Date(item.lastUsedAt).getTime()
        ? existing.lastUsedAt
        : item.lastUsedAt;
      deduped.set(item.mailboxId, {
        mailboxId: item.mailboxId,
        tag: item.tag || existing.tag,
        createdAt,
        lastUsedAt,
      });
    });

    return Array.from(deduped.values());
  } catch {
    return [] as SavedMailboxItem[];
  }
}

export function writeSavedMailboxes(items: SavedMailboxItem[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(SAVED_MAILBOXES_KEY, JSON.stringify(items));
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

export function readRegistrationDrafts() {
  if (typeof window === 'undefined') {
    return {} as Record<string, RegistrationDraft>;
  }

  try {
    const raw = window.localStorage.getItem(REGISTRATION_DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};

    if (!parsed || typeof parsed !== 'object') {
      return {} as Record<string, RegistrationDraft>;
    }

    return Object.entries(parsed as Record<string, Partial<RegistrationDraft>>).reduce<Record<string, RegistrationDraft>>((acc, [scope, draft]) => {
      const normalizedDraft = normalizeRegistrationDraft(draft);
      if (normalizedDraft) {
        acc[scope] = normalizedDraft;
      }
      return acc;
    }, {});
  } catch {
    return {} as Record<string, RegistrationDraft>;
  }
}

export function writeRegistrationDraft(scope: string, draft: RegistrationDraft) {
  if (typeof window === 'undefined') {
    return;
  }

  const drafts = readRegistrationDrafts();
  drafts[scope] = draft;
  window.localStorage.setItem(REGISTRATION_DRAFTS_KEY, JSON.stringify(drafts));
}

export function writeRegistrationDrafts(drafts: Record<string, RegistrationDraft>) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(REGISTRATION_DRAFTS_KEY, JSON.stringify(drafts));
}

export function readRegistrationRuntimeDraft() {
  if (typeof window === 'undefined') {
    return null as RegistrationDraft | null;
  }

  try {
    const raw = window.localStorage.getItem(REGISTRATION_RUNTIME_DRAFT_KEY);
    if (!raw) {
      return null;
    }

    return normalizeRegistrationDraft(JSON.parse(raw) as Partial<RegistrationDraft>);
  } catch {
    return null as RegistrationDraft | null;
  }
}

export function writeRegistrationRuntimeDraft(draft: RegistrationDraft) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(REGISTRATION_RUNTIME_DRAFT_KEY, JSON.stringify(draft));
}

export function clearRegistrationRuntimeDraft() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(REGISTRATION_RUNTIME_DRAFT_KEY);
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
