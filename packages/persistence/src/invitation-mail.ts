/**
 * Invitation email delivery, shared by the API (staff invitations, sent in-request) and the
 * outbox worker (student invitations, sent off the request path).
 *
 * Moved here from the onboarding controller so the worker can deliver without importing an app.
 * Only a loopback sink exists: production email sending is a hard gate (HG-7), and with no sink
 * configured callers record that nothing was sent rather than pretending it was.
 */
import { createConnection } from 'node:net';

/** A file sent with a message: today only the EMP-09 calendar invite (text/calendar). */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string;
}

export interface InvitationMailSink {
  send(input: {
    readonly toEmail: string;
    readonly subject: string;
    readonly textBody: string;
    readonly invitationId: string;
    readonly correlationId: string;
    readonly attachments?: readonly MailAttachment[];
  }): Promise<{ readonly providerReference?: string }>;
}

/** The receiving server refused the message permanently (5xx): retrying cannot help. */
export class PermanentMailRejection extends Error {
  constructor() {
    super('mail sink rejected message permanently');
    this.name = 'PermanentMailRejection';
  }
}

/**
 * The address every ONE email is sent from. Divakar chose info@ai8ht.pro (HG-7, 2026-09-28); an
 * environment may override it with PTP_MAIL_FROM, which must still be a plain address on a domain
 * that has been set up to send (SPF/DKIM) — a bad value is refused rather than sent.
 */
export const DEFAULT_MAIL_SENDER = 'info@ai8ht.pro';
export function mailSender(): string {
  const configured = (process.env.PTP_MAIL_FROM ?? DEFAULT_MAIL_SENDER).trim();
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(configured)) throw new Error('PTP_MAIL_FROM must be a plain email address');
  return configured;
}

export class LoopbackSmtpInvitationMailSink implements InvitationMailSink {
  constructor(readonly host = process.env.PTP_LOCAL_MAILPIT_HOST ?? '127.0.0.1', readonly port = Number(process.env.PTP_LOCAL_MAILPIT_SMTP_PORT ?? '1025')) {
    if (!['127.0.0.1', 'localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('local invitation mail sink must be loopback-bound');
    }
  }

  async send(input: { readonly toEmail: string; readonly subject: string; readonly textBody: string; readonly invitationId: string; readonly correlationId: string; readonly attachments?: readonly MailAttachment[] }): Promise<{ readonly providerReference?: string }> {
    const sender = mailSender();
    const headers = [
      `From: AI8HT ONE <${sender}>`,
      `To: ${input.toEmail}`,
      `Subject: ${sanitizeHeader(input.subject)}`,
      `X-ONE-Correlation-Id: ${sanitizeHeader(input.correlationId)}`,
    ];
    const attachments = input.attachments ?? [];
    const message = attachments.length === 0
      ? [...headers, 'Content-Type: text/plain; charset=utf-8', '', input.textBody].join('\r\n')
      : multipartMessage(headers, input.textBody, attachments, input.invitationId);
    const transcript = await smtpSend({
      host: this.host,
      port: this.port,
      from: sender,
      to: input.toEmail,
      message,
    });
    return { providerReference: `mailpit:${input.invitationId}:${transcript}`.slice(0, 256) };
  }
}

export function createConfiguredInvitationMailSink(): InvitationMailSink | undefined {
  if (process.env.PTP_LOCAL_INVITATION_MAILPIT_ENABLED !== 'true') return undefined;
  return new LoopbackSmtpInvitationMailSink();
}

export function buildInvitationUrl(token: string): string {
  const configured = process.env.PTP_INVITATION_BASE_URL ?? 'http://127.0.0.1:5173';
  const base = new URL(configured);
  const localHttp = base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !localHttp)) {
    throw new Error('invitation base URL must be HTTPS or loopback HTTP');
  }
  const invitationUrl = new URL('/invitations/accept', base);
  invitationUrl.searchParams.set('token', token);
  return invitationUrl.toString();
}

async function smtpSend(input: { readonly host: string; readonly port: number; readonly from: string; readonly to: string; readonly message: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: input.host, port: input.port });
    let buffer = '';
    let lastResponse = '';
    const commands = [
      `HELO planthepath.local\r\n`,
      `MAIL FROM:<${input.from}>\r\n`,
      `RCPT TO:<${input.to}>\r\n`,
      'DATA\r\n',
      `${input.message.replace(/\r?\n\./g, '\r\n..')}\r\n.\r\n`,
      'QUIT\r\n',
    ];
    let commandIndex = 0;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('local invitation mail sink timed out'));
    }, 5_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      const lines = buffer.trimEnd().split(/\r?\n/);
      buffer = '';
      lastResponse = lines.at(-1) ?? '';
      const code = Number(lastResponse.slice(0, 3));
      if (!Number.isInteger(code) || code >= 500) {
        clearTimeout(timeout);
        socket.destroy();
        reject(Number.isInteger(code) ? new PermanentMailRejection() : new Error('local invitation mail sink rejected message'));
        return;
      }
      if (commandIndex < commands.length) socket.write(commands[commandIndex++]!);
      else {
        clearTimeout(timeout);
        socket.end();
        resolve(lastResponse.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80) || 'accepted');
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** multipart/mixed: the text, then each attachment base64-encoded in 76-character lines. */
function multipartMessage(headers: readonly string[], textBody: string, attachments: readonly MailAttachment[], seed: string): string {
  const boundary = `one-${seed.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}-part`;
  const parts = [
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody,
    ...attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${sanitizeHeader(attachment.contentType)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${sanitizeHeader(attachment.filename).replace(/["\\]/g, '')}"`,
      '',
      ...(Buffer.from(attachment.content, 'utf8').toString('base64').match(/.{1,76}/g) ?? []),
    ]),
    `--${boundary}--`,
  ];
  return [...headers, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 160);
}
