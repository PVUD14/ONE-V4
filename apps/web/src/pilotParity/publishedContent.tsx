/**
 * Published learner content on the five pilot-parity pages.
 *
 * These pages are pilot-exact shells whose slots read NA because no content source
 * existed. This adds a card that appears **only** when something has actually been
 * published for that page — it never replaces an NA widget and never invents an example,
 * so a page with no content looks exactly as honest as it did before.
 */
import { useEffect, useState } from 'react';
import { getProtectedAccessToken, listLearnerContent } from '../api.js';
import type { LearnerContentItemDto, LearnerContentType } from '../api.js';

/**
 * A published item's body is free-form JSON, so only strings are rendered and only from
 * keys we recognise. An unknown shape shows the title and summary rather than dumping
 * whatever the author happened to store.
 */
function bodyLines(content: Readonly<Record<string, unknown>>): readonly string[] {
  return ['body', 'detail', 'description', 'guidance']
    .map((key) => content[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function PublishedContentCard({ contentType, title }: {
  readonly contentType: LearnerContentType;
  readonly title: string;
}): React.ReactElement | null {
  const [items, setItems] = useState<readonly LearnerContentItemDto[]>([]);
  const token = getProtectedAccessToken();

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listLearnerContent(token, contentType, controller.signal)
      .then((response) => setItems(response.items))
      // A failed read leaves the card absent rather than claiming there is nothing.
      .catch(() => undefined);
    return () => controller.abort();
  }, [token, contentType]);

  if (items.length === 0) return null;

  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip green">{items.length}</span></div>
    <ul className="pilot-list">
      {items.map((item) => <li key={item.id}>
        <div>
          <b>{item.title}</b>
          {item.summary ? <><br /><small>{item.summary}</small></> : null}
          {bodyLines(item.content).map((line, index) => <p key={index} style={{ margin: '4px 0 0', fontSize: 12.5 }}>{line}</p>)}
        </div>
      </li>)}
    </ul>
  </section>;
}
