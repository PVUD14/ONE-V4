/**
 * The AI-draft block a lesson or question body carries when the content factory wrote it (ENG-23).
 *
 * Why this exists: the editors keep body keys they do not own, so provenance written once at
 * creation survives every edit and the "AI draft" label cannot be lost by saving. This module is
 * the one place that writes that block and the one place that reads it back for an editor view,
 * so the lesson editor and the question bank show the same thing. Nothing here reaches a learner:
 * `publishedLessonBody` and `publishedQuestionColumns` copy only the learner text.
 *
 * Design: docs/architecture/content-factory-design.md (Decision 3).
 */
import { readAiDraftProvenance } from '@planthepath/career-readiness';

export interface AiDraftBody {
  readonly jobId: string;
  readonly generatorVersion: string;
  /** `<prompt key>@<version>`. */
  readonly promptVersion: string;
  readonly promptFingerprint: string;
  readonly model: string;
  /** ISO timestamp of the generation. */
  readonly generatedAt: string;
  /** What the reviewer must check. */
  readonly expertCheck: string;
  /** For a lesson: the model's five sections and whether they were cut to fit. */
  readonly sections?: Readonly<Record<string, string>>;
  readonly fitted?: boolean;
  readonly truncated: boolean;
  readonly guardVersion: string;
}

/** The keys a drafted body starts with. */
export function aiDraftBodyKeys(draft: AiDraftBody): Record<string, unknown> {
  return {
    provenance: {
      source: 'AI_GENERATED', generatorVersion: draft.generatorVersion, promptVersion: draft.promptVersion,
      promptFingerprint: draft.promptFingerprint, model: draft.model, generatedAt: new Date(draft.generatedAt).toISOString(), jobId: draft.jobId,
    },
    expertCheck: draft.expertCheck,
    aiDraft: {
      ...(draft.sections ? { sections: { ...draft.sections } } : {}),
      ...(draft.fitted === undefined ? {} : { fitted: draft.fitted }),
      truncated: draft.truncated,
      guard: draft.guardVersion,
    },
  };
}

export interface AiDraftView {
  readonly jobId: string;
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly generatedAt: string;
  /** What the reviewer must check before approving. */
  readonly expertCheck: string | null;
  /** The model's full text by section (lessons); null for a question. */
  readonly sections: Readonly<Record<string, string>> | null;
  /** True when the lesson text was cut to fit the editor; the full text is in `sections`. */
  readonly fitted: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** The editor view of a body's AI-draft block, or null when the body is not an AI draft. */
export function readAiDraftView(body: unknown): AiDraftView | null {
  const provenance = readAiDraftProvenance(body);
  if (!provenance) return null;
  const block = asRecord(asRecord(body).aiDraft);
  const rawSections = asRecord(block.sections);
  const sections = Object.fromEntries(Object.entries(rawSections).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return {
    jobId: provenance.jobId,
    generatorVersion: provenance.generatorVersion,
    promptVersion: provenance.promptVersion,
    model: provenance.model,
    generatedAt: provenance.generatedAt,
    expertCheck: provenance.expertCheck,
    sections: Object.keys(sections).length ? sections : null,
    fitted: block.fitted === true,
  };
}
