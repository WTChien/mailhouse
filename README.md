# Mailhouse

Disposable email system built with **React (TSX)**, **FastAPI**, **Firebase Firestore**, and **Cloudflare Email Workers** for the `gradaide.xyz` domain.

## Architecture

```text
Incoming email
-> Cloudflare Email Routing (catch-all)
-> Cloudflare Email Worker
-> POST JSON to FastAPI
-> FastAPI validates mailbox + writes Firestore
-> React listens with onSnapshot and updates instantly
```

## Project structure

- `worker/src/index.ts`: Cloudflare Email Worker that parses and forwards email JSON
- `backend/main.py`: FastAPI webhook that stores valid messages in Firestore
- `frontend/src/components/TempMail.tsx`: temporary mailbox UI and realtime inbox
- `frontend/src/lib/firebase.ts`: Firebase initialization
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
  receivedAt: Timestamp
```

## Mailbox modes

- **Temporary mode**: auto-generates a random mailbox and expires after 10 minutes.
- **Persistent mode**: lets you keep a mailbox name such as `hello123@gradaide.xyz` until you manually delete it.

## Quick start script

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
- `WEBHOOK_SECRET=change_me_optional`

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

Set either `FIREBASE_SERVICE_ACCOUNT_JSON` **or** `FIREBASE_CREDENTIALS_PATH`, and keep `MAIL_DOMAIN=gradaide.xyz`.

### Firebase key in `.env`

If you want to avoid storing `serviceAccountKey.json` as a file, place the whole service account JSON into `backend/.env` as `FIREBASE_SERVICE_ACCOUNT_JSON` on a single line. The `private_key` must use escaped newlines like `\n`.

## 3) Frontend setup

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

The frontend now talks only to FastAPI. Set `VITE_API_BASE_URL=http://127.0.0.1:8000` in `frontend/.env` and keep `VITE_MAIL_DOMAIN=gradaide.xyz`.

## API target

The backend now also supports:

- `PATCH /api/mailboxes/{mailbox_id}/messages/{message_id}/read` — mark a message read/unread
- `POST /api/cleanup?read_retention_hours=24` — remove read mail older than the retention window and clear expired temporary mailboxes

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
  "text": "Test message"
}
```

## Firestore rules note

A starter rule set is included in `firestore.rules`. It allows the frontend to create/update mailbox expiry and read messages, while keeping message writes server-side via Firebase Admin SDK. Tighten these rules before production use.
