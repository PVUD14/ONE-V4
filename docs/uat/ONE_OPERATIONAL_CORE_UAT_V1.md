# ONE Operational Core UAT V1

Phase 2A turns selected authenticated surfaces from preview-only screens into real operating surfaces.

## Accepted Phase 1 baseline

- Student login and routing: PASS
- Institution login and routing: PASS
- Other tested role routing: PASS
- Refresh/session persistence: PASS
- Sign out: PASS

Passwords and raw tokens remain outside Git.

## Student operational checks

1. Sign in as the synthetic Student.
2. Open Profile.
3. Edit target career, headline, interests, visibility and save.
4. Refresh and confirm the saved values persist.
5. Open Documents.
6. Create document metadata and confirm it appears after refresh.
7. Confirm the UI states: “File storage will be enabled in a later secure-storage phase.”
8. Archive document metadata and confirm it no longer appears as active.
9. Open Opportunities.
10. Save an opportunity reference and confirm it persists.
11. Remove the saved reference and confirm it is archived.

## Institution Admin checks

Use existing authenticated Institution APIs to verify:

- list/create/edit academic units;
- add/edit students;
- lifecycle transition with confirmation/effective state;
- CSV roster preview and commit;
- staff invitation using verified-recipient invitation lifecycle.

## Operations checks

Use existing authenticated Operations APIs to verify:

- organization create/edit;
- verification transition with reason;
- initial admin invitation;
- organization detail activity/audit;
- onboarding status.

## Known Phase 2A limitations

- Binary document upload is intentionally not implemented until secure object storage is approved.
- Full Employer hiring workflow is Phase 2B.
- Full content authoring/review CMS is Phase 2C.

