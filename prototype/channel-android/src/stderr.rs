//! Android app stdio points at /dev/null; retain existing Rust errors in logcat.
use std::{
    io::{self, BufRead, BufReader, Read},
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::OnceLock,
    thread::JoinHandle,
};

#[link(name = "log")]
extern "C" {}

// stderr belongs to the process, across Service/runtime stop and restart.
static READER: OnceLock<io::Result<JoinHandle<()>>> = OnceLock::new();

pub fn init() {
    if let Err(error) = READER.get_or_init(redirect) {
        write_log(&mut format!("Could not connect Rust stderr to logcat: {error}").into_bytes());
    }
}

fn redirect() -> io::Result<JoinHandle<()>> {
    let (read, write) = UnixStream::pair()?;
    let thread = std::thread::Builder::new()
        .name("piik-stderr".into())
        .spawn(move || {
            let mut reader = BufReader::new(read);
            // liblog has a per-message size limit; a long line becomes chunks.
            let mut line = Vec::with_capacity(4001);
            loop {
                line.clear();
                match reader.by_ref().take(4000).read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => write_log(&mut line),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        write_log(&mut format!("Rust stderr reader stopped: {error}").into_bytes());
                        break;
                    }
                }
            }
        })?;
    // The reader is running before replacing fd 2; failed setup leaves it alone.
    if unsafe { libc::dup2(write.as_raw_fd(), libc::STDERR_FILENO) } == -1 {
        let error = io::Error::last_os_error();
        drop(write);
        let _ = thread.join();
        return Err(error);
    }
    Ok(thread)
}

fn write_log(bytes: &mut Vec<u8>) {
    for byte in bytes.iter_mut() {
        if *byte == 0 {
            *byte = b'?';
        }
    }
    bytes.push(0);
    unsafe {
        ndk_sys::__android_log_write(
            ndk_sys::android_LogPriority::ANDROID_LOG_ERROR.0 as libc::c_int,
            c"PiikRust".as_ptr(),
            bytes.as_ptr().cast(),
        );
    }
    bytes.pop();
}
