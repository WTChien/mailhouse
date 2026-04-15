# Mailhouse

Disposable email system built with **React (TSX)**, **FastAPI**, **Firebase Firestore**, and **Cloudflare Email Workers** for the `gradaide.xyz` domain.

## Architecture

```text
Incoming email
-> Cloudflare Email Routing (catch-all)
-> Cloudflare Email Worker
-> POST JSON to FastAPI
-> FastAPI validates mailbox + writes Firestore
-> React fetches mailbox data from FastAPI only
```

## Core features

- **30 分鐘信箱**
  - 自動建立隨機信箱
  - 切換 navbar 或重新整理頁面都會保留目前信箱地址
  - 只有在 **30 分鐘到期** 或你手動按下 **產生新信箱** 時才會重設
- **保留信箱**
  - 可指定並保存自己想用的名稱
  - 已保存清單、分類標籤、註冊小工具草稿會同步到 Firestore（跨裝置可用）
  - 可手動載入、複製與刪除
- **共用郵件檢視**
  - `30 分鐘信箱` 與 `保留信箱` 共用同一套 `收到的郵件` 介面
  - 每封信都可 `查看全文 / 收起全文`
  - 若文字中有疑似驗證碼，介面會額外顯示可點擊複製的候選碼
  - 支援 `全部已讀` 按鈕，一鍵標記所有未讀郵件為已讀
- **註冊小工具**
  - 初始不顯示隨機名稱和密碼，安全隱私
  - 點擊「生成並複製」後才會顯示並複製隨機名稱或強密碼
  - 支援套用名稱到信箱欄位與自動帶入帳戶預設分類標籤

## Project structure

- `worker/src/index.ts`: Cloudflare Email Worker that parses and forwards incoming email JSON
- `backend/main.py`: FastAPI app for webhook handling, mailbox management, read/unread state, and cleanup
- `frontend/src/components/TemporaryMailboxPanel.tsx`: 30-minute mailbox UI
- `frontend/src/components/PersistentMailboxPanel.tsx`: persistent mailbox UI
- `frontend/src/components/MailMessageTable.tsx`: shared message table with loading states
- `frontend/src/lib/api.ts`: frontend API client for FastAPI
- `firestore.rules`: starter Firestore security rules

## Firestore schema

```text
mailboxes/{email_prefix}
  mode: "temporary" | "persistent"
  expireAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp

mailboxes/{email_prefix}/messages/{message_id}
  from: string
  subject: string
  text: string
  html: string
  calendar: string
  attachments: AttachmentSummary[]
  receivedAt: Timestamp
  isRead: boolean
  readAt: Timestamp | null
```

## Quick start

From the project root you can start the backend and frontend together in the **same terminal** and see both logs inline:

```powershell
.\run.bat
```

Or in Bash:

```bash
./run.sh
```

## 1) Cloudflare Worker setup

```powershell
cd worker
Copy-Item .dev.vars.example .dev.vars
npm install
npm run check
```

Then set these values in `worker/.dev.vars`:

- `API_WEBHOOK_URL=https://your-backend-domain/api/webhook/email`
- `MAIL_DOMAIN=gradaide.xyz`
- `WEBHOOK_SECRET=your_shared_secret`

After that, deploy the worker and bind it to the catch-all route for `gradaide.xyz` in Cloudflare Email Routing.

## 2) Backend setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --reload --port 8000 --env-file .env
```

Set these values in `backend/.env` as needed:

- `MAIL_DOMAIN=gradaide.xyz`
- `WEBHOOK_SECRET=your_shared_secret`
- `TEMP_MAILBOX_MINUTES=30`
- `FIREBASE_SERVICE_ACCOUNT_JSON=...` **or** `FIREBASE_CREDENTIALS_PATH=...`

### Firebase key in `.env`

If you want to avoid storing `serviceAccountKey.json` as a file, place the whole service account JSON into `backend/.env` as `FIREBASE_SERVICE_ACCOUNT_JSON` on a single line. The `private_key` must use escaped newlines like `\n`.

## 3) Frontend setup

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

Set these values in `frontend/.env`:

- `VITE_API_BASE_URL=http://127.0.0.1:8000`
- `VITE_MAIL_DOMAIN=gradaide.xyz`

## API overview

Main endpoints:

- `POST /api/mailboxes/temp` — create a 30-minute mailbox
- `POST /api/mailboxes/persistent` — create or load a persistent mailbox
- `POST /api/mailboxes/{mailbox_id}/extend` — extend the current temporary mailbox
- `GET /api/mailboxes/{mailbox_id}/messages` — fetch mailbox messages
- `PATCH /api/mailboxes/{mailbox_id}/messages/{message_id}/read` — mark a message as read/unread
- `POST /api/cleanup?read_retention_hours=24` — remove old read mail and expired temporary mailboxes
- `DELETE /api/mailboxes/{mailbox_id}` — delete a mailbox
- `GET /api/client-sync` — load cross-device client sync state
- `PATCH /api/client-sync` — update cross-device client sync state

The Email Worker posts JSON to:

```text
POST https://your-backend-domain/api/webhook/email
```

Example payload:

```json
{
  "to": "abc12@gradaide.xyz",
  "from": "sender@example.com",
  "subject": "Hello",
  "text": "Test message",
  "html": "<p>Test message</p>",
  "calendar": "BEGIN:VCALENDAR...",
  "attachments": [
    {
      "filename": "invite.ics",
      "mimeType": "text/calendar",
      "disposition": "attachment",
      "contentId": "",
      "size": 2048,
      "isInline": false,
      "isCalendar": true,
      "method": "REQUEST"
    }
  ]
}
```

## Notes

- The frontend now talks **only to FastAPI**; it does not access Firestore directly.
- Temporary mailbox state is saved in browser `localStorage`, so a page refresh will keep the current mailbox until expiry.
- Saved mailbox list, tag categories, and registration helper drafts are synced via `client_sync/default` in Firestore for cross-device continuity.
- `30 分鐘信箱` 與 `保留信箱` 的 `收到的郵件` 區塊使用同一個共享元件，因此顯示樣式會一致。
- If you use the **Cloudflare dashboard quick-edit Worker** fallback script, the stored subject/body may be simplified placeholders. For the original subject and full parsed text, deploy the `worker/` project version with `postal-mime` via Wrangler.
- A starter rule set is included in `firestore.rules`; tighten it further before production use.
