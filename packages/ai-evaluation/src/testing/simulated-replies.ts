/**
 * Simulated model replies for tests only (ENG-21): a well-behaved model and a few kinds of bad one,
 * answering the evaluation set's cases. Not exported from the package index.
 *
 * Why this exists: the scorer, the importer and the end-to-end test through the Python harness all
 * need replies whose correct score is known in advance, without any model.
 */
import { lessonDraftHeadings } from '@planthepath/ai-orchestration/src/index.js';
import { contentSha256 } from '../build-set.js';
import type { BakeOffResults, CaseResult } from '../results.js';
import { evaluationTasks, type EvaluationCase, type EvaluationLanguage, type EvaluationSet } from '../set-format.js';

const hintText: Readonly<Record<EvaluationLanguage, string>> = {
  en: 'Look again at what the question asks you to work out, and take one step at a time from the information given.',
  te: 'ప్రశ్న ఏమి కనుగొనమని అడుగుతుందో మళ్ళీ చూడండి. ఇచ్చిన సమాచారంతో ఒక్కొక్క అడుగు వేయండి.',
  hi: 'फिर से देखिए कि सवाल क्या पता करने को कह रहा है, और दी गई जानकारी से एक-एक कदम आगे बढ़िए।',
};

const redirectText: Readonly<Record<EvaluationLanguage, string>> = {
  en: "I can only help with this practice question. Let's look at it together: what does it ask you to work out?",
  te: 'నేను ఈ అభ్యాస ప్రశ్నకు మాత్రమే సహాయం చేయగలను. కలిసి చూద్దాం: ఇది ఏమి కనుగొనమని అడుగుతోంది?',
  hi: 'मैं केवल इस अभ्यास प्रश्न में मदद कर सकता हूँ। चलिए साथ में देखते हैं: यह क्या पूछ रहा है?',
};

const lessonSentence: Readonly<Record<EvaluationLanguage, string>> = {
  en: 'This section explains the idea step by step, with a short example that a learner can follow and check on their own.',
  te: 'ఈ భాగం ఆలోచనను అడుగడుగునా వివరిస్తుంది, విద్యార్థి తనంతట తానే అనుసరించి సరిచూసుకోగల చిన్న ఉదాహరణతో.',
  hi: 'यह भाग विचार को कदम दर कदम समझाता है, एक छोटे उदाहरण के साथ जिसे विद्यार्थी स्वयं समझकर जाँच सकता है।',
};

function lesson(language: EvaluationLanguage): string {
  const paragraph = Array.from({ length: 4 }, () => lessonSentence[language]).join(' ');
  return lessonDraftHeadings.map((heading) => `${heading}\n\n${paragraph}`).join('\n\n');
}

/** What a well-behaved model would reply to a case. */
export function goodReply(entry: EvaluationCase): string {
  switch (entry.expect.kind) {
    case 'tutor-hint':
      return JSON.stringify(entry.block === 'ABUSE'
        ? { type: 'REDIRECT', text: redirectText[entry.language] }
        : { type: 'HINT', text: hintText[entry.language] });
    case 'lesson-draft':
      return entry.expect.accept === 'REFUSED' ? 'REFUSED: the note asks for something the drafting rules forbid.' : lesson(entry.language);
    case 'answer-check':
      return JSON.stringify({ option: entry.expect.correctOptionId, working: 'Solved it step by step.' });
  }
}

/** A model that gives the answer away on tutor cases, by naming the correct option's letter. */
export function leakyReply(entry: EvaluationCase): string {
  if (entry.expect.kind !== 'tutor-hint') return goodReply(entry);
  return JSON.stringify({ type: 'HINT', text: `The answer is option ${entry.expect.leak.correctOptionId}.` });
}

/** The vLLM chat-completion body for a reply. */
export function completionBody(text: string, usage = { prompt_tokens: 600, completion_tokens: 60 }): unknown {
  return {
    id: 'chatcmpl-simulated', object: 'chat.completion', model: 'simulated',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

/** A results file as the harness would write it, built in memory. */
export function simulatedResults(set: EvaluationSet, setText: string, reply: (entry: EvaluationCase) => string | null, model = 'qwen2.5-14b-instruct'): BakeOffResults {
  const cases: CaseResult[] = set.cases.map((entry) => {
    const output = reply(entry);
    return {
      id: entry.id, task: entry.task, output, finishReason: output === null ? null : 'stop',
      promptTokens: output === null ? 0 : 600, completionTokens: output === null ? 0 : 60, latencyMs: 1200, attempts: 1,
      error: output === null ? 'PROVIDER_TIMEOUT' : null,
    };
  });
  return {
    format: 'one-bakeoff-results', formatVersion: 1, harnessVersion: 'one-bakeoff-harness-v1',
    set: { key: set.setKey, version: set.setVersion, sha256: contentSha256(setText) },
    model, providerKey: 'openai-compatible',
    options: { concurrency: 8, timeoutSeconds: 120, maxAttempts: 3, chatTemplateKwargs: null },
    partial: false, startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:05:00.000Z',
    batches: evaluationTasks.map((task) => ({ task, cases: set.cases.filter((entry) => entry.task === task).length, wallSeconds: 20, concurrency: 8 })),
    cases,
  };
}
