# LabFix

A computer-lab maintenance app for students and operators. It links multilingual reports to a workstation and fault class, groups duplicates, records repairs, and reopens recent incidents when the fault returns.

## Run the demo

Requires Node.js 24 or newer. No dependencies or external AI service are required.

```bash
LABFIX_DEMO=1 npm start
```

On PowerShell, run `$env:LABFIX_DEMO = '1'` before `npm start`. Open [http://127.0.0.1:8080](http://127.0.0.1:8080). Demo mode binds to loopback and uses a separate SQLite file by default. The unlocked desk contains synthetic sample incidents, not real student data.

### Walkthrough

1. Open **Report** in **Innovation Lab**. The map identifies workstations with an active incident or a post-repair recurrence. Try the Bangla and Banglish example buttons to see how the same workstation and fault are identified before submitting.
2. Submit a report and choose **Track this report**. The private receipt shows status updates without exposing repair notes or student report text. Save the code to reopen the receipt later.
3. In **Operator desk**, search for **PC-17**. Open its repair history and triage checklist. Assign it to Hardware, set its priority, and resolve it with a note. A matching report submitted within 30 days reopens the incident. The original receipt follows the new status.
4. Submit “The screen is blank near the window.” Confirm the location or merge it into an active incident from the **Needs review** queue. A merged report retains its receipt and history.
5. Open **Analytics** for daily report volume, fault categories, and workstations ordered by recurrence. Export the currently filtered queue as a CSV of incident metadata.

The desktop and mobile layouts use the same controls. Motion follows the browser’s reduced-motion preference. Demo dates and reports are synthetic. Use the full production mode below for actual campus data.

## Deployment

Production mode requires a shared operator token of at least 24 characters. Students can submit reports without a token and track only a specific receipt using its random 24-character code. Operators enter the token in the desk, where it is retained only for that page session. The server gates incident listings, descriptions, and edits. For real operations, keep student access on a campus network or behind the institution's gateway, and terminate HTTPS at the reverse proxy. No individual staff accounts are included.

### Docker Compose

Generate a random token, export it in the shell, and start the service:

```bash
export LABFIX_OPERATOR_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d
curl -f http://127.0.0.1:8080/healthz
```

Keep the token in a secret manager before closing the shell. For subsequent launches, inject the same token or deliberately rotate it. Compose publishes on loopback and persists SQLite in the `labfix-data` volume. Route your existing HTTPS reverse proxy to port 8080 on the host. The container runs as the unprivileged Node user. Docker tooling was unavailable during validation.

### Direct Node service

Run `npm start` with `LABFIX_OPERATOR_TOKEN` set. Use `PORT`, `HOST`, and `LABFIX_DB` to configure the bind address and database path. Point the SQLite path to persistent storage. Use a single application instance per database on a local filesystem. Back up the database using a SQLite-consistent snapshot or stop the application before copying its database files.

The API rate limit uses direct source IP addresses. Behind a campus reverse proxy, configure a per-client limit at the edge and account for the built-in shared upstream limit of 30 report requests per minute per API peer. Lab names, maps and seat numbering are configured in `store.mjs` and `matching.mjs`. The sample layout has two labs with 18 workstations each.

## Design

- **Report intake.** Unicode normalization handles Bangla digits. A workstation ID or row/seat clue is matched against the lab's inventory. Conflicting clues go to the review queue.
- **Multilingual NLP.** The fault scorer combines multilingual lexical and phrase evidence with character-trigram cosine similarity against labelled examples. A minimum score and a lead over the next class are required for automatic classification. The model is lightweight and uses manually written examples.
- **Incident matching.** A known workstation and fault class can link a report only within the same lab. Active incidents take priority. When a matching issue returns within 30 days of resolution, LabFix reopens that incident and increments its recurrence count. A report in the same category can represent a distinct underlying failure. Repair staff own that decision.
- **Operator workflow.** Priorities and assignments are persisted and logged. The operator can use the fault checklist and past repairs on the same machine to triage similar incidents. Analytics include the last 14 UTC days and all-time fault and recurrence counts. Queue filters and export operate on the 250 most recently updated incidents.
- **Persistence.** SQLite transactions commit the report, incident state, and history together. Retry keys keep repeated submissions from creating duplicate records. Operator merges retain the reports and timeline. Uncertain reports stay in an explicit review state.
- **Privacy.** The intake asks for an issue description, with no student name or contact field. The public API returns a receipt without exposing existing report text. Operators should establish a retention period before collecting real reports.

## Evidence and evaluation

```bash
npm test
npm run evaluate
```

Run `npm run evaluate -- --challenge` to reproduce the second evaluation. Both fixture sets contain authored English, Bangla, and Banglish reports, including missing locations, competing workstation clues, and ambiguous fault terms. Both are supplied with per-case outputs. They do not come from live lab logs.

| Evaluation | ASCII keyword baseline | Multilingual lexical rules | Hybrid matcher |
| --- | ---: | ---: | ---: |
| Original examples, exact workstation and fault | 11/30 | 26/30 | 26/30 |
| Challenge set, exact workstation and fault | 13/24 | 22/24 | 22/24 |
| Original examples, incorrect automatic-link candidates | 1 | 1 | 0 |
| Challenge set, incorrect automatic-link candidates | 0 | 0 | 0 |

The ablation uses the same workstation parser and multilingual rules with character similarity removed. The hybrid matcher did not improve exact accuracy over that ablation. It did turn one incorrect automatic-link candidate in the original set into a review case. The two challenge misses were sent to review. These small sets cannot establish a campus false-merge rate. No campus pilot, live student dataset, or LLM inference was used.

The browser walkthrough verified report submission, receipt tracking, incident detail and repair history, and analytics. The API integration test also verifies that a receipt follows an operator change and a subsequent merge. Docker was not available for a container smoke test.

A pilot could start in one lab and compare first-pass report routing against lab-operator labels. Report joint accuracy, false merges, operator review rate, and time to triage, with a split by language and a separate split by collection week.

## Code map

| Path | Responsibility |
| --- | --- |
| `public/` | Student form, interactive workstation map, and operator views |
| `server.mjs` | HTTP API, validation, and operator authorization |
| `matching.mjs` | Workstation parsing and multilingual fault scoring |
| `store.mjs` | SQLite schema, transactional incident workflow, and demo data |
| `eval/` | Benchmark cases and reproducible results |
| `test/` | Node test suite and HTTP integration |
| `Dockerfile`, `compose.yml` | Container and persistent volume |

### Portfolio description

LabFix is a full-stack multilingual maintenance prototype that links English, Bangla, and Banglish reports to campus workstations and tracks post-repair recurrences. Its matching engine was evaluated against keyword and multilingual lexical baselines on 54 authored cases, with separate reporting for the challenge set. Describe your individual contributions accurately when presenting the project.
