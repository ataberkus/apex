# Independent process watchdog review

**Verdict: no blocking finding in the two-file diff.** Reviewed the current diff for `scripts/micro-process.mjs` and `tests/process-micro.test.mjs` using the repository's `version-control` Git metadata, plus the surrounding implementation. No source or test files were changed by this reviewer.

The production change resets the fallback deadline once, after the final readiness observation, only when no validated service endpoint is available. Process launch and native host exit do not establish when detached Node evaluates its watchdog timer. Reserving the full existing 3500 ms lease plus 250 ms margin at the later missing-endpoint boundary covers the demonstrated startup delay while retaining a finite deadline. Successful readiness/health/self-shutdown paths are unaffected. The service watchdog duration, native bash timeout, host deadline, HTTP deadline, benchmark configuration and runtime resources are unchanged.

Ownership remains confined to the newly allocated fixture. Endpoint cleanup uses the private token and asks the fixture service to signal its own `process.pid`; the new line introduces no service-PID signal or arbitrary process selection. Missing-endpoint cleanup waits for the private fixture's watchdog record. The only direct child termination remains the existing bounded host/test-wrapper handling. The fallback does not turn a failed readiness check into a passing gate: the failure artifact remains a failure even after watchdog termination is confirmed.

The new test injects 750 ms before the actual detached service initializes its token/watchdog/listener. It also makes readiness unreadable at the existing wrapper boundary, while recording the real endpoint for an independent post-return connection refusal. This reproduces the relevant ordering with the real native bash host and real loopback service. It asserts both the watchdog's termination record and disappearance of the service after fixture removal; the existing test gains the failure artifact as assertion context. The wrapper and cleanup continue to use the scrubbed environment and ephemeral loopback only.

Evidence read, rather than executed by this reviewer:

- `validation/phase3-unit-watchdog-failure.log`: the earlier full suite failed the existing missing-readiness confirmation assertion; the native Phase 3 gate passed in that run.
- `validation/phase3-watchdog-red.log`: the new delayed-initialization regression failed before the fix (6.90 seconds), with no `watchdog_termination_confirmed` field and no confirmed process termination in its artifact.
- `validation/phase3-watchdog-green.log`: root's focused process suite passed 5/5 in 16.89 seconds, including the delayed regression in 6.80 seconds.

Independently executed only `node --check` for the two reviewed JavaScript files under a whitelisted environment; both returned exit 0. No concurrent service execution was added while root's fresh global checks were running. No provider, auth, credential or external-network operation was performed by this review.

The lease reanchor is an operational timing bound, not a proof against arbitrary scheduling starvation or initialization that begins after the last readiness attempt. Polling and filesystem operations can also delay wall-clock return beyond nominal timer arithmetic. The unchanged outer 9 second test-wrapper guard remains the hard test bound; root's focused run leaves practical margin for the demonstrated 750 ms case. No claim about benchmark timeout behavior or production process supervision follows from this fixture correction.
