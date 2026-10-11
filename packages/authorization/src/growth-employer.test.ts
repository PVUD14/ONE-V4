/**
 * Employer pipeline rules (GROWTH-05): the referral-code vocabulary pinned to 0109, what counts as a
 * well-formed `ref` (everything else is ignored like an unknown code), the link carries nothing but
 * the code, the domain hosts a request matches a lead on, the §8.3 credit candidate, and what a growth
 * person is told about someone else's referral.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROWTH_REFERRAL_CODE_ALPHABET,
  GROWTH_REFERRAL_CODE_LENGTH,
  generateGrowthReferralCode,
  growthAccessRequestHosts,
  growthEmployerCandidateBasis,
  growthEmployerCandidateBases,
  growthEmployerMilestones,
  growthReferralCodePattern,
  growthReferralLimits,
  growthReferralLinkPath,
  growthReferralMembership,
  growthReferralRevokeReasons,
  growthReferralSeenBy,
  normaliseGrowthReferralRef,
  type GrowthLeadCaller,
} from './index.js';

const migration = readFileSync(new URL('../../persistence/drizzle/0109_growth_employer_pipeline.sql', import.meta.url), 'utf8');

describe('the vocabulary matches the database', () => {
  it('uses the alphabet, length, limits, revoke reasons and candidate bases 0109 enforces', () => {
    expect(migration).toContain(`^[${GROWTH_REFERRAL_CODE_ALPHABET}]{${GROWTH_REFERRAL_CODE_LENGTH}}$`);
    expect(growthReferralCodePattern.source).toBe(`^[${GROWTH_REFERRAL_CODE_ALPHABET}]{${GROWTH_REFERRAL_CODE_LENGTH}}$`);
    expect(migration).toContain(`at most ${growthReferralLimits.liveCodesPerPerson} live codes`);
    expect(migration).toContain(`>= ${growthReferralLimits.liveCodesPerPerson}`);
    expect(migration).toContain(`at most ${growthReferralLimits.createdPerDay} codes a day`);
    for (const reason of growthReferralRevokeReasons) expect(migration).toContain(`'${reason}'`);
    for (const basis of growthEmployerCandidateBases) expect(migration).toContain(`'${basis}'`);
  });

  it('has no character that reads as another', () => {
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) expect(GROWTH_REFERRAL_CODE_ALPHABET).not.toContain(ambiguous);
    expect(new Set(GROWTH_REFERRAL_CODE_ALPHABET).size).toBe(31);
  });
});

describe('referral codes', () => {
  it('generates codes from the alphabet only and refuses a bad random source', () => {
    let next = 0;
    const code = generateGrowthReferralCode((max) => (next++ * 7) % max);
    expect(code).toMatch(growthReferralCodePattern);
    expect(code).toHaveLength(10);
    expect(() => generateGrowthReferralCode(() => 31)).toThrow(RangeError);
    expect(() => generateGrowthReferralCode(() => 0.5)).toThrow(RangeError);
  });

  it('accepts a well-formed ref in any case with surrounding space, and treats everything else as malformed', () => {
    expect(normaliseGrowthReferralRef(' abcdefghjk ')).toBe('ABCDEFGHJK');
    expect(normaliseGrowthReferralRef('23456789AB')).toBe('23456789AB');
    for (const malformed of [undefined, null, 12345, {}, [], '', 'ABCDEFGHJ', 'ABCDEFGHJKM', 'ABCDEFGHJ0', 'ABCDEFGHJI', 'ABC-EFGHJK', 'A'.repeat(65), 'ABCDEFGHJé']) {
      expect(normaliseGrowthReferralRef(malformed)).toBeNull();
    }
  });

  it('builds a link that carries the public form path and the code, nothing else', () => {
    expect(growthReferralLinkPath('ABCDEFGHJK')).toBe('/employer-access?ref=ABCDEFGHJK');
  });

  it('creates a code only through an employer-team membership', () => {
    const caller = (teams: string[], role = 'GROWTH_EXECUTIVE'): GrowthLeadCaller => ({
      scope: { kind: 'PERSON', ownerMembershipIds: ['m1'], allLeadRegionIds: [], unownedLeadRegionIds: [], workingRegionIds: [] },
      memberships: [{ membershipId: 'm1', role, teams }],
    });
    expect(growthReferralMembership(caller(['EMPLOYER_PARTNERSHIPS']))).toBe('m1');
    expect(growthReferralMembership(caller(['EMPLOYER_PARTNERSHIPS'], 'GROWTH_MANAGER'))).toBe('m1');
    expect(growthReferralMembership(caller(['COLLEGE_PARTNERSHIPS']))).toBeNull();
    expect(growthReferralMembership(caller([]))).toBeNull();
  });
});

describe('matching a request to an employer lead', () => {
  it('uses the email domain and the website host, normalised like leads, once each', () => {
    expect(growthAccessRequestHosts({ emailDomain: 'acme.co.in', websiteUrl: 'https://www.Acme.co.in/careers' })).toEqual(['acme.co.in']);
    expect(growthAccessRequestHosts({ emailDomain: 'mail.acme.example', websiteUrl: 'https://acme.example' })).toEqual(['mail.acme.example', 'acme.example']);
    expect(growthAccessRequestHosts({ emailDomain: 'localhost', websiteUrl: 'https://intranet' })).toEqual([]);
  });
});

describe('the credit candidate at onboarding (design §8.3)', () => {
  it('puts the referral first, then the lead owner, flags a conflict between two people, and is house with neither', () => {
    expect(growthEmployerCandidateBasis({ referrerUserId: 'u1', leadOwnerUserId: null })).toBe('REFERRAL_LINK');
    expect(growthEmployerCandidateBasis({ referrerUserId: 'u1', leadOwnerUserId: 'u1' })).toBe('REFERRAL_LINK');
    expect(growthEmployerCandidateBasis({ referrerUserId: null, leadOwnerUserId: 'u2' })).toBe('LEAD_OWNER_AT_HANDOFF');
    expect(growthEmployerCandidateBasis({ referrerUserId: 'u1', leadOwnerUserId: 'u2' })).toBe('CONFLICT');
    expect(growthEmployerCandidateBasis({ referrerUserId: null, leadOwnerUserId: null })).toBe('HOUSE');
  });
});

describe('what a growth person is told', () => {
  it('says whether a referral was theirs, never whose it was', () => {
    expect(growthReferralSeenBy('u1', 'u1')).toBe('YOU');
    expect(growthReferralSeenBy('u1', 'u2')).toBe('ANOTHER_TEAM_MEMBER');
    expect(growthReferralSeenBy('u1', null)).toBeNull();
  });

  it('lists the employer milestones of design §7.1 in order', () => {
    expect(growthEmployerMilestones).toEqual(['ACCESS_REQUESTED', 'ONBOARDED', 'VERIFIED', 'TERMS_ACCEPTED', 'FIRST_JOB_PUBLISHED', 'CAMPUS_DRIVE', 'SUSPENDED']);
  });
});
