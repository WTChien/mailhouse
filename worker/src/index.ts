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
      };

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
