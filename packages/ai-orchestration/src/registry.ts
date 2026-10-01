/**
 * ONE's prompt registry: every prompt version a feature may run, in code.
 *
 * Prompts live here rather than in the database (0033: a prompt edited in a row silently
 * invalidates the provenance of every generation that cites its version). The AI Operations
 * console (OPS-12) reads this list to show which prompt versions exist.
 *
 * Empty on purpose: ENG-20 built the inference adapter but registers no feature, so no feature has
 * a prompt yet. A feature's first prompt is added here, as a new immutable entry, in the same change
 * that registers its policy.
 */
import { PromptRegistry, type PromptVersion } from './prompts.js';

export const registeredPrompts: readonly PromptVersion[] = [];

/** A registry over `registeredPrompts`. Registering a version twice with different text throws. */
export function onePromptRegistry(): PromptRegistry {
  return new PromptRegistry(registeredPrompts);
}
