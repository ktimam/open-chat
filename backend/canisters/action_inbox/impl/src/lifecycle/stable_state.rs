use crate::Data;
use canister_logger::LogEntry;
use serde::Deserialize;
use std::io::{Read, Write};

// Keep this positional wire format compatible with all previously deployed ActionInbox builds.
// In particular, the three Vec<LogEntry> slots are errors, logs, and traces in that order.
type StableState = (Data, Vec<LogEntry>, Vec<LogEntry>, Vec<LogEntry>);

pub(super) struct RestoredStableState {
    pub data: Data,
    pub errors: Vec<LogEntry>,
    pub logs: Vec<LogEntry>,
    pub purged_trace_count: usize,
}

pub(super) fn write(writer: impl Write, data: &Data, errors: Vec<LogEntry>, logs: Vec<LogEntry>) {
    let (errors, logs, _) = normalize_history(errors, logs, Vec::new());

    // Preserve the legacy four-element tuple shape, but never carry trace payloads across an
    // upgrade. Trace messages can contain update arguments and must not become durable data.
    let traces: Vec<LogEntry> = Vec::new();
    msgpack::serialize((data, errors, logs, traces), writer).unwrap();
}

pub(super) fn read(reader: impl Read) -> RestoredStableState {
    let (data, errors, logs, historical_traces): StableState = msgpack::deserialize(reader).unwrap();
    let (errors, logs, purged_trace_count) = normalize_history(errors, logs, historical_traces);

    RestoredStableState {
        data,
        errors,
        logs,
        purged_trace_count,
    }
}

#[derive(Deserialize)]
struct PersistedLogMetadata {
    level: Option<String>,
}

#[derive(Clone, Copy)]
enum PersistedLevel {
    Error,
    Log,
    Trace,
    Unknown,
}

fn persisted_level(entry: &LogEntry) -> PersistedLevel {
    match serde_json::from_str::<PersistedLogMetadata>(&entry.message)
        .ok()
        .and_then(|metadata| metadata.level)
        .as_deref()
    {
        Some(level) if level.eq_ignore_ascii_case("error") => PersistedLevel::Error,
        Some(level) if level.eq_ignore_ascii_case("trace") => PersistedLevel::Trace,
        Some(level)
            if level.eq_ignore_ascii_case("info")
                || level.eq_ignore_ascii_case("warn")
                || level.eq_ignore_ascii_case("debug") =>
        {
            PersistedLevel::Log
        }
        _ => PersistedLevel::Unknown,
    }
}

fn is_sensitive_action_history(entry: &LogEntry) -> bool {
    ["c2c_notify_actions", "acknowledge_actions"]
        .iter()
        .any(|marker| entry.message.contains(marker))
}

fn normalize_history(
    errors: Vec<LogEntry>,
    logs: Vec<LogEntry>,
    traces: Vec<LogEntry>,
) -> (Vec<LogEntry>, Vec<LogEntry>, usize) {
    let mut normalized_errors = Vec::with_capacity(errors.len());
    let mut normalized_logs = Vec::with_capacity(logs.len());
    let mut purged = 0;

    // A historical ActionInbox post-upgrade decoded (errors, logs, traces) as
    // (logs, traces, errors). Classifying structured entries by their recorded level repairs a
    // state that the vulnerable build subsequently re-persisted.
    for entry in errors {
        if is_sensitive_action_history(&entry) || matches!(persisted_level(&entry), PersistedLevel::Trace) {
            purged += 1;
        } else if matches!(persisted_level(&entry), PersistedLevel::Log) {
            normalized_logs.push(entry);
        } else {
            normalized_errors.push(entry);
        }
    }
    for entry in logs {
        if is_sensitive_action_history(&entry) || matches!(persisted_level(&entry), PersistedLevel::Trace) {
            purged += 1;
        } else if matches!(persisted_level(&entry), PersistedLevel::Error) {
            normalized_errors.push(entry);
        } else {
            normalized_logs.push(entry);
        }
    }
    for entry in traces {
        if is_sensitive_action_history(&entry) {
            purged += 1;
            continue;
        }
        match persisted_level(&entry) {
            PersistedLevel::Error => normalized_errors.push(entry),
            PersistedLevel::Log => normalized_logs.push(entry),
            // Unknown entries in the trace slot cannot be proven payload-free.
            PersistedLevel::Trace | PersistedLevel::Unknown => purged += 1,
        }
    }

    normalized_errors.sort_by_key(|entry| entry.timestamp);
    normalized_logs.sort_by_key(|entry| entry.timestamp);
    (normalized_errors, normalized_logs, purged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use serde::Serialize;
    use serde_bytes::ByteBuf;
    use std::collections::{BTreeMap, HashSet};

    fn entry(timestamp: u64, message: &str) -> LogEntry {
        LogEntry {
            timestamp,
            message: message.to_string(),
        }
    }

    fn trace_entry(timestamp: u64, secret: &str) -> LogEntry {
        entry(
            timestamp,
            &format!(r#"{{"timestamp":"{timestamp}","level":"TRACE","fields":{{"secret":"{secret}"}}}}"#),
        )
    }

    fn structured_entry(timestamp: u64, level: &str, target: &str, message: &str) -> LogEntry {
        entry(
            timestamp,
            &format!(
                r#"{{"timestamp":"{timestamp}","level":"{level}","target":"{target}","fields":{{"message":"{message}"}}}}"#
            ),
        )
    }

    fn assert_entry(actual: &LogEntry, timestamp: u64, message: &str) {
        assert_eq!(actual.timestamp, timestamp);
        assert_eq!(actual.message, message);
    }

    fn data() -> Data {
        let canister_id = Principal::from_slice(&[1]);
        Data::new(7, canister_id, canister_id, Vec::new(), Vec::new(), true)
    }

    #[test]
    fn decodes_legacy_tuple_slots_and_purges_historical_traces() {
        let bytes = msgpack::serialize_to_vec((
            &data(),
            vec![entry(11, "ERROR_SENTINEL"), trace_entry(12, "MISCLASSIFIED_TRACE_SECRET")],
            vec![entry(22, "LOG_SENTINEL")],
            vec![trace_entry(33, "HISTORICAL_TRACE_SECRET")],
        ))
        .unwrap();

        let restored = read(bytes.as_slice());

        assert_entry(&restored.errors[0], 11, "ERROR_SENTINEL");
        assert_entry(&restored.logs[0], 22, "LOG_SENTINEL");
        assert_eq!(restored.purged_trace_count, 2);
        assert!(
            restored
                .errors
                .iter()
                .chain(&restored.logs)
                .all(|entry| !entry.message.contains("TRACE_SECRET"))
        );
    }

    #[test]
    fn new_tuple_round_trip_preserves_slots_without_persisting_traces() {
        let mut bytes = Vec::new();
        write(
            &mut bytes,
            &data(),
            vec![entry(44, "ERROR_SENTINEL"), trace_entry(45, "MISCLASSIFIED_TRACE_SECRET")],
            vec![entry(55, "LOG_SENTINEL")],
        );

        let (_, errors, logs, traces): StableState = msgpack::deserialize(bytes.as_slice()).unwrap();
        assert_entry(&errors[0], 44, "ERROR_SENTINEL");
        assert_eq!(errors.len(), 1);
        assert_entry(&logs[0], 55, "LOG_SENTINEL");
        assert!(traces.is_empty());

        let restored = read(bytes.as_slice());
        assert_entry(&restored.errors[0], 44, "ERROR_SENTINEL");
        assert_entry(&restored.logs[0], 55, "LOG_SENTINEL");
        assert_eq!(restored.purged_trace_count, 0);
    }

    #[test]
    fn vulnerable_rotation_is_repaired_without_losing_safe_history_or_state() {
        let mut fixture = data();
        fixture.oversized_deposit_batches_rejected = 41;

        // This is the tuple a vulnerable build could write after it restored the committed tuple
        // as (data, logs, traces, errors): old traces land in errors, old errors in logs, and old
        // logs in traces. New same-sink entries can be interleaved with those rotated vectors.
        let bytes = msgpack::serialize_to_vec((
            &fixture,
            vec![
                structured_entry(
                    10,
                    "TRACE",
                    "action_inbox_canister_impl::updates::c2c_notify_actions",
                    "DEPOSIT_SECRET",
                ),
                structured_entry(40, "ERROR", "safe::new_error", "SAFE_ERROR_NEW"),
            ],
            vec![
                structured_entry(20, "ERROR", "safe::old_error", "SAFE_ERROR_OLD"),
                structured_entry(50, "INFO", "safe::new_log", "SAFE_LOG_NEW"),
            ],
            vec![
                structured_entry(30, "INFO", "safe::old_log", "SAFE_LOG_OLD"),
                structured_entry(60, "TRACE", "safe::unrelated_trace", "SAFE_TRACE"),
            ],
        ))
        .unwrap();

        let restored = read(bytes.as_slice());
        assert_eq!(restored.data.oversized_deposit_batches_rejected, 41);
        assert_eq!(restored.purged_trace_count, 2);
        assert_eq!(
            restored.errors.iter().map(|entry| entry.timestamp).collect::<Vec<_>>(),
            vec![20, 40]
        );
        assert_eq!(
            restored.logs.iter().map(|entry| entry.timestamp).collect::<Vec<_>>(),
            vec![30, 50]
        );
        assert!(
            restored
                .errors
                .iter()
                .chain(&restored.logs)
                .all(|entry| { !entry.message.contains("DEPOSIT_SECRET") && !entry.message.contains("SAFE_TRACE") })
        );

        // A second upgrade preserves the repaired identities and cannot re-persist purged data.
        let mut rewritten = Vec::new();
        write(&mut rewritten, &restored.data, restored.errors.clone(), restored.logs.clone());
        let second = read(rewritten.as_slice());
        assert_eq!(second.data.oversized_deposit_batches_rejected, 41);
        assert_eq!(second.purged_trace_count, 0);
        assert_eq!(
            second.errors.iter().map(|entry| entry.timestamp).collect::<Vec<_>>(),
            vec![20, 40]
        );
        assert_eq!(
            second.logs.iter().map(|entry| entry.timestamp).collect::<Vec<_>>(),
            vec![30, 50]
        );
    }

    #[test]
    fn exact_committed_outer_snapshot_restores_then_rejects_non_empty_legacy_heap_state() {
        #[derive(Serialize)]
        struct LegacyStoredAction {
            id: u64,
            ephemeral_public_key: ByteBuf,
            ciphertext: ByteBuf,
            oc_signature: ByteBuf,
            created_at: u64,
        }

        #[derive(Serialize)]
        struct LegacyInbox {
            actions: BTreeMap<Vec<u8>, Vec<LegacyStoredAction>>,
            seen: HashSet<(Vec<u8>, u64)>,
            next_id: u64,
        }

        #[derive(Serialize)]
        struct LegacyData {
            user_index_canister_id: Principal,
            cycles_dispenser_canister_id: Principal,
            deployment_operators: Vec<Principal>,
            authorized_depositors: HashSet<Principal>,
            oc_signing_public_key_pem: String,
            rng_seed: [u8; 32],
            inbox: LegacyInbox,
            test_mode: bool,
        }

        let canister_id = Principal::from_slice(&[1]);
        let fingerprint = vec![7; 32];
        let legacy = LegacyData {
            user_index_canister_id: canister_id,
            cycles_dispenser_canister_id: canister_id,
            deployment_operators: vec![canister_id],
            authorized_depositors: HashSet::from([canister_id]),
            oc_signing_public_key_pem: "removed legacy key field".to_string(),
            rng_seed: [8; 32],
            inbox: LegacyInbox {
                actions: BTreeMap::from([(
                    fingerprint.clone(),
                    vec![LegacyStoredAction {
                        id: 9,
                        ephemeral_public_key: ByteBuf::from(vec![1; 65]),
                        ciphertext: ByteBuf::from(vec![2; 16]),
                        oc_signature: ByteBuf::from(vec![3; 64]),
                        created_at: 4,
                    }],
                )]),
                seen: HashSet::from([(fingerprint, 10)]),
                next_id: 9,
            },
            test_mode: true,
        };
        let bytes = msgpack::serialize_to_vec((
            legacy,
            vec![entry(11, "ERROR_SENTINEL")],
            vec![entry(22, "LOG_SENTINEL")],
            Vec::<LogEntry>::new(),
        ))
        .unwrap();

        let mut restored = read(bytes.as_slice());
        assert_eq!(restored.data.app_id, 0, "new binding defaults fail closed");
        assert_eq!(restored.data.oversized_deposit_batches_rejected, 0);
        assert_entry(&restored.errors[0], 11, "ERROR_SENTINEL");
        assert_entry(&restored.logs[0], 22, "LOG_SENTINEL");
        let error = restored.data.inbox.prepare_after_upgrade().unwrap_err();
        assert!(error.contains("1 legacy heap action buckets"));
        assert!(error.contains("1 legacy replay entries"));
    }
}
