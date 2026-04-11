import { useState } from 'react';
import PersistentMailboxPanel from './PersistentMailboxPanel';
import TemporaryMailboxPanel from './TemporaryMailboxPanel';

const tabs = [
  { id: 'temporary', label: '30 分鐘信箱' },
  { id: 'persistent', label: '保留信箱' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export default function TempMail() {
  const [activeTab, setActiveTab] = useState<TabId>('temporary');
  const [requestedPersistentMailboxId, setRequestedPersistentMailboxId] = useState('');

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
            {tab.label}
          </button>
        ))}
      </div>

      <div hidden={activeTab !== 'temporary'} aria-hidden={activeTab !== 'temporary'}>
        <TemporaryMailboxPanel
          onMoveToPersistent={(mailboxId) => {
            setRequestedPersistentMailboxId(mailboxId);
            setActiveTab('persistent');
          }}
        />
      </div>
      <div hidden={activeTab !== 'persistent'} aria-hidden={activeTab !== 'persistent'}>
        <PersistentMailboxPanel requestedOpenMailboxId={requestedPersistentMailboxId} />
      </div>
    </section>
  );
}
