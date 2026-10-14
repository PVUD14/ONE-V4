/**
 * Employer team management and interviewer invitations (EMP-02, defect D-2).
 *
 * Before EMP-02 no route exposed employer team invitations, so an employer's owner could
 * not add an admin, a recruiter or an interviewer through the product. These tests pin the
 * acceptance criteria: who may invite whom (canAssignRole), acceptance through the one
 * invitation path creating the right membership and scope, revoke / resend / end with
 * audit, the last-owner rule, organisation state (Appendix 2 §5.1), validation and the
 * honest delivery states (HG-7: no sink means NOT_CONFIGURED, never a fake "sent").
 *
 * Runs over real HTTP with a stub verifier and the real identity store, so memberships are
 * read per request exactly as production does. Needs a local Postgres in DATABASE_URL; runs
 * in a throwaway schema.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import type { InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for employer team tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Employer team tests require local Postgres');
const schemaName = 'employer_team_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

/** Bearer token → identity. The token is the external subject; email is verified. */
const identities = new Map<string, { readonly email: string }>();
const sent: { toEmail: string; subject: string; textBody: string; invitationId: string }[] = [];
let failNextSend = false;
// Stands in for the real TLS sender, so the ledger must record SMTP rather than MAILPIT (ADR-042).
const sink: InvitationMailSink = {
  providerKind: 'SMTP',
  async send(input) {
    if (failNextSend) { failNextSend = false; throw new Error('local sink unavailable'); }
    sent.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody, invitationId: input.invitationId });
    return { providerReference: 'test:' + input.invitationId };
  },
};
let app: INestApplication;
let appWithoutSink: INestApplication;
let opsUserId: string;

async function buildApp(invitationMailSink: InvitationMailSink | undefined): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      ...(invitationMailSink ? { invitationMailSink } : {}),
      verifier: { async verifyAccessToken(token: string) {
        const identity = identities.get(token);
        if (!identity) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [], email: identity.email, emailVerified: true };
      } },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  const built = module.createNestApplication();
  built.useLogger(false);
  await built.init();
  return built;
}

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  app = await buildApp(sink);
  appWithoutSink = await buildApp(undefined);
  const platformId = await organization('PLATFORM', 'VERIFIED');
  opsUserId = await user();
  await membership(opsUserId, platformId, 'OPERATIONS_ADMIN');
}, 60_000);
beforeEach(() => { sent.length = 0; failNextSend = false; });
afterAll(async () => {
  await app?.close(); await appWithoutSink?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function user(email = randomUUID() + '@example.test'): Promise<string> {
  const id = randomUUID();
  identities.set(id, { email });
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email]);
  return id;
}
/** An identity that has never signed in: acceptance creates its user row. */
function newcomer(email: string): string {
  const subject = 'sub-' + randomUUID();
  identities.set(subject, { email });
  return subject;
}
async function organization(kind: 'PLATFORM' | 'EMPLOYER', verification: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED', active = true): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,$2,$3,$4,$5)',
    [id, kind, 'Team ' + kind.toLowerCase(), verification, active]);
  return id;
}
async function membership(userId: string, orgId: string, role: string, state = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  const employerScope = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(role) ? orgId : null;
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$6)`, [id, orgId, userId, role, state, employerScope]);
  return id;
}
const api = (target: INestApplication = app) => request(target.getHttpServer());
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': randomUUID() });
const teamPath = (employerId: string) => '/api/v1/employers/' + employerId + '/team';
const invitePath = (employerId: string) => '/api/v1/employers/' + employerId + '/team-invitations';

async function employerWithOwner(verification: Parameters<typeof organization>[1] = 'VERIFIED', active = true) {
  const employerId = await organization('EMPLOYER', verification, active);
  const ownerId = await user();
  const ownerMembershipId = await membership(ownerId, employerId, 'EMPLOYER_OWNER');
  return { employerId, ownerId, ownerMembershipId };
}
function tokenFromLastEmail(toEmail: string): string {
  const message = [...sent].reverse().find((item) => item.toEmail === toEmail);
  const link = message?.textBody.match(/https?:\/\/\S+/)?.[0] ?? '';
  return new URL(link).searchParams.get('token') ?? '';
}
async function accept(subject: string, token: string, expected = 201): Promise<void> {
  await api().post('/api/v1/invitations/accept').set(auth(subject)).set('Idempotency-Key', 'accept-' + randomUUID())
    .send({ token }).expect(expected);
}
async function audits(action: string, resourceId: string) {
  return (await pool.query('SELECT actor_user_id, organization_id, context FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows;
}

describe('EMP-02 who may invite whom (canAssignRole)', () => {
  it('lets an owner invite an admin and a recruiter, but not another owner', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const admin = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'New.Admin@Example.test', role: 'EMPLOYER_ADMIN' }).expect(201);
    expect(admin.body.invitation).toMatchObject({ email: 'new.admin@example.test', role: 'EMPLOYER_ADMIN', state: 'PENDING', delivery: { state: 'SENT' } });
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'new.recruiter@example.test', role: 'RECRUITER' }).expect(201);
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'second.owner@example.test', role: 'EMPLOYER_OWNER' }).expect(403);
    const stored = await pool.query("SELECT kind, role, scope_organization_id, scope_employer_id, scope_institution_id FROM invitations WHERE organization_id=$1 ORDER BY role", [employerId]);
    expect(stored.rows).toEqual([
      { kind: 'STAFF', role: 'EMPLOYER_ADMIN', scope_organization_id: employerId, scope_employer_id: employerId, scope_institution_id: null },
      { kind: 'STAFF', role: 'RECRUITER', scope_organization_id: employerId, scope_employer_id: employerId, scope_institution_id: null },
    ]);
  });

  it('lets an admin invite a recruiter only', async () => {
    const { employerId } = await employerWithOwner();
    const adminId = await user();
    await membership(adminId, employerId, 'EMPLOYER_ADMIN');
    await api().post(invitePath(employerId)).set(auth(adminId)).send({ email: 'admin.recruiter@example.test', role: 'RECRUITER' }).expect(201);
    await api().post(invitePath(employerId)).set(auth(adminId)).send({ email: 'admin.admin@example.test', role: 'EMPLOYER_ADMIN' }).expect(403);
    await api().post(invitePath(employerId)).set(auth(adminId)).send({ email: 'admin.owner@example.test', role: 'EMPLOYER_OWNER' }).expect(403);
    const team = await api().get(teamPath(employerId)).set(auth(adminId)).expect(200);
    expect(team.body.team).toMatchObject({ actorRole: 'EMPLOYER_ADMIN', invitableRoles: ['RECRUITER'] });
  });

  it('refuses a recruiter every team route', async () => {
    const { employerId, ownerMembershipId } = await employerWithOwner();
    const recruiterId = await user();
    await membership(recruiterId, employerId, 'RECRUITER');
    const invitationId = randomUUID();
    await api().get(teamPath(employerId)).set(auth(recruiterId)).expect(403);
    await api().post(invitePath(employerId)).set(auth(recruiterId)).send({ email: 'x@example.test', role: 'RECRUITER' }).expect(403);
    await api().post(invitePath(employerId) + '/' + invitationId + '/revoke').set(auth(recruiterId)).send({ reasonCode: 'SENT_IN_ERROR' }).expect(403);
    await api().post(invitePath(employerId) + '/' + invitationId + '/resend').set(auth(recruiterId)).send({ reasonCode: 'NOT_RECEIVED' }).expect(403);
    await api().post(teamPath(employerId) + '/' + ownerMembershipId + '/end').set(auth(recruiterId)).send({ reasonCode: 'LEFT_ORGANISATION' }).expect(403);
    expect(sent).toHaveLength(0);
  });

  it('refuses another employer, an ended membership and a suspended membership', async () => {
    const { employerId } = await employerWithOwner();
    const other = await employerWithOwner();
    const endedOwner = await user();
    await membership(endedOwner, employerId, 'EMPLOYER_OWNER', 'ENDED');
    const suspendedOwner = await user();
    await membership(suspendedOwner, employerId, 'EMPLOYER_OWNER', 'SUSPENDED');
    for (const actor of [other.ownerId, endedOwner, suspendedOwner]) {
      await api().get(teamPath(employerId)).set(auth(actor)).expect(403);
      await api().post(invitePath(employerId)).set(auth(actor)).send({ email: 'y@example.test', role: 'RECRUITER' }).expect(403);
    }
  });

  it('answers 401 without a token on every team route', async () => {
    const employerId = randomUUID(); const id = randomUUID();
    await api().get(teamPath(employerId)).expect(401);
    await api().post(invitePath(employerId)).send({ email: 'z@example.test', role: 'RECRUITER' }).expect(401);
    await api().post(invitePath(employerId) + '/' + id + '/revoke').send({ reasonCode: 'SENT_IN_ERROR' }).expect(401);
    await api().post(invitePath(employerId) + '/' + id + '/resend').send({ reasonCode: 'NOT_RECEIVED' }).expect(401);
    await api().post(teamPath(employerId) + '/' + id + '/end').send({ reasonCode: 'LEFT_ORGANISATION' }).expect(401);
  });
});

describe('EMP-02 acceptance creates the right membership and scope', () => {
  it('turns an accepted recruiter invitation into an ACTIVE employer-scoped RECRUITER who can work and be an interviewer', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'interviewer@example.test', role: 'RECRUITER' }).expect(201);
    expect(sent.at(-1)).toMatchObject({ toEmail: 'interviewer@example.test', subject: 'ONE employer team invitation' });
    expect(sent.at(-1)!.textBody).toContain('as a recruiter');
    const subject = newcomer('interviewer@example.test');
    await accept(subject, tokenFromLastEmail('interviewer@example.test'));

    const invitee = await pool.query('SELECT id FROM users WHERE external_subject=$1', [subject]);
    const inviteeId = invitee.rows[0].id as string;
    const rows = await pool.query('SELECT role, state, scope_organization_id, scope_employer_id, scope_institution_id FROM organization_memberships WHERE user_id=$1', [inviteeId]);
    expect(rows.rows).toEqual([{ role: 'RECRUITER', state: 'ACTIVE', scope_organization_id: employerId, scope_employer_id: employerId, scope_institution_id: null }]);
    expect((await pool.query('SELECT state FROM invitations WHERE id=$1', [invite.body.invitation.id])).rows[0].state).toBe('ACCEPTED');

    // Works as a recruiter at once, and (decision 10.2 #2) can be put on an interview panel.
    await api().get('/api/v1/employers/' + employerId + '/opportunities').set(auth(subject)).expect(200);
    const options = await api().get('/api/v1/employers/' + employerId + '/interview-participant-options').set(auth(ownerId)).expect(200);
    expect(options.body.participants.map((item: { label: string }) => item.label)).toContain('interviewer@example.test');

    const team = await api().get(teamPath(employerId)).set(auth(ownerId)).expect(200);
    expect(team.body.team.members).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'interviewer@example.test', role: 'RECRUITER', state: 'ACTIVE', canEnd: true })]));
    expect(team.body.team.invitations).toEqual([]);
  });

  it('turns an accepted admin invitation into an ACTIVE EMPLOYER_ADMIN who can then invite recruiters', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'the.admin@example.test', role: 'EMPLOYER_ADMIN' }).expect(201);
    expect(sent.at(-1)!.textBody).toContain('as an admin');
    const subject = newcomer('the.admin@example.test');
    await accept(subject, tokenFromLastEmail('the.admin@example.test'));
    const context = await api().get('/api/v1/security/context').set(auth(subject)).expect(200);
    expect(context.body.memberships).toEqual([expect.objectContaining({ organizationId: employerId, role: 'EMPLOYER_ADMIN' })]);
    await api().post(invitePath(employerId)).set(auth(subject)).send({ email: 'via.admin@example.test', role: 'RECRUITER' }).expect(201);
  });

  it('refuses acceptance by an identity whose verified email is not the invited one', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'right.person@example.test', role: 'RECRUITER' }).expect(201);
    await accept(newcomer('wrong.person@example.test'), tokenFromLastEmail('right.person@example.test'), 403);
  });
});

describe('EMP-02 revoke, resend and end are audited', () => {
  it('audits the invitation and records its delivery', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'audited@example.test', role: 'RECRUITER' }).expect(201);
    const id = invite.body.invitation.id as string;
    expect(await audits('identity.invitation.created', id)).toEqual([{ actor_user_id: ownerId, organization_id: employerId, context: { role: 'RECRUITER', source: 'EMPLOYER_TEAM' } }]);
    const events = await pool.query('SELECT event_type FROM outbox_events WHERE organization_id=$1 ORDER BY event_type', [employerId]);
    expect(events.rows.map((row) => row.event_type)).toEqual(['identity.invitation.created', 'notification.delivery.requested']);
    const invitation = await pool.query('SELECT delivery_state, send_count, last_sent_at FROM invitations WHERE id=$1', [id]);
    expect(invitation.rows[0]).toMatchObject({ delivery_state: 'SENT', send_count: 1 });
    const command = await pool.query("SELECT c.state, a.outcome, a.provider_kind FROM notification_commands c JOIN notification_delivery_attempts a ON a.command_id=c.id WHERE c.destination_ref=$1", ['invitation:' + id]);
    expect(command.rows).toEqual([{ state: 'DELIVERED', outcome: 'SUCCEEDED', provider_kind: 'SMTP' }]);
  });

  it('revokes a pending invitation so it can no longer be accepted, once, and audits why', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'revoked@example.test', role: 'RECRUITER' }).expect(201);
    const id = invite.body.invitation.id as string;
    const token = tokenFromLastEmail('revoked@example.test');
    await api().post(invitePath(employerId) + '/' + id + '/revoke').set(auth(ownerId)).send({ reasonCode: 'WRONG_EMAIL' }).expect(201);
    expect((await pool.query('SELECT state, reason_code, revoked_at IS NOT NULL AS revoked FROM invitations WHERE id=$1', [id])).rows[0]).toEqual({ state: 'REVOKED', reason_code: 'WRONG_EMAIL', revoked: true });
    expect(await audits('identity.invitation.revoked', id)).toEqual([{ actor_user_id: ownerId, organization_id: employerId, context: { role: 'RECRUITER', reasonCode: 'WRONG_EMAIL', source: 'EMPLOYER_TEAM' } }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='identity.invitation.revoked' AND aggregate_id=$1", [id])).rows[0].n).toBe(1);
    await accept(newcomer('revoked@example.test'), token, 403);
    const again = await api().post(invitePath(employerId) + '/' + id + '/revoke').set(auth(ownerId)).send({ reasonCode: 'WRONG_EMAIL' }).expect(409);
    expect(again.body.error.code).toBe('TEAM_INVITATION_NOT_PENDING');
  });

  it('does not let an admin revoke or resend an admin invitation', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const adminId = await user();
    await membership(adminId, employerId, 'EMPLOYER_ADMIN');
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'peer.admin@example.test', role: 'EMPLOYER_ADMIN' }).expect(201);
    const id = invite.body.invitation.id as string;
    await api().post(invitePath(employerId) + '/' + id + '/revoke').set(auth(adminId)).send({ reasonCode: 'SENT_IN_ERROR' }).expect(403);
    await api().post(invitePath(employerId) + '/' + id + '/resend').set(auth(adminId)).send({ reasonCode: 'NOT_RECEIVED' }).expect(403);
    const team = await api().get(teamPath(employerId)).set(auth(adminId)).expect(200);
    expect(team.body.team.invitations).toEqual([expect.objectContaining({ id, canRevoke: false, canResend: false })]);
  });

  it('resends with a new link: the old link stops working, the new one accepts, and it is audited', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'resent@example.test', role: 'RECRUITER' }).expect(201);
    const id = invite.body.invitation.id as string;
    const firstToken = tokenFromLastEmail('resent@example.test');
    // Age the invitation past expiry: a resend must bring it back to a full 14 days.
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id=$1", [id]);
    const before = await api().get(teamPath(employerId)).set(auth(ownerId)).expect(200);
    expect(before.body.team.invitations).toEqual([expect.objectContaining({ id, state: 'EXPIRED' })]);
    const resent = await api().post(invitePath(employerId) + '/' + id + '/resend').set(auth(ownerId)).send({ reasonCode: 'LINK_EXPIRED' }).expect(201);
    expect(resent.body.invitation).toMatchObject({ id, state: 'PENDING', delivery: { state: 'SENT' } });
    const secondToken = tokenFromLastEmail('resent@example.test');
    expect(secondToken).not.toBe(firstToken);
    const row = await pool.query("SELECT send_count, expires_at > now() + interval '13 days' AS renewed FROM invitations WHERE id=$1", [id]);
    expect(row.rows[0]).toEqual({ send_count: 2, renewed: true });
    expect(await audits('identity.invitation.resent', id)).toEqual([{ actor_user_id: ownerId, organization_id: employerId, context: { role: 'RECRUITER', reasonCode: 'LINK_EXPIRED', source: 'EMPLOYER_TEAM' } }]);
    const subject = newcomer('resent@example.test');
    await accept(subject, firstToken, 403);
    await accept(subject, secondToken);
  });

  it('ends a membership: access stops on the next request, past actions stay in audit, and the end is audited', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const recruiterId = await user('leaving.recruiter@example.test');
    const recruiterMembership = await membership(recruiterId, employerId, 'RECRUITER');
    await api().post('/api/v1/employers/' + employerId + '/opportunities').set(auth(recruiterId)).send({
      referenceCode: randomUUID(), title: 'Before leaving', summary: 'A role drafted before the recruiter left.',
      employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false,
    }).expect(201);
    const pastActions = (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE actor_user_id=$1', [recruiterId])).rows[0].n as number;
    expect(pastActions).toBeGreaterThan(0);

    await api().post(teamPath(employerId) + '/' + recruiterMembership + '/end').set(auth(ownerId)).send({ reasonCode: 'LEFT_ORGANISATION' }).expect(201);
    await api().get('/api/v1/employers/' + employerId + '/opportunities').set(auth(recruiterId)).expect(403);
    expect((await pool.query('SELECT state FROM organization_memberships WHERE id=$1', [recruiterMembership])).rows[0].state).toBe('ENDED');
    expect((await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE actor_user_id=$1', [recruiterId])).rows[0].n).toBe(pastActions);
    expect(await audits('organization_membership.ended', recruiterMembership)).toEqual([{ actor_user_id: ownerId, organization_id: employerId,
      context: { role: 'RECRUITER', reasonCode: 'LEFT_ORGANISATION', endedUserId: recruiterId, self: false } }]);
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='organization_membership.ended' AND aggregate_id=$1", [recruiterMembership])).rows)
      .toEqual([{ payload: { membershipId: recruiterMembership, role: 'RECRUITER' } }]);
    const options = await api().get('/api/v1/employers/' + employerId + '/interview-participant-options').set(auth(ownerId)).expect(200);
    expect(options.body.participants.map((item: { label: string }) => item.label)).not.toContain('leaving.recruiter@example.test');
    const again = await api().post(teamPath(employerId) + '/' + recruiterMembership + '/end').set(auth(ownerId)).send({ reasonCode: 'LEFT_ORGANISATION' }).expect(409);
    expect(again.body.error.code).toBe('TEAM_MEMBER_NOT_ACTIVE');
    // The same address can be invited again once the membership has ended.
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'leaving.recruiter@example.test', role: 'RECRUITER' }).expect(201);
  });

  it('does not let an admin end an admin or an owner', async () => {
    const { employerId, ownerMembershipId } = await employerWithOwner();
    const adminId = await user();
    await membership(adminId, employerId, 'EMPLOYER_ADMIN');
    const otherAdmin = await membership(await user(), employerId, 'EMPLOYER_ADMIN');
    await api().post(teamPath(employerId) + '/' + otherAdmin + '/end').set(auth(adminId)).send({ reasonCode: 'ROLE_CHANGE' }).expect(403);
    await api().post(teamPath(employerId) + '/' + ownerMembershipId + '/end').set(auth(adminId)).send({ reasonCode: 'ROLE_CHANGE' }).expect(403);
  });
});

describe('EMP-02 the last active owner cannot be removed', () => {
  it('refuses to end the only owner, including by themselves', async () => {
    const { employerId, ownerId, ownerMembershipId } = await employerWithOwner();
    const refused = await api().post(teamPath(employerId) + '/' + ownerMembershipId + '/end').set(auth(ownerId)).send({ reasonCode: 'LEFT_ORGANISATION' }).expect(409);
    expect(refused.body.error.code).toBe('TEAM_LAST_OWNER');
    expect((await pool.query('SELECT state FROM organization_memberships WHERE id=$1', [ownerMembershipId])).rows[0].state).toBe('ACTIVE');
    const team = await api().get(teamPath(employerId)).set(auth(ownerId)).expect(200);
    expect(team.body.team.members).toEqual([expect.objectContaining({ membershipId: ownerMembershipId, isSelf: true, canEnd: false })]);
  });

  it('lets one of two owners end the other, then keeps the remaining owner', async () => {
    const { employerId, ownerId, ownerMembershipId } = await employerWithOwner();
    const secondOwnerId = await user();
    const secondOwnerMembership = await membership(secondOwnerId, employerId, 'EMPLOYER_OWNER');
    await api().post(teamPath(employerId) + '/' + secondOwnerMembership + '/end').set(auth(ownerId)).send({ reasonCode: 'ACCESS_NO_LONGER_NEEDED' }).expect(201);
    await api().post(teamPath(employerId) + '/' + ownerMembershipId + '/end').set(auth(ownerId)).send({ reasonCode: 'LEFT_ORGANISATION' }).expect(409);
  });

  it('never lets two owners end each other at the same time and leave nobody', async () => {
    const { employerId, ownerId, ownerMembershipId } = await employerWithOwner();
    const secondOwnerId = await user();
    const secondOwnerMembership = await membership(secondOwnerId, employerId, 'EMPLOYER_OWNER');
    const results = await Promise.all([
      api().post(teamPath(employerId) + '/' + secondOwnerMembership + '/end').set(auth(ownerId)).send({ reasonCode: 'ROLE_CHANGE' }),
      api().post(teamPath(employerId) + '/' + ownerMembershipId + '/end').set(auth(secondOwnerId)).send({ reasonCode: 'ROLE_CHANGE' }),
    ]);
    // One wins. The other is refused either because it now ends the last owner (409) or,
    // when the winner committed first, because its own membership has already ended (403).
    const statuses = results.map((result) => result.status).sort();
    expect(statuses[0]).toBe(201);
    expect([403, 409]).toContain(statuses[1]);
    expect((await pool.query("SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id=$1 AND role='EMPLOYER_OWNER' AND state='ACTIVE'", [employerId])).rows[0].n).toBe(1);
  });
});

describe('EMP-02 organisation state (Appendix 2 §5.1, organisation.manage)', () => {
  it.each(['SUSPENDED', 'REJECTED'] as const)('refuses a %s employer every team route, so it cannot invite anyone', async (state) => {
    const { employerId, ownerId, ownerMembershipId } = await employerWithOwner('VERIFIED');
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: state.toLowerCase() + '.pending@example.test', role: 'RECRUITER' }).expect(201);
    const id = invite.body.invitation.id as string;
    sent.length = 0;
    await pool.query('UPDATE organizations SET verification_state=$2, active=$3 WHERE id=$1', [employerId, state, state === 'REJECTED']);
    const responses = [
      await api().get(teamPath(employerId)).set(auth(ownerId)),
      await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'blocked@example.test', role: 'RECRUITER' }),
      await api().post(invitePath(employerId) + '/' + id + '/resend').set(auth(ownerId)).send({ reasonCode: 'NOT_RECEIVED' }),
      await api().post(invitePath(employerId) + '/' + id + '/revoke').set(auth(ownerId)).send({ reasonCode: 'SENT_IN_ERROR' }),
      await api().post(teamPath(employerId) + '/' + ownerMembershipId + '/end').set(auth(ownerId)).send({ reasonCode: 'LEFT_ORGANISATION' }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    }
    expect(sent).toHaveLength(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM invitations WHERE organization_id=$1", [employerId])).rows[0].n).toBe(1);
  });

  it.each(['PENDING', 'UNDER_REVIEW'] as const)('lets a %s employer set up its team before verification', async (state) => {
    const { employerId, ownerId } = await employerWithOwner(state);
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: state.toLowerCase() + '.early@example.test', role: 'RECRUITER' }).expect(201);
    await api().get(teamPath(employerId)).set(auth(ownerId)).expect(200);
  });
});

describe('EMP-02 validation, duplicates, pagination and delivery honesty', () => {
  it('rejects malformed input with 400 before touching anything', async () => {
    const { employerId, ownerId, ownerMembershipId } = await employerWithOwner();
    const cases: [string, string, unknown, string][] = [
      ['post', invitePath(employerId), { email: 'a@example.test', role: 'RECRUITER', extra: true }, 'INVALID_REQUEST'],
      ['post', invitePath(employerId), { email: 'not-an-email', role: 'RECRUITER' }, 'TEAM_EMAIL_INVALID'],
      ['post', invitePath(employerId), { email: 'a@example.test', role: 'PLATFORM_SUPER_ADMIN' }, 'TEAM_ROLE_INVALID'],
      ['post', invitePath(employerId), { email: 'a@example.test', role: 'INTERVIEWER' }, 'TEAM_ROLE_INVALID'],
      ['post', invitePath(employerId) + '/' + randomUUID() + '/revoke', { reasonCode: 'BECAUSE' }, 'REASON_CODE_INVALID'],
      ['post', invitePath(employerId) + '/not-a-uuid/resend', { reasonCode: 'NOT_RECEIVED' }, 'INVALID_REQUEST'],
      ['post', teamPath(employerId) + '/' + ownerMembershipId + '/end', {}, 'REASON_CODE_INVALID'],
    ];
    for (const [, path, body, code] of cases) {
      const response = await api().post(path).set(auth(ownerId)).send(body as object).expect(400);
      expect(response.body.error.code).toBe(code);
    }
    for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?cursor=nope', '?unknown=1']) {
      await api().get(teamPath(employerId) + query).set(auth(ownerId)).expect(400);
    }
    await api().post(invitePath(employerId) + '/' + randomUUID() + '/revoke').set(auth(ownerId)).send({ reasonCode: 'SENT_IN_ERROR' }).expect(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM invitations WHERE organization_id=$1', [employerId])).rows[0].n).toBe(0);
  });

  it('refuses to invite a current member or a second pending invitation, and replaces an expired one', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    await membership(await user('already.here@example.test'), employerId, 'RECRUITER');
    const member = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'Already.Here@example.test', role: 'EMPLOYER_ADMIN' }).expect(409);
    expect(member.body.error.code).toBe('TEAM_MEMBER_ALREADY_EXISTS');
    const self = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: (await pool.query('SELECT email FROM users WHERE id=$1', [ownerId])).rows[0].email, role: 'RECRUITER' }).expect(409);
    expect(self.body.error.code).toBe('TEAM_MEMBER_ALREADY_EXISTS');
    const first = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'twice@example.test', role: 'RECRUITER' }).expect(201);
    const second = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'twice@example.test', role: 'RECRUITER' }).expect(409);
    expect(second.body.error.code).toBe('TEAM_INVITATION_ALREADY_PENDING');
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id=$1", [first.body.invitation.id]);
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'twice@example.test', role: 'RECRUITER' }).expect(201);
    expect((await pool.query('SELECT state FROM invitations WHERE id=$1', [first.body.invitation.id])).rows[0].state).toBe('EXPIRED');
  });

  it('pages members with a keyset cursor', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    for (let index = 0; index < 3; index += 1) await membership(await user(), employerId, 'RECRUITER');
    const first = await api().get(teamPath(employerId) + '?limit=2').set(auth(ownerId)).expect(200);
    expect(first.body.team.members).toHaveLength(2);
    expect(first.body.team.nextCursor).toEqual(expect.any(String));
    const second = await api().get(teamPath(employerId) + '?limit=2&cursor=' + first.body.team.nextCursor).set(auth(ownerId)).expect(200);
    expect(second.body.team.members).toHaveLength(2);
    expect(second.body.team.nextCursor).toBeNull();
    const ids = [...first.body.team.members, ...second.body.team.members].map((item: { membershipId: string }) => item.membershipId);
    expect(new Set(ids).size).toBe(4);
  });

  it('records NOT_CONFIGURED when no mail sink exists (HG-7) and never claims a send', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    const invite = await api(appWithoutSink).post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'unsent@example.test', role: 'RECRUITER' }).expect(201);
    expect(invite.body.invitation.delivery).toEqual({ state: 'NOT_CONFIGURED' });
    expect(sent).toHaveLength(0);
    expect((await pool.query('SELECT delivery_state, send_count FROM invitations WHERE id=$1', [invite.body.invitation.id])).rows[0]).toEqual({ delivery_state: 'NOT_CONFIGURED', send_count: 0 });
    const team = await api(appWithoutSink).get(teamPath(employerId)).set(auth(ownerId)).expect(200);
    expect(team.body.team.deliveryConfigured).toBe(false);
    expect(team.body.team.invitations[0].delivery).toMatchObject({ state: 'NOT_CONFIGURED', sendCount: 0, lastSentAt: null });
  });

  it('keeps the invitation and records FAILED when the sink cannot send', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    failNextSend = true;
    const invite = await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'failed.send@example.test', role: 'RECRUITER' }).expect(201);
    expect(invite.body.invitation.delivery).toEqual({ state: 'FAILED' });
    expect((await pool.query('SELECT state, delivery_state FROM invitations WHERE id=$1', [invite.body.invitation.id])).rows[0]).toEqual({ state: 'PENDING', delivery_state: 'FAILED' });
    const resent = await api().post(invitePath(employerId) + '/' + invite.body.invitation.id + '/resend').set(auth(ownerId)).send({ reasonCode: 'NOT_RECEIVED' }).expect(201);
    expect(resent.body.invitation.delivery).toEqual({ state: 'SENT' });
  });

  it('carries no readiness, score or internal error text in any team response', async () => {
    const { employerId, ownerId } = await employerWithOwner();
    await api().post(invitePath(employerId)).set(auth(ownerId)).send({ email: 'contract@example.test', role: 'RECRUITER' }).expect(201);
    const team = await api().get(teamPath(employerId)).set(auth(ownerId)).expect(200);
    expect(JSON.stringify(team.body)).not.toMatch(/readiness|band|score|mastery|token_hash|stack/i);
  });
});
