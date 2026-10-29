//! One non-inheritable Windows Job belongs to the parent encoding supervisor.
use anyhow::Result;
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::*,
};

pub(super) struct Job(HANDLE);
impl Job {
    pub fn new() -> Result<Self> {
        // No name/security inheritance: only the parent's handle keeps it alive.
        let job = Self(unsafe { CreateJobObjectW(None, None)? });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )?;
        }
        Ok(job)
    }
    pub fn assign(&self, process: std::os::windows::io::RawHandle) -> Result<()> {
        unsafe {
            AssignProcessToJobObject(self.0, HANDLE(process))?;
        }
        Ok(())
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}
