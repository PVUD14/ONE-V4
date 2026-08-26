import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssistantWidget } from './assistantWidget.js';

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    getProtectedAccessToken: vi.fn(() => 'test-token'),
    streamAssistantChat: vi.fn(async (_token, _persona, _messages, onDelta: (text: string) => void) => {
      onDelta('Open Assessments from the sidebar.');
      return 'Open Assessments from the sidebar.';
    }),
    sendAssistantFeedback: vi.fn(async () => undefined),
  };
});

import { getProtectedAccessToken, streamAssistantChat } from './api.js';

describe('AssistantWidget', () => {
  beforeEach(() => {
    cleanup();
    vi.mocked(streamAssistantChat).mockClear();
    vi.mocked(getProtectedAccessToken).mockReturnValue('test-token');
  });

  it('renders nothing when signed out', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null as unknown as string);
    const { container } = render(<AssistantWidget persona="student" />);
    expect(container.firstChild).toBeNull();
  });

  it('opens, shows persona starters, and streams an answer', async () => {
    render(<AssistantWidget persona="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open ONE Assistant' }));
    expect(screen.getByRole('dialog', { name: 'ONE Assistant' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'How do I take an assessment?' }));
    await waitFor(() => {
      expect(screen.getByText('Open Assessments from the sidebar.')).toBeTruthy();
    });
    const call = vi.mocked(streamAssistantChat).mock.calls[0]!;
    expect(call[1]).toBe('student');
    expect(call[2][call[2].length - 1]).toEqual({ role: 'user', content: 'How do I take an assessment?' });
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy();
  });

  it('sends a typed question from the input', async () => {
    render(<AssistantWidget persona="institution" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open ONE Assistant' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask the assistant' }), { target: { value: 'How do I reopen an exam?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(vi.mocked(streamAssistantChat)).toHaveBeenCalled();
    });
    expect(vi.mocked(streamAssistantChat).mock.calls[0]![1]).toBe('institution');
  });
});
