# Infrastructure / IaC Baseline

## V1 topology direction

Single AWS region, Multi-AZ where managed services support it, with tested backup/restore rather than active-active multi-region. Public web traffic terminates at managed edge/load-balancing controls; application workloads, data stores, queues, and private services are not directly internet-exposed unless explicitly required.

## Deployable boundaries

1. Student/Institution/Employer web surfaces.
2. Operations web surface with stricter administrative controls.
3. Modular transactional API.
4. AI orchestration service.
5. Background worker(s).

## Managed service direction

- PostgreSQL-compatible managed relational database as system of record.
- Private object storage for resumes/documents with quarantine/scan lifecycle.
- Durable managed queue for async jobs/events.
- Managed cache only where justified by measured need.
- Managed identity provider; final provider remains an ADR/pilot decision.
- Managed secrets/key services.
- Central logging/metrics/tracing and security integration.

## Network

Databases and internal services use private networking/security groups. Egress is controlled and observable. Production admin/data services are not exposed through broad public ingress.

## IaC conventions

All durable cloud resources must be represented through IaC before production. Modules/stacks separate network, identity/security, data, compute, observability, and edge concerns. Environment-specific values are parameters/configuration; secrets are references, not plaintext IaC variables committed to Git.

## Recovery

Database automated backups/PITR, object versioning/retention where appropriate, IaC reproducibility, and documented restoration steps are mandatory. RPO/RTO values are finalized and tested before pilot/GA.

## Scale

Optimize V1 for ~10,000 students and 100+ employers with horizontal application/worker scaling. AI concurrency/cost is treated independently from CRUD workload. Self-hosted GPU inference is benchmark-gated, not assumed.