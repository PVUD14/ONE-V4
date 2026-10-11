/**
 * Tests for the real outgoing-mail sender (TlsSmtpMailSink) and the environment switch that selects it.
 *
 * Every test talks to an in-process fake SMTP server with a self-signed certificate generated at test
 * time. Nothing here contacts a real mail server or sends a real email. The fake certificate is
 * trusted by passing it to the sender as an extra CA; certificate verification is never disabled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import {
  createConfiguredInvitationMailSink,
  LoopbackSmtpInvitationMailSink,
  MailDeliveryFailure,
  mailProviderKind,
  PermanentMailRejection,
  TlsSmtpMailSink,
  type SmtpSettings,
} from '../src/invitation-mail.js';
import { startFakeSmtpServer, type FakeSmtpBehaviour, type FakeSmtpServer } from './fixtures/fake-smtp-server.js';

const PASSWORD = 'n0t-a-real-Passw0rd!';
const servers: FakeSmtpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fakeServer(input: { readonly mode: 'tls' | 'starttls' } & FakeSmtpBehaviour): Promise<FakeSmtpServer> {
  const server = await startFakeSmtpServer(input);
  servers.push(server);
  return server;
}

function sinkFor(server: FakeSmtpServer, mode: 'tls' | 'starttls', overrides: Partial<SmtpSettings> = {}, trust = true): TlsSmtpMailSink {
  return new TlsSmtpMailSink(
    { host: '127.0.0.1', port: server.port, security: mode, user: 'info@ai8ht.pro', password: PASSWORD, timeoutMs: 5_000, ...overrides },
    trust ? { trustedCertificates: server.certificatePem } : {},
  );
}

const message = {
  toEmail: 'student@example.test',
  subject: 'You are invited to ONE',
  textBody: 'Hello,\nPlease accept your invitation.\n',
  invitationId: '0f3c2b1a-0000-4000-8000-000000000001',
  correlationId: 'corr-1',
};

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the send to fail');
}

function expectNoPassword(error: Error): void {
  const encoded = [PASSWORD, Buffer.from(PASSWORD).toString('base64'), Buffer.from(`\0info@ai8ht.pro\0${PASSWORD}`).toString('base64')];
  const surfaces = [error.message, String(error.stack), JSON.stringify(error), inspect(error, { depth: 5 })];
  for (const surface of surfaces) for (const secret of encoded) expect(surface).not.toContain(secret);
}

describe('TlsSmtpMailSink over implicit TLS (port 465 style)', () => {
  it('sends the whole dialogue over TLS, authenticates, and delivers the shared message format', async () => {
    const server = await fakeServer({ mode: 'tls' });
    const result = await sinkFor(server, 'tls').send(message);

    const session = server.sessions[0]!;
    expect(session.lines.length).toBeGreaterThan(0);
    expect(session.lines.every((entry) => entry.tls)).toBe(true);
    expect(session.auth).toEqual({ mechanism: 'PLAIN', user: 'info@ai8ht.pro', password: PASSWORD });
    expect(session.mailFrom).toBe('MAIL FROM:<info@ai8ht.pro>');
    expect(session.rcptTo).toBe('RCPT TO:<student@example.test>');
    expect(session.message).toContain('From: AI8HT ONE <info@ai8ht.pro>');
    expect(session.message).toContain('To: student@example.test');
    expect(session.message).toContain('Subject: You are invited to ONE');
    expect(session.message).toContain('X-ONE-Correlation-Id: corr-1');
    expect(session.message).toMatch(/^Date: .+\+0000$/m);
    expect(session.message).toMatch(/^Message-ID: <[0-9a-f-]+@ai8ht\.pro>$/m);
    expect(session.message).toContain('Hello,\r\nPlease accept your invitation.');
    expect(session.lines.at(-1)!.line).toBe('QUIT');
    expect(result.providerReference).toMatch(/^smtp:.*FAKE123Q/);
  });

  it('uses AUTH LOGIN when that is the only mechanism the server offers', async () => {
    const server = await fakeServer({ mode: 'tls', authMechanisms: ['LOGIN'] });
    await sinkFor(server, 'tls').send(message);
    expect(server.sessions[0]!.auth).toEqual({ mechanism: 'LOGIN', user: 'info@ai8ht.pro', password: PASSWORD });
  });

  it('refuses a server that offers no mechanism it can use, without sending mail', async () => {
    const server = await fakeServer({ mode: 'tls', authMechanisms: ['CRAM-MD5'] });
    const error = await rejectionOf(sinkFor(server, 'tls').send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect(error).not.toBeInstanceOf(PermanentMailRejection);
    expect(server.sessions[0]!.mailFrom).toBeUndefined();
  });

  it('verifies the certificate: an untrusted server is refused before any credential is sent', async () => {
    const server = await fakeServer({ mode: 'tls' });
    const error = await rejectionOf(sinkFor(server, 'tls', {}, false).send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect((error as MailDeliveryFailure).stage).toBe('TLS');
    expect(server.sessions.flatMap((session) => session.lines)).toEqual([]);
    expectNoPassword(error);
  });

  it('verifies the host name against the certificate', async () => {
    const server = await fakeServer({ mode: 'tls' });
    // The certificate names 127.0.0.1 and localhost; a mismatching name must fail even though the CA is trusted.
    const sink = new TlsSmtpMailSink(
      { host: '127.0.0.1', port: server.port, security: 'tls', user: 'info@ai8ht.pro', password: PASSWORD, timeoutMs: 5_000 },
      { trustedCertificates: server.certificatePem, serverNameForTest: 'smtp.other-domain.test' },
    );
    const error = await rejectionOf(sink.send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect((error as MailDeliveryFailure).stage).toBe('TLS');
    expect(server.sessions.flatMap((session) => session.lines)).toEqual([]);
  });
  it('refuses a plaintext-only server: no TLS handshake, no credentials, no mail', async () => {
    // A server that only speaks plain SMTP (and offers no STARTTLS) on the port configured for TLS.
    const server = await fakeServer({ mode: 'starttls', advertiseStartTls: false });
    const error = await rejectionOf(sinkFor(server, 'tls').send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect(error).not.toBeInstanceOf(PermanentMailRejection);
    expect((error as MailDeliveryFailure).stage).toBe('TLS');
    for (const session of server.sessions) {
      expect(session.auth).toBeUndefined();
      expect(session.mailFrom).toBeUndefined();
      expect(session.lines.map((entry) => entry.line)).not.toContainEqual(expect.stringMatching(/^(EHLO|AUTH|MAIL)/));
    }
    expectNoPassword(error);
  });

  it('sends from mailSender(), so PTP_MAIL_FROM decides the envelope and the From header', async () => {
    const server = await fakeServer({ mode: 'tls' });
    vi.stubEnv('PTP_MAIL_FROM', 'noreply@ai8ht.pro');
    try {
      await sinkFor(server, 'tls').send(message);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(server.sessions[0]!.mailFrom).toBe('MAIL FROM:<noreply@ai8ht.pro>');
    expect(server.sessions[0]!.message).toContain('From: AI8HT ONE <noreply@ai8ht.pro>');
  });
});

describe('TlsSmtpMailSink over STARTTLS (port 587 style)', () => {
  it('upgrades to TLS before authenticating and sends everything after EHLO encrypted', async () => {
    const server = await fakeServer({ mode: 'starttls' });
    await sinkFor(server, 'starttls').send(message);

    const lines = server.sessions[0]!.lines;
    const plain = lines.filter((entry) => !entry.tls).map((entry) => entry.line.split(' ')[0]);
    expect(plain).toEqual(['EHLO', 'STARTTLS']);
    const afterUpgrade = lines.filter((entry) => entry.tls).map((entry) => entry.line.split(' ')[0]);
    expect(afterUpgrade.slice(0, 2)).toEqual(['EHLO', 'AUTH']);
    expect(server.sessions[0]!.auth?.password).toBe(PASSWORD);
    expect(server.sessions[0]!.message).toContain('From: AI8HT ONE <info@ai8ht.pro>');
  });

  it('never falls back to plain text when the server does not offer STARTTLS', async () => {
    const server = await fakeServer({ mode: 'starttls', advertiseStartTls: false });
    const error = await rejectionOf(sinkFor(server, 'starttls').send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect(error).not.toBeInstanceOf(PermanentMailRejection);
    const verbs = server.sessions[0]!.lines.map((entry) => entry.line.split(' ')[0]);
    expect(verbs).not.toContain('AUTH');
    expect(verbs).not.toContain('MAIL');
  });

  it('refuses an untrusted certificate presented after STARTTLS, before AUTH', async () => {
    const server = await fakeServer({ mode: 'starttls' });
    const error = await rejectionOf(sinkFor(server, 'starttls', {}, false).send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect((error as MailDeliveryFailure).stage).toBe('TLS');
    expect(server.sessions[0]!.lines.map((entry) => entry.line.split(' ')[0])).toEqual(['EHLO', 'STARTTLS']);
  });
});

describe('TlsSmtpMailSink message content', () => {
  it('attaches a calendar invite as multipart/mixed with a base64 part', async () => {
    const server = await fakeServer({ mode: 'tls' });
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    await sinkFor(server, 'tls').send({ ...message, attachments: [{ filename: 'interview.ics', contentType: 'text/calendar; method=REQUEST', content: ics }] });

    const received = server.sessions[0]!.message!;
    const boundary = /boundary="([^"]+)"/.exec(received)?.[1];
    expect(boundary).toBeTruthy();
    expect(received).toContain('MIME-Version: 1.0');
    expect(received).toContain('Content-Type: text/calendar; method=REQUEST');
    expect(received).toContain('Content-Disposition: attachment; filename="interview.ics"');
    const part = received.split(`--${boundary}`).find((section) => section.includes('text/calendar'))!;
    const encoded = part.split('\r\n\r\n')[1]!.replace(/\s+/g, '');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(ics);
    expect(received.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('dot-stuffs lines that begin with a period and normalises bare line feeds to CRLF', async () => {
    const server = await fakeServer({ mode: 'tls' });
    await sinkFor(server, 'tls').send({ ...message, textBody: 'first\n.hidden line\n.\nlast' });
    // The fake server removes the stuffing; the text must round-trip exactly and the message must not end early.
    expect(server.sessions[0]!.message).toContain('first\r\n.hidden line\r\n.\r\nlast');
  });

  it('encodes a non-ASCII subject and body instead of sending raw 8-bit text', async () => {
    const server = await fakeServer({ mode: 'tls' });
    await sinkFor(server, 'tls').send({ ...message, subject: 'Interview — Round 2', textBody: 'Namaste — see you soon' });
    const received = server.sessions[0]!.message!;
    expect(received).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(/[^\x00-\x7f]/.test(received)).toBe(false);
    expect(received).toContain('Content-Transfer-Encoding: base64');
    expect(received).toContain(Buffer.from('Namaste — see you soon', 'utf8').toString('base64'));
  });

  it('refuses a recipient address that could inject headers, without connecting', async () => {
    const server = await fakeServer({ mode: 'tls' });
    const error = await rejectionOf(sinkFor(server, 'tls').send({ ...message, toEmail: 'a@example.test\r\nBcc: victim@example.test' }));
    expect(error).toBeInstanceOf(PermanentMailRejection);
    expect(server.sessions).toEqual([]);
  });
});

describe('TlsSmtpMailSink reply codes and failures', () => {
  it('a 5xx on RCPT is a permanent rejection (the recipient bounced)', async () => {
    const server = await fakeServer({ mode: 'tls', replies: { RCPT: '550 5.1.1 <student@example.test>: user unknown' } });
    const error = await rejectionOf(sinkFor(server, 'tls').send(message));
    expect(error).toBeInstanceOf(PermanentMailRejection);
    expect((error as PermanentMailRejection).code).toBe(550);
    expect(server.sessions[0]!.message).toBeUndefined();
  });

  it('a 5xx after the message body is a permanent rejection', async () => {
    const server = await fakeServer({ mode: 'tls', replies: { MESSAGE: '554 5.7.1 message refused' } });
    const error = await rejectionOf(sinkFor(server, 'tls').send(message));
    expect(error).toBeInstanceOf(PermanentMailRejection);
  });

  it('a 4xx is retryable and is not reported as a bounce', async () => {
    for (const replies of [{ RCPT: '451 4.3.0 try again later' }, { MAIL: '421 4.7.0 too many connections' }, { MESSAGE: '452 4.3.1 insufficient storage' }] as const) {
      const server = await fakeServer({ mode: 'tls', replies });
      const error = await rejectionOf(sinkFor(server, 'tls').send(message));
      expect(error).toBeInstanceOf(MailDeliveryFailure);
      expect(error).not.toBeInstanceOf(PermanentMailRejection);
      expect((error as MailDeliveryFailure).retryable).toBe(true);
    }
  });

  it('refused credentials are a sender problem, never a recipient bounce, and never echo the password', async () => {
    const server = await fakeServer({ mode: 'tls', replies: { AUTH: '535 5.7.8 authentication failed' } });
    const error = await rejectionOf(sinkFor(server, 'tls').send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect(error).not.toBeInstanceOf(PermanentMailRejection);
    expect((error as MailDeliveryFailure).stage).toBe('AUTH');
    expect(error.message).toContain('535');
    expectNoPassword(error);
    expect(server.sessions[0]!.mailFrom).toBeUndefined();
  });

  it('times out a server that stops answering, as a retryable failure', async () => {
    for (const silentAt of ['GREETING', 'MESSAGE'] as const) {
      const server = await fakeServer({ mode: 'tls', silentAt });
      const started = Date.now();
      const error = await rejectionOf(sinkFor(server, 'tls', { timeoutMs: 300 }).send(message));
      expect(error).toBeInstanceOf(MailDeliveryFailure);
      expect((error as MailDeliveryFailure).stage).toBe('TIMEOUT');
      expect((error as MailDeliveryFailure).retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  it('a refused connection is retryable', async () => {
    const server = await fakeServer({ mode: 'tls' });
    const port = server.port;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const error = await rejectionOf(new TlsSmtpMailSink(
      { host: '127.0.0.1', port, security: 'tls', user: 'info@ai8ht.pro', password: PASSWORD, timeoutMs: 2_000 },
      { trustedCertificates: server.certificatePem },
    ).send(message));
    expect(error).toBeInstanceOf(MailDeliveryFailure);
    expect((error as MailDeliveryFailure).retryable).toBe(true);
  });

  it('never writes the password to the console or into any error, on success or failure', async () => {
    const written: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { written.push(args.map((arg) => inspect(arg)).join(' ')); });
    }
    const ok = await fakeServer({ mode: 'tls' });
    await sinkFor(ok, 'tls').send(message);
    for (const replies of [{ AUTH: '535 5.7.8 bad credentials' }, { RCPT: '550 no' }, { MAIL: '451 later' }] as const) {
      const server = await fakeServer({ mode: 'tls', replies });
      expectNoPassword(await rejectionOf(sinkFor(server, 'tls').send(message)));
    }
    for (const line of written) {
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toContain(Buffer.from(PASSWORD).toString('base64'));
    }
  });
});

describe('createConfiguredInvitationMailSink', () => {
  const base = { PTP_SMTP_HOST: 'smtpout.secureserver.net', PTP_SMTP_SECURITY: 'tls', PTP_SMTP_USER: 'info@ai8ht.pro', PTP_SMTP_PASSWORD: PASSWORD };

  it('returns nothing when no sender is configured, so every email is recorded NOT_CONFIGURED', () => {
    expect(createConfiguredInvitationMailSink({})).toBeUndefined();
  });

  it('keeps the local Mailpit sink when only its flag is on', () => {
    expect(createConfiguredInvitationMailSink({ PTP_LOCAL_INVITATION_MAILPIT_ENABLED: 'true' })).toBeInstanceOf(LoopbackSmtpInvitationMailSink);
  });

  it('returns the TLS sender when PTP_SMTP_HOST is set, with the port defaulting from the security mode', () => {
    const tls = createConfiguredInvitationMailSink(base);
    expect(tls).toBeInstanceOf(TlsSmtpMailSink);
    expect((tls as TlsSmtpMailSink).port).toBe(465);
    const starttls = createConfiguredInvitationMailSink({ ...base, PTP_SMTP_SECURITY: 'starttls' });
    expect((starttls as TlsSmtpMailSink).port).toBe(587);
    expect((createConfiguredInvitationMailSink({ ...base, PTP_SMTP_PORT: '2465' }) as TlsSmtpMailSink).port).toBe(2465);
  });

  it('accepts PTP_SMTP_SECURITY as TLS or STARTTLS in any case, and defaults it from the port when unset', () => {
    const upper = createConfiguredInvitationMailSink({ ...base, PTP_SMTP_SECURITY: 'STARTTLS' }) as TlsSmtpMailSink;
    expect(upper.security).toBe('starttls');
    expect((createConfiguredInvitationMailSink({ ...base, PTP_SMTP_SECURITY: 'TLS' }) as TlsSmtpMailSink).security).toBe('tls');
    const unset = createConfiguredInvitationMailSink({ ...base, PTP_SMTP_SECURITY: undefined }) as TlsSmtpMailSink;
    expect([unset.security, unset.port]).toEqual(['tls', 465]);
    const submission = createConfiguredInvitationMailSink({ ...base, PTP_SMTP_SECURITY: undefined, PTP_SMTP_PORT: '587' }) as TlsSmtpMailSink;
    expect([submission.security, submission.port]).toEqual(['starttls', 587]);
    const blank = createConfiguredInvitationMailSink({ ...base, PTP_SMTP_SECURITY: '' }) as TlsSmtpMailSink;
    expect([blank.security, blank.port]).toEqual(['tls', 465]);
  });

  it('treats an empty PTP_SMTP_HOST as "not configured", so compose can pass blank values through', () => {
    expect(createConfiguredInvitationMailSink({ PTP_SMTP_HOST: '', PTP_SMTP_PORT: '', PTP_SMTP_USER: '', PTP_SMTP_PASSWORD: '', PTP_SMTP_SECURITY: '' })).toBeUndefined();
    expect(createConfiguredInvitationMailSink({ PTP_SMTP_HOST: '  ', PTP_SMTP_USER: 'info@ai8ht.pro' })).toBeUndefined();
  });

  it('labels each sink with the provider kind the delivery ledger records', () => {
    expect(createConfiguredInvitationMailSink(base)!.providerKind).toBe('SMTP');
    expect(createConfiguredInvitationMailSink({ PTP_LOCAL_INVITATION_MAILPIT_ENABLED: 'true' })!.providerKind).toBe('MAILPIT');
    expect(mailProviderKind(createConfiguredInvitationMailSink(base)!)).toBe('SMTP');
    // A sink that does not say (a test double) is recorded as the loopback kind it stands in for.
    expect(mailProviderKind({ send: async () => ({}) })).toBe('MAILPIT');
  });

  it('does not expose the password through the sink object', () => {
    const sink = createConfiguredInvitationMailSink(base)!;
    expect(JSON.stringify(sink)).not.toContain(PASSWORD);
    expect(inspect(sink, { depth: 10, showHidden: true })).not.toContain(PASSWORD);
  });

  it.each([
    ['the user is missing', { ...base, PTP_SMTP_USER: '' }],
    ['the password is missing', { ...base, PTP_SMTP_PASSWORD: undefined }],
    ['the host is set but the user and password are blank', { PTP_SMTP_HOST: 'smtpout.secureserver.net', PTP_SMTP_USER: '', PTP_SMTP_PASSWORD: '' }],
    ['the password is an empty string', { ...base, PTP_SMTP_PASSWORD: '' }],
    ['the security mode is not tls or starttls', { ...base, PTP_SMTP_SECURITY: 'none' }],
    ['the port is not a port', { ...base, PTP_SMTP_PORT: '99999' }],
    ['the host is not a host name', { ...base, PTP_SMTP_HOST: 'smtp://smtpout.secureserver.net' }],
    ['the Mailpit flag is also on', { ...base, PTP_LOCAL_INVITATION_MAILPIT_ENABLED: 'true' }],
  ])('refuses to start when %s, without echoing the password', (_label, env) => {
    let thrown: unknown;
    try {
      createConfiguredInvitationMailSink(env as Record<string, string | undefined>);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/PTP_SMTP_[A-Z]+|PTP_LOCAL_INVITATION_MAILPIT_ENABLED/);
    expectNoPassword(thrown as Error);
  });

  it('names exactly the variable that is wrong', () => {
    const messageFor = (env: Record<string, string | undefined>) => {
      try {
        createConfiguredInvitationMailSink(env);
      } catch (error) {
        return (error as Error).message;
      }
      return 'no error';
    };
    expect(messageFor({ ...base, PTP_SMTP_PASSWORD: '' })).toContain('PTP_SMTP_PASSWORD');
    expect(messageFor({ ...base, PTP_SMTP_USER: ' ' })).toContain('PTP_SMTP_USER');
    expect(messageFor({ ...base, PTP_SMTP_PORT: 'abc' })).toContain('PTP_SMTP_PORT');
    expect(messageFor({ ...base, PTP_SMTP_SECURITY: 'ssl' })).toContain('PTP_SMTP_SECURITY');
  });
});
