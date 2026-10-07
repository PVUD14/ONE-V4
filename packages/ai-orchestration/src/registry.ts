/**
 * ONE's prompt registry: every prompt version a feature may run, in code.
 *
 * Prompts live here rather than in the database (0033: a prompt edited in a row silently
 * invalidates the provenance of every generation that cites its version). The AI Operations
 * console (OPS-12) reads this list to show which prompt versions exist.
 *
 * ENG-21 added the first three (tutor hint, lesson draft, answer check) with the features that run
 * them (`first-features.ts`), because the bake-off must evaluate exactly what a feature will send.
 * A later version is a new immutable entry, never an edit.
 */
import { contentLessonDraftPromptV1, firstFeaturePrompts, tutorHintPromptV1 } from './first-features.js';
import { PromptRegistry, type PromptVersion } from './prompts.js';

/** Every prompt a feature runs now, plus the versions they replaced, so an older generation or evaluation still resolves. */
export const registeredPrompts: readonly PromptVersion[] = [...firstFeaturePrompts, tutorHintPromptV1, contentLessonDraftPromptV1];

/** A registry over `registeredPrompts`. Registering a version twice with different text throws. */
export function onePromptRegistry(): PromptRegistry {
  return new PromptRegistry(registeredPrompts);
}
