/**
 * A prompt version has to identify exactly one piece of text forever, because every
 * generated row cites one. These tests are about that promise rather than about
 * string interpolation.
 */
import { describe, expect, it } from 'vitest';
import { PromptNotFoundError, PromptParameterError, PromptRegistry, promptFingerprint, renderPrompt } from '../src/index.js';

const base = {
  key: 'demo',
  version: 1,
  purpose: 'Test fixture.',
  system: 'System for {{tone}}.',
  parameters: ['tone', 'name'],
  user: 'Hello {{name}}.',
  maxOutputTokens: 100,
  temperature: 0,
};

describe('registry', () => {
  it('refuses to re-register a version with different text', () => {
    const registry = new PromptRegistry([base]);
    // Editing a prompt in place silently invalidates the provenance of every row that
    // already cites that version. Adding a version is the only correct move.
    expect(() => registry.register({ ...base, system: 'Something else.' }))
      .toThrow(/already registered with different text/);
  });

  it('accepts an identical re-registration, so module reloads are harmless', () => {
    const registry = new PromptRegistry([base]);
    expect(() => registry.register({ ...base })).not.toThrow();
  });

  it('resolves a specific version and reports a missing one', () => {
    const registry = new PromptRegistry([base, { ...base, version: 2, system: 'v2.' }]);
    expect(registry.get('demo', 1).system).toBe('System for {{tone}}.');
    expect(() => registry.get('demo', 3)).toThrow(PromptNotFoundError);
  });

  it('returns the highest version as latest', () => {
    const registry = new PromptRegistry([base, { ...base, version: 3, system: 'v3.' }, { ...base, version: 2, system: 'v2.' }]);
    expect(registry.latest('demo').version).toBe(3);
  });

  it('rejects a non-positive version', () => {
    expect(() => new PromptRegistry([{ ...base, version: 0 }])).toThrow(PromptParameterError);
  });
});

describe('rendering', () => {
  it('fills every declared placeholder', () => {
    const rendered = renderPrompt(base, { tone: 'a careers adviser', name: 'Asha' });
    expect(rendered.system).toBe('System for a careers adviser.');
    expect(rendered.user).toBe('Hello Asha.');
  });

  it('refuses a missing parameter rather than sending the model a placeholder', () => {
    // Rendering "Hello {{name}}." verbatim produces a draft that looks fine until
    // somebody reads it.
    expect(() => renderPrompt(base, { tone: 'x' })).toThrow(/requires parameter name/);
  });

  it('refuses an undeclared parameter', () => {
    expect(() => renderPrompt(base, { tone: 'x', name: 'y', extra: 'z' }))
      .toThrow(/does not declare parameter extra/);
  });
});

describe('fingerprint', () => {
  it('is stable for the same text and differs when the text changes', () => {
    expect(promptFingerprint(base)).toBe(promptFingerprint({ ...base }));
    expect(promptFingerprint(base)).not.toBe(promptFingerprint({ ...base, user: 'Hi {{name}}.' }));
  });
});
