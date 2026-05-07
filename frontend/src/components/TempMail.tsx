import { useEffect, useState } from 'react';
import PersistentMailboxPanel, { type PersistentPromotionRequest } from './PersistentMailboxPanel';
import TemporaryMailboxPanel from './TemporaryMailboxPanel';
import GitHubAccountPanel from './GitHubAccountPanel';
import {
  clearRegistrationRuntimeDraft,
  readRegistrationDrafts,
  readRegistrationRuntimeDraft,
  readSavedMailboxes,
  writeRegistrationRuntimeDraft,
  writeRegistrationDrafts,
  writeSavedMailboxes,
} from './mailboxUtils';
import { getClientSyncState, updateClientSyncState } from '../lib/api';

const tabs = [
  { id: 'persistent', label: '保留信箱', hint: '長期分類管理' },
  { id: 'temporary', label: '新增信箱', hint: '新增臨時信箱' },
  { id: 'github', label: 'GitHub 帳號管理', hint: 'GitHub 帳號追蹤' },
] as const;

type TabId = (typeof tabs)[number]['id'];

type GitHubFocusRequest = {
  mailboxId: string;
  requestId: string;
};

export default function TempMail() {
  const [activeTab, setActiveTab] = useState<TabId>('persistent');
  const [requestedPromotion, setRequestedPromotion] = useState<PersistentPromotionRequest | null>(null);
  const [githubFocusRequest, setGitHubFocusRequest] = useState<GitHubFocusRequest | null>(null);
  const [syncReady, setSyncReady] = useState(false);
  const [savedMailboxes, setSavedMailboxes] = useState<any[]>([]);


  useEffect(() => {
    let disposed = false;

    const migrateLocalDataToCloud = async () => {
      try {
        const localSavedMailboxes = readSavedMailboxes();
        const localRegistrationDrafts = readRegistrationDrafts();
        const localRuntimeDraft = readRegistrationRuntimeDraft();

        const hasLocalData = localSavedMailboxes.length > 0 || Object.keys(localRegistrationDrafts).length > 0;

        if (hasLocalData) {
          try {
            await updateClientSyncState({
              savedMailboxes: localSavedMailboxes,
              registrationDrafts: localRegistrationDrafts,
              registrationRuntimeDraft: localRuntimeDraft,
            });
            if (!disposed) {
              writeSavedMailboxes([]);
              writeRegistrationDrafts({});
              if (!localRuntimeDraft?.generatedName && !localRuntimeDraft?.generatedPassword) {
                clearRegistrationRuntimeDraft();
              }
            }
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

  if (!syncReady) {
    return <section className="tabs-shell">同步資料載入中...</section>;
  }

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
          isActive={activeTab === 'temporary'}
          savedMailboxes={savedMailboxes}
          onMoveToPersistent={(mailboxId) => {
            setRequestedPromotion({
              mailboxId,
              requestId: `${mailboxId}-${Date.now()}`,
            });
            setGitHubFocusRequest({ mailboxId, requestId: `${mailboxId}-${Date.now()}` });
            setActiveTab('persistent');
          }}
        />
      </div>
      <div hidden={activeTab !== 'persistent'} aria-hidden={activeTab !== 'persistent'}>
        <PersistentMailboxPanel
          isActive={activeTab === 'persistent'}
          requestedPromotion={requestedPromotion}
          focusMailboxId={githubFocusRequest?.mailboxId ?? null}
          focusRequestId={githubFocusRequest?.requestId ?? ''}
          onJumpToGitHubAccount={(mailboxId) => {
            setGitHubFocusRequest({ mailboxId, requestId: `${mailboxId}-${Date.now()}` });
            setActiveTab('github');
          }}
          onSavedMailboxesChange={setSavedMailboxes}
        />
      </div>
      <div hidden={activeTab !== 'github'} aria-hidden={activeTab !== 'github'}>
        <GitHubAccountPanel
          onViewMailbox={(mailboxId) => {
            setGitHubFocusRequest({ mailboxId, requestId: `${mailboxId}-${Date.now()}` });
            setActiveTab('persistent');
          }}
          focusMailboxId={githubFocusRequest?.mailboxId ?? null}
          focusRequestId={githubFocusRequest?.requestId ?? ''}
        />
      </div>


    </section>
  );
}
