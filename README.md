# LabFix

A computer-lab maintenance app for students and operators. It links multilingual reports to a workstation and fault class, groups duplicates, records repairs, and reopens recent incidents when the fault returns. A retrieval-augmented triage copilot can investigate a ticket using runbooks and the workstation's repair history, then draft source-linked checks for staff review.

## Run the demo

Requires Node.js 24 or newer. The demo runs in evidence mode without a model endpoint.

```bash
npm ci
LABFIX_DEMO=1 npm start
```

On PowerShell, run `$env:LABFIX_DEMO = '1'` before `npm start`. Open [http://127.0.0.1:8080](http://127.0.0.1:8080). Demo mode binds to loopback and uses a separate SQLite file by default. The unlocked desk contains synthetic sample incidents, not real student data.

### Walkthrough

1. Open **Report** in **Innovation Lab**. The map identifies workstations with an active incident or a post-repair recurrence. Try the Bangla and Banglish example buttons to see how the same workstation and fault are identified before submitting.
2. Submit a report and choose **Track this report**. The private receipt shows the current repair stage and timestamps without exposing repair notes or student report text. Use **Copy receipt code** to save the code. Recent lookups are retained in memory until the page is refreshed or closed.
3. In **Operator desk**, open the **PC-17** sample recurrence. In **Triage copilot**, select **Recurring fault** and generate a draft. Inspect its citations, open **Retrieval activity**, and record an operator review. Use **Incident details** to assign the repair or change status, and **Reports & history** for the original reports and audit log. A matching report submitted within 30 days reopens a resolved incident, and the original receipt follows the new status.
4. Submit “The screen is blank near the window.” Confirm the location or merge it into an active incident from the **Needs review** queue. A merged report retains its receipt and history.
5. Select **Response overdue** to see incidents waiting past their first-response target. In **Workstations**, open **PC-06** to see an availability restriction and its internal history. Return it to service with a note, then check the student map.
6. Open **Knowledge library** to search the versioned runbooks, or **Analytics** for report volume, fault categories, and workstation recurrences. Export the filtered queue as CSV. Open **Matching evaluation** in the footer to compare the three intake matchers by language.

The responsive interface follows the browser's reduced-motion preference. Demo reports, workstation restrictions, and dates are synthetic. Use the production configuration for actual campus data.

## Run with a local LLM

Start an OpenAI-compatible inference server that supports native function tools and JSON-schema responses. For example, with llama.cpp and a locally stored tool-capable GGUF model:

```bash
llama-server --model /path/to/model.gguf --alias labfix-local --host 127.0.0.1 --port 8765 --jinja
LABFIX_DEMO=1 LABFIX_MODEL=labfix-local LABFIX_MODEL_URL=http://127.0.0.1:8765/v1 npm start
```

Set `LABFIX_MODEL_TOKEN` when the inference endpoint requires bearer authentication. The operator workspace shows the configured model, and each completed draft reports whether the model actually generated it. A missing, timed-out, or invalid model response yields a labeled evidence draft.

1. SQLite FTS5 retrieves runbooks using the ticket category and symptom text. The copilot exposes two read-only tools to the model, runbook search and repair-history lookup. Repair history is scoped to the same lab, workstation, and fault class.
2. The model selects an evidence tool through a native call. If the endpoint completes that request without a valid call, the model can select the same allowed tools through a constrained JSON response. After retrieval, the model selects a runbook and orders its diagnostic checks. The server verifies the cited IDs and renders the primary assessment and checks from the retrieved sources. The model may also supply a follow-up question.
3. Each draft stores the retrieval activity and source excerpts used to prepare it. An operator can record a review note on a current draft. Incident edits and new reports invalidate unfinished reviews. Staff change the incident status using the usual incident controls.

The configured endpoint receives bounded ticket and evidence excerpts. The app removes common e-mail addresses, links, and long numeric identifiers from excerpts. Use a trusted private inference endpoint for real lab data. Allow at least 75 seconds for inference requests at your reverse proxy.

## Deployment

Production mode requires a shared operator token of at least 24 characters. Students can submit reports without a token and track only a specific receipt using its random 24-character code. Operators enter the token in the desk, where it is retained only for that page session. The server gates incident listings, descriptions, and edits. For real operations, keep student access on a campus network or behind the institution's gateway, and terminate HTTPS at the reverse proxy. No individual staff accounts are included.

### Docker Compose

Generate a random token, export it in the shell, and start the service:

```bash
export LABFIX_OPERATOR_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d
curl -f http://127.0.0.1:8080/healthz
```

Keep the token in a secret manager before closing the shell. For subsequent launches, inject the same token or deliberately rotate it. Compose publishes on loopback and persists SQLite in the `labfix-data` volume. Set `LABFIX_PORT` to change the host port and point your HTTPS reverse proxy at that port. Set the optional model variables to reach a private inference service from the container. The container runs as the unprivileged Node user with a read-only root filesystem. Its volume holds the SQLite database and write-ahead log.

### Direct Node service

Run `npm start` with `LABFIX_OPERATOR_TOKEN` set. Use `PORT`, `HOST`, and `LABFIX_DB` to configure the bind address and database path. Point the SQLite path to persistent storage. Use a single application instance per database on a local filesystem. Back up the database using a SQLite-consistent snapshot or stop the application before copying its database files.

The API rate limit uses direct source IP addresses. Behind a campus reverse proxy, configure a per-client limit at the edge and account for the built-in shared upstream limit of 30 report requests per minute per API peer. Lab names, maps and seat numbering are configured in `store.mjs` and `matching.mjs`. The sample layout has two labs with 18 workstations each.

## Design

- **Report intake.** Unicode normalization handles Bangla digits. A workstation ID or row/seat clue is matched against the lab's inventory. Conflicting clues go to the review queue.
- **Multilingual NLP.** The fault scorer combines multilingual lexical and phrase evidence with character-trigram cosine similarity against labelled examples. A minimum score and a lead over the next class are required for automatic classification. The model is lightweight and uses manually written examples.
- **Incident matching.** A known workstation and fault class can link a report only within the same lab. Active incidents take priority. When a matching issue returns within 30 days of resolution, LabFix reopens that incident and increments its recurrence count. A report in the same category can represent a distinct underlying failure. Repair staff own that decision.
- **Operator workflow.** Priorities and assignments are persisted and logged. The operator can use the fault checklist and past repairs on the same machine to triage similar incidents. Analytics include the last 14 UTC days and all-time fault and recurrence counts. Queue filters and export operate on the 250 most recently updated incidents.
- **Response targets.** Urgent, high, and normal priorities have first-response targets of 2, 8, and 24 hours from the start of the current incident cycle. Moving an incident to In progress or Resolved records a first response. A new cycle starts on reopening, and the current priority sets that cycle's target. Operator updates check for intervening changes before saving.
- **Workstation availability.** Staff can take a workstation out of service or return it to use. Each change records a timestamp and an internal note for the selected lab. The public map shows the availability without exposing the note. Incident status and workstation availability can change independently.
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

The API suite covers receipt tracking through status changes and merges, production operator access, workstation availability, and response targets. Docker Compose configuration can be validated with `LABFIX_OPERATOR_TOKEN=replace-with-a-long-secret docker compose config --quiet`.

Evaluate copilot retrieval and check provenance separately from the intake matcher:

```bash
npm run evaluate:copilot
npm run evaluate:copilot -- --live
```

The ten authored copilot cases compare a category-only lookup against ranked runbook retrieval. The live variant reports model completions, labeled fallbacks, expected runbook citations, source-backed checks, and per-case latency. These fixtures test retrieval against the bundled library. Operator-rated usefulness and performance on independent campus tickets require a pilot.

In the local Qwen3-0.6B run, the expected runbook ranked first in 10 of 10 cases, compared with 4 of 10 for the category-only lookup. The model completed nine drafts. The unconfirmed-workstation case stayed in evidence mode for manual triage. All suggested check IDs mapped to retrieved sources.

A pilot could start in one lab and compare first-pass report routing against lab-operator labels. Report joint accuracy, false merges, operator review rate, and time to triage, with a split by language and a separate split by collection week.

## Code map

| Path | Responsibility |
| --- | --- |
| `public/` | Student form, interactive workstation map, and operator views |
| `server.mjs` | HTTP API, validation, and operator authorization |
| `matching.mjs` | Workstation parsing and multilingual fault scoring |
| `knowledge.mjs`, `copilot.mjs` | Versioned runbooks, SQLite retrieval, read-only model tools, and draft validation |
| `store.mjs` | SQLite schema, transactional incident workflow, and demo data |
| `eval/` | Benchmark cases and reproducible results |
| `test/` | Node test suite and HTTP integration |
| `Dockerfile`, `compose.yml` | Container and persistent volume |

### Portfolio description

LabFix is a full-stack multilingual maintenance prototype that links English, Bangla, and Banglish reports to campus workstations and tracks post-repair recurrences. Its matching engine was evaluated against keyword and multilingual lexical baselines on 54 authored cases, with separate reporting for the challenge set. Describe your individual contributions accurately when presenting the project.
