/**
 * A fake SMTP server for the mail-sender tests: implicit TLS (port-465 style) or plain with STARTTLS
 * (port-587 style), recording every line of the dialogue so a test can assert what was sent.
 *
 * It exists so the TLS sender can be proven end to end without ever contacting a real mail server.
 * Its certificate is self-signed and generated in memory at test time (nothing key-shaped is
 * committed); a test trusts it by handing the certificate to the sender as an extra CA, never by
 * switching certificate verification off.
 */
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createSecureContext, TLSSocket, createServer as createTlsServer } from 'node:tls';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// ---- a minimal DER encoder, just enough for one self-signed X.509 v3 certificate ----

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const sequence = (...content: Buffer[]) => der(0x30, ...content);
const set = (...content: Buffer[]) => der(0x31, ...content);
function objectIdentifier(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

/** A fresh P-256 key and a self-signed certificate for 127.0.0.1 / localhost, both as PEM text. */
export function selfSignedCertificate(commonName = 'one-test-smtp.local'): { readonly certificatePem: string; readonly keyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaWithSha256 = sequence(objectIdentifier('1.2.840.10045.4.3.2'));
  const name = sequence(set(sequence(objectIdentifier('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8')))));
  const now = Date.now();
  const serial = randomBytes(12);
  serial[0] = serial[0]! & 0x7f;
  const subjectAltName = sequence(
    der(0x82, Buffer.from('localhost', 'ascii')), // dNSName
    der(0x87, Buffer.from([127, 0, 0, 1])), // iPAddress
  );
  const extensions = der(0xa3, sequence(
    sequence(objectIdentifier('2.5.29.17'), der(0x04, subjectAltName)),
    sequence(objectIdentifier('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
  ));
  const tbsCertificate = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaWithSha256,
    name,
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 3_600_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbsCertificate, { key: privateKey, dsaEncoding: 'der' });
  const certificate = sequence(tbsCertificate, ecdsaWithSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const base64 = certificate.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    certificatePem: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// ---- the server ----

export interface FakeSmtpBehaviour {
  /** Mechanisms advertised after EHLO (on a TLS channel). */
  readonly authMechanisms?: readonly string[];
  /** Advertise STARTTLS on the plain channel (starttls mode only). Default true. */
  readonly advertiseStartTls?: boolean;
  /** Override the reply to one stage, e.g. { RCPT: '550 5.1.1 no such user' }. */
  readonly replies?: Partial<Record<'GREETING' | 'EHLO' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'MESSAGE', string>>;
  /** Stop answering at this stage (to exercise the sender's timeout). */
  readonly silentAt?: 'GREETING' | 'EHLO' | 'MAIL' | 'MESSAGE';
}

export interface RecordedSession {
  /** Every line the client sent, in order, with whether it arrived over TLS. */
  readonly lines: { readonly line: string; readonly tls: boolean }[];
  /** The decoded AUTH credentials the client presented, if any. */
  auth?: { readonly mechanism: string; readonly user: string; readonly password: string };
  mailFrom?: string;
  rcptTo?: string;
  /** The message exactly as received, with dot-stuffing removed. */
  message?: string;
}

export interface FakeSmtpServer {
  readonly port: number;
  readonly certificatePem: string;
  readonly sessions: RecordedSession[];
  close(): Promise<void>;
}

export async function startFakeSmtpServer(input: { readonly mode: 'tls' | 'starttls' } & FakeSmtpBehaviour): Promise<FakeSmtpServer> {
  const { certificatePem, keyPem } = selfSignedCertificate();
  const secureContext = createSecureContext({ cert: certificatePem, key: keyPem });
  const sessions: RecordedSession[] = [];
  const sockets = new Set<Socket>();

  const serve = (initial: Socket, startsSecure: boolean) => {
    const session: RecordedSession = { lines: [] };
    sessions.push(session);
    let socket = initial;
    let secure = startsSecure;
    let buffer = '';
    let state: 'COMMAND' | 'DATA' | 'AUTH_LOGIN_USER' | 'AUTH_LOGIN_PASSWORD' = 'COMMAND';
    let dataLines: string[] = [];
    let loginUser = '';
    const reply = (stage: keyof NonNullable<FakeSmtpBehaviour['replies']> | 'NONE', fallback: string) => {
      if (stage !== 'NONE' && input.silentAt === stage) return;
      const override = stage === 'NONE' ? undefined : input.replies?.[stage];
      socket.write(`${override ?? fallback}\r\n`);
    };
    const ehloReply = () => {
      const extensions = ['250-one-test-smtp.local greets you', '250-PIPELINING', '250-SIZE 10485760'];
      if (!secure && input.mode === 'starttls' && input.advertiseStartTls !== false) extensions.push('250-STARTTLS');
      if (secure && (input.authMechanisms ?? ['PLAIN', 'LOGIN']).length) extensions.push(`250-AUTH ${(input.authMechanisms ?? ['PLAIN', 'LOGIN']).join(' ')}`);
      extensions.push('250 8BITMIME');
      if (input.replies?.EHLO) return reply('EHLO', '');
      if (input.silentAt === 'EHLO') return;
      socket.write(`${extensions.join('\r\n')}\r\n`);
    };
    const handleLine = (line: string) => {
      if (state === 'DATA') {
        if (line === '.') {
          state = 'COMMAND';
          session.message = dataLines.map((entry) => (entry.startsWith('.') ? entry.slice(1) : entry)).join('\r\n');
          reply('MESSAGE', '250 2.0.0 Ok: queued as FAKE123Q');
          return;
        }
        dataLines.push(line);
        return;
      }
      session.lines.push({ line, tls: secure });
      if (state === 'AUTH_LOGIN_USER') {
        loginUser = Buffer.from(line, 'base64').toString('utf8');
        state = 'AUTH_LOGIN_PASSWORD';
        socket.write('334 UGFzc3dvcmQ6\r\n');
        return;
      }
      if (state === 'AUTH_LOGIN_PASSWORD') {
        state = 'COMMAND';
        session.auth = { mechanism: 'LOGIN', user: loginUser, password: Buffer.from(line, 'base64').toString('utf8') };
        reply('AUTH', '235 2.7.0 Authentication successful');
        return;
      }
      const verb = line.split(' ')[0]!.toUpperCase();
      if (verb === 'EHLO') ehloReply();
      else if (verb === 'STARTTLS' && !secure) {
        socket.write('220 2.0.0 Ready to start TLS\r\n');
        socket.removeAllListeners('data');
        const upgraded = new TLSSocket(socket, { isServer: true, secureContext });
        sockets.add(upgraded);
        socket = upgraded;
        secure = true;
        buffer = '';
        attach();
      } else if (verb === 'AUTH') {
        const [, mechanism, initial] = line.split(' ');
        if (mechanism === 'PLAIN' && initial) {
          const [, user, password] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
          session.auth = { mechanism: 'PLAIN', user: user ?? '', password: password ?? '' };
          reply('AUTH', '235 2.7.0 Authentication successful');
        } else if (mechanism === 'LOGIN') {
          state = 'AUTH_LOGIN_USER';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else socket.write('504 5.5.4 mechanism not supported\r\n');
      } else if (verb === 'MAIL') {
        session.mailFrom = line;
        reply('MAIL', '250 2.1.0 Ok');
      } else if (verb === 'RCPT') {
        session.rcptTo = line;
        reply('RCPT', '250 2.1.5 Ok');
      } else if (verb === 'DATA') {
        if (input.replies?.DATA) return reply('DATA', '');
        state = 'DATA';
        dataLines = [];
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (verb === 'QUIT') {
        socket.end('221 2.0.0 Bye\r\n');
      } else socket.write('502 5.5.2 command not recognised\r\n');
    };
    const attach = () => {
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1');
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handleLine(line);
        }
      });
      socket.on('error', () => undefined);
    };
    attach();
    reply('GREETING', '220 one-test-smtp.local ESMTP ready');
  };

  const server: Server = input.mode === 'tls'
    ? createTlsServer({ cert: certificatePem, key: keyPem }, (socket) => { sockets.add(socket); serve(socket, true); })
    : createNetServer((socket) => { sockets.add(socket); serve(socket, false); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    certificatePem,
    sessions,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
