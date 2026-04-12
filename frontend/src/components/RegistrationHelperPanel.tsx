import { useEffect, useState } from 'react';
import { generateStrongPassword, generateSuggestedMailboxName } from './mailboxUtils';

type Props = {
  onApplyName?: (value: string) => void;
  profileScope?: string;
  onApplyTag?: (value: string) => void;
  persistDraft?: boolean;
  defaultCollapsed?: boolean;
};

type RegistrationDraft = {
  generatedName: string;
  generatedPassword: string;
  updatedAt: string;
};

const REGISTRATION_DRAFTS_KEY = 'mailhouse.registrationDrafts';
const REGISTRATION_RUNTIME_DRAFT_KEY = 'mailhouse.registrationRuntimeDraft';

function readDrafts() {
  if (typeof window === 'undefined') {
    return {} as Record<string, RegistrationDraft>;
  }

  try {
    const raw = window.localStorage.getItem(REGISTRATION_DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};

    if (!parsed || typeof parsed !== 'object') {
      return {} as Record<string, RegistrationDraft>;
    }

    return parsed as Record<string, RegistrationDraft>;
  } catch {
    return {} as Record<string, RegistrationDraft>;
  }
}

function writeDraft(scope: string, draft: RegistrationDraft) {
  if (typeof window === 'undefined') {
    return;
  }

  const drafts = readDrafts();
  drafts[scope] = draft;
  window.localStorage.setItem(REGISTRATION_DRAFTS_KEY, JSON.stringify(drafts));
}

function readRuntimeDraft() {
  if (typeof window === 'undefined') {
    return null as RegistrationDraft | null;
  }

  try {
    const raw = window.localStorage.getItem(REGISTRATION_RUNTIME_DRAFT_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<RegistrationDraft>;
    if (typeof parsed.generatedName !== 'string' || typeof parsed.generatedPassword !== 'string') {
      return null;
    }

    return {
      generatedName: parsed.generatedName,
      generatedPassword: parsed.generatedPassword,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null as RegistrationDraft | null;
  }
}

function writeRuntimeDraft(draft: RegistrationDraft) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(REGISTRATION_RUNTIME_DRAFT_KEY, JSON.stringify(draft));
}

function clearRuntimeDraft() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(REGISTRATION_RUNTIME_DRAFT_KEY);
}

function scopeLabel(scope: string) {
  if (scope.startsWith('tag:')) {
    return scope.slice(4) || '自訂分類';
  }

  if (scope === 'nintendo') {
    return 'Nintendo';
  }

  if (scope === 'xiaomi') {
    return '小米';
  }

  return '一般';
}

function scopeDefaultTag(scope: string) {
  if (scope.startsWith('tag:')) {
    return normalizeScopeTag(scope.slice(4));
  }

  if (scope === 'nintendo') {
    return 'nintendo';
  }

  if (scope === 'xiaomi') {
    return '小米';
  }

  return '';
}

function normalizeScopeTag(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 28);
}

export default function RegistrationHelperPanel({
  onApplyName,
  profileScope = 'general',
  onApplyTag,
  persistDraft = false,
  defaultCollapsed = true,
}: Props) {
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [generatedName, setGeneratedName] = useState('');
  const [nameCopied, setNameCopied] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState('');

  const refreshName = () => {
    const next = generateSuggestedMailboxName();
    setGeneratedName(next);
    return next;
  };

  const refreshPassword = () => {
    const next = generateStrongPassword();
    setGeneratedPassword(next);
    return next;
  };

  useEffect(() => {
    if (!persistDraft) {
      // 不再自动生成名称和密码，只在点击时生成
      return;
    }

    const draft = readDrafts()[profileScope];
    if (draft?.generatedName || draft?.generatedPassword) {
      setGeneratedName(draft.generatedName ?? '');
      setGeneratedPassword(draft.generatedPassword ?? '');
      setLastSavedAt(draft.updatedAt ?? '');
      return;
    }

    const runtimeDraft = readRuntimeDraft();
    if (runtimeDraft?.generatedName || runtimeDraft?.generatedPassword) {
      setGeneratedName(runtimeDraft.generatedName);
      setGeneratedPassword(runtimeDraft.generatedPassword);
      setLastSavedAt(runtimeDraft.updatedAt ?? '');
      clearRuntimeDraft();
      return;
    }

    // 不再初始化时生成
  }, [persistDraft, profileScope]);

  useEffect(() => {
    if (!persistDraft) {
      if (!generatedName && !generatedPassword) {
        return;
      }

      writeRuntimeDraft({
        generatedName,
        generatedPassword,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (!generatedName && !generatedPassword) {
      return;
    }

    const updatedAt = new Date().toISOString();
    writeDraft(profileScope, {
      generatedName,
      generatedPassword,
      updatedAt,
    });
    setLastSavedAt(updatedAt);
  }, [generatedName, generatedPassword, persistDraft, profileScope]);

  const copyValue = async (type: 'name' | 'password', value: string) => {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);

    if (type === 'name') {
      setNameCopied(true);
      window.setTimeout(() => setNameCopied(false), 1500);
      return;
    }

    setPasswordCopied(true);
    window.setTimeout(() => setPasswordCopied(false), 1500);
  };

  const handleApplyName = () => {
    if (!generatedName || !onApplyName) {
      return;
    }

    onApplyName(generatedName);

    const suggestedTag = scopeDefaultTag(profileScope);
    if (suggestedTag && onApplyTag) {
      onApplyTag(suggestedTag);
    }
  };

  const handleGenerateAndCopy = async (type: 'name' | 'password') => {
    try {
      const value = type === 'name' ? refreshName() : refreshPassword();
      await copyValue(type, value);
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="generator-panel">
      <div className="message-section__header">
        <h3>註冊小工具</h3>
      </div>

      <p className="muted generator-hint">
        目前分類：{scopeLabel(profileScope)}
        {persistDraft && lastSavedAt ? `，已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-TW')}` : ''}
      </p>

      <div className="generator-grid">
        <article className="generator-card">
          <span className="field-label">隨機名稱</span>
          <strong className="generator-value">{generatedName || '按下生成後顯示'}</strong>
          <p className="muted generator-hint">可用於帳號名稱、暱稱或保留信箱名稱。</p>
          <div className="generator-actions">
            <button type="button" onClick={() => void handleGenerateAndCopy('name')}>
              {nameCopied ? '已複製' : '生成並複製'}
            </button>
            {onApplyName ? (
              <button type="button" className="secondary" onClick={handleApplyName} disabled={!generatedName}>
                套用到信箱欄位
              </button>
            ) : null}
          </div>
        </article>

        <article className="generator-card">
          <span className="field-label">強密碼</span>
          <strong className="generator-value">{generatedPassword || '按下生成後顯示'}</strong>
          <p className="muted generator-hint">格式：前四碼英文大小寫 + 後五碼數字。</p>
          <div className="generator-actions">
            <button type="button" onClick={() => void handleGenerateAndCopy('password')}>
              {passwordCopied ? '已複製' : '生成並複製'}
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
