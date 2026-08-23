/**
 * Decides whether a signed-in identity sees the pilot experience.
 *
 * The pilot renders a curated sample dataset at full fidelity for client
 * demonstrations. The rule that authenticated views never show fiction survives
 * because the fiction is scoped to identities that exist for it: an account whose
 * local part begins with `demo.`, or one explicitly listed at build time. Every
 * other signed-in user renders the real application, untouched.
 */
export function isPilotIdentity(
  email: string | null | undefined,
  env: { readonly VITE_PILOT_ACCOUNTS?: string } = import.meta.env as { readonly VITE_PILOT_ACCOUNTS?: string },
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (normalized.startsWith('demo.')) return true;
  const allowList = (env.VITE_PILOT_ACCOUNTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowList.includes(normalized);
}
