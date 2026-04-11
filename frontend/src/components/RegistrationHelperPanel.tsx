import { useEffect, useState } from 'react';
import { generateStrongPassword, generateSuggestedMailboxName } from './mailboxUtils';

type Props = {
  onApplyName?: (value: string) => void;
};

export default function RegistrationHelperPanel({ onApplyName }: Props) {
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [generatedName, setGeneratedName] = useState('');
  const [nameCopied, setNameCopied] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

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
    refreshName();
    refreshPassword();
  }, []);

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
  };

  return (
    <div className="generator-panel">
      <div className="message-section__header">
        <h3>註冊小工具</h3>
        <span>一鍵生成</span>
      </div>

      <div className="generator-grid">
        <article className="generator-card">
          <span className="field-label">隨機名稱</span>
          <strong className="generator-value">{generatedName || '產生中...'}</strong>
          <p className="muted generator-hint">可用於帳號名稱、暱稱或保留信箱名稱。</p>
          <div className="generator-actions">
            <button type="button" className="secondary" onClick={refreshName}>
              生成名稱
            </button>
            <button type="button" onClick={() => void copyValue('name', generatedName)} disabled={!generatedName}>
              {nameCopied ? '已複製' : '一鍵複製'}
            </button>
            {onApplyName ? (
              <button type="button" className="secondary" onClick={handleApplyName} disabled={!generatedName}>
                套用名稱
              </button>
            ) : null}
          </div>
        </article>

        <article className="generator-card">
          <span className="field-label">強密碼</span>
          <strong className="generator-value">{generatedPassword || '產生中...'}</strong>
          <p className="muted generator-hint">格式：前四碼英文大小寫 + 後五碼數字。</p>
          <div className="generator-actions">
            <button type="button" className="secondary" onClick={refreshPassword}>
              產生密碼
            </button>
            <button type="button" onClick={() => void copyValue('password', generatedPassword)} disabled={!generatedPassword}>
              {passwordCopied ? '已複製' : '一鍵複製'}
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
