//! A non-inheritable Windows Job owned by one child supervisor.
use anyhow::Result;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use windows::Win32::{Foundation::HANDLE, System::JobObjects::*};

pub struct Job(OwnedHandle);
impl Job {
    pub fn new() -> Result<Self> {
        // No name/security inheritance: only the parent's handle keeps it alive.
        let handle = unsafe { CreateJobObjectW(None, None)? };
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                HANDLE(job.0.as_raw_handle()),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )?;
        }
        Ok(job)
    }
    pub fn assign(&self, process: RawHandle) -> Result<()> {
        unsafe {
            AssignProcessToJobObject(HANDLE(self.0.as_raw_handle()), HANDLE(process))?;
        }
        Ok(())
    }
}
