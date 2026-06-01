import { useEffect, useRef, useState } from 'react';
import PersistentMailboxPanel, { type PersistentPromotionRequest } from './PersistentMailboxPanel';
import TemporaryMailboxPanel from './TemporaryMailboxPanel';
import {
  clearRegistrationRuntimeDraft,
  readRegistrationDrafts,
  readRegistrationRuntimeDraft,
  readSavedMailboxes,
  readTagFieldConfigs,
  writeRegistrationRuntimeDraft,
  writeRegistrationDrafts,
  writeSavedMailboxes,
  writeTagFieldConfigs,
} from './mailboxUtils';
import { getClientSyncState, updateClientSyncState } from '../lib/api';

const tabs = [
  { id: 'persistent', label: '保留信箱', hint: '長期分類管理' },
  { id: 'temporary', label: '新增信箱', hint: '新增臨時信箱' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export default function TempMail() {
  const [activeTab, setActiveTab] = useState<TabId>('persistent');
  const [requestedPromotion, setRequestedPromotion] = useState<PersistentPromotionRequest | null>(null);
  const [activeTagNavbar, setActiveTagNavbar] = useState('all');
  const [syncReady, setSyncReady] = useState(false);
  const [savedMailboxes, setSavedMailboxes] = useState<any[]>([]);
  const prevActiveTabRef = useRef<TabId>('persistent');


  useEffect(() => {
    let disposed = false;

    const migrateLocalDataToCloud = async () => {
      try {
        const localSavedMailboxes = readSavedMailboxes();
        const localRegistrationDrafts = readRegistrationDrafts();
        const localRuntimeDraft = readRegistrationRuntimeDraft();

        const localTagFieldConfigs = readTagFieldConfigs();
        const hasLocalData = localSavedMailboxes.length > 0 || Object.keys(localRegistrationDrafts).length > 0 || Object.keys(localTagFieldConfigs).length > 0;

        if (hasLocalData) {
          try {
            await updateClientSyncState({
              savedMailboxes: localSavedMailboxes,
              tagFieldConfigs: localTagFieldConfigs,
              registrationDrafts: localRegistrationDrafts,
              registrationRuntimeDraft: localRuntimeDraft,
            });
          } catch (uploadError) {
            console.error('Failed to upload local data to cloud. Keeping local data for retry:', uploadError);
          }
        }
      } catch (error) {
        console.error(error);
      } finally {
        if (!disposed) {
          setSyncReady(true);
        }
      }
    };

    void migrateLocalDataToCloud();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    // Clear promotion state when leaving persistent tab to avoid stale state
    if (prevActiveTabRef.current === 'persistent' && activeTab !== 'persistent') {
      setRequestedPromotion(null);
    }
    prevActiveTabRef.current = activeTab;
  }, [activeTab]);

  if (!syncReady) {
    return <section className="tabs-shell">同步資料載入中...</section>;
  }

  return (
    <section className="tabs-shell">
      <div className="tabs-navbar">
        <div className="tabs-navbar__primary">
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

        {activeTab === 'persistent' ? (
          <div className="tabs-navbar__secondary" role="tablist" aria-label="標籤管理頁面">
            <button
              type="button"
              className={`account-tab ${activeTagNavbar === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTagNavbar('all')}
            >
              全部帳號
            </button>
            {Array.from(new Set(savedMailboxes.map((item) => item.tag).filter(Boolean))).map((tag) => {
              const normalizedTag = String(tag);
              return (
                <button
                  key={normalizedTag}
                  type="button"
                  className={`account-tab ${activeTagNavbar === normalizedTag ? 'active' : ''}`}
                  onClick={() => setActiveTagNavbar(normalizedTag)}
                >
                  {normalizedTag}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div hidden={activeTab !== 'temporary'} aria-hidden={activeTab !== 'temporary'}>
        <TemporaryMailboxPanel
          isActive={activeTab === 'temporary'}
          savedMailboxes={savedMailboxes}
          onMoveToPersistent={(mailboxId) => {
            setRequestedPromotion({
              mailboxId,
              requestId: `${mailboxId}-${Date.now()}`,
            });
            setActiveTab('persistent');
          }}
        />
      </div>
      <div hidden={activeTab !== 'persistent'} aria-hidden={activeTab !== 'persistent'}>
        <PersistentMailboxPanel
          isActive={activeTab === 'persistent'}
          requestedPromotion={requestedPromotion}
          activeTagNavbar={activeTagNavbar}
          onActiveTagNavbarChange={setActiveTagNavbar}
          onSavedMailboxesChange={setSavedMailboxes}
        />
      </div>

    </section>
  );
}
