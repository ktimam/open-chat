use crate::memory::get_upgrades_memory;
use ic_cdk::stable::WASM_PAGE_SIZE_IN_BYTES;
use ic_cdk_timers::TimerId;
use ic_stable_structures::Memory;
use std::cell::Cell;
use std::cmp::min;
use std::time::Duration;
use tracing::trace;

/// A stable write is bounded to 256 KiB per timer message. Large UserIndex snapshots are scrubbed
/// incrementally, so post-upgrade never adds an unbounded stable-memory walk.
const MAX_SCRUB_BYTES_PER_TICK: u64 = 256 * 1024;
const SCRUB_INTERVAL: Duration = Duration::from_secs(1);

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
    static PROGRESS: Cell<Option<ScrubProgress>> = Cell::default();
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScrubProgress {
    next_offset: u64,
    total_bytes: u64,
}

/// Called only after a successful UserIndex restore and runtime initialization. Segment 0 is a
/// disposable raw MessagePack upgrade snapshot; normal rollback remains compatible because every
/// subsequent upgrade's existing `pre_upgrade` hook rewrites that same raw format first.
pub(crate) fn start_after_restore() -> bool {
    let memory = get_upgrades_memory();
    start(memory.size().saturating_mul(WASM_PAGE_SIZE_IN_BYTES))
}

fn start(total_bytes: u64) -> bool {
    if total_bytes == 0 || TIMER_ID.get().is_some() || PROGRESS.get().is_some() {
        return false;
    }
    PROGRESS.set(Some(ScrubProgress {
        next_offset: 0,
        total_bytes,
    }));
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(Duration::ZERO, run)));
    true
}

fn run() {
    TIMER_ID.set(None);
    let Some(mut progress) = PROGRESS.get() else {
        return;
    };
    let memory = get_upgrades_memory();
    let more = scrub_next_chunk(&memory, &mut progress);
    if more {
        PROGRESS.set(Some(progress));
        TIMER_ID.set(Some(ic_cdk_timers::set_timer(SCRUB_INTERVAL, run)));
    } else {
        PROGRESS.set(None);
        trace!(bytes = progress.total_bytes, "UserIndex upgrade snapshot scrub complete");
    }
}

fn scrub_next_chunk<M: Memory>(memory: &M, progress: &mut ScrubProgress) -> bool {
    if progress.next_offset >= progress.total_bytes {
        return false;
    }
    let bytes = min(MAX_SCRUB_BYTES_PER_TICK, progress.total_bytes - progress.next_offset);
    memory.write(progress.next_offset, &vec![0; bytes as usize]);
    progress.next_offset += bytes;
    progress.next_offset < progress.total_bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::VectorMemory;

    #[test]
    fn snapshot_scrub_is_complete_and_strictly_bounded_per_step() {
        let memory = VectorMemory::default();
        let total_bytes = 5 * WASM_PAGE_SIZE_IN_BYTES;
        assert_eq!(memory.grow(5), 0);
        memory.write(0, &vec![0xA5; total_bytes as usize]);
        let mut progress = ScrubProgress {
            next_offset: 0,
            total_bytes,
        };
        let mut previous_offset = 0;

        while scrub_next_chunk(&memory, &mut progress) {
            assert!(progress.next_offset - previous_offset <= MAX_SCRUB_BYTES_PER_TICK);
            previous_offset = progress.next_offset;
        }
        assert_eq!(progress.next_offset, total_bytes);
        assert!(progress.next_offset - previous_offset <= MAX_SCRUB_BYTES_PER_TICK);

        let mut restored = vec![1; total_bytes as usize];
        memory.read(0, &mut restored);
        assert!(restored.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn empty_or_complete_progress_never_writes_or_reschedules() {
        let memory = VectorMemory::default();
        let mut progress = ScrubProgress {
            next_offset: 0,
            total_bytes: 0,
        };
        assert!(!scrub_next_chunk(&memory, &mut progress));
    }

    #[test]
    fn scrub_budget_is_four_wasm_pages() {
        assert_eq!(MAX_SCRUB_BYTES_PER_TICK, 4 * WASM_PAGE_SIZE_IN_BYTES);
        assert_eq!(SCRUB_INTERVAL, Duration::from_secs(1));
    }
}
