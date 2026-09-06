# Draft update: generic in-chat cards and external-app processing

Target: existing [fork PR #73](https://github.com/ktimam/open-chat/pull/73), stacked on the
refreshed model PR. Keep draft status; retarget upstream only after the stack is agreed.
This is a prepared description, not a PR update or publication action.

## Summary

Provide reusable registered app interfaces for chat: bounded manifests and app enablement,
scoped linking, isolated app-authored cards, private context, exact content attestation,
user-reviewed confirmation and authenticated delivery.

The newer integration checkpoint adds a generic app-owned local processor. An app declares
the protocol in its registered schema and receives bounded text/OCR evidence for extraction,
or model candidates for normalization. The host supplies inference and validation plumbing;
the app owns interpretation, labels, field meanings and final backend constraints.

## Security and lifecycle

- Registered app surfaces only; opaque credentialless sandbox, exact source-window checks,
  independent frame/request nonces and bounded timeouts/concurrency.
- No account credentials, private-context grant or consumer keys in processing messages.
- Validate raw candidates and returned candidates before card construction.
- Preserve exact app-authored content verification, confirmation binding and versioned delivery.
- Reconnect/retry must retain prepared work without silently repeating model inference or
  treating an unverified card as accepted.
- Keep production/testnet capability brakes, backend authorization and snapshot restrictions.
- Keep app-specific code, prompts, fixtures and examples in their app repositories.

Protocol reference: [Local app processing](../local-app-processing.md).

## Verification and readiness

The combined integration follow-up passed 1,862 frontend tests, both typechecks and read-only
lint. App-host boundary checks found no findings. Recorded-response
replay, real model inference and fully verified app-card flows remain distinct evidence.
A complete physical-phone partner-card run is still outstanding.

The existing PR is 16 commits behind the integration checkpoint and includes no reported
hosted checks. Refresh and independently validate its app-only scope after PR1 is refreshed.
Do not copy the combined checkpoint into this PR while calling it app-interface-only.

Release remains blocked by expired/drifted dependency policies, fresh advisory findings,
complete final-head CI, coordinated backend rollout and artifact/runtime acceptance. Publisher
signing/version requirements are separate from the requested locally signed test APK.
See [release readiness](model-app-readiness.md) for the exact snapshot and required sequence.
This draft does not request production activation or claim release readiness.
