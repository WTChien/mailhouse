import { useState } from 'react';
import PersistentMailboxPanel from './PersistentMailboxPanel';
import TemporaryMailboxPanel from './TemporaryMailboxPanel';

const tabs = [
  { id: 'temporary', label: '10 分鐘信箱' },
  { id: 'persistent', label: '保留信箱' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export default function TempMail() {
  const [activeTab, setActiveTab] = useState<TabId>('temporary');

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

      {activeTab === 'temporary' ? <TemporaryMailboxPanel /> : <PersistentMailboxPanel />}
    </section>
  );
}
