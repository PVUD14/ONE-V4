/**
 * AI Operations console rules (OPS-12): who may read, stop and configure; how a limits change is
 * classified; when a feature may be switched on; the shape of a recorded evaluation; and the two
 * new approval actions.
 */
import { describe, expect, it } from 'vitest';
import {
  aiConfigureIsBreakGlass,
  aiFeatureEnableReasons,
  aiLimitsRaiseReasons,
  aiStopIsBreakGlass,
  approvalRequestReasons,
  canConfigureAi,
  canStopAi,
  canViewAiOperations,
  classifyAiLimitsChange,
  highRiskActionKeys,
  highRiskActions,
  isLegacyHighRiskActionKey,
  readAiEvaluationMetrics,
  refuseAiFeatureEnable,
  refuseApprovalRequest,
} from './index.js';

const actor = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ userId: 'u-' + role, memberships: [{ role, state, grants }] });

describe('who may do what', () => {
  it('reads with AI_OPS_VIEW: the three platform roles, never an institution admin', () => {
    for (const role of ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']) expect(canViewAiOperations(actor(role))).toBe(true);
    expect(canViewAiOperations(actor('INSTITUTION_ADMIN'))).toBe(false);
  });

  it('stops AI with AI_OPS_CONFIGURE or OPS_FLAGS_MANAGE, so the operator on duty can pull the brake', () => {
    for (const role of ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']) expect(canStopAi(actor(role))).toBe(true);
    expect(canStopAi(actor('INSTITUTION_ADMIN'))).toBe(false);
    expect(canStopAi(actor('INSTITUTION_ADMIN', 'ACTIVE', ['AI_OPS_CONFIGURE']))).toBe(false);
  });

  it('configures only with AI_OPS_CONFIGURE: by grant, or the super admin as break-glass', () => {
    expect(canConfigureAi(actor('OPERATIONS_ADMIN'))).toBe(false);
    expect(canConfigureAi(actor('SECURITY_ADMIN'))).toBe(false);
    expect(canConfigureAi(actor('OPERATIONS_ADMIN', 'ACTIVE', ['AI_OPS_CONFIGURE']))).toBe(true);
    expect(canConfigureAi(actor('PLATFORM_SUPER_ADMIN'))).toBe(true);
    expect(aiConfigureIsBreakGlass(actor('PLATFORM_SUPER_ADMIN'))).toBe(true);
    expect(aiConfigureIsBreakGlass(actor('OPERATIONS_ADMIN', 'ACTIVE', ['AI_OPS_CONFIGURE']))).toBe(false);
    // Stopping is never break-glass for a role that switches flags by baseline.
    expect(aiStopIsBreakGlass(actor('PLATFORM_SUPER_ADMIN'))).toBe(false);
    expect(aiStopIsBreakGlass(actor('SECURITY_ADMIN'))).toBe(false);
  });

  it('gives an inactive membership nothing, its grant included', () => {
    for (const state of ['PENDING', 'SUSPENDED', 'ENDED']) {
      const inactive = actor('OPERATIONS_ADMIN', state, ['AI_OPS_CONFIGURE']);
      expect(canViewAiOperations(inactive)).toBe(false);
      expect(canStopAi(inactive)).toBe(false);
      expect(canConfigureAi(inactive)).toBe(false);
    }
  });
});

describe('limits changes', () => {
  const current = { cap: 100, capWindow: 'DAY' as const, maxInputChars: 4000 };
  it('treats any decrease with no increase as lowering', () => {
    expect(classifyAiLimitsChange(current, { ...current, cap: 50 })).toBe('LOWER');
    expect(classifyAiLimitsChange(current, { ...current, maxInputChars: 1000 })).toBe('LOWER');
  });
  it('treats any increase, or a window change either way, as widening', () => {
    expect(classifyAiLimitsChange(current, { ...current, cap: 101 })).toBe('RAISE');
    expect(classifyAiLimitsChange(current, { ...current, maxInputChars: 4001 })).toBe('RAISE');
    expect(classifyAiLimitsChange(current, { ...current, cap: 50, maxInputChars: 5000 })).toBe('RAISE');
    expect(classifyAiLimitsChange(current, { ...current, capWindow: 'MONTH' })).toBe('RAISE');
    expect(classifyAiLimitsChange({ ...current, capWindow: 'MONTH' }, { ...current, capWindow: 'DAY', cap: 1 })).toBe('RAISE');
  });
  it('reports no change as unchanged', () => {
    expect(classifyAiLimitsChange(current, { ...current })).toBe('UNCHANGED');
  });
});

describe('switching a feature on', () => {
  const ready = { enabled: false, killSwitchEngaged: false, promptDeclared: true, evaluationPasses: true };
  it('is allowed only with the kill switch released, a declared prompt and a passing evaluation', () => {
    expect(refuseAiFeatureEnable(ready)).toBeNull();
    expect(refuseAiFeatureEnable({ ...ready, enabled: true })).toBe('AI_FEATURE_ALREADY_ENABLED');
    expect(refuseAiFeatureEnable({ ...ready, killSwitchEngaged: true })).toBe('AI_KILL_SWITCH_ENGAGED');
    expect(refuseAiFeatureEnable({ ...ready, promptDeclared: false })).toBe('AI_PROMPT_UNDECLARED');
    expect(refuseAiFeatureEnable({ ...ready, evaluationPasses: false })).toBe('AI_EVALUATION_REQUIRED');
  });
});

describe('evaluation metrics', () => {
  const metric = { name: 'task_accuracy', value: 0.9, threshold: 0.85, comparator: 'AT_LEAST' };
  it('accepts 1–20 well-formed metrics and a PASS that meets every threshold', () => {
    expect(readAiEvaluationMetrics([metric, { name: 'unsafe_rate', value: 0, threshold: 0.01, comparator: 'AT_MOST' }], 'PASS')).toEqual({
      metrics: [metric, { name: 'unsafe_rate', value: 0, threshold: 0.01, comparator: 'AT_MOST' }],
    });
  });
  it('refuses a PASS below any threshold, but records a FAIL whatever the numbers', () => {
    const below = { ...metric, value: 0.5 };
    expect(readAiEvaluationMetrics([below], 'PASS')).toEqual({ refusal: 'AI_EVALUATION_PASS_BELOW_THRESHOLD' });
    expect(readAiEvaluationMetrics([below], 'FAIL')).toEqual({ metrics: [below] });
    expect(readAiEvaluationMetrics([metric], 'FAIL')).toEqual({ metrics: [metric] });
  });
  it('refuses malformed metrics', () => {
    for (const bad of [
      [], 'x', [null], [[metric]], Array.from({ length: 21 }, (_, index) => ({ ...metric, name: 'm_' + index })),
      [{ ...metric, name: 'Bad' }], [{ ...metric, value: '0.9' }], [{ ...metric, threshold: Number.NaN }],
      [{ ...metric, value: Number.POSITIVE_INFINITY }], [{ ...metric, comparator: 'ABOUT' }], [{ ...metric, extra: 1 }],
      [metric, metric],
    ]) {
      expect(readAiEvaluationMetrics(bad, 'FAIL')).toEqual({ refusal: 'AI_EVALUATION_METRICS_INVALID' });
    }
  });
});

describe('approval actions', () => {
  it('adds switching on and widening as extended high-risk actions under AI_OPS_CONFIGURE', () => {
    expect(highRiskActionKeys).toEqual(expect.arrayContaining(['AI_FEATURE_ENABLE', 'AI_FEATURE_LIMITS_RAISE', 'COMMS_TEMPLATE_PUBLISH']));
    for (const key of ['AI_FEATURE_ENABLE', 'AI_FEATURE_LIMITS_RAISE'] as const) {
      expect(highRiskActions[key]).toMatchObject({ capability: 'AI_OPS_CONFIGURE', targetType: 'ai_feature_policy' });
      expect(isLegacyHighRiskActionKey(key)).toBe(false);
    }
    expect(approvalRequestReasons.AI_FEATURE_ENABLE).toEqual(aiFeatureEnableReasons);
    expect(approvalRequestReasons.AI_FEATURE_LIMITS_RAISE).toEqual(aiLimitsRaiseReasons);
    expect(refuseApprovalRequest(actor('OPERATIONS_ADMIN'), 'AI_FEATURE_ENABLE')).toBe('FORBIDDEN');
    expect(refuseApprovalRequest(actor('OPERATIONS_ADMIN', 'ACTIVE', ['AI_OPS_CONFIGURE']), 'AI_FEATURE_ENABLE')).toBeNull();
  });
});
