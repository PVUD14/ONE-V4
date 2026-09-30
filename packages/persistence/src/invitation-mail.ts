/**
 * Outgoing email for ONE, shared by the API (staff invitations, sent in-request) and the outbox worker
 * (student invitations, announcements, hiring notifications, status notices — sent off the request path).
 *
 * Two sinks exist. `TlsSmtpMailSink` is the real sender: authenticated SMTP over implicit TLS (port 465)
 * or an enforced STARTTLS upgrade (port 587), configured only from PTP_SMTP_* environment variables —
 * Divakar chose GoDaddy's smtpout.secureserver.net for info@ai8ht.pro (2026-09-30). The loopback sink
 * talks plain SMTP to a local Mailpit for development. With neither configured, callers record that
 * nothing was sent rather than pretending it was.
 */
import { createConnection, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

/** A file sent with a message: today only the EMP-09 calendar invite (text/calendar). */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string;
}

export interface MailMessageInput {
  readonly toEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly invitationId: string;
  readonly correlationId: string;
  readonly attachments?: readonly MailAttachment[];
}

export interface InvitationMailSink {
  send(input: MailMessageInput): Promise<{ readonly providerReference?: string }>;
}

/** The receiving server refused the message permanently (5xx): retrying cannot help. */
export class PermanentMailRejection extends Error {
  constructor(readonly code?: number) {
    super('mail sink rejected message permanently');
    this.name = 'PermanentMailRejection';
  }
}

/**
 * Anything else that stopped a send: a 4xx, a timeout, a dropped connection, a certificate that failed
 * verification, or the sender itself being refused (bad credentials, sender not allowed). Callers treat
 * it as FAILED, not BOUNCED — a sender-side fault must never mark a recipient's address as bad.
 * The message carries only the stage, the reply code and a fixed description; never server text or
 * credentials.
 */
export type MailDeliveryStage = 'CONNECT' | 'TLS' | 'TIMEOUT' | 'GREETING' | 'EHLO' | 'STARTTLS' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'MESSAGE';
export class MailDeliveryFailure extends Error {
  constructor(readonly stage: MailDeliveryStage, readonly retryable: boolean, readonly code?: number, detail?: string) {
    super(`mail delivery failed at ${stage}${code === undefined ? '' : ` (${code})`}${detail ? `: ${detail}` : ''}`);
    this.name = 'MailDeliveryFailure';
  }
}

/**
 * The address every ONE email is sent from. Divakar chose info@ai8ht.pro (HG-7, 2026-09-28); an
 * environment may override it with PTP_MAIL_FROM, which must still be a plain address on a domain
 * that has been set up to send (SPF/DKIM) — a bad value is refused rather than sent.
 */
export const DEFAULT_MAIL_SENDER = 'info@ai8ht.pro';
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export function mailSender(): string {
  const configured = (process.env.PTP_MAIL_FROM ?? DEFAULT_MAIL_SENDER).trim();
  if (!PLAIN_ADDRESS.test(configured)) throw new Error('PTP_MAIL_FROM must be a plain email address');
  return configured;
}

/**
 * The RFC 5322 message both sinks send, so a Mailpit capture and a real delivery carry identical
 * headers. Line endings are CRLF; text that is not plain 7-bit ASCII is base64-encoded so the message
 * never depends on the server accepting 8-bit data.
 */
export function buildMailMessage(input: MailMessageInput, sender: string, now = new Date()): string {
  const headers = [
    `From: AI8HT ONE <${sender}>`,
    `To: ${sanitizeHeader(input.toEmail)}`,
    `Subject: ${encodeHeaderText(sanitizeHeader(input.subject))}`,
    `Date: ${now.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${randomUUID()}@${sender.split('@')[1]}>`,
    `X-ONE-Correlation-Id: ${sanitizeHeader(input.correlationId)}`,
    'MIME-Version: 1.0',
  ];
  const attachments = input.attachments ?? [];
  const lines = attachments.length === 0
    ? [...headers, ...textPart(input.textBody)]
    : multipartMessage(headers, input.textBody, attachments, input.invitationId);
  return lines.join('\r\n');
}

export class LoopbackSmtpInvitationMailSink implements InvitationMailSink {
  constructor(readonly host = process.env.PTP_LOCAL_MAILPIT_HOST ?? '127.0.0.1', readonly port = Number(process.env.PTP_LOCAL_MAILPIT_SMTP_PORT ?? '1025')) {
    if (!['127.0.0.1', 'localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('local invitation mail sink must be loopback-bound');
    }
  }

  async send(input: MailMessageInput): Promise<{ readonly providerReference?: string }> {
    const sender = mailSender();
    const transcript = await smtpSend({
      host: this.host,
      port: this.port,
      from: sender,
      to: input.toEmail,
      message: buildMailMessage(input, sender),
    });
    return { providerReference: `mailpit:${input.invitationId}:${transcript}`.slice(0, 256) };
  }
}

// ---------------------------------------------------------------------------------------------------
// The real sender
// ---------------------------------------------------------------------------------------------------

export type SmtpSecurity = 'tls' | 'starttls';
export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** `tls`: TLS from the first byte (465). `starttls`: plain greeting, then a mandatory upgrade (587). */
  readonly security: SmtpSecurity;
  readonly user: string;
  readonly password: string;
  /** The name given in EHLO. Defaults to one.ai8ht.pro. */
  readonly heloName?: string;
  /** Idle limit for every step; the whole send is bounded by three times this. Default 20 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Test-only options. `trustedCertificates` adds a trust anchor (a fake server's self-signed
 * certificate) on top of normal verification; `serverNameForTest` changes the name the certificate is
 * checked against. Neither turns verification off, and the product path passes neither.
 */
export interface TlsSmtpMailSinkTestOptions {
  readonly trustedCertificates?: string;
  readonly serverNameForTest?: string;
}

const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export class TlsSmtpMailSink implements InvitationMailSink {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly user: string;
  readonly heloName: string;
  readonly timeoutMs: number;
  // True private fields: never serialised, inspected or logged with the sink.
  readonly #password: string;
  readonly #testOptions: TlsSmtpMailSinkTestOptions;

  constructor(settings: SmtpSettings, testOptions: TlsSmtpMailSinkTestOptions = {}) {
    if (!HOST_NAME.test(settings.host) && !isIP(settings.host)) throw new Error('PTP_SMTP_HOST must be a bare host name');
    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) throw new Error('PTP_SMTP_PORT must be a port number');
    if (settings.security !== 'tls' && settings.security !== 'starttls') throw new Error('PTP_SMTP_SECURITY must be tls or starttls');
    if (!settings.user || /[\r\n\0]/.test(settings.user)) throw new Error('PTP_SMTP_USER must be set');
    if (!settings.password || /[\r\n\0]/.test(settings.password)) throw new Error('PTP_SMTP_PASSWORD must be set');
    const heloName = settings.heloName ?? 'one.ai8ht.pro';
    if (!HOST_NAME.test(heloName)) throw new Error('PTP_SMTP_HELO_NAME must be a host name');
    this.host = settings.host;
    this.port = settings.port;
    this.security = settings.security;
    this.user = settings.user;
    this.heloName = heloName;
    this.timeoutMs = settings.timeoutMs ?? 20_000;
    this.#password = settings.password;
    this.#testOptions = testOptions;
  }

  async send(input: MailMessageInput): Promise<{ readonly providerReference?: string }> {
    // An address that is not plain cannot be delivered and could inject headers or SMTP commands.
    if (!PLAIN_ADDRESS.test(input.toEmail)) throw new PermanentMailRejection();
    const sender = mailSender();
    const message = buildMailMessage(input, sender);
    const servername = this.#testOptions.serverNameForTest ?? (isIP(this.host) ? undefined : this.host);
    const session = await SmtpSession.open({
      host: this.host,
      port: this.port,
      implicitTls: this.security === 'tls',
      timeoutMs: this.timeoutMs,
      ...(servername ? { servername } : {}),
      ...(this.#testOptions.trustedCertificates ? { ca: this.#testOptions.trustedCertificates } : {}),
    });
    try {
      await session.expect('GREETING', [220]);
      let extensions = await session.ehlo(this.heloName);
      if (this.security === 'starttls') {
        // Never continue in plain text: no STARTTLS offered means no send.
        if (!extensions.has('STARTTLS')) throw new MailDeliveryFailure('STARTTLS', false, undefined, 'server does not offer STARTTLS');
        await session.command('STARTTLS', 'STARTTLS', [220]);
        await session.upgrade();
        extensions = await session.ehlo(this.heloName);
      }
      await this.authenticate(session, extensions);
      const accepted = await session.transfer(sender, input.toEmail, message);
      await session.quit();
      const reference = accepted.replace(/^\d{3}[ -]?/, '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 200);
      return { providerReference: `smtp:${reference || 'accepted'}` };
    } finally {
      session.close();
    }
  }

  private async authenticate(session: SmtpSession, extensions: ReadonlyMap<string, string>): Promise<void> {
    if (!session.encrypted) throw new MailDeliveryFailure('AUTH', false, undefined, 'refusing to authenticate without TLS');
    const mechanisms = new Set((extensions.get('AUTH') ?? '').toUpperCase().split(/\s+/).filter(Boolean));
    const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    if (mechanisms.has('PLAIN')) {
      await session.command('AUTH', `AUTH PLAIN ${base64(`\0${this.user}\0${this.#password}`)}`, [235]);
    } else if (mechanisms.has('LOGIN')) {
      await session.command('AUTH', 'AUTH LOGIN', [334]);
      await session.command('AUTH', base64(this.user), [334]);
      await session.command('AUTH', base64(this.#password), [235]);
    } else {
      throw new MailDeliveryFailure('AUTH', false, undefined, 'server offers neither AUTH PLAIN nor AUTH LOGIN');
    }
  }
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

interface SmtpSessionOptions {
  readonly host: string;
  readonly port: number;
  readonly implicitTls: boolean;
  readonly timeoutMs: number;
  readonly servername?: string;
  readonly ca?: string;
}

/** One SMTP conversation: reads replies line by line, enforces timeouts, and classifies reply codes. */
class SmtpSession {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private replyLines: string[] = [];
  private readonly replies: SmtpReply[] = [];
  private pending: { readonly resolve?: (reply: SmtpReply) => void; readonly reject: (error: Error) => void } | undefined;
  private failure: MailDeliveryFailure | undefined;
  private readonly deadline: NodeJS.Timeout;
  private readonly onData = (chunk: Buffer) => this.receive(chunk);
  private readonly onError = (error: NodeJS.ErrnoException) => this.fail(classifySocketError(error, this.inTls));
  private readonly onClose = () => this.fail(new MailDeliveryFailure('CONNECT', true, undefined, 'connection closed'));
  private readonly onTimeout = () => this.fail(new MailDeliveryFailure('TIMEOUT', true));
  private inTls: boolean;

  private constructor(private readonly plainSocket: Socket | TLSSocket, private readonly options: SmtpSessionOptions) {
    this.socket = plainSocket;
    this.inTls = options.implicitTls;
    this.deadline = setTimeout(this.onTimeout, options.timeoutMs * 3);
    this.listen(plainSocket);
  }

  static async open(options: SmtpSessionOptions): Promise<SmtpSession> {
    const socket = options.implicitTls
      ? tlsConnect({ host: options.host, port: options.port, ...tlsOptions(options) })
      : createConnection({ host: options.host, port: options.port });
    const session = new SmtpSession(socket, options);
    try {
      await session.waitFor(socket, options.implicitTls ? 'secureConnect' : 'connect');
    } catch (error) {
      session.close();
      throw error;
    }
    return session;
  }

  get encrypted(): boolean {
    return 'encrypted' in this.socket && this.socket.encrypted === true;
  }

  async expect(stage: MailDeliveryStage, accepted: readonly number[]): Promise<string> {
    const reply = await this.read();
    if (accepted.includes(reply.code)) return reply.lines.at(-1) ?? '';
    throw classifyReply(stage, reply.code);
  }

  async command(stage: MailDeliveryStage, line: string, accepted: readonly number[]): Promise<string> {
    this.write(`${line}\r\n`);
    return this.expect(stage, accepted);
  }

  /** EHLO, returning the advertised extensions keyed by keyword (e.g. AUTH → "PLAIN LOGIN"). */
  async ehlo(name: string): Promise<ReadonlyMap<string, string>> {
    this.write(`EHLO ${name}\r\n`);
    const reply = await this.read();
    if (reply.code !== 250) throw classifyReply('EHLO', reply.code);
    const extensions = new Map<string, string>();
    for (const line of reply.lines.slice(1)) {
      const [keyword, ...rest] = line.slice(4).trim().split(/[\s=]+/);
      if (keyword) extensions.set(keyword.toUpperCase(), rest.join(' '));
    }
    return extensions;
  }

  /** Switch the connection to TLS after a 220 to STARTTLS; anything received before it is discarded. */
  async upgrade(): Promise<void> {
    this.unlisten(this.plainSocket);
    this.plainSocket.on('error', () => undefined);
    this.buffer = '';
    this.replyLines = [];
    this.replies.length = 0;
    this.inTls = true;
    const secure = tlsConnect({ socket: this.plainSocket as Socket, ...tlsOptions(this.options) });
    this.socket = secure;
    this.listen(secure);
    await this.waitFor(secure, 'secureConnect');
  }

  /** MAIL FROM, RCPT TO, DATA and the dot-stuffed body; returns the server's acceptance line. */
  async transfer(from: string, to: string, message: string): Promise<string> {
    await this.command('MAIL', `MAIL FROM:<${from}>`, [250]);
    await this.command('RCPT', `RCPT TO:<${to}>`, [250, 251]);
    await this.command('DATA', 'DATA', [354]);
    const body = message.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
    this.write(`${body}\r\n.\r\n`);
    return this.expect('MESSAGE', [250]);
  }

  /** End the session politely; the message is already accepted, so a failure here changes nothing. */
  async quit(): Promise<void> {
    try {
      this.write('QUIT\r\n');
      await this.read();
    } catch {
      // Already accepted.
    }
  }

  close(): void {
    clearTimeout(this.deadline);
    this.failure ??= new MailDeliveryFailure('CONNECT', true, undefined, 'session closed');
    this.unlisten(this.socket);
    this.socket.on('error', () => undefined);
    this.socket.destroy();
    if (this.socket !== this.plainSocket) this.plainSocket.destroy();
  }

  private listen(socket: Socket | TLSSocket): void {
    socket.setTimeout(this.options.timeoutMs);
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('timeout', this.onTimeout);
  }

  private unlisten(socket: Socket | TLSSocket): void {
    socket.setTimeout(0);
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
    socket.off('timeout', this.onTimeout);
  }

  private waitFor(socket: Socket | TLSSocket, event: 'connect' | 'secureConnect'): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const done = () => {
        this.pending = undefined;
        resolve();
      };
      socket.once(event, done);
      this.pending = { reject: (error) => { socket.off(event, done); reject(error); } };
    });
  }

  private write(data: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  private read(): Promise<SmtpReply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1');
    if (this.buffer.length > 65_536) return this.fail(new MailDeliveryFailure('CONNECT', true, undefined, 'reply too long'));
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.replyLines.push(line);
      if (/^\d{3}-/.test(line)) continue;
      const code = /^\d{3}(?: |$)/.test(line) ? Number(line.slice(0, 3)) : Number.NaN;
      this.replies.push({ code, lines: this.replyLines });
      this.replyLines = [];
    }
    const pending = this.pending;
    if (pending?.resolve && this.replies.length) {
      this.pending = undefined;
      pending.resolve(this.replies.shift()!);
    }
  }

  private fail(error: MailDeliveryFailure): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.deadline);
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    this.socket.destroy();
  }
}

/** Certificate verification is always on; `ca`, when given (tests only), adds a trust anchor to it. */
function tlsOptions(options: SmtpSessionOptions) {
  return {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2' as const,
    ...(options.servername ? { servername: options.servername } : {}),
    ...(options.ca ? { ca: options.ca } : {}),
  };
}

/**
 * 5xx on the recipient or the message is a bounce (PermanentMailRejection). 5xx anywhere else — the
 * greeting, EHLO, STARTTLS, AUTH, MAIL FROM — is the sender being refused (credentials, sender policy),
 * which must not mark the recipient's address as bad. 4xx and anything unexpected are retryable.
 */
function classifyReply(stage: MailDeliveryStage, code: number): Error {
  if (code >= 500 && code < 600 && (stage === 'RCPT' || stage === 'DATA' || stage === 'MESSAGE')) return new PermanentMailRejection(code);
  if (code >= 500 && code < 600) return new MailDeliveryFailure(stage, false, code);
  return new MailDeliveryFailure(stage, true, Number.isNaN(code) ? undefined : code);
}

function classifySocketError(error: NodeJS.ErrnoException, inTls: boolean): MailDeliveryFailure {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : undefined;
  const certificate = code !== undefined && /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO|HOSTNAME|DEPTH_ZERO|ISSUER/.test(code);
  if (certificate || (inTls && code?.startsWith('ERR_SSL'))) return new MailDeliveryFailure('TLS', false, undefined, code);
  if (code === 'ETIMEDOUT') return new MailDeliveryFailure('TIMEOUT', true, undefined, code);
  return new MailDeliveryFailure('CONNECT', true, undefined, code);
}

// ---------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Chooses the sink from the environment. PTP_SMTP_HOST selects the real TLS sender, and then every
 * other PTP_SMTP_* setting must be valid or this throws and the API or worker refuses to start — a
 * half-configured sender is worse than none. Without it: the local Mailpit sink when its flag is on,
 * otherwise nothing (every email recorded NOT_CONFIGURED). Errors name variables, never values.
 */
export function createConfiguredInvitationMailSink(env: Environment = process.env): InvitationMailSink | undefined {
  const host = env.PTP_SMTP_HOST?.trim();
  const mailpit = env.PTP_LOCAL_INVITATION_MAILPIT_ENABLED === 'true';
  if (host) {
    if (mailpit) throw new Error('Set either PTP_SMTP_HOST or PTP_LOCAL_INVITATION_MAILPIT_ENABLED, not both');
    return new TlsSmtpMailSink(smtpSettingsFromEnvironment(env, host));
  }
  if (!mailpit) return undefined;
  return new LoopbackSmtpInvitationMailSink();
}

function smtpSettingsFromEnvironment(env: Environment, host: string): SmtpSettings {
  const security = env.PTP_SMTP_SECURITY?.trim().toLowerCase();
  if (security !== 'tls' && security !== 'starttls') throw new Error('PTP_SMTP_SECURITY must be tls or starttls when PTP_SMTP_HOST is set');
  const user = env.PTP_SMTP_USER?.trim();
  if (!user) throw new Error('PTP_SMTP_USER must be set when PTP_SMTP_HOST is set');
  const password = env.PTP_SMTP_PASSWORD;
  if (!password) throw new Error('PTP_SMTP_PASSWORD must be set when PTP_SMTP_HOST is set');
  const portText = env.PTP_SMTP_PORT?.trim();
  const port = portText ? Number(portText) : security === 'tls' ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PTP_SMTP_PORT must be a port number');
  const timeoutText = env.PTP_SMTP_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutText ? Number(timeoutText) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000)) {
    throw new Error('PTP_SMTP_TIMEOUT_MS must be a whole number between 1000 and 120000');
  }
  const heloName = env.PTP_SMTP_HELO_NAME?.trim();
  return { host, port, security, user, password, ...(heloName ? { heloName } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
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

// ---------------------------------------------------------------------------------------------------
// Loopback transport and message building
// ---------------------------------------------------------------------------------------------------

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
        reject(Number.isInteger(code) ? new PermanentMailRejection(code) : new Error('local invitation mail sink rejected message'));
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

/** The text part's headers and body: 7-bit as-is when it can be, otherwise base64. */
function textPart(textBody: string): string[] {
  const normalised = textBody.replace(/\r?\n/g, '\r\n');
  const sevenBit = /^[\x00-\x7f]*$/.test(normalised) && normalised.split('\r\n').every((line) => line.length <= 998);
  return sevenBit
    ? ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', normalised]
    : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', ...base64Lines(normalised)];
}

/** multipart/mixed: the text, then each attachment base64-encoded in 76-character lines. */
function multipartMessage(headers: readonly string[], textBody: string, attachments: readonly MailAttachment[], seed: string): string[] {
  const boundary = `one-${seed.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}-part`;
  const parts = [
    `--${boundary}`, ...textPart(textBody),
    ...attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${sanitizeHeader(attachment.contentType)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${sanitizeHeader(attachment.filename).replace(/["\\]/g, '')}"`,
      '',
      ...base64Lines(attachment.content),
    ]),
    `--${boundary}--`,
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts];
}

function base64Lines(content: string): string[] {
  return Buffer.from(content, 'utf8').toString('base64').match(/.{1,76}/g) ?? [];
}

/** RFC 2047 encoded-words for a header value that is not plain ASCII, folded so no line grows long. */
function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 160);
}
