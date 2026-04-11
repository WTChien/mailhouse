import PostalMime from 'postal-mime';

interface Env {
  API_WEBHOOK_URL: string;
  MAIL_DOMAIN?: string;
  WEBHOOK_SECRET?: string;
}

type ParsedAddress = {
  address?: string;
  name?: string;
};

type ParsedAttachment = {
  filename: string | null;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  related?: boolean;
  contentId?: string;
  method?: string;
  content: ArrayBuffer | Uint8Array | string;
};

type AttachmentSummary = {
  filename: string;
  mimeType: string;
  disposition: 'attachment' | 'inline' | 'unknown';
  contentId: string;
  size: number;
  isInline: boolean;
  isCalendar: boolean;
  method: string;
};

const MAX_CALENDAR_TEXT_LENGTH = 120_000;

function getContentSize(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).length;
  }

  if (content instanceof ArrayBuffer) {
    return content.byteLength;
  }

  return content.byteLength;
}

function asUtf8Text(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(content));
  }

  return new TextDecoder().decode(content);
}

function summarizeAttachment(attachment: ParsedAttachment): AttachmentSummary {
  const disposition = attachment.disposition ?? 'unknown';
  const mimeType = String(attachment.mimeType ?? 'application/octet-stream').toLowerCase();
  const isInline = disposition === 'inline' || Boolean(attachment.related);

  return {
    filename: attachment.filename ?? '',
    mimeType,
    disposition,
    contentId: attachment.contentId ?? '',
    size: getContentSize(attachment.content),
    isInline,
    isCalendar: mimeType === 'text/calendar',
    method: attachment.method ?? '',
  };
}

function pickAddress(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }

  if (Array.isArray(value)) {
    const first = value.find((item): item is ParsedAddress => !!item && typeof item === 'object');
    if (first?.address) {
      return first.address.trim().toLowerCase();
    }
  }

  if (value && typeof value === 'object') {
    const record = value as { address?: unknown; value?: unknown };

    if (typeof record.address === 'string') {
      return record.address.trim().toLowerCase();
    }

    if (Array.isArray(record.value)) {
      const first = record.value.find((item): item is ParsedAddress => !!item && typeof item === 'object');
      if (first?.address) {
        return first.address.trim().toLowerCase();
      }
    }
  }

  return fallback.trim().toLowerCase();
}

export default {
  async email(message: { from: string; to: string; raw: ReadableStream }, env: Env): Promise<void> {
    try {
      const parser = new PostalMime();
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parsed = await parser.parse(rawEmail);

      const payload = {
        to: pickAddress(parsed.to, message.to),
        from: pickAddress(parsed.from, message.from),
        subject: typeof parsed.subject === 'string' ? parsed.subject : '',
        text: typeof parsed.text === 'string' ? parsed.text : '',
        html: typeof parsed.html === 'string' ? parsed.html : '',
        calendar: '',
        attachments: [] as AttachmentSummary[],
      };

      const attachments = Array.isArray(parsed.attachments)
        ? (parsed.attachments as ParsedAttachment[])
        : [];

      payload.attachments = attachments.map((attachment) => summarizeAttachment(attachment));

      const calendarAttachment = attachments.find((attachment) => String(attachment.mimeType ?? '').toLowerCase() === 'text/calendar');
      if (calendarAttachment) {
        const calendarText = asUtf8Text(calendarAttachment.content);
        payload.calendar = calendarText.slice(0, MAX_CALENDAR_TEXT_LENGTH);
      }

      const response = await fetch(env.API_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.WEBHOOK_SECRET ? { 'x-webhook-secret': env.WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('Failed to forward email to API:', response.status, errorBody);
      }
    } catch (error) {
      console.error('Email Worker failed to parse or forward the message:', error);
    }
  },
} satisfies ExportedHandler<Env>;
