# SOC Analyst L1 — Career Target v1 (DRAFT, for subject-expert review)

**What this is.** The reasoning and sources behind the draft requirement set for catalogue role **C01 SOC Analyst L1**
(starter role `SOC_ANALYST`), written for ENG-11. The data is `data/engine/soc-analyst-l1-target-v1.draft.json`;
it loads through `db:import:career-target-draft` as an `AGENT_DRAFTED` requirement set in state `DRAFT`, with
thirteen new skills as pending (unpublished, inactive) topics. Design: `docs/architecture/career-target-drafts-table-design.md`.

**Status.** Model-produced content (program Part B.8). The coding agent wrote it by hand from the public sources
below; the product made no model call. **Nothing here is reviewed.** Every skill and every requirement carries an
`expertCheck` note in the data file; a subject expert must check each one before the set is submitted, and a second
person must review and approve before it can publish. No student sees any of it until then.

**What it does not claim.** No labour-market figures, hiring volumes, salary data or employer demand are stated or
implied: none were researched for this goal, and none should be inferred from the levels. The levels and target
depths are our proposal; the sources do not grade their criteria by importance or give mastery targets. Nothing
here computes or shows a readiness value; readiness stays a band (ADR-020).

## Sources

1. **Primary — NQR qualification file "Analyst Security Operations Centre".** IT-ITeS Sector Skills Council
   NASSCOM; NCrF/NSQF level 5; NQR code `QG-05-IT-01540-2023-V1.1-NASSCOM` (version 3; previous
   `2021/ITES/ITSSC/04668`); final NSQC approval 25 Nov 2021; validity 3 years, next review date stated as
   25 Nov 2024. Mandatory NOS: **SSC/N0906** "Monitor and log events and alarms of possible security threats" (V2.0,
   core, 35% weightage), **SSC/N0907** "Investigate and respond to events and alarms that could be security threats"
   (V2.0, core, 35%), SSC/N9014 (inclusive, sustainable workplace, non-core) and DGT/VSQ/N0102 (employability,
   non-core); 480 hours including 90 hours OJT; minimum aggregate pass 70%.
   <https://www.nqr.gov.in/qualification/file/SSC%20Q0909_Analyst%20Security%20Operations%20Centre_V3.pdf>
2. **Cross-check — NQR OEM qualification file "Cybersecurity Analysis-IBM".** NQR code
   `NG-05-IT-02239-2024-V1-NASSCOM`, NSQF level 5, NSQC approval 15 Mar 2024; modules include cybersecurity tools and
   attacks, operating-system security, compliance frameworks, network security, incident response and forensics,
   and threat intelligence. Used only to confirm the skill areas; it is vendor-specific, so nothing here depends on it.
   <https://nqr.gov.in/qualification/file/Q%20File%20Cybersecurity%20Analyst%20-%20IBM.pdf>
3. **Cross-check — NIST NICE Framework work role "Defensive Cybersecurity" (PD-WRL-001)**, formerly Cyber Defense
   Analyst: analysing data from defence tools (IDS alerts, firewalls, network traffic logs) to mitigate threats.
   <https://niccs.cisa.gov/tools/nice-framework/work-role/defensive-cybersecurity>
4. **ONE job-role catalogue row C01** (`docs/ops/inputs/job-role-catalogue.md`): core skill areas "Networking, Linux
   and Windows logs, SIEM alert triage, incident response, MITRE ATT&CK, reporting"; main evidence "Scenarios and
   objective tests now; labs in V3".

## Decisions taken (recommended answers adopted, per AGENTS.md)

- **Which qualification.** The goal names "the NQR Cybersecurity Analyst qualification". The NQR file titled
  *Cybersecurity Analyst* is an OEM qualification tied to one vendor's certificate (source 2). The sector
  qualification for the SOC L1 job is *Analyst Security Operations Centre* (source 1), whose two core NOS are
  monitoring and responding — the job itself. **Adopted: source 1 as the basis, source 2 as a cross-check.**
  Divakar may override.
- **Currency.** Source 1's stated next review date (25 Nov 2024) has passed. The file was the one published on NQR
  when fetched (26 Sep 2026). **Expert check: confirm no newer version supersedes it.**
- **PC numbering.** The NOS tables in the PDF render with the NOS label offset from its rows. We read PC1–PC26 of
  the first table as SSC/N0906 and PC1–PC24 of the second as SSC/N0907 (consistent with their titles and with the
  totals 31/69 and 32/68). **Expert check: confirm against the file.**
- **Evidence type.** Every new requirement asks for `ASSESSMENT_OUTCOME` only. The catalogue's evidence for C01 is
  scenarios and objective tests now, labs in V3, and nothing in ONE writes `TOPIC_DEMONSTRATION` evidence yet;
  requiring it would make every requirement unmeetable. Add it when labs exist. The qualification's own assessment is
  mostly practical (about 69% of marks), which is the argument for doing so.
- **Target depths.** ESSENTIAL analysis skills at 0.70, which mirrors the qualification's 70% minimum pass; their
  foundations at 0.65; IMPORTANT at 0.55–0.60; HELPFUL at 0.50. A pass mark is not a mastery ratio — this is a
  starting point for the expert, not a finding.
- **Starter requirements kept.** `professional-communication` (ESSENTIAL 0.75) and `interview-foundations`
  (IMPORTANT 0.60) are carried unchanged from the live set, so a publish changes nothing a student already sees
  unless the reviewer decides it should.
- **Out of scope for the target:** SSC/N9014 (workplace inclusion and sustainability) and DGT/VSQ/N0102
  (employability) are non-core NOS about the workplace, not the SOC job; they are not requirements here.

## Skills and requirements

| Skill (stable key) | Level | Target | Qualification basis | Prerequisites |
| --- | --- | --- | --- | --- |
| `soc-alert-triage` | ESSENTIAL | 0.70 | N0907 PC1, PC6, PC10; N0906 PC15 | monitoring-siem, security-fundamentals |
| `soc-log-analysis-correlation` | ESSENTIAL | 0.70 | N0906 PC13, PC14; N0907 PC2, PC9, PC11, PC12 | os-log-sources, monitoring-siem |
| `soc-security-monitoring-siem` | ESSENTIAL | 0.70 | N0906 PC2, PC3, PC9, PC11; N0907 PC24 | os-log-sources, networking |
| `soc-os-log-sources` | ESSENTIAL | 0.65 | N0906 PC8; catalogue C01 | networking |
| `soc-networking-fundamentals` | ESSENTIAL | 0.65 | Evidence of Level; tools annexure | — |
| `soc-incident-response-process` | ESSENTIAL | 0.65 | N0907 PC5, PC7, PC13, PC16, PC17, PC20, PC21; N0906 PC20, PC26 | alert-triage |
| `soc-ticketing-and-reporting` | ESSENTIAL | 0.65 | N0906 PC16–PC19, PC21–PC23, PC25; N0907 PC22, PC23 | — |
| `soc-security-fundamentals` | ESSENTIAL | 0.65 | Evidence of Level; N0907 PC15 | — |
| `soc-network-traffic-analysis` | IMPORTANT | 0.60 | N0906 PC10; N0907 PC3, PC4 | networking |
| `soc-attack-frameworks-mitre` | IMPORTANT | 0.55 | catalogue C01; tools annexure; N0907 PC8 | security-fundamentals |
| `soc-threat-intel-sources` | HELPFUL | 0.50 | N0906 PC4; N0907 PC19 | security-fundamentals |
| `soc-vulnerability-basics` | HELPFUL | 0.50 | Evidence of Level | security-fundamentals |
| `soc-policy-and-compliance-basics` | HELPFUL | 0.50 | N0906 PC24; Evidence of Level | — |
| `professional-communication` (live) | ESSENTIAL | 0.75 | starter set, unchanged | — |
| `interview-foundations` (live) | IMPORTANT | 0.60 | starter set, unchanged | — |

Criteria not mapped to any skill, and why: N0906 PC1 (agree monitoring scope), PC5, PC6 (telemetry of the security
platform), PC7, PC12 (coordinate with network-defence staff) and N0907 PC14 (how access was obtained), PC18 (health
check of the security solution) are either organisation-specific or covered by the broader skills above. **Expert
check: say whether any deserves its own skill.**

## What the reviewer does

1. Check every `expertCheck` note in the data file and each decision above; edit the draft on the operator screen
   (Content Management → job-role catalogue → C01) or send it back.
2. The draft cannot publish until its thirteen skills are published as topics (design, open point 1); the publish
   is refused with `CAREER_TOPIC_NOT_LIVE` until then.
3. Publishing needs `CONTENT_PUBLISH` and a second person's approval. The label stays `SELECTABLE`: "verified"
   needs the placement test, path and evidence that do not exist yet.
