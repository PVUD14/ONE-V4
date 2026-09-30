/**
 * One-off manual test of the configured outgoing-mail sender: sends ONE fixed, harmless message to the
 * address given on the command line, through exactly the sink the API and worker would use.
 *
 * It exists so Divakar can prove a new mail configuration (docs/ops/runbook-mail-sender.md) before any
 * real user is emailed. It SENDS A REAL EMAIL when PTP_SMTP_HOST is set, so it refuses to run without
 * --confirm-real-send, and it is never run by tests or by an agent. It prints only the outcome — the
 * stage and reply code on failure — never the password or the server's text.
 */
import { randomUUID } from 'node:crypto';
import { createConfiguredInvitationMailSink, MailDeliveryFailure, PermanentMailRejection, TlsSmtpMailSink } from './invitation-mail.js';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const toIndex = args.indexOf('--to');
  const to = toIndex >= 0 ? args[toIndex + 1] : undefined;
  if (!to || !args.includes('--confirm-real-send')) {
    console.error('usage: mail:send-test -- --to <address> --confirm-real-send   (sends a REAL email)');
    return 2;
  }
  const sink = createConfiguredInvitationMailSink();
  if (!sink) {
    console.error('No mail sender is configured (PTP_SMTP_HOST is empty); nothing was sent.');
    return 1;
  }
  const via = sink instanceof TlsSmtpMailSink ? `${sink.host}:${sink.port} (${sink.security}) as ${sink.user}` : 'the local Mailpit sink';
  console.log(`Sending one test message to ${to} via ${via} ...`);
  try {
    const result = await sink.send({
      toEmail: to,
      subject: 'ONE mail sender test',
      textBody: [
        'This is a one-off test of the AI8HT ONE outgoing-mail configuration.',
        '',
        'If you received it, the sender, TLS and authentication are working. No action is needed.',
      ].join('\n'),
      invitationId: randomUUID(),
      correlationId: `mail-send-test-${Date.now()}`,
    });
    console.log(`Accepted by the server. Reference: ${result.providerReference ?? 'none'}`);
    return 0;
  } catch (error) {
    if (error instanceof PermanentMailRejection) console.error(`The server refused this recipient or message permanently (${error.code ?? 'no code'}).`);
    else if (error instanceof MailDeliveryFailure) console.error(`${error.message}${error.retryable ? ' (retryable)' : ''}`);
    else console.error('The send failed before reaching the server.');
    return 1;
  }
}

process.exitCode = await main();
