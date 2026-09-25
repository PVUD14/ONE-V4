/**
 * Which students an institution staff member may see.
 *
 * One definition, used by every institution read that returns student-level data, so a
 * department head cannot see another department through an endpoint that forgot the
 * rule. This is the pure form, tested against unit trees; packages/persistence turns
 * its result into a SQL predicate.
 *
 * Owners and admins see the whole institution. A placement admin, department head or
 * faculty member sees the units their membership is scoped to, including every unit
 * below them (a department's programmes, batches and sections). A membership with no
 * unit scope stays institution-wide: that is how staff actions have always treated it,
 * and failing closed would empty every existing department-head workspace.
 *
 * Faculty (INST-03): once an institution records teaching assignments, a faculty
 * membership carries `teachingUnitIds` — the sections and batches of its active
 * assignments — and its scope is exactly those units and everything below them. An
 * empty list is no students; the membership's own department and batch no longer widen
 * it. Until the institution records its first assignment the field is absent and faculty
 * keep the membership scope above. See docs/architecture/faculty-teaching-assignments-table-design.md.
 */

export const institutionWideStaffRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'] as const;
export const institutionUnitScopedStaffRoles = ['PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'] as const;

export interface InstitutionUnitNode {
  readonly id: string;
  readonly parentUnitId: string | null;
}

export interface InstitutionStaffScopeMembership {
  readonly role: string;
  readonly departmentUnitId?: string | null;
  readonly batchUnitId?: string | null;
  /** The membership row, so persistence can look up its teaching assignments. */
  readonly membershipId?: string | null;
  /**
   * FACULTY_LECTURER only: the units of the membership's active teaching assignments.
   * Absent (undefined or null) while the institution has none recorded at all.
   */
  readonly teachingUnitIds?: readonly string[] | null;
}

/**
 * INSTITUTION: every student. NONE: no student (no qualifying membership).
 * UNITS: a student is visible when, for at least one clause, every anchor in that clause
 * covers one of the student's units. Each anchor lists the unit ids it covers: itself and
 * all its descendants. One clause per membership, so holding two scoped roles is the
 * union of both.
 */
export type InstitutionStudentScope =
  | { readonly kind: 'INSTITUTION' }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'UNITS'; readonly clauses: readonly (readonly (readonly string[])[])[] };

export interface InstitutionStudentUnits {
  readonly departmentUnitId?: string | null;
  readonly programUnitId?: string | null;
  readonly batchUnitId?: string | null;
  readonly sectionUnitId?: string | null;
}

/** The unit itself and every unit below it. Cycle-safe; an unknown id covers only itself. */
export function institutionUnitDescendants(unitId: string, units: readonly InstitutionUnitNode[]): readonly string[] {
  const children = new Map<string, string[]>();
  for (const unit of units) {
    if (!unit.parentUnitId) continue;
    const siblings = children.get(unit.parentUnitId) ?? [];
    siblings.push(unit.id);
    children.set(unit.parentUnitId, siblings);
  }
  const covered = new Set<string>([unitId]);
  const queue = [unitId];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as string) ?? []) {
      if (covered.has(child)) continue;
      covered.add(child);
      queue.push(child);
    }
  }
  return [...covered].sort();
}

export function institutionStudentScope(
  memberships: readonly InstitutionStaffScopeMembership[],
  units: readonly InstitutionUnitNode[],
): InstitutionStudentScope {
  const clauses: (readonly string[])[][] = [];
  for (const membership of memberships) {
    if ((institutionWideStaffRoles as readonly string[]).includes(membership.role)) return { kind: 'INSTITUTION' };
    if (!(institutionUnitScopedStaffRoles as readonly string[]).includes(membership.role)) continue;
    if (teachesByAssignment(membership)) {
      // One clause per assigned unit: a student in any of them is visible.
      for (const unit of new Set(membership.teachingUnitIds)) clauses.push([institutionUnitDescendants(unit, units)]);
      continue;
    }
    const anchors = institutionScopeAnchors(membership);
    if (anchors.length === 0) return { kind: 'INSTITUTION' };
    clauses.push(anchors.map((anchor) => institutionUnitDescendants(anchor, units)));
  }
  return clauses.length === 0 ? { kind: 'NONE' } : { kind: 'UNITS', clauses };
}

function teachesByAssignment(membership: InstitutionStaffScopeMembership): membership is InstitutionStaffScopeMembership & { readonly teachingUnitIds: readonly string[] } {
  return membership.role === 'FACULTY_LECTURER' && Array.isArray(membership.teachingUnitIds);
}

/**
 * The units a membership's scope is anchored on, for naming it on a screen: a faculty
 * member's assigned units once assignments are in use, otherwise the membership's
 * department and batch. Empty for an unscoped membership.
 */
export function institutionScopeAnchors(membership: InstitutionStaffScopeMembership): readonly string[] {
  if (teachesByAssignment(membership)) return [...new Set(membership.teachingUnitIds)];
  return [membership.departmentUnitId, membership.batchUnitId].filter((id): id is string => Boolean(id));
}

/** True when `unitId` is `anchorId` or below it — the rule for department-scoped writes. */
export function isUnitWithin(unitId: string, anchorId: string, units: readonly InstitutionUnitNode[]): boolean {
  return institutionUnitDescendants(anchorId, units).includes(unitId);
}

export function isStudentInInstitutionScope(scope: InstitutionStudentScope, student: InstitutionStudentUnits): boolean {
  if (scope.kind === 'INSTITUTION') return true;
  if (scope.kind === 'NONE') return false;
  const studentUnits = [student.departmentUnitId, student.programUnitId, student.batchUnitId, student.sectionUnitId]
    .filter((id): id is string => Boolean(id));
  return scope.clauses.some((anchors) => anchors.every((covered) => studentUnits.some((unit) => covered.includes(unit))));
}

/**
 * Announcement senders (INST-06, decision 10.2 #8): owners, admins and placement admins
 * institution-wide (a placement admin narrowed by their membership's unit scope, as for
 * reads); department heads their department; faculty their sections.
 */
export const institutionAnnouncementSenderRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'] as const;

/**
 * Who a membership may send an announcement to. The same definition as reads, with two
 * deliberate differences, because the read fallbacks would widen a sender to the whole
 * college: a faculty member sends only through active teaching assignments (none recorded
 * means nobody), and a department head needs a department on their membership.
 */
export function institutionAnnouncementScope(
  memberships: readonly InstitutionStaffScopeMembership[],
  units: readonly InstitutionUnitNode[],
): InstitutionStudentScope {
  const senders = memberships
    .filter((membership) => (institutionAnnouncementSenderRoles as readonly string[]).includes(membership.role))
    .filter((membership) => membership.role !== 'DEPARTMENT_HEAD' || Boolean(membership.departmentUnitId))
    .map((membership) => membership.role === 'FACULTY_LECTURER'
      ? { ...membership, teachingUnitIds: membership.teachingUnitIds ?? [] }
      : membership);
  return institutionStudentScope(senders, units);
}

/**
 * True when `scope` may address the audience: the whole institution (`null`) needs an
 * institution-wide scope; a unit needs some clause whose every anchor covers it — the rule
 * a student row is tested against, applied to the unit itself.
 */
export function canAddressInstitutionAudience(scope: InstitutionStudentScope, audienceUnitId: string | null): boolean {
  if (scope.kind === 'INSTITUTION') return true;
  if (scope.kind === 'NONE' || audienceUnitId === null) return false;
  return scope.clauses.some((anchors) => anchors.every((covered) => covered.includes(audienceUnitId)));
}

/**
 * The membership that admits an announcement to `audienceUnitId`, most senior role first,
 * with that membership's own sending scope — recipients are resolved inside it. Null when
 * none of the caller's memberships may address the audience.
 */
export function institutionAnnouncementSender<M extends InstitutionStaffScopeMembership>(
  memberships: readonly M[],
  units: readonly InstitutionUnitNode[],
  audienceUnitId: string | null,
): { readonly membership: M; readonly scope: InstitutionStudentScope } | null {
  const ordered = [...memberships].sort((left, right) => senderRank(left.role) - senderRank(right.role));
  for (const membership of ordered) {
    const scope = institutionAnnouncementScope([membership], units);
    if (canAddressInstitutionAudience(scope, audienceUnitId)) return { membership, scope };
  }
  return null;
}

function senderRank(role: string): number {
  const rank = (institutionAnnouncementSenderRoles as readonly string[]).indexOf(role);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}
