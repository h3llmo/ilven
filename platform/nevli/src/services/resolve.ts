import type { Gender } from "../context.ts";

export interface Profile { age?: number; gender?: Gender }
export interface Criterion { id: string; presetId: string; priority: number; minAge: number | null; maxAge: number | null; gender: Gender | null }

/** Age from birth year. Approximate by up to one year (we never store a full birth date). */
export function ageFromBirthYear(birthYear: number | null | undefined, now = new Date()): number | undefined {
  return birthYear == null ? undefined : now.getUTCFullYear() - birthYear;
}

/**
 * Preset resolution (CLAUDE.md §5.2): evaluate criteria by ascending priority; first match wins.
 * A criterion on an attribute the user did not share never matches. No match → default preset.
 */
export function resolvePresetId(criteria: Criterion[], profile: Profile, defaultPresetId: string): string {
  const sorted = [...criteria].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const c of sorted) if (matches(c, profile)) return c.presetId;
  return defaultPresetId;
}

function matches(c: Criterion, p: Profile): boolean {
  if (c.minAge != null && (p.age == null || p.age < c.minAge)) return false;
  if (c.maxAge != null && (p.age == null || p.age > c.maxAge)) return false;
  if (c.gender != null && p.gender !== c.gender) return false;
  return true;
}
