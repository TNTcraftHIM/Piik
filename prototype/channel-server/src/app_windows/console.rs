//! Only terminal entry or native-window fallback acquires a console.
use std::io;

#[link(name = "kernel32")]
extern "system" {
    fn AttachConsole(process: u32) -> i32;
    fn AllocConsole() -> i32;
    fn GetConsoleProcessList(ids: *mut u32, count: u32) -> u32;
    fn GetStdHandle(kind: u32) -> isize;
    fn SetStdHandle(kind: u32, handle: isize) -> i32;
    fn GetFileType(handle: isize) -> u32;
    fn GetConsoleMode(handle: isize, mode: *mut u32) -> i32;
}

pub fn attach(create_if_missing: bool) -> io::Result<()> {
    let redirected = [-10i32, -11, -12].map(|kind| {
        // SAFETY: These are the standard input/output/error identifiers. A
        // successful file-type query proves a live handle, and GetConsoleMode
        // distinguishes console handles from files, pipes and NUL.
        unsafe {
            let handle = GetStdHandle(kind as u32);
            let mut mode = 0;
            (GetFileType(handle) != 0 && GetConsoleMode(handle, &mut mode) == 0)
                .then_some((kind as u32, handle))
        }
    });
    let result = acquire(create_if_missing);
    for (kind, handle) in redirected.into_iter().flatten() {
        // SAFETY: Preserve the caller's same live redirected handle; this does
        // not duplicate or close its writer, even when AllocConsole set defaults.
        if unsafe { SetStdHandle(kind, handle) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    result
}

fn acquire(create_if_missing: bool) -> io::Result<()> {
    // Acquire before shutdown handlers register. Existing terminals and their
    // redirected standard handles belong to the launching process.
    // SAFETY: ATTACH_PARENT_PROCESS names the current process's parent console.
    if unsafe { AttachConsole(u32::MAX) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(5) {
        // ERROR_ACCESS_DENIED means this process already has a console.
        return Ok(());
    }
    if !create_if_missing && matches!(error.raw_os_error(), Some(6 | 87)) {
        // A headless App keeps its inherited pipes when there is no parent console.
        return Ok(());
    }
    if !create_if_missing {
        return Err(error);
    }
    // SAFETY: This runs only at terminal/fallback acquisition, before handlers.
    if unsafe { AllocConsole() } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn attached() -> bool {
    let mut id = 0;
    // SAFETY: The buffer is valid for the one element requested. A larger
    // returned count still proves attachment; no process list is consumed.
    unsafe { GetConsoleProcessList(&mut id, 1) != 0 }
}
