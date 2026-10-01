import { useRef } from 'react';
import qrcode from 'qrcode-generator';
import { Bell, Camera, CheckCircle2, Copy, Download, EyeOff, Link2, X } from 'lucide-react';
import { DetailRows, downloadCsv, useOverlay, type ModalState } from './pilotOverlay.js';
import { usePilotSession } from './pilotSession.js';
import { pilotPersona } from './pilotData.js';

/**
 * The public-profile share experience (stage 1 of the public profile proposal):
 * an opt-in, link-only profile with a scannable QR code. Also the profile photo
 * upload used by every persona's identity card - the chosen image lives only in
 * this browser session; nothing is uploaded anywhere from the pilot.
 */

export function QrSvg({ value, size = 176 }: { readonly value: string; readonly size?: number }): React.ReactElement {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  const cells: React.ReactElement[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) {
        cells.push(<rect key={`${row}-${column}`} x={column + quiet} y={row + quiet} width={1.02} height={1.02} />);
      }
    }
  }
  return <svg className="pilot-qr" viewBox={`0 0 ${total} ${total}`} width={size} height={size} role="img" aria-label={`QR code for ${value}`}>
    <rect width={total} height={total} fill="#ffffff" />
    <g fill="#101828">{cells}</g>
  </svg>;
}

const PUBLIC_URL = 'https://oneby8.com/p/arjun-reddy';

export function shareProfileModal(): ModalState {
  return {
    title: 'Public Profile',
    subtitle: 'Link-only · visible to whoever has the link',
    body: <ShareProfileBody />,
  };
}

function ShareProfileBody(): React.ReactElement {
  const overlay = useOverlay();
  const copyLink = (): void => {
    void navigator.clipboard?.writeText(PUBLIC_URL).catch(() => undefined);
    overlay.toast('Profile link copied (sample).');
  };
  const downloadQr = (): void => {
    const svg = document.querySelector('.pilot-qr');
    if (!svg) return;
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'arjun-reddy-profile-qr.svg';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    overlay.toast('QR code downloaded - print it on a resume or poster.');
  };
  return <div>
    <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
      <QrSvg value={PUBLIC_URL} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <span className="pilot-chip green" style={{ marginBottom: 8 }}>Public link enabled</span>
        <p className="pilot-modal-text" style={{ margin: '8px 0' }}>Anyone who scans this code or opens the link sees {pilotPersona.firstName}&apos;s public profile - and nothing else.</p>
        <div className="pilot-share-link"><Link2 size={13} /> <span>oneby8.com/p/arjun-reddy</span></div>
      </div>
    </div>
    <div style={{ margin: '14px 0 4px' }}>
      <strong style={{ fontSize: 12.5, display: 'block', marginBottom: 7 }}>Visible on the public profile</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {['Name & photo', 'Institution (verified)', 'Education', 'Projects', 'Certificates', 'Skills'].map((item) => (
          <span key={item} className="pilot-chip blue"><CheckCircle2 size={11} /> {item}</span>
        ))}
        <span className="pilot-chip slate"><EyeOff size={11} /> Readiness band — never public</span>
      </div>
    </div>
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); downloadQr(); }}><Download size={14} /> Download QR</button>
      <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); copyLink(); }}><Copy size={14} /> Copy Link</button>
    </div>
  </div>;
}

/** Photo upload row shared by every persona's identity card and the student profile. */
export function PhotoUploadControl({ compact }: { readonly compact?: boolean }): React.ReactElement {
  const overlay = useOverlay();
  const session = usePilotSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const onPick = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { overlay.toast('Please choose an image file.'); return; }
    session.setProfilePhoto(URL.createObjectURL(file));
    overlay.toast('Profile photo updated (sample - stays in this browser session).');
    overlay.closeModal();
  };
  return <>
    <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPick} />
    <button type="button" className={`pilot-btn ${compact ? 'ghost small' : 'ghost'}`}
      onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}>
      <Camera size={14} /> {session.profilePhotoUrl ? 'Change Photo' : 'Upload Photo'}
    </button>
  </>;
}

export function IdentityCardBody({ rows, email, initials }: {
  readonly rows: readonly (readonly [string, string])[];
  readonly email: string;
  readonly initials: string;
}): React.ReactElement {
  return <div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
      <PilotAvatar initials={initials} size={56} fontSize={19} />
      <PhotoUploadControl compact />
    </div>
    <DetailRows rows={rows} />
    <p className="pilot-modal-text" style={{ marginTop: 10 }}>Signed in as {email}. This is a demo identity - everything it sees is sample data.</p>
  </div>;
}

/** Notification centre: dismiss one, mark all read, clear all. */
export function NotificationsBody(): React.ReactElement {
  const session = usePilotSession();
  const overlay = useOverlay();
  if (session.notifications.length === 0) {
    return <p className="pilot-modal-text">You&apos;re all caught up - no notifications.</p>;
  }
  return <div>
    <div className="pilot-list">
      {session.notifications.map((entry) => (
        <div key={entry.id} className="pilot-list-row" style={{ alignItems: 'flex-start', opacity: entry.read ? 0.55 : 1 }}>
          <span className="pilot-tile amber"><Bell size={15} /></span>
          <div className="grow"><strong style={{ fontWeight: entry.read ? 500 : 650, fontSize: 12.5 }}>{entry.text}</strong><small>{entry.when}</small></div>
          <button type="button" className="pilot-icon-button" style={{ width: 28, height: 28 }} aria-label={`Dismiss notification: ${entry.text}`}
            onClick={(event) => { event.stopPropagation(); session.dismissNotification(entry.id); }}><X size={13} /></button>
        </div>
      ))}
    </div>
    <div className="pilot-modal-actions">
      <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); session.markAllNotificationsRead(); }}>Mark All as Read</button>
      <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); session.clearNotifications(); overlay.closeModal(); overlay.toast('Notifications cleared.'); }}>Clear All</button>
    </div>
  </div>;
}

/** Report download with a choice of formats: CSV, Excel-compatible CSV, printable PDF. */
export function ReportFormatBody({ filenameBase, title, rows }: {
  readonly filenameBase: string;
  readonly title: string;
  readonly rows: readonly (readonly string[])[];
}): React.ReactElement {
  const overlay = useOverlay();
  const asCsv = (extension: string): void => {
    downloadCsv(`${filenameBase}.${extension}`, rows);
    overlay.closeModal();
    overlay.toast(`${filenameBase}.${extension} downloaded (sample data).`);
  };
  const asPdf = (): void => {
    const printable = window.open('', '_blank', 'width=900,height=700');
    if (!printable) { overlay.toast('Allow pop-ups to print the PDF.'); return; }
    const bodyRows = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('');
    printable.document.write(`<!doctype html><title>${title}</title><style>
      body { font-family: Inter, "Segoe UI", sans-serif; color: #101828; padding: 32px; }
      h1 { font-size: 20px; margin: 0 0 4px; } p { color: #5d6b82; margin: 0 0 18px; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
      td { border-bottom: 1px solid #e5eaf2; padding: 8px 10px; text-align: left; }
      tr:first-child td { font-weight: 700; }
    </style><h1>${title}</h1><p>ONE by AI8HT · sample data · use your browser's dialog to save as PDF</p><table>${bodyRows}</table>`);
    printable.document.close();
    printable.focus();
    printable.print();
    overlay.closeModal();
  };
  return <div>
    <p className="pilot-modal-text">Choose the format for <strong>{title}</strong>.</p>
    <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}>
      <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); asCsv('csv'); }}><Download size={14} /> CSV</button>
      <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); asCsv('xls'); }}><Download size={14} /> Excel</button>
      <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); asPdf(); }}><Download size={14} /> PDF (print)</button>
    </div>
  </div>;
}

export function PilotAvatar({ initials, size = 38, fontSize = 13 }: { readonly initials: string; readonly size?: number; readonly fontSize?: number }): React.ReactElement {
  const session = usePilotSession();
  if (session.profilePhotoUrl) {
    return <img className="pilot-avatar" src={session.profilePhotoUrl} alt="" style={{ width: size, height: size, objectFit: 'cover' }} />;
  }
  return <span className="pilot-avatar" style={{ width: size, height: size, fontSize }}>{initials}</span>;
}
