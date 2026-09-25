# Job role catalogue (input for OPS-08)

> **What this file is.** A faithful transcription of Appendix 4 of the ONE Program Goal v1.0 — the job-role
> catalogue from the ONE Adaptive Learning Engine Master Plan (Job role catalogue tab, revision 11).
> **Why it exists.** Program rule B.3: the job-role catalogue is loaded once by OPS-08 from this file, and every
> other goal reads it from the database. `data/careers/catalogue-v1.json` is generated from the tables below and a
> test (`packages/persistence/test/career-catalogue-input.test.ts`) re-parses this file and fails if the two drift
> or if any count below is wrong.
>
> Transcribed 2026-09-26 by OPS-08 from the program text extract, where table cells were broken across lines;
> every row was reconstructed and the counts verified: **108 role rows** (S 25, D 9, C 9, E 13, L 7, M 14, P 6,
> V 11, B 14) and **13 goal rows** (G01–G13). No row was guessed. Wording is the source's own.
>
> "Core skill areas" are drafts to be validated against NQR qualification files and job descriptions before any
> role becomes verified. The **Release** column is the *planned* release in which a role gets a full track — it is
> planning data, not a statement that anything is verified today.

## How to use this catalogue

The catalogue lists 108 entry-level campus roles in six families (A–F), plus 13 goals that are not jobs (G).
Every role is selectable by students from V1; what grows with each release is how deeply ONE can teach and
verify it.

| Label | What it means for a student |
| --- | --- |
| V1 verified | Full adaptive track in the pilot: placement test, path, tutor, evidence, readiness band |
| V2 verified / V3 verified | Planned release in which the role gets a full track |
| Selectable | Student can choose it today. They get the shared aptitude and communication path, the role's required skill areas, an honest "not yet verified" label, and progress on any skill ONE can already measure. Unmeasured requirements show as UNKNOWN, never as weak |

Every selection is a demand signal. Counting which selectable roles students choose, per college and
branch, decides which roles become verified next.

Students state roles in their own words. "I want to be a developer" or "core job in Mech" maps to
catalogue roles through synonyms, and the student confirms the match.

### How a role becomes verified

1. Demand: enough students or pilot-college recruiters ask for it.
2. Draft the career target from the matching NQR qualification file (for example the Cybersecurity Analyst
   qualification, https://www.nqr.gov.in/qualifications/13867) and 20–30 Indian job descriptions.
3. Build the skill map, tagged question bank, misconception codes and hint ladders.
4. Subject-expert review, then 1–3 recruiters confirm the must-haves.
5. Publish a versioned career target; the role's label changes to verified.

## A. Software, IT and product (25 roles)

| ID | Role | Typical branches | Core skill areas (draft) | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| S01 | Associate Software Engineer / Programmer Analyst Trainee (IT services mass hiring) | All branches | One programming language, basic data structures, SQL, OOP, aptitude, communication | Executed code, objective tests | V2 verified |
| S02 | Software Developer (backend) | CSE, IT, ECE, EEE | Backend language, data structures and algorithms, databases, APIs, Git, testing basics | Executed code, small project | V2 verified |
| S03 | Frontend Developer | CSE, IT, any | HTML, CSS, JavaScript, one framework, accessibility basics, API use | Executed code, project | V3 verified |
| S04 | Full-Stack Developer | CSE, IT | Frontend, backend, database, deployment basics | Project | V3 verified |
| S05 | Mobile App Developer | CSE, IT, ECE | Kotlin or Swift or a cross-platform toolkit, UI, APIs, app lifecycle | Project | V3 verified |
| S06 | Software Test Engineer (manual QA) | All branches | Testing life cycle, test cases, defect life cycle, SQL basics | Scenario tests, written test cases | V2 verified |
| S07 | Test Automation Engineer (SDET) | CSE, IT, ECE | Programming, browser automation, API testing, CI basics | Executed code | V3 verified |
| S08 | DevOps Engineer (junior) | CSE, IT | Linux, Git, CI/CD, containers, scripting, cloud basics | Labs | V3 verified |
| S09 | Cloud Support / Associate Cloud Engineer | CSE, IT, ECE, EEE | Cloud fundamentals, networking, Linux, identity basics, troubleshooting | Labs, objective tests | V3 verified |
| S10 | Site Reliability Engineer (junior) | CSE, IT | Linux, monitoring, scripting, networking, incident handling | Labs | Selectable |
| S11 | System Administrator (Linux / Windows) | CSE, IT, ECE, EEE | OS administration, users and permissions, backup, scripting, directory basics | Labs | V3 verified |
| S12 | Network / NOC Engineer | ECE, CSE, IT, EEE | TCP/IP, subnetting, routing and switching, firewalls, monitoring | Objective tests, configuration simulation | V3 verified |
| S13 | Technical Support / IT Helpdesk Engineer | All branches | OS and hardware troubleshooting, networking basics, ticketing, customer communication | Scenarios; spoken tasks later | V2 verified |
| S14 | Database Administrator / SQL Developer | CSE, IT | SQL, schema design, indexing, backup and recovery, performance | Executed SQL | V3 verified |
| S15 | ERP / SAP Consultant (trainee) | All branches | Business processes (finance, supply chain, HR), ERP navigation, configuration basics | Scenarios | Selectable |
| S16 | CRM / Salesforce Developer | CSE, IT | Platform basics, data model, automation, integration | Executed code | Selectable |
| S17 | Mainframe Developer | CSE, IT, any | COBOL, JCL, DB2, batch processing | Executed code | Selectable |
| S18 | Game Developer | CSE, IT | Game engine, C# or C++, maths for games | Project | Selectable |
| S19 | UI / UX Designer | Any | User research, wireframes, visual design, prototyping, usability testing | Portfolio artifact | Selectable |
| S20 | Technical Writer | Any | Technical writing, documentation tools, API documentation basics | Writing rubric | V3 verified |
| S21 | IT Business Analyst | CSE, IT, any | Requirements, process modelling, SQL basics, documentation, stakeholder communication | Writing, scenarios | V3 verified |
| S22 | Associate Product Manager / Product Analyst | Any | Product thinking, analytics, user research, prioritisation | Case, writing | Selectable |
| S23 | IT Project Coordinator / Scrum Associate | Any | Agile and Scrum, planning tools, reporting, communication | Scenarios | Selectable |
| S24 | Blockchain Developer | CSE, IT | Cryptography basics, smart contracts | Executed code | Selectable |
| S25 | AR / VR Developer | CSE, IT | 3D engines, graphics basics, interaction design | Project | Selectable |

## B. Data, AI and cybersecurity (18 roles)

| ID | Role | Typical branches | Core skill areas (draft) | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| D01 | Data Analyst | All branches | Spreadsheets, SQL, statistics basics, dashboards, turning business questions into analysis | Executed SQL, notebook task | V2 verified |
| D02 | BI Developer / Reporting Analyst | Any | SQL, data modelling, dashboards, ETL basics | Executed SQL, dashboard artifact | V3 verified |
| D03 | MIS Executive | Any | Advanced spreadsheets, reporting, data hygiene | Practical spreadsheet task | Selectable |
| D04 | Data Engineer (junior) | CSE, IT | SQL, Python, data pipelines, cloud data services, data modelling | Executed code | V3 verified |
| D05 | Data Scientist (entry) | CSE, IT, ECE, maths-strong branches | Statistics, Python, machine-learning basics, experiments, communicating results | Notebook | V3 verified |
| D06 | Machine Learning Engineer (junior) | CSE, IT, ECE | ML algorithms, Python, evaluation, deployment basics | Executed code, notebook | V3 verified |
| D07 | GenAI / LLM Application Developer | CSE, IT | Python, model APIs, prompting, retrieval, evaluation, safety | Executed code, project | Selectable |
| D08 | AI Data Specialist / Annotation Analyst | Any | Domain knowledge, annotation guidelines, quality checks, writing | Rubric-graded tasks | Selectable |
| D09 | Computer Vision Engineer (junior) | CSE, ECE | Image processing, deep-learning basics | Notebook | Selectable |
| C01 | SOC Analyst L1 | CSE, IT, ECE | Networking, Linux and Windows logs, SIEM alert triage, incident response, MITRE ATT&CK, reporting | Scenarios and objective tests now; labs in V3 | V1 verified |
| C02 | Vulnerability Assessment Analyst (VAPT associate) | CSE, IT, ECE | Networking, web basics, scanning tools, CVSS, reporting | Labs, report rubric | V2 verified |
| C03 | Penetration Tester (junior) | CSE, IT | Web and application security, networking, Linux, exploitation in labs, reporting | Labs, capture-the-flag | V3 verified |
| C04 | GRC / IT Audit Analyst | Any | ISO 27001 basics, risk assessment, controls, policies, audit evidence | Scenarios, writing | V3 verified |
| C05 | Application Security Analyst | CSE, IT | OWASP Top 10, secure code review, SAST and DAST basics | Code-review task | V3 verified |
| C06 | Cloud Security Associate | CSE, IT | Cloud identity, network security groups, logging, misconfiguration review | Labs | Selectable |
| C07 | IAM Analyst | CSE, IT, any | Identity life cycle, access reviews, directory services, SSO and MFA | Scenarios | Selectable |
| C08 | Digital Forensics Analyst (junior) | CSE, IT, ECE | File systems, evidence handling, forensic tools, reporting | Labs | Selectable |
| C09 | OT / ICS Security Associate | EEE, ECE, Instrumentation | Industrial protocols, OT networks, safety-first security | Scenarios | Selectable |

## C. Electronics, electrical and instrumentation (20 roles)

| ID | Role | Typical branches | Core skill areas (draft) | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| E01 | Embedded Software Engineer | ECE, EEE, CSE | C programming, microcontrollers, RTOS basics, UART / SPI / I2C, debugging | Executed code, simulated hardware | V2 verified |
| E02 | Embedded Hardware / PCB Design Engineer | ECE, EEE | Circuit design, PCB tools, component selection, signal-integrity basics | Design artifact | Selectable |
| E03 | VLSI Design Engineer (RTL) | ECE, EEE | Digital design, Verilog or VHDL, timing basics, synthesis | HDL simulation | V3 verified |
| E04 | VLSI Verification Engineer | ECE, EEE | SystemVerilog, UVM basics, test planning | HDL simulation | V3 verified |
| E05 | Physical Design Engineer | ECE | Floorplanning, placement and routing, static timing basics | Objective tests, tool task | Selectable |
| E06 | Analog / Mixed-Signal Design Engineer (junior) | ECE, EEE | Analog circuits, SPICE simulation | Simulation task | Selectable |
| E07 | Telecom / RF Engineer | ECE | Communication systems, RF basics, 4G / 5G concepts, drive testing | Objective tests, scenarios | Selectable |
| E08 | IoT Engineer | ECE, EEE, CSE | Sensors, microcontrollers, connectivity, cloud IoT basics | Project | V3 verified |
| E09 | Electronics Test and Validation Engineer | ECE, EEE | Test equipment, test plans, measurement, documentation | Scenarios; lab later | Selectable |
| E10 | Field Service Engineer (electronics / medical equipment) | ECE, EEE, Instrumentation | Troubleshooting, equipment knowledge, safety, customer communication | Scenarios; spoken tasks later | Selectable |
| E11 | Instrumentation and Control Engineer | Instrumentation, EEE, ECE | Sensors and transducers, control loops, calibration, reading P&IDs | Numerical problems, objective tests | V3 verified |
| E12 | Automation Engineer (PLC / SCADA) | EEE, Instrumentation, ECE, Mechanical | Ladder-logic PLC programming, SCADA / HMI, drives, industrial networks | PLC simulation | V3 verified |
| E13 | Robotics Engineer (junior) | Mechanical, ECE, EEE | Kinematics, control, ROS basics, sensors | Project | Selectable |
| L01 | Graduate Engineer Trainee — Electrical (power, utilities, PSUs) | EEE | Circuits, machines, power systems, protection, electrical safety | Numerical and objective tests | V2 verified |
| L02 | Electrical Design Engineer (buildings / MEP) | EEE | Load calculation, cable sizing, lighting design, electrical drawings, IS codes | Numerical problems, drawing task | V3 verified |
| L03 | Power Systems / Protection Engineer | EEE | Power flow, protection relays, switchgear, fault analysis | Numerical problems | Selectable |
| L04 | Electrical Maintenance Engineer (plant) | EEE | Motors, transformers, preventive maintenance, safety, troubleshooting | Scenarios | V3 verified |
| L05 | Renewable Energy Engineer (solar / wind) | EEE, Mechanical | PV system design, inverters, energy yield, grid connection | Numerical problems, design task | V3 verified |
| L06 | EV Powertrain / Battery Systems Engineer | EEE, Mechanical, ECE | Batteries and BMS, motors and drives, power electronics | Numerical problems, simulation | Selectable |
| L07 | Electrical Site / Project Engineer | EEE | Installation, testing and commissioning, bill of quantities, safety | Scenarios | Selectable |

## D. Mechanical, manufacturing, chemical and process (20 roles)

| ID | Role | Typical branches | Core skill areas (draft) | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| M01 | Graduate Engineer Trainee — Mechanical | Mechanical, Production, Automobile | Thermodynamics, strength of materials, manufacturing processes, machine design, safety | Numerical and objective tests | V2 verified |
| M02 | Design Engineer (CAD) | Mechanical, Automobile, Aeronautical | Engineering drawing and GD&T, 3D CAD modelling, design basics, materials | Drawing or model artifact | V2 verified |
| M03 | CAE / Simulation Analyst (FEA / CFD) | Mechanical, Aeronautical | FEA and CFD fundamentals, meshing, interpreting results | Simulation task | V3 verified |
| M04 | Production / Manufacturing Engineer | Mechanical, Production | Manufacturing processes, line balancing, lean basics, shop-floor problem solving | Scenarios, numerical problems | V3 verified |
| M05 | Quality Engineer (QA / QC) | Mechanical, Production, any | Metrology, SPC, 7 QC tools, ISO 9001 basics, root-cause analysis | Numerical problems, scenarios | V3 verified |
| M06 | Maintenance Engineer (mechanical) | Mechanical | Machine elements, preventive and predictive maintenance, hydraulics and pneumatics, safety | Scenarios | Selectable |
| M07 | Industrial / Process Improvement Engineer | Mechanical, Production | Work study, lean, Six Sigma basics, data analysis | Case | Selectable |
| M08 | HVAC Design Engineer (MEP) | Mechanical | Heat-load calculation, duct design, psychrometry, codes | Numerical problems, design task | V3 verified |
| M09 | Automotive Engineer (service / design) | Automobile, Mechanical | Vehicle systems, diagnostics, powertrain basics | Objective tests, scenarios | Selectable |
| M10 | CNC Programmer / Tool Design Engineer | Mechanical, Production | CNC G-code, CAM, tooling, tolerances | G-code simulation | Selectable |
| M11 | Aircraft Maintenance / MRO Engineer (trainee) | Aeronautical, Mechanical | Aircraft systems, regulation basics, maintenance documentation | Objective tests | Selectable |
| M12 | Piping Design Engineer | Mechanical, Chemical | Piping codes, isometrics, stress basics, P&IDs | Drawing task | Selectable |
| M13 | Sourcing / Supply Chain Engineer | Mechanical, Production, any | Procurement, vendor development, costing, ERP basics | Case | Selectable |
| M14 | Production Planning and Control (PPC) Engineer | Mechanical, Production | MRP, scheduling, inventory, capacity planning | Numerical problems, case | Selectable |
| P01 | Process Engineer (chemical) | Chemical | Mass and energy balances, unit operations, process flow diagrams, process simulation basics | Numerical problems, simulation | V3 verified |
| P02 | Production / Plant Operations Engineer (chemical, pharma, FMCG) | Chemical, Mechanical | Plant operations, SOPs, safety, troubleshooting | Scenarios | Selectable |
| P03 | QA / QC Analyst (pharma / chemical) | Chemical, Biotech, Pharmacy | Analytical methods, GMP and GLP, documentation | Objective tests, scenarios | Selectable |
| P04 | Process Safety / HSE Engineer | Chemical, Mechanical, any | HAZOP basics, risk assessment, safety regulations, incident investigation | Scenarios | V3 verified |
| P05 | Bioprocess / Biotech Associate | Biotech, Chemical | Fermentation, downstream processing, lab practice, GMP | Objective tests | Selectable |
| P06 | Environmental Engineer (treatment plants) | Chemical, Civil, Environmental | Water and wastewater treatment, air-pollution control, regulations | Numerical problems | Selectable |

## E. Civil and construction (11 roles)

| ID | Role | Typical branches | Core skill areas (draft) | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| V01 | Site Engineer / Graduate Engineer Trainee — Civil | Civil | Construction materials, site execution, surveying basics, reading drawings, safety | Scenarios, numerical problems | V2 verified |
| V02 | Structural Design Engineer | Civil | Structural analysis, RCC and steel design, IS codes, analysis software | Numerical problems, design task | V3 verified |
| V03 | Quantity Surveyor / Estimation and Billing Engineer | Civil | Quantity take-off, rate analysis, bill of quantities, billing, contract basics | Numerical problems, spreadsheet task | V3 verified |
| V04 | Planning Engineer | Civil, Mechanical | CPM / PERT scheduling, planning tools, progress tracking | Numerical problems, schedule artifact | Selectable |
| V05 | BIM Modeller / Engineer | Civil, Architecture | BIM concepts, modelling tools, clash coordination, drawings | Model artifact | Selectable |
| V06 | Highway / Transportation Engineer | Civil | Pavement design, traffic engineering, IRC codes | Numerical problems | Selectable |
| V07 | Geotechnical Engineer (junior) | Civil | Soil mechanics, foundations, soil testing | Numerical problems | Selectable |
| V08 | Water Resources / Public Health Engineer | Civil | Hydraulics, hydrology, water supply and sanitation | Numerical problems | Selectable |
| V09 | Quality Control Engineer — Civil | Civil | Material testing, QA / QC plans, IS standards | Scenarios, numerical problems | Selectable |
| V10 | Surveyor / GIS Analyst | Civil, Geo-informatics | Surveying instruments, GIS, remote-sensing basics | Practical GIS task | Selectable |
| V11 | MEP Coordinator | Civil, Mechanical, EEE | MEP drawings, clash detection, site coordination | Scenarios | Selectable |

## F. Business, finance, sales and operations — all branches (14 roles)

| ID | Role | Typical branches | Core skill areas (draft) | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| B01 | Management Trainee (general) | All branches | Business fundamentals, communication, problem solving, spreadsheets | Case; group discussion and interview later | V3 verified |
| B02 | Business / Operations Analyst | All branches | Spreadsheets, SQL basics, process mapping, reporting, communication | Case, spreadsheet task | V2 verified |
| B03 | Associate Consultant (technology / management) | All branches | Structured problem solving, case analysis, presentations, domain basics | Case, writing | V3 verified |
| B04 | Financial Analyst | All branches | Accounting basics, financial statements, spreadsheet modelling, valuation basics | Spreadsheet task | Selectable |
| B05 | Bank Probationary Officer / Bank Officer | All branches | Quantitative aptitude, reasoning, English, banking and financial awareness | Timed objective tests | V2 verified |
| B06 | Risk and Compliance Analyst (BFSI) | All branches | Risk basics, KYC / AML, regulations, analytics | Scenarios | Selectable |
| B07 | Equity Research / Investment Analyst (entry) | All branches | Financial analysis, valuation, report writing | Writing, spreadsheet task | Selectable |
| B08 | Pre-sales / Solutions Engineer | CSE, IT, ECE, any | Product knowledge, solution design basics, presentation, requirements gathering | Case; presentation later | V3 verified |
| B09 | Technical Sales / Business Development Executive | All branches | Product knowledge, communication, negotiation, CRM | Role-play later | V3 verified |
| B10 | Digital Marketing Executive | All branches | SEO and SEM, social media, analytics, content | Campaign artifact, analytics task | Selectable |
| B11 | Customer Success Associate | All branches | Product knowledge, communication, problem solving, CRM | Scenarios | Selectable |
| B12 | HR Associate / Talent Acquisition | All branches | Recruitment process, HR basics, communication, spreadsheets | Scenarios | Selectable |
| B13 | Supply Chain / Logistics Analyst | All branches | Logistics, inventory, forecasting basics, spreadsheets and SQL | Case, spreadsheet task | Selectable |
| B14 | Procurement Analyst | All branches | Sourcing, negotiation basics, vendor management, ERP | Case | Selectable |

## G. Goals that are not job roles

| ID | Goal | Goal type | Links to roles | Main evidence | Release |
| --- | --- | --- | --- | --- | --- |
| G01 | GATE (PSU jobs or M.Tech admission) | Exam | L01, M01, V01, E-series, P01 | Timed objective and numerical tests | V3 verified |
| G02 | Engineering Services / state PSC engineering exams | Exam | L01, M01, V01 | Timed objective tests | Selectable |
| G03 | Bank and other government recruitment exams | Exam | B05 | Timed aptitude tests (reuses the V1 aptitude block) | V2 verified |
| G04 | MBA entrance (CAT and similar) | Exam | B01, B03 | Timed aptitude and verbal tests | Selectable |
| G05 | Study abroad (GRE, IELTS / TOEFL) | Exam | Any | Timed tests; speaking in V3 | Selectable |
| G06 | IT services recruitment tests | Company preparation | S01, S06, S13 | Timed aptitude and coding tests | V2 verified |
| G07 | Product-company coding interviews | Company preparation | S02, S03, S04, D04 | Executed code; interview practice later | V3 verified |
| G08 | Employer-defined drive preparation | Company preparation | Any role the employer names | Employer's own career target | V2 |
| G09 | Industry certifications (cloud, networking, security, ISO 27001) | Certification | S09, S12, C-series | Objective tests, labs | V3 |
| G10 | Communication and interview skills | Topic | All roles | Writing rubric now; spoken interviews in V3 | V2 (writing), V3 (speech) |
| G11 | Any single topic ("teach me Docker", "improve my Excel") | Topic | Counts toward every role that requires it | Depends on the skill | V1 for verified topics; Explore mode in V3 |
| G12 | Entrepreneurship / start my own venture | Explore | B-series skills | Case, project | Selectable |
| G13 | "Not sure yet" | Career discovery | Suggests 3–5 roles from branch, interests and placement results | Short interest and strengths survey | V1 |

## H. Branch-to-role map and verification order

By V3, 52 of the 108 roles have verified tracks (1 in V1, 13 in V2, 38 in V3); the other 56 stay selectable until
demand justifies building them.

| Branch | Branch-specific roles | Cross-branch roles most students also target | Verified by V2 for this branch |
| --- | --- | --- | --- |
| CSE / IT | S01–S25, D01–D09, C01–C09 | B02, B05, B08 | S01, S02, S06, S13, D01, C01, C02 |
| ECE | E01–E10, E13, S12, C09 | S01, S06, S13, D01 | E01 (plus the cross-branch set) |
| EEE | L01–L07, E11, E12, C09 | S01, S09, D01 | L01 |
| Instrumentation / EIE | E10, E11, E12, C09 | S01, D01 | Cross-branch set only; E11 and E12 in V3 |
| Mechanical, Production, Automobile, Aeronautical | M01–M14, E12, E13, L05, L06 | S01, D01, B02, B13 | M01, M02 |
| Civil | V01–V11, P06 | S01, D01, B02 | V01 |
| Chemical, Biotech, Pharmacy | P01–P06, M12 | D01, B02, B06 | Cross-branch set only; P01 and P04 in V3 |
| Non-engineering (B.Sc, B.Com, BBA, BCA) | — | B-series, D01, D03, S06, S13, S19, S20 | Cross-branch set; BCA follows CSE / IT |

Every branch has at least five verified cross-branch options by V2 (S01, S06, S13, D01, B02, B05), plus the
shared aptitude block from V1.

| Release | Roles and goals verified | Why these first |
| --- | --- | --- |
| V1 | C01 SOC Analyst L1; shared aptitude block; G13 career discovery | Proves the engine end to end; aptitude serves every branch |
| V2 | S01, S02, S06, S13, D01, C02, E01, L01, M01, M02, V01, B02, B05; goals G03, G06, G08, G10 (writing) | Highest-volume campus hiring plus one core role for each major branch |
| V3 | The 38 rows marked V3 verified, reordered by demand data | Depth for each branch and the specialist roles recruiters ask for |
| Any time | Selectable roles promoted when demand crosses the threshold | Keeps building effort tied to real demand |

**Promotion rule (proposed):** a selectable role moves to the next release's build list when at least 200
students across at least 3 colleges select it, or when a paying employer asks for it as a drive target. The
catalogue is reviewed every semester; new roles enter as selectable through the same process.
