import { useState } from 'react';
import ApiSettingsModal from './components/ApiSettingsModal';
import TempMail from './components/TempMail';

export default function App() {
  const [showApiSettings, setShowApiSettings] = useState(false);

  return (
    <main className="simple-shell">
      <header className="simple-header">
        <div>
          <p className="eyebrow">Multi-domain</p>
          <h1>Mailhouse 信箱中心</h1>
          <p className="subtitle">降低誤觸、快速分類、集中管理驗證信箱</p>
        </div>
        <button type="button" className="secondary api-settings-button" onClick={() => setShowApiSettings(true)}>
          <span aria-hidden="true">⚙</span>
          API 設定
        </button>
      </header>

      <TempMail />
      {showApiSettings ? <ApiSettingsModal onClose={() => setShowApiSettings(false)} /> : null}
    </main>
  );
}
