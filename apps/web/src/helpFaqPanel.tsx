import { useEffect, useMemo, useState } from 'react';
import { getHelpArticles, type HelpArticleDto } from './api.js';

/**
 * Role-filtered Help & FAQ, fed by the same curated corpus that grounds the
 * ONE Assistant — the FAQ and the assistant can never disagree.
 */
export function HelpFaqPanel({ persona }: { readonly persona: 'student' | 'institution' | 'employer' }): React.ReactElement {
  const [articles, setArticles] = useState<readonly HelpArticleDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    getHelpArticles(abort.signal)
      .then((response) => setArticles(response.articles))
      .catch(() => setFailed(true));
    return () => abort.abort();
  }, []);

  const visible = useMemo(() => {
    if (!articles) return [];
    const scoped = articles.filter((article) => article.personas.includes('all') || article.personas.includes(persona));
    const needle = query.trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter((article) =>
      article.title.toLowerCase().includes(needle) ||
      article.body.toLowerCase().includes(needle) ||
      article.keywords.some((keyword) => keyword.toLowerCase().includes(needle)));
  }, [articles, persona, query]);

  if (failed) return <section className="card wide-card"><h2>Help &amp; FAQ</h2><p>The help guide could not be loaded right now. Try again shortly.</p></section>;
  if (!articles) return <section className="card wide-card"><h2>Help &amp; FAQ</h2><p>Loading the help guide…</p></section>;

  return (
    <section className="card wide-card help-faq">
      <h2>Help &amp; FAQ</h2>
      <p className="help-faq-intro">Answers for your role, from the same guide that powers the ONE Assistant. For a conversation instead, use the sparkle button.</p>
      <input
        type="search"
        className="help-faq-search"
        placeholder="Search the guide…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search help articles"
      />
      {visible.length === 0 ? (
        <p className="help-faq-empty">Nothing matches "{query}". Try a different word, or ask the assistant.</p>
      ) : (
        <div className="help-faq-list">
          {visible.map((article) => (
            <details key={article.id} className="help-faq-item">
              <summary>{article.title}</summary>
              <p>{article.body}</p>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
