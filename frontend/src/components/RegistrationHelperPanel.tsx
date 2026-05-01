import { useEffect, useState } from 'react';
import { updateClientSyncState } from '../lib/api';
import {
  clearRegistrationRuntimeDraft,
  generateStrongPassword,
  generateSuggestedMailboxName,
  readRegistrationDrafts,
  readRegistrationRuntimeDraft,
  writeRegistrationRuntimeDraft,
  type RegistrationDraft,
} from './mailboxUtils';

type Props = {
  onApplyName?: (value: string) => void;
  profileScope?: string;
  onApplyTag?: (value: string) => void;
  persistDraft?: boolean;
  defaultCollapsed?: boolean;
  maskPassword?: boolean;
  draftOverride?: RegistrationDraft | null;
  draftOverrideKey?: string;
};

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
  maskPassword = false,
  draftOverride = null,
  draftOverrideKey = '',
}: Props) {
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [generatedName, setGeneratedName] = useState('');
  const [nameCopied, setNameCopied] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(!maskPassword);
  const [lastSavedAt, setLastSavedAt] = useState('');

  useEffect(() => {
    setShowPassword(!maskPassword);
  }, [maskPassword]);

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

    const draft = readRegistrationDrafts()[profileScope];
    if (draft?.generatedName || draft?.generatedPassword) {
      setGeneratedName(draft.generatedName ?? '');
      setGeneratedPassword(draft.generatedPassword ?? '');
      setLastSavedAt(draft.updatedAt ?? '');
      return;
    }

    const runtimeDraft = readRegistrationRuntimeDraft();
    if (runtimeDraft?.generatedName || runtimeDraft?.generatedPassword) {
      setGeneratedName(runtimeDraft.generatedName);
      setGeneratedPassword(runtimeDraft.generatedPassword);
      setLastSavedAt(runtimeDraft.updatedAt ?? '');
      clearRegistrationRuntimeDraft();
      void updateClientSyncState({ registrationRuntimeDraft: null }).catch((error) => {
        console.error(error);
      });
      return;
    }

    // 不再初始化时生成
  }, [persistDraft, profileScope]);

  useEffect(() => {
    if (!persistDraft) {
      if (!generatedName && !generatedPassword) {
        return;
      }

      const timerId = window.setTimeout(() => {
        writeRegistrationRuntimeDraft({
          generatedName,
          generatedPassword,
          updatedAt: new Date().toISOString(),
        });

        const runtimeDraft = readRegistrationRuntimeDraft();
        void updateClientSyncState({ registrationRuntimeDraft: runtimeDraft }).catch((error) => {
          console.error('Failed to sync runtime draft:', error);
        });
      }, 1000);

      return () => window.clearTimeout(timerId);
    }

    if (!generatedName && !generatedPassword) {
      return;
    }

    const timerId = window.setTimeout(() => {
      const updatedAt = new Date().toISOString();
      setLastSavedAt(updatedAt);

      const drafts = readRegistrationDrafts();
      drafts[profileScope] = {
        generatedName,
        generatedPassword,
        updatedAt,
      };

      void updateClientSyncState({ registrationDrafts: drafts }).catch((error) => {
        console.error('Failed to sync registration drafts:', error);
      });
    }, 1500);

    return () => window.clearTimeout(timerId);
  }, [generatedName, generatedPassword, persistDraft, profileScope]);

  useEffect(() => {
    if (!draftOverrideKey) {
      return;
    }

    if (!draftOverride?.generatedName && !draftOverride?.generatedPassword) {
      return;
    }

    setGeneratedName(draftOverride.generatedName);
    setGeneratedPassword(draftOverride.generatedPassword);
    setLastSavedAt(draftOverride.updatedAt ?? '');
  }, [draftOverride, draftOverrideKey]);

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

  const handleGenerateOnly = (type: 'name' | 'password') => {
    if (type === 'name') {
      refreshName();
      return;
    }

    refreshPassword();
  };

  const handleCopyCurrent = async (type: 'name' | 'password') => {
    try {
      const value = type === 'name' ? generatedName : generatedPassword;
      await copyValue(type, value);
    } catch (error) {
      console.error(error);
    }
  };

  const displayPassword = generatedPassword
    ? showPassword
      ? generatedPassword
      : '•'.repeat(generatedPassword.length)
    : '按下生成後顯示';

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
            {generatedName ? (
              <>
                <button type="button" className="secondary" onClick={() => handleGenerateOnly('name')}>
                  <span className="button-content">
                    <span aria-hidden="true">🔁</span>
                    <span>重新生成</span>
                  </span>
                </button>
                <button type="button" onClick={() => void handleCopyCurrent('name')}>
                  <span className="button-content">
                    <span aria-hidden="true">📋</span>
                    <span>{nameCopied ? '已複製' : '複製名稱'}</span>
                  </span>
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void handleGenerateAndCopy('name')}>
                <span className="button-content">
                  <span aria-hidden="true">✨</span>
                  <span>{nameCopied ? '已複製' : '生成並複製'}</span>
                </span>
              </button>
            )}
            {onApplyName ? (
              <button type="button" className="secondary" onClick={handleApplyName} disabled={!generatedName}>
                <span className="button-content">
                  <span aria-hidden="true">🧩</span>
                  <span>套用到信箱欄位</span>
                </span>
              </button>
            ) : null}
          </div>
        </article>

        <article className="generator-card">
          <span className="field-label">強密碼</span>
          <div className="generator-value-row">
            <strong className="generator-value">{displayPassword}</strong>
            {generatedPassword && maskPassword ? (
              <button
                type="button"
                className="secondary small"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? '隱藏密碼' : '顯示密碼'}
                title={showPassword ? '隱藏密碼' : '顯示密碼'}
              >
                <span className="button-content">
                  <span aria-hidden="true">{showPassword ? '🙈' : '👁️'}</span>
                  <span>{showPassword ? '隱藏' : '顯示'}</span>
                </span>
              </button>
            ) : null}
          </div>
          <p className="muted generator-hint">格式：前四碼英文大小寫 + 後五碼數字。</p>
          <div className="generator-actions">
            {generatedPassword ? (
              <>
                <button type="button" className="secondary" onClick={() => handleGenerateOnly('password')}>
                  <span className="button-content">
                    <span aria-hidden="true">🔁</span>
                    <span>重新生成</span>
                  </span>
                </button>
                <button type="button" onClick={() => void handleCopyCurrent('password')}>
                  <span className="button-content">
                    <span aria-hidden="true">📋</span>
                    <span>{passwordCopied ? '已複製' : '複製密碼'}</span>
                  </span>
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void handleGenerateAndCopy('password')}>
                <span className="button-content">
                  <span aria-hidden="true">✨</span>
                  <span>{passwordCopied ? '已複製' : '生成並複製'}</span>
                </span>
              </button>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
