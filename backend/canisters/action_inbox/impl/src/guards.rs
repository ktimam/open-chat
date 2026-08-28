use crate::read_state;

pub fn caller_is_authorized_depositor() -> Result<(), String> {
    if read_state(|state| state.is_caller_authorized_depositor()) {
        Ok(())
    } else {
        Err("Caller is not an authorized depositor".to_string())
    }
}
