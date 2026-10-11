/**
 * Lesson languages for learners (ENG-16, migration 0097): the language a learner chose, the
 * languages they may choose, and the lessons they read rendered in it.
 *
 * Why this exists: OPS-09c publishes a lesson's variants as their own reviewed content revisions
 * and writes no lesson version for them; this is the one place that reads them for a student. It
 * reads only the latest PUBLISHED revision of each variant under a PUBLISHED release manifest, so
 * an unpublished draft or an archived variant is never served; the choice among them and the
 * English fallback with its notice are the pure `chooseLessonRendering`. The lesson's id, topic and
 * prerequisites are never changed, so completion and evidence stay per lesson, whatever the
 * language. Nothing is translated or generated here.
 *
 * Design: docs/architecture/lesson-language-serving-design.md
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  canChooseLessonLanguage,
  chooseLessonRendering,
  offeredLessonLanguages,
  readLessonIdentity,
  readLessonLanguage,
  type LessonLanguage,
  type LessonLanguageNotice,
  type LessonLanguageOption,
  type PublishedLessonVariant,
} from '@planthepath/career-readiness';

/** Anything with pg's `query(text, values)`: a Pool, a PoolClient or `drizzleAsPgClient(db)`. */
export interface LessonLanguageQueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export const lessonLanguageChangedAction = 'learner.lesson_language.changed';

async function rows<T>(client: LessonLanguageQueryClient, text: string, values: readonly unknown[] = []): Promise<T[]> {
  return (await client.query(text, values)).rows as T[];
}

/** The learner's chosen lesson language; English when they never chose. */
export async function learnerLessonLanguage(client: LessonLanguageQueryClient, userId: string): Promise<LessonLanguage> {
  const [row] = await rows<{ lesson_language: string }>(client,
    'SELECT lesson_language FROM learner_language_preferences WHERE user_id = $1', [userId]);
  return readLessonLanguage(row?.lesson_language);
}

/** Languages with at least one published lesson variant. */
export async function publishedLessonLanguages(client: LessonLanguageQueryClient): Promise<readonly string[]> {
  const found = await rows<{ language: string }>(client, `
    SELECT DISTINCT c.body #>> '{variant,language}' AS language
    FROM content_revisions c
    JOIN release_manifests rm ON rm.id = c.release_manifest_id AND rm.status = 'PUBLISHED'
    WHERE c.entity_type = 'LESSON' AND c.state = 'PUBLISHED' AND COALESCE(c.body ->> 'variantOf', '') <> ''
  `);
  return found.map((row) => row.language).filter((language): language is string => typeof language === 'string');
}

export interface LearnerLessonLanguageView {
  readonly selected: LessonLanguage;
  readonly offered: readonly LessonLanguageOption[];
}

export async function learnerLessonLanguageView(client: LessonLanguageQueryClient, userId: string): Promise<LearnerLessonLanguageView> {
  const [selected, published] = await Promise.all([learnerLessonLanguage(client, userId), publishedLessonLanguages(client)]);
  return { selected, offered: offeredLessonLanguages(published, selected) };
}

export class LessonLanguageNotOffered extends Error {
  constructor() {
    super('LESSON_LANGUAGE_NOT_OFFERED');
    this.name = 'LessonLanguageNotOffered';
  }
}

/**
 * Record the learner's choice, with its audit row, in one transaction. Only an offered language
 * may be chosen. Choosing the language already chosen changes nothing and writes no audit row.
 */
export async function setLearnerLessonLanguage(pool: Pool, input: { readonly userId: string; readonly language: unknown; readonly correlationId: string }): Promise<LearnerLessonLanguageView> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!canChooseLessonLanguage(input.language, await publishedLessonLanguages(client))) throw new LessonLanguageNotOffered();
    const language = input.language;
    const [previous] = await rows<{ lesson_language: string }>(client,
      'SELECT lesson_language FROM learner_language_preferences WHERE user_id = $1 FOR UPDATE', [input.userId]);
    const from = readLessonLanguage(previous?.lesson_language);
    if (!previous || previous.lesson_language !== language) {
      await client.query(`
        INSERT INTO learner_language_preferences (user_id, lesson_language, updated_at) VALUES ($1, $2, now())
        ON CONFLICT (user_id) DO UPDATE SET lesson_language = EXCLUDED.lesson_language, updated_at = now()
      `, [input.userId, language]);
    }
    if (from !== language) {
      await client.query(`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id, context)
        VALUES ($1::uuid, $2::uuid, $3, 'learner_language_preference', $4::text, 'SUCCESS', $5, $6::jsonb)
      `, [randomUUID(), input.userId, lessonLanguageChangedAction, input.userId, input.correlationId, JSON.stringify({ from, to: language })]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return learnerLessonLanguageView(pool, input.userId);
}

export interface RenderedLessonFields {
  readonly title: string;
  readonly body: { readonly summary?: string; readonly practice?: string };
  readonly language: LessonLanguage;
  readonly languageNotice: LessonLanguageNotice | null;
}

/**
 * The words of each given current lesson version in `language` (a published variant, or the
 * English lesson with a notice). Keyed by lesson version id; a version not found is absent.
 */
export async function renderLessonVersions(
  client: LessonLanguageQueryClient,
  lessonVersionIds: readonly string[],
  language: LessonLanguage,
): Promise<ReadonlyMap<string, RenderedLessonFields>> {
  const ids = [...new Set(lessonVersionIds)];
  if (!ids.length) return new Map();
  const lessons = await rows<{ id: string; version: number; title: string; body: unknown; base_id: string; base_body: unknown }>(client, `
    SELECT l.id::text AS id, l.version, l.title, l.body, COALESCE(cr.entity_id, l.id)::text AS base_id, cr.body AS base_body
    FROM lesson_versions l
    LEFT JOIN content_revisions cr ON cr.id = l.content_revision_id
    WHERE l.id = ANY($1::uuid[])
  `, [ids]);
  const variants = language === 'en' ? [] : await rows<{ variant_of: string; revision: number; body: unknown }>(client, `
    SELECT DISTINCT ON (c.entity_id) c.body ->> 'variantOf' AS variant_of, c.revision, c.body
    FROM content_revisions c
    JOIN release_manifests rm ON rm.id = c.release_manifest_id AND rm.status = 'PUBLISHED'
    WHERE c.entity_type = 'LESSON' AND c.state = 'PUBLISHED'
      AND c.body ->> 'variantOf' = ANY($1::text[]) AND c.body #>> '{variant,language}' = $2
    ORDER BY c.entity_id, c.revision DESC
  `, [lessons.map((lesson) => lesson.base_id.toLowerCase()), language]);
  const byBase = new Map<string, PublishedLessonVariant[]>();
  for (const variant of variants) {
    const key = String(variant.variant_of).toLowerCase();
    byBase.set(key, [...(byBase.get(key) ?? []), { revision: Number(variant.revision), body: variant.body }]);
  }
  const rendered = new Map<string, RenderedLessonFields>();
  for (const lesson of lessons) {
    const body = (lesson.body && typeof lesson.body === 'object' ? lesson.body : {}) as { summary?: string; practice?: string };
    rendered.set(lesson.id, chooseLessonRendering({
      base: { version: Number(lesson.version), title: lesson.title, body, variant: readLessonIdentity(lesson.base_body).variant },
      language,
      variants: byBase.get(lesson.base_id.toLowerCase()) ?? [],
    }));
  }
  return rendered;
}

type CatalogLesson = Record<string, unknown> & { readonly id: string };
type CatalogModule = Record<string, unknown> & { readonly lessons?: readonly CatalogLesson[] };

/**
 * A copy of the published catalogue with every lesson's title and body in `language`, and each
 * lesson labelled with the language it is in and its notice. Ids, topics and prerequisites are
 * the catalogue's own.
 */
export async function renderCatalogForLearner(
  client: LessonLanguageQueryClient,
  catalog: Record<string, unknown>,
  language: LessonLanguage,
): Promise<Record<string, unknown>> {
  const modules = (Array.isArray(catalog.modules) ? catalog.modules : []) as CatalogModule[];
  const ids = modules.flatMap((module) => (module.lessons ?? []).map((lesson) => String(lesson.id)));
  const rendered = await renderLessonVersions(client, ids, language);
  return {
    ...catalog,
    modules: modules.map((module) => ({
      ...module,
      lessons: (module.lessons ?? []).map((lesson) => {
        const words = rendered.get(String(lesson.id));
        return words
          ? { ...lesson, title: words.title, body: words.body, language: words.language, languageNotice: words.languageNotice }
          : { ...lesson, language: 'en', languageNotice: null };
      }),
    })),
  };
}
