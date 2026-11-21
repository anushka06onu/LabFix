# LabFix

A computer-lab maintenance app for students and operators. It links multilingual reports to a workstation and fault class, groups duplicates, records repairs, and reopens recent incidents when the fault returns.

## Run the demo

Requires Node.js 24 or newer. No dependencies or external AI service are required.

```bash
LABFIX_DEMO=1 npm start
```

On PowerShell, run `$env:LABFIX_DEMO = '1'` before `npm start`. Open [http://127.0.0.1:8080](http://127.0.0.1:8080). Demo mode binds to loopback and uses a separate SQLite file by default. The unlocked desk contains synthetic sample incidents, not real student data.

### Walkthrough

1. Open **Operator desk** and select **PC-17** in **Innovation Lab**. Three sample reports show the original incident, post-repair recurrence and duplicate report. The repair note remains visible.
2. Use **Report a fault** to submit “last row seat 5 off hoy every few minutes” in that lab. The receipt confirms that it linked to the active incident.
3. Resolve the incident with a repair note and submit “পিসি ১৭ বারবার বন্ধ হয়ে যায়.” Refresh the operator desk to see it reopened with a new recurrence.
4. Submit “The screen is blank near the window.” The report goes to **Needs review**. The operator can confirm the asset and fault or merge the report into an existing active incident.

## Deployment

Production mode requires a shared operator token of at least 24 characters. Students can submit reports without a token. Operators enter the token in the desk, where it is retained only for that page session. The server gates incident listings, descriptions, and edits. For real operations, keep student access on a campus network or behind the institution's gateway, and terminate HTTPS at the reverse proxy. No individual staff accounts are included.

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
- **Persistence.** SQLite transactions commit the report, incident state, and history together. Retry keys keep repeated submissions from creating duplicate records. Operator merges retain the reports and timeline. Uncertain reports stay in an explicit review state.
- **Privacy.** The intake asks for an issue description, with no student name or contact field. The public API returns a receipt without exposing existing report text. Operators should establish a retention period before collecting real reports.

## Evidence and evaluation

```bash
npm test
npm run evaluate
```

The 30-case fixture suite contains English, Bangla, and Banglish examples, including missing locations and conflicting clues. The simple baseline uses explicit workstation IDs and keyword-only scoring for ASCII reports. The multilingual system adds row/seat parsing, bilingual lexical coverage, and trigram similarity. The comparison measures these changes together. `eval/results.json` contains the outputs and errors per example.

| Metrics on authored fixtures | Baseline | LabFix |
| --- | ---: | ---: |
| Correct workstation or abstention | 22/30 | 30/30 |
| Correct fault or abstention | 18/30 | 26/30 |
| Exact workstation and fault pair | 11/30 | 26/30 |
| Incorrect automatic-link candidates | 1 | 0 |

Zero incorrect candidates in this small fixture set does not establish a deployment error rate. Four fault identifications were missed. No campus pilot or student dataset was used. Tests cover repair and recurrence, lab and fault isolation, durable storage, authorization, and operator merge behavior. No LLM inference runs in the application.

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

LabFix is a full-stack multilingual maintenance prototype that links English, Bangla, and Banglish reports to campus workstations and tracks post-repair recurrences. Its matching engine was benchmarked against a keyword baseline on 30 authored cases. Describe your individual contributions accurately when presenting the project.
