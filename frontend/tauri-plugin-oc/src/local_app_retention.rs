//! Process-retention capability only. It never authorizes a transfer or contains its payload.
//! Kept Tauri-free so the native loopback harness exercises startup/loss/cleanup races.
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

pub trait RetentionBackend: Send + Sync {
    /// Return success only after Android has established the foreground service.
    fn start(&self, owner: &str, remaining_ms: u64) -> Result<(), ()>;
    fn extend(&self, owner: &str, remaining_ms: u64) -> Result<(), ()>;
    fn active(&self, owner: &str) -> bool;
    fn release(&self, owner: &str);
}

pub struct RetentionLease {
    backend: Option<Arc<dyn RetentionBackend>>,
    owner: String,
    released: AtomicBool,
}
impl RetentionLease {
    pub fn start(backend: Option<Arc<dyn RetentionBackend>>, scope: &str, id: &str, remaining_ms: u64) -> Result<Arc<Self>, String> {
        if !matches!(scope, "handoff" | "setup") || id.len() != 32 ||
            !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) ||
            remaining_ms == 0 || remaining_ms > if scope == "handoff" { 120_000 } else { 600_000 } {
            return Err("Invalid local transfer retention".into());
        }
        let owner = format!("{scope}:{id}");
        if let Some(platform) = &backend {
            if platform.start(&owner, remaining_ms).is_err() {
                platform.release(&owner);
                return Err("Could not keep the approved local transfer active".into());
            }
        }
        Ok(Arc::new(Self { backend, owner, released: AtomicBool::new(false) }))
    }
    pub fn active(&self) -> bool {
        !self.released.load(Ordering::SeqCst) && self.backend.as_ref().is_none_or(|b| b.active(&self.owner))
    }
    pub fn extend(&self, remaining_ms: u64) -> bool {
        if !self.owner.starts_with("handoff:") || remaining_ms == 0 || remaining_ms > 600_000 || !self.active() ||
            self.backend.as_ref().is_some_and(|b| b.extend(&self.owner, remaining_ms).is_err()) {
            self.release();
            return false;
        }
        true
    }
    pub fn release(&self) {
        if !self.released.swap(true, Ordering::SeqCst) {
            if let Some(backend) = &self.backend { backend.release(&self.owner); }
        }
    }
}
impl Drop for RetentionLease { fn drop(&mut self) { self.release(); } }

#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::{collections::HashSet, sync::{Mutex, atomic::AtomicUsize}};
    #[derive(Default)]
    pub struct Platform {
        pub owners: Mutex<HashSet<String>>,
        pub refuse: AtomicBool,
        pub extensions: AtomicUsize,
    }
    impl RetentionBackend for Platform {
        fn start(&self, owner: &str, _: u64) -> Result<(), ()> {
            if self.refuse.load(Ordering::SeqCst) { return Err(()); }
            self.owners.lock().unwrap().insert(owner.into()); Ok(())
        }
        fn extend(&self, owner: &str, _: u64) -> Result<(), ()> {
            if !self.active(owner) { return Err(()); }
            self.extensions.fetch_add(1, Ordering::SeqCst); Ok(())
        }
        fn active(&self, owner: &str) -> bool { self.owners.lock().unwrap().contains(owner) }
        fn release(&self, owner: &str) { self.owners.lock().unwrap().remove(owner); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Fake { live: AtomicBool, refuse: AtomicBool, owners: Mutex<Vec<String>> }
    impl RetentionBackend for Fake {
        fn start(&self, owner: &str, _: u64) -> Result<(), ()> {
            self.owners.lock().unwrap().push(owner.into());
            if self.refuse.load(Ordering::SeqCst) { return Err(()); }
            self.live.store(true, Ordering::SeqCst); Ok(())
        }
        fn extend(&self, _: &str, _: u64) -> Result<(), ()> { if self.live.load(Ordering::SeqCst) { Ok(()) } else { Err(()) } }
        fn active(&self, _: &str) -> bool { self.live.load(Ordering::SeqCst) }
        fn release(&self, owner: &str) { self.owners.lock().unwrap().push(format!("release:{owner}")); self.live.store(false, Ordering::SeqCst); }
    }
    #[test]
    fn refused_start_releases_without_producing_lease() {
        let backend = Arc::new(Fake::default()); backend.refuse.store(true, Ordering::SeqCst);
        assert!(RetentionLease::start(Some(backend.clone()), "handoff", &"a".repeat(32), 120_000).is_err());
        assert_eq!(backend.owners.lock().unwrap().len(), 2);
    }
    #[test]
    fn platform_loss_cannot_be_extended_or_revived_and_release_is_once() {
        let backend = Arc::new(Fake::default());
        let lease = RetentionLease::start(Some(backend.clone()), "handoff", &"a".repeat(32), 120_000).unwrap();
        assert!(lease.active()); assert!(lease.extend(600_000));
        backend.live.store(false, Ordering::SeqCst);
        assert!(!lease.active()); assert!(!lease.extend(600_000));
        lease.release(); drop(lease);
        assert_eq!(backend.owners.lock().unwrap().len(), 2);
    }
    #[test]
    fn invalid_owners_and_deadlines_do_not_start_platform() {
        for (scope, id, ttl) in [("auth", "a".repeat(32), 1), ("setup", "A".repeat(32), 1), ("handoff", "a".repeat(32), 120_001), ("setup", "a".repeat(32), 0)] {
            assert!(RetentionLease::start(None, scope, &id, ttl).is_err());
        }
    }
}
