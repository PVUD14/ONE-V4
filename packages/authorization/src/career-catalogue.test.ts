/**
 * Job-role catalogue rules (OPS-08): who may move a requirement set, the self-review
 * refusal, reason codes, the publish action's place in dual control, and branch matching.
 * Pure functions; the 0051 trigger repeats the lifecycle and the API spec proves both agree.
 */
import { describe, expect, it } from 'vitest';
import {
  canReadCareerCatalogue,
  careerCatalogueReasons,
  careerRequirementSetTransitions,
  careerRoleMatchesBranch,
  normalizeCareerSynonym,
  refuseCareerSetTransition,
} from './career-catalogue.js';
import {
  approvalRequestReasons,
  highRiskActions,
  isLegacyHighRiskActionKey,
  legacyHighRiskActionKeys,
  refuseApprovalRequest,
} from './high-risk-actions.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });
const author = withGrants('author', ['CATALOGUE_MANAGE']);
const reviewer = withGrants('reviewer', ['CONTENT_REVIEW']);
const authorWhoReviews = withGrants('author', ['CATALOGUE_MANAGE', 'CONTENT_REVIEW']);
const plainOperations = { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };

describe('reading the catalogue', () => {
  it('needs a catalogue capability; an ACTIVE membership without one is denied, and an inactive one holds nothing', () => {
    expect(canReadCareerCatalogue(author)).toBe(true);
    expect(canReadCareerCatalogue(reviewer)).toBe(true);
    expect(canReadCareerCatalogue(withGrants('p', ['CONTENT_PUBLISH']))).toBe(true);
    expect(canReadCareerCatalogue(plainOperations)).toBe(false);
    expect(canReadCareerCatalogue(withGrants('s', ['CATALOGUE_MANAGE'], 'SUSPENDED'))).toBe(false);
    expect(canReadCareerCatalogue({ memberships: [{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['CATALOGUE_MANAGE'] }] })).toBe(false);
  });

  it('lets the super admin in only as break-glass (no baseline role holds catalogue capabilities)', () => {
    expect(canReadCareerCatalogue({ memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] })).toBe(true);
    expect(canReadCareerCatalogue({ memberships: [{ role: 'SECURITY_ADMIN', state: 'ACTIVE' }] })).toBe(false);
  });
});

describe('requirement-set transitions', () => {
  const move = (actor: typeof author, from: keyof typeof careerRequirementSetTransitions, to: keyof typeof careerRequirementSetTransitions, reasonCode: string, authorUserId = 'author') =>
    refuseCareerSetTransition({ actor, from, to, reasonCode, authorUserId });

  it('lets the author submit and a different reviewer pass the review', () => {
    expect(move(author, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'REVIEWED', 'REVIEW_PASSED')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'DRAFT', 'CHANGES_REQUESTED')).toBeNull();
  });

  it('refuses a self-review even when the author also holds CONTENT_REVIEW', () => {
    expect(move(authorWhoReviews, 'IN_REVIEW', 'REVIEWED', 'REVIEW_PASSED')).toBe('CAREER_SET_SELF_REVIEW_REFUSED');
    expect(move(authorWhoReviews, 'IN_REVIEW', 'DRAFT', 'CHANGES_REQUESTED')).toBe('CAREER_SET_SELF_REVIEW_REFUSED');
  });

  it('needs the capability the move uses', () => {
    expect(move(author, 'IN_REVIEW', 'REVIEWED', 'REVIEW_PASSED', 'someone-else')).toBe('FORBIDDEN');
    expect(move(reviewer, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW', 'someone-else')).toBe('FORBIDDEN');
    expect(move(plainOperations as typeof author, 'DRAFT', 'WITHDRAWN', 'ABANDONED')).toBe('FORBIDDEN');
  });

  it('lets only the author recall their own set, and only through a listed reason', () => {
    expect(move(author, 'IN_REVIEW', 'DRAFT', 'AUTHOR_RECALL')).toBeNull();
    expect(move(withGrants('other', ['CATALOGUE_MANAGE']), 'IN_REVIEW', 'DRAFT', 'AUTHOR_RECALL')).toBe('REASON_CODE_INVALID');
    expect(move(author, 'DRAFT', 'IN_REVIEW', 'REVIEW_PASSED')).toBe('REASON_CODE_INVALID');
  });

  it('never publishes, supersedes or leaves a terminal state as an operator transition', () => {
    expect(move(author, 'REVIEWED', 'PUBLISHED', 'REVIEW_PASSED')).toBe('CAREER_SET_TRANSITION_NOT_ALLOWED');
    expect(move(author, 'PUBLISHED', 'SUPERSEDED', 'ABANDONED')).toBe('CAREER_SET_TRANSITION_NOT_ALLOWED');
    expect(move(author, 'WITHDRAWN', 'DRAFT', 'AUTHOR_RECALL')).toBe('CAREER_SET_TRANSITION_NOT_ALLOWED');
    expect(move(author, 'DRAFT', 'REVIEWED', 'REVIEW_PASSED')).toBe('CAREER_SET_TRANSITION_NOT_ALLOWED');
  });

  it('defines every reason code in the house pattern', () => {
    const all = [
      ...careerCatalogueReasons.synonymAdd, ...careerCatalogueReasons.synonymRemove, ...careerCatalogueReasons.draftCreate,
      ...careerCatalogueReasons.itemsSave, ...Object.values(careerCatalogueReasons.transition).flat(), ...approvalRequestReasons.CAREER_REQUIREMENT_SET_PUBLISH,
    ];
    for (const code of all) expect(code).toMatch(/^[A-Z0-9_:-]{3,64}$/);
  });
});

describe('publishing is a dual-controlled high-risk action (§5.4)', () => {
  it('needs CONTENT_PUBLISH to request, and targets a requirement set', () => {
    expect(highRiskActions.CAREER_REQUIREMENT_SET_PUBLISH).toMatchObject({ capability: 'CONTENT_PUBLISH', targetType: 'career_requirement_set' });
    expect(refuseApprovalRequest(withGrants('p', ['CONTENT_PUBLISH']), 'CAREER_REQUIREMENT_SET_PUBLISH')).toBeNull();
    expect(refuseApprovalRequest(author, 'CAREER_REQUIREMENT_SET_PUBLISH')).toBe('FORBIDDEN');
    expect(refuseApprovalRequest(reviewer, 'CAREER_REQUIREMENT_SET_PUBLISH')).toBe('FORBIDDEN');
  });

  it('is stored as an extended key, because 0038 re-adds its five-key CHECK on every replay', () => {
    expect(legacyHighRiskActionKeys).toEqual(['ORGANIZATION_SUSPEND', 'FEATURE_FLAG_HIGH_RISK_CHANGE', 'OUTBOX_BACKLOG_SUPERSEDE', 'PRIVACY_HOLD_RELEASE', 'CAPABILITY_GRANT_HIGH_RISK']);
    expect(isLegacyHighRiskActionKey('CAREER_REQUIREMENT_SET_PUBLISH')).toBe(false);
    expect(isLegacyHighRiskActionKey('PRIVACY_HOLD_RELEASE')).toBe(true);
  });
});

describe('search helpers', () => {
  it('normalises synonyms the way the 0051 CHECK expects', () => {
    expect(normalizeCareerSynonym('  Core   Job in MECH ')).toBe('core job in mech');
  });

  it('matches a branch exactly or through "All branches" / "Any"', () => {
    expect(careerRoleMatchesBranch(['CSE', 'IT', 'ECE'], 'ece')).toBe(true);
    expect(careerRoleMatchesBranch(['CSE', 'IT'], 'Civil')).toBe(false);
    expect(careerRoleMatchesBranch(['All branches'], 'Civil')).toBe(true);
    expect(careerRoleMatchesBranch(['CSE', 'IT', 'any'], 'Chemical')).toBe(true);
  });
});
