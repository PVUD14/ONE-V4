/**
 * A failed request shows a short support code, never the raw correlation id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SupportCode, supportCode, supportCodeSuffix } from './supportCode.js';

const reference = 'e6aa7892-ff20-42fe-9b8c-1693e7165b50';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('support code', () => {
  it('is the first eight characters of the reference', () => {
    expect(supportCode(reference)).toBe('e6aa7892');
    expect(supportCode('corr-broken')).toBe('corrbrok');
    expect(supportCode(null)).toBe('');
  });

  it('appends to a message as a sentence, or not at all without a reference', () => {
    expect(`Unable to load.${supportCodeSuffix(reference)}`).toBe('Unable to load. Support code: e6aa7892.');
    expect(`Unable to load.${supportCodeSuffix(undefined)}`).toBe('Unable to load.');
  });

  it('renders the short code with a copy button, and never the full reference', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { container } = render(<SupportCode reference={reference} />);
    expect(screen.getByText('Support code: e6aa7892')).toBeInTheDocument();
    expect(container.textContent).not.toContain(reference);
    fireEvent.click(screen.getByRole('button', { name: 'Copy support code' }));
    expect(writeText).toHaveBeenCalledWith('e6aa7892');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('renders nothing without a reference', () => {
    const { container } = render(<SupportCode reference="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
