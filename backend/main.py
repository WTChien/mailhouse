import json
import os
import re
import secrets
import string
from html import unescape
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import firebase_admin
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from firebase_admin import credentials, firestore
from pydantic import BaseModel, ConfigDict, Field


load_dotenv()

app = FastAPI(title="Mailhouse Webhook API", version="3.0.0")
MAIL_DOMAIN = os.getenv("MAIL_DOMAIN", "gradaide.xyz").lower()
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if origin.strip()
]
RANDOM_CHARS = string.ascii_lowercase + string.digits

try:
    TEMP_MAILBOX_MINUTES = max(1, int(os.getenv("TEMP_MAILBOX_MINUTES", "30")))
except ValueError:
    TEMP_MAILBOX_MINUTES = 30

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class EmailPayload(BaseModel):
    to: str = ""
    from_: str = Field(default="", alias="from")
    subject: str = ""
    text: str = ""
    html: str = ""
    calendar: str = ""
    attachments: list[dict[str, Any]] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class PersistentMailboxPayload(BaseModel):
    mailboxId: str = Field(..., min_length=3, max_length=24)


class ReadStatePayload(BaseModel):
    isRead: bool = True


class SavedMailboxItemPayload(BaseModel):
    mailboxId: str = ""
    tag: str = ""
    createdAt: str = ""
    lastUsedAt: str = ""


class RegistrationDraftPayload(BaseModel):
    generatedName: str = ""
    generatedPassword: str = ""
    updatedAt: str = ""


class ClientSyncStateUpdatePayload(BaseModel):
    savedMailboxes: Optional[list[SavedMailboxItemPayload]] = None
    registrationDrafts: Optional[dict[str, RegistrationDraftPayload]] = None
    registrationRuntimeDraft: Optional[RegistrationDraftPayload] = None


def load_firebase_credential() -> Optional[credentials.Base]:
    """Load Firebase credentials from env JSON or a local service account file."""
    service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    credentials_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "").strip()

    if service_account_json:
        service_account_info = json.loads(service_account_json)
        return credentials.Certificate(service_account_info)

    if credentials_path and os.path.exists(credentials_path):
        return credentials.Certificate(credentials_path)

    return None


def init_firestore_client() -> firestore.Client:
    """Initialize Firebase Admin SDK and return a Firestore client."""
    if not firebase_admin._apps:
        cred = load_firebase_credential()

        if cred is not None:
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()

    return firestore.client()


db = init_firestore_client()


def extract_email(raw_value: str) -> Optional[str]:
    """Extract a clean email address from strings like 'Name <user@domain.com>'."""
    if not raw_value:
        return None

    match = re.search(r"([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[A-Za-z]{2,})", raw_value)
    if match:
        return match.group(1).lower()

    return raw_value.strip().lower() or None


def normalize_mailbox_id(value: str) -> Optional[str]:
    cleaned = re.sub(r"[^a-z0-9]", "", value.lower())[:24]
    return cleaned or None


def normalize_mailbox_tag(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())[:28]


def parse_iso_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def normalize_registration_draft(value: Any) -> Optional[dict[str, str]]:
    if not isinstance(value, dict):
        return None

    generated_name = str(value.get("generatedName", "")).strip()
    generated_password = str(value.get("generatedPassword", "")).strip()

    if not generated_name and not generated_password:
        return None

    updated_at_raw = value.get("updatedAt")
    updated_at = parse_iso_datetime(updated_at_raw)
    if updated_at is None:
        updated_at = datetime.now(timezone.utc)

    return {
        "generatedName": generated_name,
        "generatedPassword": generated_password,
        "updatedAt": updated_at.astimezone(timezone.utc).isoformat(),
    }


def normalize_saved_mailboxes(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []

    normalized_items: list[dict[str, str]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for raw_item in value:
        if not isinstance(raw_item, dict):
            continue

        mailbox_id = normalize_mailbox_id(str(raw_item.get("mailboxId", "")))
        if not mailbox_id:
            continue

        created_at = parse_iso_datetime(raw_item.get("createdAt"))
        last_used_at = parse_iso_datetime(raw_item.get("lastUsedAt"))

        created_at_iso = (created_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
        last_used_at_iso = (last_used_at or created_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()

        normalized_items.append(
            {
                "mailboxId": mailbox_id,
                "tag": normalize_mailbox_tag(raw_item.get("tag", "")),
                "createdAt": created_at_iso or now_iso,
                "lastUsedAt": last_used_at_iso,
            }
        )

    deduped: dict[str, dict[str, str]] = {}
    for item in normalized_items:
        existing = deduped.get(item["mailboxId"])
        if existing is None:
            deduped[item["mailboxId"]] = item
            continue

        existing_created = parse_iso_datetime(existing.get("createdAt")) or datetime.now(timezone.utc)
        existing_last_used = parse_iso_datetime(existing.get("lastUsedAt")) or datetime.now(timezone.utc)
        current_created = parse_iso_datetime(item.get("createdAt")) or datetime.now(timezone.utc)
        current_last_used = parse_iso_datetime(item.get("lastUsedAt")) or datetime.now(timezone.utc)

        deduped[item["mailboxId"]] = {
            "mailboxId": item["mailboxId"],
            "tag": item.get("tag") or existing.get("tag", ""),
            "createdAt": min(existing_created, current_created).astimezone(timezone.utc).isoformat(),
            "lastUsedAt": max(existing_last_used, current_last_used).astimezone(timezone.utc).isoformat(),
        }

    return list(deduped.values())


def normalize_registration_drafts(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        return {}

    result: dict[str, dict[str, str]] = {}
    for raw_scope, raw_draft in value.items():
        scope = str(raw_scope or "").strip()[:64]
        if not scope:
            continue

        draft = normalize_registration_draft(raw_draft)
        if draft is None:
            continue

        result[scope] = draft

    return result


def normalize_client_sync_state(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    runtime_draft = normalize_registration_draft(raw.get("registrationRuntimeDraft"))

    return {
        "savedMailboxes": normalize_saved_mailboxes(raw.get("savedMailboxes")),
        "registrationDrafts": normalize_registration_drafts(raw.get("registrationDrafts")),
        "registrationRuntimeDraft": runtime_draft,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }


def html_to_text(html_content: str) -> str:
    if not html_content:
        return ""

    text = re.sub(r"(?is)<(script|style|head|title|meta)[^>]*>.*?</\1>", " ", html_content)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|li|tr|h[1-6]|blockquote|section|article|table)>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def generate_mailbox_id(length: int = 5) -> str:
    return "".join(secrets.choice(RANDOM_CHARS) for _ in range(length))


def get_prefix_from_recipient(raw_to: str) -> Optional[str]:
    recipient = extract_email(raw_to)
    if not recipient or "@" not in recipient:
        return None

    prefix, domain = recipient.split("@", 1)
    if MAIL_DOMAIN and domain.lower() != MAIL_DOMAIN:
        return None

    return prefix.lower()


def to_utc_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None

    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def to_iso_string(value: Any) -> Optional[str]:
    dt = to_utc_datetime(value)
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def serialize_mailbox(prefix: str, mailbox_data: dict[str, Any]) -> dict[str, Any]:
    expire_at = mailbox_data.get("expireAt")
    mode = str(mailbox_data.get("mode", "temporary" if expire_at else "persistent")).lower()

    return {
        "mailboxId": prefix,
        "email": f"{prefix}@{MAIL_DOMAIN}",
        "mode": mode,
        "expireAt": to_iso_string(expire_at),
        "createdAt": to_iso_string(mailbox_data.get("createdAt")),
        "updatedAt": to_iso_string(mailbox_data.get("updatedAt")),
    }


def serialize_message(document: firestore.DocumentSnapshot) -> dict[str, Any]:
    data = document.to_dict() or {}
    return {
        "id": document.id,
        "from": data.get("from", "unknown"),
        "subject": data.get("subject", "(no subject)"),
        "text": data.get("text", ""),
        "html": data.get("html", ""),
        "calendar": data.get("calendar", ""),
        "attachments": data.get("attachments", []),
        "receivedAt": to_iso_string(data.get("receivedAt")),
        "isRead": bool(data.get("isRead", False)),
        "readAt": to_iso_string(data.get("readAt")),
    }


def mailbox_is_active(mailbox_data: dict[str, Any]) -> tuple[bool, Optional[str]]:
    expire_at = to_utc_datetime(mailbox_data.get("expireAt"))
    mailbox_mode = str(mailbox_data.get("mode", "temporary" if expire_at else "persistent")).lower()

    if mailbox_mode == "persistent":
        return True, None

    if expire_at is None:
        return False, "missing_expiration"

    if expire_at <= datetime.now(timezone.utc):
        return False, "mailbox_expired"

    return True, None


def delete_mailbox_messages(mailbox_ref: firestore.DocumentReference) -> None:
    batch = db.batch()
    operations = 0

    for message_doc in mailbox_ref.collection("messages").stream():
        batch.delete(message_doc.reference)
        operations += 1

        if operations == 400:
            batch.commit()
            batch = db.batch()
            operations = 0

    if operations:
        batch.commit()


def cleanup_mailboxes_and_messages(read_retention_hours: int = 0) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    read_cutoff = now - timedelta(hours=read_retention_hours)
    deleted_messages = 0
    deleted_mailboxes = 0

    for mailbox_doc in db.collection("mailboxes").stream():
        mailbox_data = mailbox_doc.to_dict() or {}
        mailbox_ref = mailbox_doc.reference
        mailbox_mode = str(mailbox_data.get("mode", "temporary")).lower()
        expire_at = to_utc_datetime(mailbox_data.get("expireAt"))

        for message_doc in mailbox_ref.collection("messages").stream():
            message_data = message_doc.to_dict() or {}
            is_read = bool(message_data.get("isRead", False))
            read_at = to_utc_datetime(message_data.get("readAt"))
            should_delete = is_read and (read_at is None or read_at <= read_cutoff)

            if should_delete or (mailbox_mode == "temporary" and expire_at is not None and expire_at <= now):
                message_doc.reference.delete()
                deleted_messages += 1

        if mailbox_mode == "temporary" and expire_at is not None and expire_at <= now:
            mailbox_ref.delete()
            deleted_mailboxes += 1

    return {
        "deletedMessages": deleted_messages,
        "deletedMailboxes": deleted_mailboxes,
    }


@app.get("/health")
async def health_check() -> dict:
    return {"status": "ok"}


@app.get("/api/client-sync")
async def get_client_sync_state() -> dict[str, Any]:
    sync_ref = db.collection("client_sync").document("default")
    snapshot = sync_ref.get()
    if not snapshot.exists:
        return {
            "status": "ok",
            "savedMailboxes": [],
            "registrationDrafts": {},
            "registrationRuntimeDraft": None,
            "updatedAt": None,
        }

    data = snapshot.to_dict() or {}
    normalized = normalize_client_sync_state(data)
    return {
        "status": "ok",
        "savedMailboxes": normalized.get("savedMailboxes", []),
        "registrationDrafts": normalized.get("registrationDrafts", {}),
        "registrationRuntimeDraft": normalized.get("registrationRuntimeDraft"),
        "updatedAt": to_iso_string(data.get("updatedAt")),
    }


@app.patch("/api/client-sync")
async def update_client_sync_state(payload: ClientSyncStateUpdatePayload) -> dict[str, Any]:
    sync_ref = db.collection("client_sync").document("default")
    current_data = sync_ref.get().to_dict() or {}
    merged_state = {
        "savedMailboxes": current_data.get("savedMailboxes", []),
        "registrationDrafts": current_data.get("registrationDrafts", {}),
        "registrationRuntimeDraft": current_data.get("registrationRuntimeDraft"),
    }

    payload_data = payload.model_dump(exclude_unset=True)
    if "savedMailboxes" in payload_data:
        merged_state["savedMailboxes"] = payload_data.get("savedMailboxes")

    if "registrationDrafts" in payload_data:
        merged_state["registrationDrafts"] = payload_data.get("registrationDrafts")

    if "registrationRuntimeDraft" in payload_data:
        merged_state["registrationRuntimeDraft"] = payload_data.get("registrationRuntimeDraft")

    normalized = normalize_client_sync_state(merged_state)
    sync_ref.set(normalized, merge=True)

    return {
        "status": "ok",
        "savedMailboxes": normalized.get("savedMailboxes", []),
        "registrationDrafts": normalized.get("registrationDrafts", {}),
        "registrationRuntimeDraft": normalized.get("registrationRuntimeDraft"),
    }


@app.post("/api/mailboxes/temp")
async def create_temporary_mailbox() -> dict[str, Any]:
    for _ in range(20):
        prefix = generate_mailbox_id()
        mailbox_ref = db.collection("mailboxes").document(prefix)

        if not mailbox_ref.get().exists:
            expire_at = datetime.now(timezone.utc) + timedelta(minutes=TEMP_MAILBOX_MINUTES)
            mailbox_ref.set(
                {
                    "mode": "temporary",
                    "expireAt": expire_at,
                    "createdAt": firestore.SERVER_TIMESTAMP,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            return {
                "status": "ok",
                "mailboxId": prefix,
                "email": f"{prefix}@{MAIL_DOMAIN}",
                "mode": "temporary",
                "expireAt": expire_at.isoformat(),
            }

    raise HTTPException(status_code=500, detail="unable to create temporary mailbox")


@app.post("/api/mailboxes/persistent")
async def create_or_load_persistent_mailbox(payload: PersistentMailboxPayload) -> dict[str, Any]:
    prefix = normalize_mailbox_id(payload.mailboxId)
    if not prefix or len(prefix) < 3:
        raise HTTPException(status_code=400, detail="mailbox name must be at least 3 alphanumeric characters")

    mailbox_ref = db.collection("mailboxes").document(prefix)
    mailbox_snapshot = mailbox_ref.get()
    mailbox_data = mailbox_snapshot.to_dict() or {}

    if mailbox_snapshot.exists:
        is_active, reason = mailbox_is_active(mailbox_data)
        existing_mode = str(mailbox_data.get("mode", "temporary")).lower()

        if existing_mode == "temporary" and is_active:
            raise HTTPException(status_code=409, detail="temporary mailbox name is currently in use")

        if reason == "mailbox_expired":
            delete_mailbox_messages(mailbox_ref)

    mailbox_ref.set(
        {
            "mode": "persistent",
            "expireAt": None,
            "createdAt": mailbox_data.get("createdAt", firestore.SERVER_TIMESTAMP),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {
        "status": "ok",
        "mailboxId": prefix,
        "email": f"{prefix}@{MAIL_DOMAIN}",
        "mode": "persistent",
        "expireAt": None,
    }


@app.post("/api/mailboxes/{mailbox_id}/promote")
async def promote_mailbox_to_persistent(mailbox_id: str) -> dict[str, Any]:
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = db.collection("mailboxes").document(prefix)
    mailbox_snapshot = mailbox_ref.get()
    if not mailbox_snapshot.exists:
        raise HTTPException(status_code=404, detail="mailbox not found")

    mailbox_data = mailbox_snapshot.to_dict() or {}
    is_active, reason = mailbox_is_active(mailbox_data)

    if not is_active and reason == "mailbox_expired":
        delete_mailbox_messages(mailbox_ref)
        raise HTTPException(status_code=410, detail="temporary mailbox has already expired")

    mailbox_ref.set(
        {
            "mode": "persistent",
            "expireAt": None,
            "createdAt": mailbox_data.get("createdAt", firestore.SERVER_TIMESTAMP),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {
        "status": "ok",
        "mailboxId": prefix,
        "email": f"{prefix}@{MAIL_DOMAIN}",
        "mode": "persistent",
        "expireAt": None,
    }


@app.post("/api/mailboxes/{mailbox_id}/extend")
async def extend_temporary_mailbox(mailbox_id: str) -> dict[str, Any]:
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = db.collection("mailboxes").document(prefix)
    mailbox_snapshot = mailbox_ref.get()
    if not mailbox_snapshot.exists:
        raise HTTPException(status_code=404, detail="mailbox not found")

    mailbox_data = mailbox_snapshot.to_dict() or {}
    mailbox_mode = str(mailbox_data.get("mode", "temporary")).lower()
    if mailbox_mode != "temporary":
        raise HTTPException(status_code=400, detail="only temporary mailboxes can be extended")

    expire_at = datetime.now(timezone.utc) + timedelta(minutes=TEMP_MAILBOX_MINUTES)
    mailbox_ref.set(
        {
            "mode": "temporary",
            "expireAt": expire_at,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {
        "status": "ok",
        "mailboxId": prefix,
        "email": f"{prefix}@{MAIL_DOMAIN}",
        "mode": "temporary",
        "expireAt": expire_at.isoformat(),
    }


@app.get("/api/mailboxes/{mailbox_id}/messages")
async def get_mailbox_messages(mailbox_id: str, limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = db.collection("mailboxes").document(prefix)
    mailbox_snapshot = mailbox_ref.get()
    if not mailbox_snapshot.exists:
        raise HTTPException(status_code=404, detail="mailbox not found")

    mailbox_data = mailbox_snapshot.to_dict() or {}
    messages_query = (
        mailbox_ref.collection("messages")
        .order_by("receivedAt", direction=firestore.Query.DESCENDING)
        .limit(limit)
        .stream()
    )

    return {
        "status": "ok",
        **serialize_mailbox(prefix, mailbox_data),
        "messages": [serialize_message(message) for message in messages_query],
    }


@app.patch("/api/mailboxes/{mailbox_id}/messages/{message_id}/read")
async def mark_message_read(mailbox_id: str, message_id: str, payload: ReadStatePayload) -> dict[str, Any]:
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    message_ref = db.collection("mailboxes").document(prefix).collection("messages").document(message_id)
    message_snapshot = message_ref.get()
    if not message_snapshot.exists:
        raise HTTPException(status_code=404, detail="message not found")

    message_ref.set(
        {
            "isRead": payload.isRead,
            "readAt": firestore.SERVER_TIMESTAMP if payload.isRead else None,
        },
        merge=True,
    )

    return {
        "status": "ok",
        "mailboxId": prefix,
        "messageId": message_id,
        "isRead": payload.isRead,
    }


@app.post("/api/cleanup")
async def cleanup_messages(read_retention_hours: int = Query(default=0, ge=0, le=720)) -> dict[str, Any]:
    result = cleanup_mailboxes_and_messages(read_retention_hours=read_retention_hours)
    return {
        "status": "ok",
        "readRetentionHours": read_retention_hours,
        **result,
    }


@app.delete("/api/mailboxes/{mailbox_id}")
async def delete_mailbox(mailbox_id: str) -> dict[str, Any]:
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = db.collection("mailboxes").document(prefix)
    mailbox_snapshot = mailbox_ref.get()
    if not mailbox_snapshot.exists:
        return {"status": "ok", "mailboxId": prefix}

    delete_mailbox_messages(mailbox_ref)
    mailbox_ref.delete()
    return {"status": "ok", "mailboxId": prefix}


@app.post("/api/webhook/email")
async def receive_email(
    payload: EmailPayload,
    x_webhook_secret: Optional[str] = Header(default=None),
) -> JSONResponse:
    """Receive Cloudflare Email Worker JSON payload and store it in Firestore."""
    if WEBHOOK_SECRET and x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="invalid webhook secret")

    to_value = payload.to.strip()
    from_value = payload.from_.strip()
    subject_value = payload.subject.strip()
    text_value = payload.text.strip()
    html_value = payload.html.strip()
    calendar_value = payload.calendar.strip()
    attachments_value = payload.attachments if isinstance(payload.attachments, list) else []

    normalized_attachments: list[dict[str, Any]] = []
    for attachment in attachments_value[:24]:
        if not isinstance(attachment, dict):
            continue

        raw_size = attachment.get("size", 0)
        try:
            parsed_size = max(0, int(raw_size or 0))
        except (TypeError, ValueError):
            parsed_size = 0

        mime_type = str(attachment.get("mimeType", "application/octet-stream")).strip().lower()
        disposition = str(attachment.get("disposition", "unknown")).strip().lower()
        normalized_attachments.append(
            {
                "filename": str(attachment.get("filename", "")).strip(),
                "mimeType": mime_type,
                "disposition": disposition if disposition in {"attachment", "inline", "unknown"} else "unknown",
                "contentId": str(attachment.get("contentId", "")).strip(),
                "size": parsed_size,
                "isInline": bool(attachment.get("isInline", False)),
                "isCalendar": bool(attachment.get("isCalendar", mime_type == "text/calendar")),
                "method": str(attachment.get("method", "")).strip().upper(),
            }
        )

    if not text_value and html_value:
        text_value = html_to_text(html_value)

    if not calendar_value:
        calendar_part = next((item for item in normalized_attachments if item.get("isCalendar")), None)
        if calendar_part:
            calendar_value = f"CALENDAR ({calendar_part.get('method') or 'EVENT'})"

    prefix = get_prefix_from_recipient(to_value)
    if not prefix:
        return JSONResponse(status_code=200, content={"status": "ignored", "reason": "invalid_recipient"})

    mailbox_ref = db.collection("mailboxes").document(prefix)
    mailbox_snapshot = mailbox_ref.get()

    if not mailbox_snapshot.exists:
        return JSONResponse(status_code=200, content={"status": "ignored", "reason": "mailbox_not_found"})

    mailbox_data = mailbox_snapshot.to_dict() or {}
    is_active, reason = mailbox_is_active(mailbox_data)
    mailbox_mode = str(mailbox_data.get("mode", "temporary" if mailbox_data.get("expireAt") else "persistent")).lower()

    if not is_active:
        return JSONResponse(status_code=200, content={"status": "ignored", "reason": reason})

    mailbox_ref.collection("messages").add(
        {
            "from": from_value or "unknown",
            "subject": subject_value or "(no subject)",
            "text": text_value or "",
            "html": html_value or "",
            "calendar": calendar_value or "",
            "attachments": normalized_attachments,
            "receivedAt": firestore.SERVER_TIMESTAMP,
            "isRead": False,
            "readAt": None,
        }
    )

    mailbox_ref.set({"updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return JSONResponse(status_code=200, content={"status": "stored", "mailbox": prefix, "mode": mailbox_mode})
