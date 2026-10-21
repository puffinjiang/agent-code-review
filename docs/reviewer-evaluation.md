# Reviewer evaluation protocol

The unit tests check data handling, installation safety, template syntax, and the
finding protocol. They do not run an LLM, prove native subagent discovery, or
measure review recall or false-positive rates. All platform `verified` flags
remain false until native runtime checks have been recorded.

## Native platform smoke test

For each supported host and version, install into an isolated home or disposable
repository. Record host version, model, date, scope, mode, and installed file
hashes. Confirm that the platform discovers all five named roles and that their
actual instruction bodies match the installed templates. A parser accepting TOML
or YAML is not enough.

Run quick, standard, and deep reviews. Record native delegation traces showing
each selected reviewer and a separate verifier. Check bounded scheduling when
there are fewer available slots than requested roles. With delegation disabled,
verify that the report discloses the limitation rather than claims independence.
Check staged and historical source snapshots, including worktree content that
differs from the target. Confirm that the repository and Git state are unchanged.

## Detection and counter-evidence cases

Use isolated test repositories. Keep expected outcomes outside the reviewer's
input so it cannot read answer labels, BUG comments, or this evaluation guide as
evidence. Pair every real defect with a closely related protected version:

| Category | Defect case | Counter-evidence case |
| --- | --- | --- |
| Correctness | Changed state transition violates a caller contract | The apparently missing check is enforced by that contract |
| Correctness | Scheduled cleanup deletes retained data on an empty selection | Cleanup safely returns when the selection is empty |
| Security | One tenant can read another tenant's object | An enforced row-level/ownership constraint covers that path |
| Security | Untrusted input reaches a raw SQL sink | The same input is bound as a query parameter |
| Concurrency | Two workers can claim and bill the same job | An atomic conditional claim permits one winner |
| Concurrency | Retried delivery repeats a non-idempotent action | A persisted idempotency key and constraint prevent repetition |
| Performance | Per-item queries run over an unbounded request collection | A bounded startup-only loop or a verified batched query |
| Performance | Query degrades with realistic scale and no supporting index | A schema-defined index supports the actual predicate |

Include cases with missing schema or runtime context: the correct verifier result
is NEEDS_VERIFICATION unless the available source proves or disproves the claim.
Include unrelated pre-existing defects, distinct bugs on adjacent lines, and the
same pattern in two files. Check origin classification and preservation of each
supported trigger/location.

## Measurements and reporting

Run each case multiple times with fixed configuration and collect raw candidate
JSON, verifier JSON, final report, and tool traces. Score candidate recall,
confirmed recall, confirmed precision, supported rejections, uncertain cases,
severity, origin, and exact-location accuracy separately. A consensus among
reviewers is not independent source evidence. Count a confirmed finding without
an independent supporting trace as an invalid confirmation.

Publish denominators, repetitions, model/host versions, and failed cases alongside
any aggregate result. Claim a reduction in false positives only after comparison
against a defined baseline on the same held-out cases. Keep installation tests,
fixture behavior tests, and model detection evaluations separately labeled.

No native platform evaluation or model accuracy measurements have been recorded
in this repository yet.
