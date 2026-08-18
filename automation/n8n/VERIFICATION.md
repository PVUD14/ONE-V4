# n8n verification evidence

Verified on 2026-08-18 against the checked-in compose and workflow files.

## Runtime under test

- n8n: `n8nio/n8n:2.35.3@sha256:31375a4f730081a139bba2d379bf2efaa8e662cc9e131d12bb5e15859d4f0282`
- PostgreSQL: `postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`
- Mailpit: `axllent/mailpit:v1.30.6@sha256:7f33095f80e901f6ad08028f06ca284aa58fe84942be5496008d041d3b9f4d4d`

The test used only synthetic credentials and recipients. The compose networks were Docker `internal` networks; the optional host bindings were loopback-only.

## Results

- `node automation/n8n/scripts/validate-workflows.mjs`: `validated 6 inactive, email-only, hash-pinned n8n workflows`.
- Fresh n8n CLI import: six workflows imported with their stable registry IDs.
- Immediately after import: `6` workflows, `0` active.
- One workflow (`assessment-due`) was temporarily published for the delivery test.
- Authenticated webhook invocation returned HTTP `200` with a bound JSON callback containing `status=SUCCEEDED`, the exact synthetic callback ID/token, and an SMTP message reference.
- Mailpit API returned exactly `1` message with subject `PlanThePath assessment due` and the synthetic recipient `learner@example.test`.
- The workflow was unpublished immediately after the test. Final database query: `6` workflows, `0` active.
- Final startup log showed n8n `2.35.3`, no MCP-registry fetch, and `0` published workflows in the dependency index.

## Built-in security audit

`n8n audit` completed under the final configuration. It confirmed:

- community packages disabled;
- version notifications disabled;
- templates disabled;
- public API disabled;
- diagnostics disabled;
- `nodesInclude` limited to `n8n-nodes-base.webhook`, `n8n-nodes-base.emailSend`, and `n8n-nodes-base.respondToWebhook`;
- high-risk filesystem, command, network, database, source-control, AI, and imported-source integration nodes excluded.

The audit also identified the two deliberately disposable synthetic credentials as unused after the workflow was unpublished. The verification stack and its credential/database volumes were destroyed after evidence capture.

## Container controls observed

Docker inspection of the n8n container returned:

- read-only root filesystem: `true`;
- dropped capabilities: `ALL`;
- security option: `no-new-privileges:true`;
- memory limit: `1 GiB`;
- CPU limit: `1`;
- host binding: `127.0.0.1:5678` only in the local override.

The n8n image logs a Python-runner warning because Python is absent. Both Code nodes and command-execution nodes are excluded, so the pilot workflows cannot invoke either task runner.
