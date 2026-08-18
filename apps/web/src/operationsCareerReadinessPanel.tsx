import { useEffect, useState } from 'react';
import {
  getCareerReadinessAccessToken,
  getCareerReadinessImportOperations,
  getCareerReadinessOperationsStatus,
  type CareerReadinessOperationsStatus,
} from './api.js';

type ImportOperation = Awaited<ReturnType<typeof getCareerReadinessImportOperations>>[number];

export function OperationsCareerReadinessPanel(): React.ReactElement {
  const [imports, setImports] = useState<readonly ImportOperation[]>([]);
  const [status, setStatus] = useState<CareerReadinessOperationsStatus | null>(null);
  const [message, setMessage] = useState('Loading governed Career Readiness operations data...');

  useEffect(() => {
    const token = getCareerReadinessAccessToken();
    if (!token) {
      setMessage('Sign in with an Operations role to load the backend-enforced governance surface.');
      return undefined;
    }
    const abort = new AbortController();
    Promise.all([getCareerReadinessImportOperations(token, abort.signal), getCareerReadinessOperationsStatus(token, abort.signal)])
      .then(([loadedImports, loadedStatus]) => {
        setImports(loadedImports);
        setStatus(loadedStatus);
        setMessage('API-backed operational state. No source database, event payload, recipient address, or secret is exposed.');
      })
      .catch(() => setMessage('Operational API data is unavailable or this identity lacks the required Operations role.'));
    return () => abort.abort();
  }, []);

  return <section className="career-api-panel" aria-labelledby="operations-career-title">
    <div className="career-api-heading"><div><span className="eyebrow">Backend-enforced operations</span>
      <h2 id="operations-career-title">Career Readiness governance and automation</h2></div>
      <span className={`career-api-state ${status ? 'connected' : 'unavailable'}`}>{status ? 'API-backed' : 'Restricted'}</span></div>
    <p className="career-api-status" role="status">{message}</p>
    {status ? <div className="career-api-grid">
      <article><span>Frozen imports</span><h3>{imports.length} package{imports.length === 1 ? '' : 's'}</h3>
        <p>{imports.reduce((sum, item) => sum + item.blockedRecords, 0)} quarantined record{imports.reduce((sum, item) => sum + item.blockedRecords, 0) === 1 ? '' : 's'}.</p></article>
      <article><span>Release manifests</span><h3>{status.releases.filter((item) => item.status === 'PUBLISHED').length} published</h3>
        <p>Each release is hash-pinned and approval-gated.</p></article>
      <article><span>Content review</span><h3>{status.reviewQueue.length} queued</h3><p>Self-approval is rejected in the database.</p></article>
      <article><span>Outbox failures</span><h3>{status.outboxFailures.length}</h3><p>Replay requires a native audited operation.</p></article>
      <article><span>Automation allowlist</span><h3>{status.workflows.length} workflow{status.workflows.length === 1 ? '' : 's'}</h3>
        <p>{status.workflows.filter((item) => item.active && !item.killSwitch).length} enabled; all destinations are email.</p></article>
      <article><span>Recent commands</span><h3>{status.automationCommands.length}</h3>
        <p>{status.automationCommands.filter((item) => item.state.startsWith('FAILED')).length} failed or awaiting reconciliation.</p></article>
    </div> : null}
    {imports.map((item) => <article className="role-card role-wide" key={item.id}><span>{item.status}</span><h3>{item.packageIdentity}</h3>
      <p>{item.sourceRepository} at {item.sourceCommit.slice(0, 12)} - {item.blockedRecords} blocked.</p>
      <small>Manifest {item.manifestHash.slice(0, 16)}... | transform {item.transformVersion}</small></article>)}
  </section>;
}
