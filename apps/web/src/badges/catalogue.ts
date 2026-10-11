/**
 * The Momentum badge catalogue: the sixteen approved badges, read from badges.json (a copy of
 * design inventory 04-badges/badges.json without its fictional sample states).
 *
 * It exists so every badge surface renders from one list — name, family, tier, criterion, the
 * evidence it needs, its meter (unit and target, or why it has none) and who may see it. Two
 * badges are band-based (First Climb, Ready For Next Step): they are `private`, carry no meter,
 * and are never shown to an employer or on a shared profile. The catalogue holds no state: what a
 * person has earned comes from the backend, which records no badges today (see the phase report).
 */
import catalogueText from './badges.json?raw';

export type BadgeFamily = 'foundation' | 'evidence' | 'apply' | 'learn' | 'streak';
export type BadgeVisibility = 'private' | 'student-choice';

export interface BadgeMeter { readonly meter: true; readonly unit: string; readonly target: number }
export interface BadgeNoMeter { readonly meter: false; readonly reason: string }

export interface BadgeDefinition {
  readonly id: string;
  readonly name: string;
  readonly family: BadgeFamily;
  readonly tier: 'bronze' | 'silver' | 'gold';
  readonly tierLevel: 1 | 2 | 3;
  readonly criterion: string;
  readonly evidenceNeeded: readonly string[];
  readonly progress: BadgeMeter | BadgeNoMeter;
  readonly visibility: BadgeVisibility;
  readonly files: { readonly earned: string; readonly locked: string; readonly progress: string | null; readonly animated: string };
}

const families: readonly BadgeFamily[] = ['foundation', 'evidence', 'apply', 'learn', 'streak'];

function parseCatalogue(text: string): readonly BadgeDefinition[] {
  const raw = JSON.parse(text) as { badges?: unknown };
  if (!Array.isArray(raw.badges)) throw new Error('badges.json has no badges');
  return raw.badges.map((entry: Record<string, unknown>) => {
    const progress = entry.progress as Record<string, unknown>;
    const files = entry.files as Record<string, string | null>;
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || !families.includes(entry.family as BadgeFamily)) throw new Error('badges.json has a malformed badge');
    if (entry.visibility !== 'private' && entry.visibility !== 'student-choice') throw new Error(`badge ${entry.id} has no visibility`);
    // A band-based badge never carries a meter: readiness is a band, never a percentage.
    if (entry.visibility === 'private' && progress.meter !== false) throw new Error(`private badge ${entry.id} must not have a meter`);
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family as BadgeFamily,
      tier: entry.tier as BadgeDefinition['tier'],
      tierLevel: entry.tierLevel as BadgeDefinition['tierLevel'],
      criterion: String(entry.criterion),
      evidenceNeeded: (entry.evidenceNeeded as string[]).map(String),
      progress: progress.meter === true
        ? { meter: true, unit: String(progress.unit), target: Number(progress.target) }
        : { meter: false, reason: String(progress.reason ?? '') },
      visibility: entry.visibility,
      files: { earned: String(files.earned), locked: String(files.locked), progress: files.progress ? String(files.progress) : null, animated: String(files.animated) },
    } satisfies BadgeDefinition;
  });
}

export const badgeCatalogue: readonly BadgeDefinition[] = parseCatalogue(catalogueText);

const byId = new Map(badgeCatalogue.map((badge) => [badge.id, badge]));

export function badgeById(id: string): BadgeDefinition | undefined {
  return byId.get(id);
}

/** Band-based badges (First Climb, Ready For Next Step): private to the student, always. */
export function isBandBased(badge: BadgeDefinition): boolean {
  return badge.visibility === 'private';
}
