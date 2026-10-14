import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons/Icon.js';
import {
  ApiRequestError,
  getProtectedAccessToken,
  sendAssistantFeedback,
  streamAssistantChat,
  type AssistantMessage,
  type AssistantPersona,
} from './api.js';

const STARTERS: Record<AssistantPersona, readonly string[]> = {
  student: [
    'How do I take an assessment?',
    'Why can’t I start my assessment?',
    'How do I share my public profile?',
  ],
  institution: [
    'How do I publish and assign an exam?',
    'How do I reopen or extend an exam?',
    'Who has not attempted an assessment?',
  ],
  employer: [
    'How do I post a role and run a drive?',
    'How do I view a candidate’s profile?',
    'Can I see readiness scores?',
  ],
};

interface ChatEntry extends AssistantMessage {
  /** Set once for finished assistant answers so feedback can be offered. */
  readonly done?: boolean;
}

/**
 * The ONE Assistant: a floating, persona-aware help chat grounded in curated
 * product articles on the server. It never sees profile data — it explains the
 * product, and says so when it does not know.
 */
export function AssistantWidget({ persona }: { readonly persona: AssistantPersona }): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<readonly ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rated, setRated] = useState<ReadonlySet<number>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current && typeof logRef.current.scrollTo === 'function') {
      logRef.current.scrollTo({ top: logRef.current.scrollHeight });
    }
  }, [entries, open]);

  if (!token) return null;

  const ask = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setNotice(null);
    setDraft('');
    setBusy(true);
    const history: AssistantMessage[] = [
      ...entries.filter((entry) => entry.content.length > 0).map(({ role, content }): AssistantMessage => ({ role, content })),
      { role: 'user' as const, content: trimmed },
    ].slice(-11);
    setEntries((current) => [...current, { role: 'user', content: trimmed }, { role: 'assistant', content: '' }]);
    try {
      await streamAssistantChat(token, persona, history, (delta) => {
        setEntries((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + delta };
          return next;
        });
      });
      setEntries((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, done: true };
        return next;
      });
    } catch (error) {
      setEntries((current) => current.slice(0, -1));
      if (error instanceof ApiRequestError && error.status === 503) {
        setNotice('The assistant is switched off for now. Please use Help & FAQ, or contact support.');
      } else if (error instanceof ApiRequestError && error.status === 429) {
        setNotice('You have reached today’s assistant limit. It resets tomorrow — for anything urgent, contact your placement cell or support.');
      } else {
        setNotice('The assistant could not answer just now. Please try again in a moment.');
      }
    } finally {
      setBusy(false);
    }
  };

  const rate = (index: number, helpful: boolean): void => {
    const answer = entries[index];
    const question = entries[index - 1];
    if (!answer || !question) return;
    setRated((current) => new Set(current).add(index));
    void sendAssistantFeedback(token, helpful, question.content, answer.content);
  };

  return (
    <div className={`assistant-widget${open ? ' open' : ''}`}>
      {open ? (
        <div className="assistant-panel" role="dialog" aria-label="ONE Assistant">
          <div className="assistant-head">
            <span className="assistant-title"><Icon name="coach" size={16} /> ONE Assistant</span>
            <button type="button" className="assistant-close" aria-label="Close assistant" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button>
          </div>
          <div className="assistant-log" ref={logRef}>
            {entries.length === 0 ? (
              <div className="assistant-intro">
                <p>Hi! I can explain how ONE works — assessments, profiles, results and more. I don’t see your personal data, and I’ll say so when I don’t know.</p>
                <div className="assistant-starters">
                  {STARTERS[persona].map((starter) => (
                    <button key={starter} type="button" onClick={() => void ask(starter)}>{starter}</button>
                  ))}
                </div>
              </div>
            ) : (
              entries.map((entry, index) => (
                <div key={index} className={`assistant-msg ${entry.role}`}>
                  <p>{entry.content || '…'}</p>
                  {entry.role === 'assistant' && entry.done && !rated.has(index) ? (
                    <span className="assistant-rate">
                      <button type="button" aria-label="Helpful" onClick={() => rate(index, true)}><Icon name="check" size={16} /></button>
                      <button type="button" aria-label="Not helpful" onClick={() => rate(index, false)}><Icon name="close" size={16} /></button>
                    </span>
                  ) : null}
                </div>
              ))
            )}
            {notice ? <p className="assistant-notice">{notice}</p> : null}
          </div>
          <form
            className="assistant-input"
            onSubmit={(event) => { event.preventDefault(); void ask(draft); }}
          >
            <input
              type="text"
              value={draft}
              maxLength={2000}
              placeholder="Ask about using ONE…"
              aria-label="Ask the assistant"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" aria-label="Send" disabled={busy || draft.trim().length === 0}><Icon name="arrow-right" size={16} /></button>
          </form>
          <p className="assistant-foot">Answers come from ONE’s help guide and can be wrong — conversations may be reviewed to improve help.</p>
        </div>
      ) : null}
      <button
        type="button"
        className="assistant-launcher"
        aria-label={open ? 'Close ONE Assistant' : 'Open ONE Assistant'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="coach" size={20} />
      </button>
    </div>
  );
}
