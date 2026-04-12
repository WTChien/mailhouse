import { useState } from 'react';
import PersistentMailboxPanel, { type PersistentPromotionRequest } from './PersistentMailboxPanel';
import TemporaryMailboxPanel from './TemporaryMailboxPanel';
import { readRegistrationRuntimeDraft } from './mailboxUtils';

const tabs = [
  { id: 'temporary', label: '30 分鐘信箱', hint: '短時驗證收信' },
  { id: 'persistent', label: '保留信箱', hint: '長期分類管理' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export default function TempMail() {
  const [activeTab, setActiveTab] = useState<TabId>('temporary');
  const [requestedPromotion, setRequestedPromotion] = useState<PersistentPromotionRequest | null>(null);

  return (
    <section className="tabs-shell">
      <div className="tabs-navbar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`nav-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="nav-tab__title">{tab.label}</span>
            <span className="nav-tab__hint">{tab.hint}</span>
          </button>
        ))}
      </div>

      <div hidden={activeTab !== 'temporary'} aria-hidden={activeTab !== 'temporary'}>
        <TemporaryMailboxPanel
          onMoveToPersistent={(mailboxId) => {
            setRequestedPromotion({
              mailboxId,
              registrationDraft: readRegistrationRuntimeDraft(),
              requestId: `${mailboxId}-${Date.now()}`,
            });
            setActiveTab('persistent');
          }}
        />
      </div>
      <div hidden={activeTab !== 'persistent'} aria-hidden={activeTab !== 'persistent'}>
        <PersistentMailboxPanel requestedPromotion={requestedPromotion} />
      </div>
    </section>
  );
}
