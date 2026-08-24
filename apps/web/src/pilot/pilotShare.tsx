import { useRef } from 'react';
import qrcode from 'qrcode-generator';
import { Camera, CheckCircle2, Copy, Download, EyeOff, Link2 } from 'lucide-react';
import { DetailRows, useOverlay, type ModalState } from './pilotOverlay.js';
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

const PUBLIC_URL = 'https://one.ai8ht.pro/p/arjun-reddy';

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
        <div className="pilot-share-link"><Link2 size={13} /> <span>one.ai8ht.pro/p/arjun-reddy</span></div>
      </div>
    </div>
    <div style={{ margin: '14px 0 4px' }}>
      <strong style={{ fontSize: 12.5, display: 'block', marginBottom: 7 }}>Visible on the public profile</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {['Name & photo', 'Institution (verified)', 'Education', 'Projects', 'Certificates', 'Skills'].map((item) => (
          <span key={item} className="pilot-chip blue"><CheckCircle2 size={11} /> {item}</span>
        ))}
        <span className="pilot-chip slate"><EyeOff size={11} /> Readiness scores — never public</span>
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

export function IdentityCardBody({ rows, email }: {
  readonly rows: readonly (readonly [string, string])[];
  readonly email: string;
}): React.ReactElement {
  return <div>
    <DetailRows rows={rows} />
    <div style={{ marginTop: 12 }}><PhotoUploadControl /></div>
    <p className="pilot-modal-text" style={{ marginTop: 10 }}>Signed in as {email}. This is a demo identity - everything it sees is sample data.</p>
  </div>;
}

export function PilotAvatar({ initials, size = 38, fontSize = 13 }: { readonly initials: string; readonly size?: number; readonly fontSize?: number }): React.ReactElement {
  const session = usePilotSession();
  if (session.profilePhotoUrl) {
    return <img className="pilot-avatar" src={session.profilePhotoUrl} alt="" style={{ width: size, height: size, objectFit: 'cover' }} />;
  }
  return <span className="pilot-avatar" style={{ width: size, height: size, fontSize }}>{initials}</span>;
}
