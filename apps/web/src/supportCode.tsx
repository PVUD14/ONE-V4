/**
 * ONE · Support code
 *
 * When a request fails, ONE keeps its correlation id so support can find it in the
 * logs. A person should never be shown a raw UUID, so every error and "not permitted"
 * state shows the same short support code instead — the first eight characters,
 * which are enough to find the request — through these helpers.
 */
import { useState } from 'react';

const CODE_LENGTH = 8;

/** The short code for a correlation id, or '' when there is none. */
export function supportCode(reference: string | null | undefined): string {
  if (!reference) return '';
  return reference.replace(/[^A-Za-z0-9]/g, '').slice(0, CODE_LENGTH).toLowerCase();
}

/** " Support code: ab12cd34." for appending to a message; '' when there is no reference. */
export function supportCodeSuffix(reference: string | null | undefined): string {
  const code = supportCode(reference);
  return code ? ` Support code: ${code}.` : '';
}

/** Small muted "Support code: ab12cd34" with a copy button, for error and not-permitted states. */
export function SupportCode({ reference }: { readonly reference: string | null | undefined }): React.ReactElement | null {
  const code = supportCode(reference);
  const [copied, setCopied] = useState(false);
  if (!code) return null;
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true)).catch(() => undefined);
  };
  return <small className="support-code"><span>Support code: {code}</span>{' '}
    <button type="button" className="pilot-btn ghost small" onClick={copy}>{copied ? 'Copied' : 'Copy support code'}</button></small>;
}
