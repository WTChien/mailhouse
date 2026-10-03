import json
import hashlib
import hmac
import os
import re
import secrets
import string
from html import unescape
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import firebase_admin
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from firebase_admin import credentials, firestore
from google.api_core.exceptions import AlreadyExists
from pydantic import BaseModel, ConfigDict, Field

from verification import extract_verification_code


load_dotenv()

app = FastAPI(title="Mailhouse Webhook API", version="3.0.0")
# Mailhouse now serves one canonical domain. Keeping this as a single value also
# prevents a comma-separated environment variable from leaking into an address.
DEFAULT_MAIL_DOMAIN = "weiting.win"
MAIL_DOMAINS = [DEFAULT_MAIL_DOMAIN]
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")
TEMP_MAIL_API_KEY = os.getenv("TEMP_MAIL_API_KEY", "").strip()
TEMP_MAIL_ADMIN_KEY = os.getenv("TEMP_MAIL_ADMIN_KEY", "").strip()
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4012,http://127.0.0.1:4012",
    ).split(",")
    if origin.strip()
]
LOCAL_CORS_REGEX = r"https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$"
print(f"[mailhouse] Effective CORS_ORIGINS: {CORS_ORIGINS}")
RANDOM_CHARS = string.ascii_lowercase + string.digits

try:
    TEMP_MAILBOX_MINUTES = max(1, int(os.getenv("TEMP_MAILBOX_MINUTES", "30")))
except ValueError:
    TEMP_MAILBOX_MINUTES = 30

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    domain: Optional[str] = None


class ReadStatePayload(BaseModel):
    isRead: bool = True


class SavedMailboxItemPayload(BaseModel):
    mailboxId: str = ""
    domain: str = ""
    tag: str = ""
    createdAt: str = ""
    lastUsedAt: str = ""
    fieldValues: Optional[dict[str, str]] = None


class TagFieldConfigPayload(BaseModel):
    selectedFields: list[str] = Field(default_factory=list)
    updatedAt: str = ""


class RegistrationDraftPayload(BaseModel):
    generatedName: str = ""
    generatedPassword: str = ""
    updatedAt: str = ""


class ClientSyncStateUpdatePayload(BaseModel):
    savedMailboxes: Optional[list[SavedMailboxItemPayload]] = None
    tagFieldConfigs: Optional[dict[str, TagFieldConfigPayload]] = None
    registrationDrafts: Optional[dict[str, RegistrationDraftPayload]] = None
    registrationRuntimeDraft: Optional[RegistrationDraftPayload] = None


class ApiKeyCreatePayload(BaseModel):
    name: str = Field(default="ADB automation", min_length=1, max_length=80)


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

API_KEY_TOKEN_PATTERN = re.compile(r"^mhk_([a-f0-9]{16})_([A-Za-z0-9_-]{32,})$")
STRICT_TEMP_MAILBOX_ID_PATTERN = re.compile(r"^[a-z0-9]{8,24}$")


def hash_api_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require_admin_key(x_admin_key: Optional[str] = Header(default=None)) -> None:
    if not TEMP_MAIL_ADMIN_KEY:
        raise HTTPException(status_code=503, detail="API key administration is not configured")

    if not x_admin_key or not hmac.compare_digest(x_admin_key, TEMP_MAIL_ADMIN_KEY):
        raise HTTPException(status_code=401, detail="invalid admin key")


def require_temp_mail_api_key(authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    scheme, separator, raw_token = (authorization or "").partition(" ")
    if not separator or scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = raw_token.strip()
    if not token:
        raise HTTPException(status_code=401, detail="invalid API key", headers={"WWW-Authenticate": "Bearer"})

    if TEMP_MAIL_API_KEY and hmac.compare_digest(token, TEMP_MAIL_API_KEY):
        return {"id": "environment", "ref": db.collection("api_key_usage").document("environment")}

    token_match = API_KEY_TOKEN_PATTERN.fullmatch(token)
    if not token_match:
        raise HTTPException(status_code=401, detail="invalid API key", headers={"WWW-Authenticate": "Bearer"})

    key_id = token_match.group(1)
    key_ref = db.collection("api_keys").document(key_id)
    key_snapshot = key_ref.get()
    if not key_snapshot.exists:
        raise HTTPException(status_code=401, detail="invalid API key", headers={"WWW-Authenticate": "Bearer"})

    key_data = key_snapshot.to_dict() or {}
    stored_hash = str(key_data.get("keyHash", ""))
    if key_data.get("revokedAt") is not None or not stored_hash or not hmac.compare_digest(hash_api_key(token), stored_hash):
        raise HTTPException(status_code=401, detail="invalid API key", headers={"WWW-Authenticate": "Bearer"})

    return {"id": key_id, "ref": key_ref}


def record_api_usage(api_key: dict[str, Any], action: str) -> None:
    key_ref = api_key["ref"]
    # Polling may happen every second and several clients can share one key.
    # Shards avoid turning the API-key document into a single write hotspot.
    usage_ref = key_ref.collection("usage_shards").document(str(secrets.randbelow(10)))
    usage_ref.set(
        {
            "lastUsedAt": firestore.SERVER_TIMESTAMP,
            "total": firestore.Increment(1),
            action: firestore.Increment(1),
        },
        merge=True,
    )


def serialize_api_key(document: firestore.DocumentSnapshot) -> dict[str, Any]:
    data = document.to_dict() or {}
    usage = {"total": 0, "create": 0, "code": 0, "delete": 0}
    last_used_at = to_utc_datetime(data.get("lastUsedAt"))
    for shard in document.reference.collection("usage_shards").stream():
        shard_data = shard.to_dict() or {}
        for field_name in usage:
            usage[field_name] += int(shard_data.get(field_name, 0) or 0)
        shard_last_used_at = to_utc_datetime(shard_data.get("lastUsedAt"))
        if shard_last_used_at and (last_used_at is None or shard_last_used_at > last_used_at):
            last_used_at = shard_last_used_at

    return {
        "id": document.id,
        "name": data.get("name", "Unnamed key"),
        "prefix": data.get("prefix", ""),
        "created_at": to_iso_string(data.get("createdAt")),
        "last_used_at": to_iso_string(last_used_at),
        "revoked_at": to_iso_string(data.get("revokedAt")),
        "usage": {
            "total": usage["total"],
            "create": usage["create"],
            "code": usage["code"],
            "delete": usage["delete"],
        },
    }


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


def normalize_mail_domain(value: Optional[str]) -> str:
    domain = str(value or DEFAULT_MAIL_DOMAIN).strip().lower()
    if domain not in MAIL_DOMAINS:
        raise HTTPException(status_code=400, detail="unsupported mail domain")

    return domain


def encode_mailbox_doc_id(prefix: str, domain: str) -> str:
    if domain == DEFAULT_MAIL_DOMAIN:
        return prefix

    domain_key = re.sub(r"[^a-z0-9]+", "_", domain).strip("_")
    return f"{prefix}__{domain_key}"


def get_mailbox_ref(prefix: str, domain: str) -> firestore.DocumentReference:
    return db.collection("mailboxes").document(encode_mailbox_doc_id(prefix, domain))


def get_temp_mail_api_state_ref(prefix: str, domain: str) -> firestore.DocumentReference:
    return db.collection("temp_mail_api_state").document(encode_mailbox_doc_id(prefix, domain))


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


def normalize_tag_field_config(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    selected_fields_raw = value.get("selectedFields")
    if not isinstance(selected_fields_raw, list):
        selected_fields_raw = []

    selected_fields: list[str] = []
    for field_name in selected_fields_raw:
        field_value = str(field_name or "").strip()
        if field_value and field_value in {"name", "account", "password", "notes"} and field_value not in selected_fields:
            selected_fields.append(field_value)

    updated_at = parse_iso_datetime(value.get("updatedAt"))
    updated_at_iso = (updated_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()

    return {
        "selectedFields": selected_fields,
        "updatedAt": updated_at_iso,
    }


def normalize_tag_field_configs(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}

    result: dict[str, dict[str, Any]] = {}
    for raw_tag, raw_config in value.items():
        tag = normalize_mailbox_tag(str(raw_tag or ""))
        if not tag:
            continue

        config = normalize_tag_field_config(raw_config)
        if config is None:
          continue

        result[tag] = config

    return result


def normalize_mailbox_field_values(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}

    result: dict[str, str] = {}
    for key in ("name", "account", "email", "password", "notes"):
        raw_value = value.get(key)
        if isinstance(raw_value, str) and raw_value.strip():
            result[key] = raw_value.strip()

    return result


def normalize_saved_mailboxes(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []

    normalized_items: list[dict[str, Any]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for raw_item in value:
        if not isinstance(raw_item, dict):
            continue

        mailbox_id = normalize_mailbox_id(str(raw_item.get("mailboxId", "")))
        if not mailbox_id:
            continue
        try:
            mail_domain = normalize_mail_domain(str(raw_item.get("domain", "")) or DEFAULT_MAIL_DOMAIN)
        except HTTPException:
            continue

        created_at = parse_iso_datetime(raw_item.get("createdAt"))
        last_used_at = parse_iso_datetime(raw_item.get("lastUsedAt"))

        created_at_iso = (created_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
        last_used_at_iso = (last_used_at or created_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()

        normalized_items.append(
            {
                "mailboxId": mailbox_id,
                "domain": mail_domain,
                "tag": normalize_mailbox_tag(raw_item.get("tag", "")),
                "createdAt": created_at_iso or now_iso,
                "lastUsedAt": last_used_at_iso,
                "fieldValues": normalize_mailbox_field_values(raw_item.get("fieldValues")),
            }
        )

    deduped: dict[str, dict[str, Any]] = {}
    for item in normalized_items:
        dedupe_key = f'{item["mailboxId"]}@{item["domain"]}'
        existing = deduped.get(dedupe_key)
        if existing is None:
            deduped[dedupe_key] = item
            continue

        existing_created = parse_iso_datetime(existing.get("createdAt")) or datetime.now(timezone.utc)
        existing_last_used = parse_iso_datetime(existing.get("lastUsedAt")) or datetime.now(timezone.utc)
        current_created = parse_iso_datetime(item.get("createdAt")) or datetime.now(timezone.utc)
        current_last_used = parse_iso_datetime(item.get("lastUsedAt")) or datetime.now(timezone.utc)

        deduped[dedupe_key] = {
            "mailboxId": item["mailboxId"],
            "domain": item["domain"],
            "tag": item.get("tag") or existing.get("tag", ""),
            "createdAt": min(existing_created, current_created).astimezone(timezone.utc).isoformat(),
            "lastUsedAt": max(existing_last_used, current_last_used).astimezone(timezone.utc).isoformat(),
            "fieldValues": {
                **normalize_mailbox_field_values(existing.get("fieldValues")),
                **normalize_mailbox_field_values(item.get("fieldValues")),
            },
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
        "tagFieldConfigs": normalize_tag_field_configs(raw.get("tagFieldConfigs")),
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


def create_unique_temporary_mailbox(
    mail_domain: str,
    *,
    id_length: int = 5,
    api_managed: bool = False,
) -> tuple[str, datetime]:
    """Atomically reserve a unique temporary mailbox in Firestore."""
    for _ in range(20):
        prefix = generate_mailbox_id(id_length)
        mailbox_ref = get_mailbox_ref(prefix, mail_domain)
        expire_at = datetime.now(timezone.utc) + timedelta(minutes=TEMP_MAILBOX_MINUTES)
        mailbox_data: dict[str, Any] = {
            "domain": mail_domain,
            "mode": "temporary",
            "expireAt": expire_at,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }

        if api_managed:
            mailbox_data["apiManaged"] = True

        try:
            mailbox_ref.create(mailbox_data)
            if api_managed:
                try:
                    get_temp_mail_api_state_ref(prefix, mail_domain).set(
                        {
                            "mailboxId": prefix,
                            "domain": mail_domain,
                            "expireAt": expire_at,
                            "latestVerificationCode": None,
                            "latestVerificationReceivedAt": None,
                            "latestVerificationSubject": None,
                            "createdAt": firestore.SERVER_TIMESTAMP,
                            "updatedAt": firestore.SERVER_TIMESTAMP,
                        }
                    )
                except Exception:
                    mailbox_ref.delete()
                    raise
            return prefix, expire_at
        except AlreadyExists:
            continue

    raise HTTPException(status_code=500, detail="unable to create temporary mailbox")


def get_recipient_parts(raw_to: str) -> Optional[tuple[str, str]]:
    recipient = extract_email(raw_to)
    if not recipient or "@" not in recipient:
        return None

    prefix, domain = recipient.split("@", 1)
    domain = domain.lower()
    if domain not in MAIL_DOMAINS:
        return None

    return prefix.lower(), domain


def to_utc_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, datetime):
        return None

    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def to_iso_string(value: Any) -> Optional[str]:
    dt = to_utc_datetime(value)
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def serialize_mailbox(prefix: str, domain: str, mailbox_data: dict[str, Any]) -> dict[str, Any]:
    expire_at = mailbox_data.get("expireAt")
    mode = str(mailbox_data.get("mode", "temporary" if expire_at else "persistent")).lower()

    return {
        "mailboxId": prefix,
        "domain": domain,
        "email": f"{prefix}@{domain}",
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
            if mailbox_data.get("apiManaged") is True:
                db.collection("temp_mail_api_state").document(mailbox_doc.id).delete()
            mailbox_ref.delete()
            deleted_mailboxes += 1

    return {
        "deletedMessages": deleted_messages,
        "deletedMailboxes": deleted_mailboxes,
    }


@app.get("/health")
async def health_check() -> dict:
    return {"status": "ok"}


@app.get("/ping")
async def ping() -> dict[str, str]:
    return {"message": "pong"}


@app.get("/api/client-sync")
async def get_client_sync_state() -> dict[str, Any]:
    sync_ref = db.collection("client_sync").document("default")
    snapshot = sync_ref.get()
    if not snapshot.exists:
        return {
            "status": "ok",
            "savedMailboxes": [],
            "tagFieldConfigs": {},
            "registrationDrafts": {},
            "registrationRuntimeDraft": None,
            "updatedAt": None,
        }

    data = snapshot.to_dict() or {}
    normalized = normalize_client_sync_state(data)
    return {
        "status": "ok",
        "savedMailboxes": normalized.get("savedMailboxes", []),
        "tagFieldConfigs": normalized.get("tagFieldConfigs", {}),
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
        "tagFieldConfigs": current_data.get("tagFieldConfigs", {}),
        "registrationDrafts": current_data.get("registrationDrafts", {}),
        "registrationRuntimeDraft": current_data.get("registrationRuntimeDraft"),
    }

    payload_data = payload.model_dump(exclude_unset=True)
    if "savedMailboxes" in payload_data:
        merged_state["savedMailboxes"] = payload_data.get("savedMailboxes")

    if "tagFieldConfigs" in payload_data:
        merged_state["tagFieldConfigs"] = payload_data.get("tagFieldConfigs")

    if "registrationDrafts" in payload_data:
        merged_state["registrationDrafts"] = payload_data.get("registrationDrafts")

    if "registrationRuntimeDraft" in payload_data:
        merged_state["registrationRuntimeDraft"] = payload_data.get("registrationRuntimeDraft")

    normalized = normalize_client_sync_state(merged_state)
    sync_ref.set(normalized, merge=True)

    return {
        "status": "ok",
        "savedMailboxes": normalized.get("savedMailboxes", []),
        "tagFieldConfigs": normalized.get("tagFieldConfigs", {}),
        "registrationDrafts": normalized.get("registrationDrafts", {}),
        "registrationRuntimeDraft": normalized.get("registrationRuntimeDraft"),
    }


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/mail-domains")
async def get_mail_domains() -> dict[str, Any]:
    return {
        "status": "ok",
        "defaultDomain": DEFAULT_MAIL_DOMAIN,
        "domains": MAIL_DOMAINS,
    }


@app.post("/api/mailboxes/temp")
async def create_temporary_mailbox(domain: Optional[str] = Query(default=None)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix, expire_at = create_unique_temporary_mailbox(mail_domain)
    return {
        "status": "ok",
        "mailboxId": prefix,
        "domain": mail_domain,
        "email": f"{prefix}@{mail_domain}",
        "mode": "temporary",
        "expireAt": expire_at.isoformat(),
    }


@app.post("/api/mailboxes/persistent")
async def create_or_load_persistent_mailbox(payload: PersistentMailboxPayload) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(payload.domain)
    prefix = normalize_mailbox_id(payload.mailboxId)
    if not prefix or len(prefix) < 3:
        raise HTTPException(status_code=400, detail="mailbox name must be at least 3 alphanumeric characters")

    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
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
            "domain": mail_domain,
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
        "domain": mail_domain,
        "email": f"{prefix}@{mail_domain}",
        "mode": "persistent",
        "expireAt": None,
    }


@app.post("/api/mailboxes/{mailbox_id}/promote")
async def promote_mailbox_to_persistent(mailbox_id: str, domain: Optional[str] = Query(default=None)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
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
            "domain": mail_domain,
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
        "domain": mail_domain,
        "email": f"{prefix}@{mail_domain}",
        "mode": "persistent",
        "expireAt": None,
    }


@app.post("/api/mailboxes/{mailbox_id}/extend")
async def extend_temporary_mailbox(mailbox_id: str, domain: Optional[str] = Query(default=None)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
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
        "domain": mail_domain,
        "email": f"{prefix}@{mail_domain}",
        "mode": "temporary",
        "expireAt": expire_at.isoformat(),
    }


@app.get("/api/mailboxes/{mailbox_id}/messages")
async def get_mailbox_messages(mailbox_id: str, domain: Optional[str] = Query(default=None), limit: int = Query(default=50, ge=1, le=200)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
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
        **serialize_mailbox(prefix, mail_domain, mailbox_data),
        "messages": [serialize_message(message) for message in messages_query],
    }


@app.patch("/api/mailboxes/{mailbox_id}/messages/{message_id}/read")
async def mark_message_read(mailbox_id: str, message_id: str, payload: ReadStatePayload, domain: Optional[str] = Query(default=None)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    message_ref = get_mailbox_ref(prefix, mail_domain).collection("messages").document(message_id)
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


@app.delete("/api/mailboxes/{mailbox_id}/messages")
async def delete_all_mailbox_messages(mailbox_id: str, domain: Optional[str] = Query(default=None)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
    mailbox_snapshot = mailbox_ref.get()
    if not mailbox_snapshot.exists:
        raise HTTPException(status_code=404, detail="mailbox not found")

    deleted_messages = 0
    batch = db.batch()
    operations = 0

    for message_doc in mailbox_ref.collection("messages").stream():
        batch.delete(message_doc.reference)
        operations += 1
        deleted_messages += 1

        if operations == 400:
            batch.commit()
            batch = db.batch()
            operations = 0

    if operations:
        batch.commit()

    mailbox_ref.set({"updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)

    return {
        "status": "ok",
        "mailboxId": prefix,
        "deletedMessages": deleted_messages,
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
async def delete_mailbox(mailbox_id: str, domain: Optional[str] = Query(default=None)) -> dict[str, Any]:
    mail_domain = normalize_mail_domain(domain)
    prefix = normalize_mailbox_id(mailbox_id or "")
    if not prefix:
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
    mailbox_snapshot = mailbox_ref.get()
    if not mailbox_snapshot.exists:
        return {"status": "ok", "mailboxId": prefix}

    mailbox_data = mailbox_snapshot.to_dict() or {}
    delete_mailbox_messages(mailbox_ref)
    mailbox_ref.delete()
    if mailbox_data.get("apiManaged") is True:
        get_temp_mail_api_state_ref(prefix, mail_domain).delete()
    return {"status": "ok", "mailboxId": prefix}


@app.get("/api/admin/api-keys")
async def list_api_keys(_: None = Depends(require_admin_key)) -> dict[str, Any]:
    key_documents = list(db.collection("api_keys").stream())
    key_documents.sort(
        key=lambda document: to_utc_datetime((document.to_dict() or {}).get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return {"status": "ok", "api_keys": [serialize_api_key(document) for document in key_documents]}


@app.post("/api/admin/api-keys", status_code=201)
async def create_api_key(payload: ApiKeyCreatePayload, _: None = Depends(require_admin_key)) -> dict[str, Any]:
    name = re.sub(r"\s+", " ", payload.name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="API key name is required")

    for _attempt in range(10):
        key_id = secrets.token_hex(8)
        raw_api_key = f"mhk_{key_id}_{secrets.token_urlsafe(32)}"
        key_ref = db.collection("api_keys").document(key_id)
        try:
            key_ref.create(
                {
                    "name": name,
                    "prefix": f"{raw_api_key[:14]}…",
                    "keyHash": hash_api_key(raw_api_key),
                    "createdAt": firestore.SERVER_TIMESTAMP,
                    "lastUsedAt": None,
                    "revokedAt": None,
                    "usage": {"total": 0, "create": 0, "code": 0, "delete": 0},
                }
            )
            return {
                "status": "created",
                "api_key": raw_api_key,
                "key": {
                    "id": key_id,
                    "name": name,
                    "prefix": f"{raw_api_key[:14]}…",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "last_used_at": None,
                    "revoked_at": None,
                    "usage": {"total": 0, "create": 0, "code": 0, "delete": 0},
                },
            }
        except AlreadyExists:
            continue

    raise HTTPException(status_code=500, detail="unable to create API key")


@app.delete("/api/admin/api-keys/{key_id}")
async def revoke_api_key(key_id: str, _: None = Depends(require_admin_key)) -> dict[str, Any]:
    if not re.fullmatch(r"[a-f0-9]{16}", key_id):
        raise HTTPException(status_code=400, detail="invalid API key id")

    key_ref = db.collection("api_keys").document(key_id)
    key_snapshot = key_ref.get()
    if not key_snapshot.exists:
        raise HTTPException(status_code=404, detail="API key not found")

    key_ref.set({"revokedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return {"status": "revoked", "id": key_id}


@app.post("/api/temp-mail", status_code=201)
async def create_api_temporary_mailbox(
    api_key: dict[str, Any] = Depends(require_temp_mail_api_key),
) -> dict[str, Any]:
    record_api_usage(api_key, "create")
    prefix, expire_at = create_unique_temporary_mailbox(
        DEFAULT_MAIL_DOMAIN,
        id_length=12,
        api_managed=True,
    )
    return {
        "email": f"{prefix}@{DEFAULT_MAIL_DOMAIN}",
        "mailbox_id": prefix,
        "expires_at": expire_at.isoformat(),
    }


@app.get("/api/temp-mail/{mailbox_id}/code")
async def get_api_temporary_mailbox_code(
    mailbox_id: str,
    api_key: dict[str, Any] = Depends(require_temp_mail_api_key),
) -> dict[str, Any]:
    record_api_usage(api_key, "code")
    if not STRICT_TEMP_MAILBOX_ID_PATTERN.fullmatch(mailbox_id):
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    state_snapshot = get_temp_mail_api_state_ref(mailbox_id, DEFAULT_MAIL_DOMAIN).get()
    if not state_snapshot.exists:
        raise HTTPException(status_code=404, detail="mailbox not found")

    state_data = state_snapshot.to_dict() or {}
    expire_at = to_utc_datetime(state_data.get("expireAt"))
    if expire_at is None or expire_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="temporary mailbox has expired")

    code = state_data.get("latestVerificationCode")
    if not code:
        return {"status": "waiting", "code": None}

    return {
        "status": "received",
        "code": str(code),
        "received_at": to_iso_string(state_data.get("latestVerificationReceivedAt")),
        "subject": state_data.get("latestVerificationSubject") or "",
    }


@app.delete("/api/temp-mail/{mailbox_id}")
async def delete_api_temporary_mailbox(
    mailbox_id: str,
    api_key: dict[str, Any] = Depends(require_temp_mail_api_key),
) -> dict[str, Any]:
    record_api_usage(api_key, "delete")
    if not STRICT_TEMP_MAILBOX_ID_PATTERN.fullmatch(mailbox_id):
        raise HTTPException(status_code=400, detail="invalid mailbox id")

    state_ref = get_temp_mail_api_state_ref(mailbox_id, DEFAULT_MAIL_DOMAIN)
    state_snapshot = state_ref.get()
    if not state_snapshot.exists:
        raise HTTPException(status_code=404, detail="mailbox not found")

    mailbox_ref = get_mailbox_ref(mailbox_id, DEFAULT_MAIL_DOMAIN)
    delete_mailbox_messages(mailbox_ref)
    mailbox_ref.delete()
    state_ref.delete()
    return {"status": "deleted", "mailbox_id": mailbox_id}


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

    recipient_parts = get_recipient_parts(to_value)
    if not recipient_parts:
        return JSONResponse(status_code=200, content={"status": "ignored", "reason": "invalid_recipient"})

    prefix, mail_domain = recipient_parts
    mailbox_ref = get_mailbox_ref(prefix, mail_domain)
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
    verification_code = extract_verification_code(subject_value, text_value)
    if verification_code and mailbox_data.get("apiManaged") is True:
        get_temp_mail_api_state_ref(prefix, mail_domain).set(
            {
                "latestVerificationCode": verification_code,
                "latestVerificationReceivedAt": firestore.SERVER_TIMESTAMP,
                "latestVerificationSubject": subject_value or "(no subject)",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )
    return JSONResponse(status_code=200, content={"status": "stored", "mailbox": prefix, "domain": mail_domain, "mode": mailbox_mode})
