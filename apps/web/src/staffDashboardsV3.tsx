import { PlacementOfficerHome } from './rolePortal/placementOfficerHome.js';
import { EmployerHome } from './rolePortal/employerHome.js';

/**
 * The staff dashboards' stable entry points. Each now renders its approved Momentum home: the
 * placement officer's (re-skin phase 6, rolePortal/placementOfficerHome.tsx) and the employer's
 * (re-skin phase 7, rolePortal/employerHome.tsx). A block renders only when its data exists; no
 * slot prints "NA". The names stay so existing callers do not change.
 */

// --- Institution -------------------------------------------------------------

export function InstitutionDashboardV3({ institutionId, basePath }: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  return <PlacementOfficerHome institutionId={institutionId} basePath={basePath} />;
}

// --- Employer ----------------------------------------------------------------

export function EmployerDashboardV3({ basePath }: { readonly basePath: string }): React.ReactElement {
  return <EmployerHome basePath={basePath} />;
}
