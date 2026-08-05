#!/usr/bin/env bash
# Read-only, fail-closed validation for a deployed generic action inbox. No canister state is changed.
set -euo pipefail

NETWORK=${1:?"usage: validate-action-inbox-wiring.sh <dfx-network> [action-inbox-id] [user-index-id] [local-user-index-id] <app-id>"}
ACTION_INBOX_ID=${2:-$(dfx canister --network "$NETWORK" id action_inbox)}
USER_INDEX_ID=${3:-$(dfx canister --network "$NETWORK" id user_index)}
LOCAL_USER_INDEX_ID=${4:-$(dfx canister --network "$NETWORK" id local_user_index)}
APP_ID=${5:?"the immutable registered app id is required"}

for value in "$ACTION_INBOX_ID" "$USER_INDEX_ID" "$LOCAL_USER_INDEX_ID"; do
  test -n "$value" || { echo "required canister id is empty" >&2; exit 1; }
done
test "$ACTION_INBOX_ID" != "$USER_INDEX_ID" || { echo "action_inbox and user_index ids must differ" >&2; exit 1; }
printf '%s' "$APP_ID" | grep -Eq '^[1-9][0-9]*$' || { echo "app id must be a positive integer" >&2; exit 1; }

CONFIG=$(dfx canister --network "$NETWORK" call "$ACTION_INBOX_ID" configuration '(record {})')
printf '%s' "$CONFIG" | grep -Eq "app_id[[:space:]]*=[[:space:]]*$APP_ID([[:space:]]*:[[:space:]]*nat32)?" || {
  echo "action_inbox is not bound to expected app id $APP_ID" >&2
  exit 1
}
printf '%s' "$CONFIG" | grep -Fq "$USER_INDEX_ID" || {
  echo "action_inbox configuration does not reference the expected user_index" >&2
  exit 1
}
CONFIG_PRINCIPALS=$(printf '%s' "$CONFIG" | grep -oE '[a-z0-9]{5}(-[a-z0-9]{5})+-[a-z0-9]{3}' | sort -u)
test "$CONFIG_PRINCIPALS" = "$USER_INDEX_ID" || {
  echo "action_inbox has an unexpected UserIndex or depositor allowlist: $CONFIG_PRINCIPALS" >&2
  exit 1
}

LUI_ROUTE=$(dfx canister --network "$NETWORK" call "$LOCAL_USER_INDEX_ID" action_inbox_canister '(record {})')
printf '%s' "$LUI_ROUTE" | grep -Fq "$ACTION_INBOX_ID" || {
  echo "local_user_index is not routed to the expected action_inbox" >&2
  exit 1
}

SIGNING_KEYS=$(dfx canister --network "$NETWORK" call "$USER_INDEX_ID" action_signing_keys '(record {})')
printf '%s' "$SIGNING_KEYS" | grep -Fq 'action_inbox_deposit' || {
  echo "user_index does not expose the dedicated action-inbox signing-key purpose" >&2
  exit 1
}
printf '%s' "$SIGNING_KEYS" | grep -Eq 'signature_version[[:space:]]*=[[:space:]]*4([[:space:]]*:[[:space:]]*nat16)?' || {
  echo "user_index does not advertise action-inbox signature version 4" >&2
  exit 1
}
printf '%s' "$SIGNING_KEYS" | grep -Fq 'Active' || {
  echo "user_index has no active action-inbox signing key" >&2
  exit 1
}

echo "action_inbox wiring valid: app=$APP_ID inbox=$ACTION_INBOX_ID relay=$USER_INDEX_ID local_user_index=$LOCAL_USER_INDEX_ID"
echo "action_signing_keys is discovery metadata only; verify the active key id against the consumer's independently pinned allowlist"
