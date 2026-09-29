//! A small POSIX process guardian for the packaged desktop runtime.
//!
//! The guardian is deliberately a direct child of the Tauri shell and is not
//! part of the workload group it manages. It owns exactly one direct child:
//! the target process. The child creates a new session/process group before
//! exec, and the guardian only ever signals that still-unreaped direct-child
//! group. This provides containment for descendants which remain in that
//! group; a descendant that deliberately calls `setsid` can escape, which is
//! outside the guarantee of this helper.

#[cfg(unix)]
mod posix {
    use std::collections::BTreeMap;
    use std::ffi::{CString, OsStr, OsString};
    use std::io::{self, Read, Write};
    use std::os::fd::{FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::process::ExitStatus;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::mpsc::{self, Receiver, TryRecvError};
    use std::thread;
    use std::time::{Duration, Instant};

    const MAX_GRACE_MS: u64 = 60_000;
    const MAX_TARGET_ENV_BYTES: usize = 1 << 20;
    const POLL_INTERVAL_MS: i32 = 50;
    const SIGNAL_PIPE_CAPACITY: usize = 8;
    const READY_MARKER: &[u8] = b"READY\n";

    static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);

    #[derive(Debug, PartialEq, Eq)]
    struct GuardianArgs {
        grace: Duration,
        target_env_fd: Option<RawFd>,
        target: Vec<OsString>,
    }

    #[derive(Debug)]
    enum OwnerEvent {
        Eof,
        TargetStdinClosed,
    }

    enum ReadyOutcome {
        Ready,
        Aborted,
    }

    struct SignalPipe {
        read: RawFd,
        write: RawFd,
    }

    struct RawChild {
        pid: libc::pid_t,
        stdin: std::fs::File,
    }

    #[derive(Debug, PartialEq, Eq)]
    enum GroupSignalOutcome {
        Delivered,
        Empty,
        PermissionDenied,
    }

    trait TargetCleanup {
        fn group_kill(&mut self, child_pid: libc::pid_t) -> io::Result<GroupSignalOutcome>;
        fn direct_kill(&mut self, child_pid: libc::pid_t) -> io::Result<()>;
        fn leader_exited(&mut self, child_pid: libc::pid_t) -> io::Result<bool>;
        fn wait_leader_exit(&mut self, child_pid: libc::pid_t) -> io::Result<()>;
        fn reap(&mut self, child_pid: libc::pid_t) -> io::Result<ExitStatus>;
    }

    struct TargetGuard {
        pid: libc::pid_t,
        group_ready: bool,
        reaped: bool,
    }

    impl TargetGuard {
        fn new(pid: libc::pid_t) -> Self {
            Self {
                pid,
                group_ready: false,
                reaped: false,
            }
        }

        fn mark_group_ready(&mut self) {
            self.group_ready = true;
        }

        fn terminate_and_reap(&mut self) -> io::Result<ExitStatus> {
            let mut cleanup = PosixTargetCleanup;
            let status = terminate_target(self.pid, self.group_ready, &mut cleanup)?;
            self.reaped = true;
            Ok(status)
        }
    }

    impl Drop for TargetGuard {
        fn drop(&mut self) {
            if self.reaped {
                return;
            }
            let mut cleanup = PosixTargetCleanup;
            loop {
                // Never reap after one ignored group-kill failure. The
                // direct child remains the authority until the complete
                // group cleanup state machine has succeeded.
                if terminate_target(self.pid, self.group_ready, &mut cleanup).is_ok() {
                    self.reaped = true;
                    return;
                }
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS as u64));
            }
        }
    }

    struct PosixTargetCleanup;

    impl Drop for SignalPipe {
        fn drop(&mut self) {
            SIGNAL_WRITE_FD.store(-1, Ordering::SeqCst);
            // These descriptors are private to this process. Closing them is
            // best effort because there is no useful recovery during exit.
            unsafe {
                libc::close(self.read);
                libc::close(self.write);
            }
        }
    }

    extern "C" fn signal_handler(signal: libc::c_int) {
        let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
        if fd < 0 {
            return;
        }
        let byte = [signal as u8];
        // `write` is async-signal-safe. The pipe is non-blocking, so a burst
        // of signals cannot deadlock the guardian inside the handler.
        unsafe {
            let _ = libc::write(fd, byte.as_ptr().cast(), byte.len());
        }
    }

    fn io_error(context: &str) -> io::Error {
        io::Error::new(
            io::ErrorKind::Other,
            format!("{context}: {}", io::Error::last_os_error()),
        )
    }

    fn parse_args<I>(args: I) -> Result<GuardianArgs, String>
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut args = args.into_iter();
        let mut grace_ms = None;
        let mut target_env_fd = None;
        let mut target = Vec::new();
        while let Some(arg) = args.next() {
            if arg == OsStr::new("--grace-ms") {
                let value = args
                    .next()
                    .ok_or_else(|| "--grace-ms requires a value".to_string())?;
                let value = value
                    .to_str()
                    .ok_or_else(|| "--grace-ms must be an ASCII integer".to_string())?;
                let parsed = value
                    .parse::<u64>()
                    .map_err(|_| "--grace-ms must be a non-negative integer".to_string())?;
                if parsed > MAX_GRACE_MS {
                    return Err(format!("--grace-ms must be <= {MAX_GRACE_MS}"));
                }
                grace_ms = Some(parsed);
            } else if arg == OsStr::new("--target-env-fd") {
                let value = args
                    .next()
                    .ok_or_else(|| "--target-env-fd requires a value".to_string())?;
                let value = value
                    .to_str()
                    .ok_or_else(|| "--target-env-fd must be an ASCII integer".to_string())?;
                let parsed = value
                    .parse::<i32>()
                    .map_err(|_| "--target-env-fd must be a non-negative integer".to_string())?;
                if parsed < 3 {
                    return Err("--target-env-fd must be >= 3".to_string());
                }
                target_env_fd = Some(parsed);
            } else if arg == OsStr::new("--") {
                target.extend(args);
                break;
            } else {
                return Err(format!("unknown option: {}", arg.to_string_lossy()));
            }
        }
        let grace_ms = grace_ms.ok_or_else(|| "--grace-ms is required".to_string())?;
        if target.is_empty() {
            return Err("a target is required after --".to_string());
        }
        Ok(GuardianArgs {
            grace: Duration::from_millis(grace_ms),
            target_env_fd,
            target,
        })
    }

    struct TargetEnv {
        entries: Vec<CString>,
        pointers: Vec<*const libc::c_char>,
        executable_candidates: Vec<CString>,
        executable_pointers: Vec<*const libc::c_char>,
    }

    fn read_target_env_fd(fd: RawFd) -> io::Result<TargetEnv> {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 16 * 1024];
        loop {
            let count = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
            if count == 0 {
                break;
            }
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            bytes.extend_from_slice(&chunk[..count as usize]);
            if bytes.len() > MAX_TARGET_ENV_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("target environment exceeds {MAX_TARGET_ENV_BYTES} bytes"),
                ));
            }
        }
        let values =
            serde_json::from_slice::<BTreeMap<String, String>>(&bytes).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("target environment is not a JSON object: {error}"),
                )
            })?;
        let entries: Vec<CString> = values
            .into_iter()
            .map(|(key, value)| {
                if key.is_empty() || key.contains('=') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "target environment contains an invalid key",
                    ));
                }
                let mut entry = key.into_bytes();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                CString::new(entry).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "target environment contains NUL",
                    )
                })
            })
            .collect::<Result<Vec<_>, io::Error>>()?;
        let mut pointers = entries
            .iter()
            .map(|entry| entry.as_ptr())
            .collect::<Vec<_>>();
        pointers.push(std::ptr::null());
        Ok(TargetEnv {
            entries,
            pointers,
            executable_candidates: Vec::new(),
            executable_pointers: Vec::new(),
        })
    }

    fn prepare_executable_candidates(mut target_env: TargetEnv, executable: &[u8]) -> TargetEnv {
        if executable.contains(&b'/') {
            return target_env;
        }
        let path = target_env
            .entries
            .iter()
            .find_map(|entry| entry.as_bytes().strip_prefix(b"PATH="))
            .unwrap_or(b"/usr/bin:/bin");
        for directory in path.split(|byte| *byte == b':') {
            let mut candidate = Vec::with_capacity(directory.len() + executable.len() + 2);
            if directory.is_empty() {
                candidate.extend_from_slice(executable);
            } else {
                candidate.extend_from_slice(directory);
                candidate.push(b'/');
                candidate.extend_from_slice(executable);
            }
            if let Ok(candidate) = CString::new(candidate) {
                target_env.executable_candidates.push(candidate);
            }
        }
        target_env.executable_pointers = target_env
            .executable_candidates
            .iter()
            .map(|candidate| candidate.as_ptr())
            .collect();
        target_env
    }

    fn set_cloexec(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            return Err(io_error("fcntl(F_GETFD)"));
        }
        let result = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        if result < 0 {
            return Err(io_error("fcntl(F_SETFD)"));
        }
        Ok(())
    }

    fn set_nonblocking(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return Err(io_error("fcntl(F_GETFL)"));
        }
        let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
        if result < 0 {
            return Err(io_error("fcntl(F_SETFL)"));
        }
        Ok(())
    }

    fn create_pipe(nonblocking_read: bool) -> io::Result<(RawFd, RawFd)> {
        let mut fds = [0; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io_error("pipe"));
        }
        let result = (|| {
            set_cloexec(fds[0])?;
            set_cloexec(fds[1])?;
            if nonblocking_read {
                set_nonblocking(fds[0])?;
                set_nonblocking(fds[1])?;
            }
            Ok::<(), io::Error>(())
        })();
        if let Err(error) = result {
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return Err(error);
        }
        Ok((fds[0], fds[1]))
    }

    fn install_signal_handlers(pipe_write: RawFd) -> io::Result<()> {
        SIGNAL_WRITE_FD.store(pipe_write, Ordering::SeqCst);
        for signal in [libc::SIGTERM, libc::SIGINT] {
            let previous =
                unsafe { libc::signal(signal, signal_handler as *const () as libc::sighandler_t) };
            if previous == libc::SIG_ERR {
                SIGNAL_WRITE_FD.store(-1, Ordering::SeqCst);
                return Err(io_error("signal"));
            }
        }
        Ok(())
    }

    fn detach_guardian_group() -> io::Result<()> {
        // A guardian that is already a group leader is outside the target
        // group by construction. Otherwise setpgid must succeed: treating
        // EPERM as success could leave the guardian in its launcher's group,
        // allowing a caller's group teardown to kill the guardian while its
        // target survives in the new session.
        if unsafe { libc::getpgrp() } == unsafe { libc::getpid() } {
            return Ok(());
        }
        if unsafe { libc::setpgid(0, 0) } != 0 {
            let error = io::Error::last_os_error();
            return Err(io::Error::new(
                error.kind(),
                format!("setpgid(guardian): {error}"),
            ));
        }
        Ok(())
    }

    fn spawn_target(
        target: &[OsString],
        target_env: Option<&TargetEnv>,
        barrier_read: RawFd,
        barrier_write: RawFd,
        ready_read: RawFd,
        ready_write: RawFd,
        stdin_read: RawFd,
        stdin_write: RawFd,
    ) -> io::Result<RawChild> {
        let argv = target
            .iter()
            .map(|arg| {
                CString::new(arg.as_bytes()).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "target argument contains NUL")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut argv_ptrs = argv.iter().map(|arg| arg.as_ptr()).collect::<Vec<_>>();
        argv_ptrs.push(std::ptr::null());
        let child_pid = unsafe { libc::fork() };
        if child_pid < 0 {
            return Err(io_error("fork(target)"));
        }
        if child_pid == 0 {
            // This branch is intentionally limited to async-signal-safe POSIX
            // calls until exec. The target waits for the parent-side barrier
            // after setsid, so the recorded direct-child PID is authoritative.
            unsafe {
                // Close every parent-only write/read end before setsid. In
                // particular, retaining barrier_write would keep the read
                // end alive if the guardian dies while this child is waiting.
                libc::close(barrier_write);
                libc::close(ready_read);
                libc::close(stdin_write);
                if libc::setsid() < 0 {
                    libc::_exit(127);
                }
                for signal in [libc::SIGTERM, libc::SIGINT] {
                    if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR {
                        libc::_exit(127);
                    }
                }
                let mut written = 0;
                while written < READY_MARKER.len() {
                    let count = libc::write(
                        ready_write,
                        READY_MARKER[written..].as_ptr().cast(),
                        READY_MARKER.len() - written,
                    );
                    if count <= 0 {
                        libc::_exit(127);
                    }
                    written += count as usize;
                }
                libc::close(ready_write);
                let mut byte = [0_u8; 1];
                loop {
                    let count = libc::read(barrier_read, byte.as_mut_ptr().cast(), byte.len());
                    if count == 1 {
                        break;
                    }
                    libc::_exit(127);
                }
                if libc::dup2(stdin_read, libc::STDIN_FILENO) < 0 {
                    libc::_exit(127);
                }
                libc::close(stdin_read);
                libc::close(stdin_write);
                libc::close(barrier_read);
                if let Some(target_env) = target_env {
                    exec_with_target_env(&argv, &argv_ptrs, target_env);
                } else {
                    libc::execvp(argv_ptrs[0], argv_ptrs.as_ptr());
                }
                libc::_exit(127);
            }
        }
        close_fd(barrier_read);
        close_fd(ready_write);
        close_fd(stdin_read);
        Ok(RawChild {
            pid: child_pid,
            // SAFETY: this process owns the write end returned by `pipe`.
            stdin: unsafe { std::fs::File::from_raw_fd(stdin_write) },
        })
    }

    fn exec_with_target_env(
        argv: &[CString],
        argv_ptrs: &[*const libc::c_char],
        target_env: &TargetEnv,
    ) {
        if argv[0].as_bytes().contains(&b'/') {
            unsafe {
                libc::execve(
                    argv[0].as_ptr(),
                    argv_ptrs.as_ptr(),
                    target_env.pointers.as_ptr(),
                )
            };
            return;
        }
        for candidate in &target_env.executable_pointers {
            unsafe { libc::execve(*candidate, argv_ptrs.as_ptr(), target_env.pointers.as_ptr()) };
        }
    }

    fn release_target(barrier_write: RawFd) -> io::Result<()> {
        let byte = [1_u8];
        let result = unsafe { libc::write(barrier_write, byte.as_ptr().cast(), byte.len()) };
        if result == 1 {
            Ok(())
        } else {
            Err(io_error("write target exec barrier"))
        }
    }

    fn kill_direct_child(child_pid: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
        let result = unsafe { libc::kill(child_pid, signal) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(error)
    }

    fn wait_for_ready(
        child_pid: libc::pid_t,
        ready_read: RawFd,
        signal_read: RawFd,
        barrier_write: RawFd,
        owner_receiver: &Receiver<OwnerEvent>,
    ) -> io::Result<ReadyOutcome> {
        let mut ready = Vec::with_capacity(READY_MARKER.len());
        loop {
            if child_has_exited(child_pid)? {
                close_fd(barrier_write);
                return Ok(ReadyOutcome::Aborted);
            }
            match owner_receiver.try_recv() {
                Ok(OwnerEvent::Eof) | Err(TryRecvError::Disconnected) => {
                    close_fd(barrier_write);
                    return Ok(ReadyOutcome::Aborted);
                }
                Ok(OwnerEvent::TargetStdinClosed) | Err(TryRecvError::Empty) => {}
            }
            let mut poll_fds = [
                libc::pollfd {
                    fd: ready_read,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: signal_read,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let result =
                unsafe { libc::poll(poll_fds.as_mut_ptr(), poll_fds.len() as _, POLL_INTERVAL_MS) };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if poll_fds
                .iter()
                .any(|poll_fd| poll_fd.revents & libc::POLLNVAL != 0)
            {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "poll reported an invalid guardian pipe",
                ));
            }
            if poll_fds[1].revents & libc::POLLIN != 0 {
                let signals = drain_signals(signal_read)?;
                if signals.iter().any(|signal| {
                    *signal as libc::c_int == libc::SIGTERM
                        || *signal as libc::c_int == libc::SIGINT
                }) {
                    close_fd(barrier_write);
                    return Ok(ReadyOutcome::Aborted);
                }
            }
            if poll_fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                let mut bytes = [0_u8; READY_MARKER.len()];
                let remaining = READY_MARKER.len() - ready.len();
                let count = unsafe { libc::read(ready_read, bytes.as_mut_ptr().cast(), remaining) };
                if count < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::Interrupted
                    {
                        continue;
                    }
                    return Err(error);
                }
                if count == 0 {
                    return Err(io_error("target closed READY pipe"));
                }
                ready.extend_from_slice(&bytes[..count as usize]);
                if ready.len() >= READY_MARKER.len() {
                    if ready.as_slice() != READY_MARKER {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "target sent an invalid READY marker",
                        ));
                    }
                    let group = unsafe { libc::getpgid(child_pid) };
                    if group != child_pid {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "target READY did not establish its own process group",
                        ));
                    }
                    return Ok(ReadyOutcome::Ready);
                }
            }
        }
    }

    fn send_group_signal_raw(
        child_pid: libc::pid_t,
        signal: libc::c_int,
    ) -> io::Result<GroupSignalOutcome> {
        // The caller supplies the still-unreaped direct child PID. Never take
        // a PID or PGID from runtime state, and never signal the guardian's
        // own group here.
        if child_pid <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "direct child PID is invalid",
            ));
        }
        let result = unsafe { libc::kill(-child_pid, signal) };
        if result == 0 {
            return Ok(GroupSignalOutcome::Delivered);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(GroupSignalOutcome::Empty);
        }
        if error.raw_os_error() == Some(libc::EPERM) {
            return Ok(GroupSignalOutcome::PermissionDenied);
        }
        Err(error)
    }

    fn send_group_signal(child_pid: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
        match send_group_signal_raw(child_pid, signal)? {
            GroupSignalOutcome::Delivered | GroupSignalOutcome::Empty => Ok(()),
            GroupSignalOutcome::PermissionDenied => {
                // A TERM racing with a target exit may see the same macOS
                // zombie EPERM. Only suppress it after a fresh WNOWAIT check.
                if child_has_exited(child_pid)? {
                    Ok(())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "group signal returned EPERM while target is live",
                    ))
                }
            }
        }
    }

    fn ensure_group_killed<C: TargetCleanup>(
        child_pid: libc::pid_t,
        cleanup: &mut C,
    ) -> io::Result<()> {
        let mut retried_after_permission = false;
        loop {
            match cleanup.group_kill(child_pid)? {
                GroupSignalOutcome::Delivered | GroupSignalOutcome::Empty => return Ok(()),
                GroupSignalOutcome::PermissionDenied => {}
            }

            // A group KILL can race a still-live leader on macOS. Keep the
            // direct child as the authority: inspect it with WNOWAIT, direct
            // KILL it when live, wait for its zombie state, and retry the
            // group. Never unwind or reap merely because group KILL returned
            // EPERM.
            if cleanup.leader_exited(child_pid)? {
                if retried_after_permission {
                    // A second EPERM after WNOWAIT confirms an unreaped
                    // zombie with no signalable group member left.
                    return Ok(());
                }
                retried_after_permission = true;
                continue;
            }
            cleanup.direct_kill(child_pid)?;
            cleanup.wait_leader_exit(child_pid)?;
            retried_after_permission = true;
        }
    }

    fn terminate_target<C: TargetCleanup>(
        child_pid: libc::pid_t,
        group_ready: bool,
        cleanup: &mut C,
    ) -> io::Result<ExitStatus> {
        if group_ready {
            ensure_group_killed(child_pid, cleanup)?;
        } else {
            cleanup.direct_kill(child_pid)?;
        }
        cleanup.reap(child_pid)
    }

    fn child_has_exited(child_pid: libc::pid_t) -> io::Result<bool> {
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child_pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            return Err(io_error("waitid(target)"));
        }
        // WNOWAIT is load-bearing: the group is killed before a subsequent
        // wait() reaps the direct child, so descendants cannot outlive the
        // authority check by racing PID reuse.
        Ok(unsafe { info.si_pid() } != 0)
    }

    fn reap_target(child_pid: libc::pid_t) -> io::Result<ExitStatus> {
        let mut status = 0;
        loop {
            let result = unsafe { libc::waitpid(child_pid, &mut status, 0) };
            if result == child_pid {
                use std::os::unix::process::ExitStatusExt;
                return Ok(ExitStatus::from_raw(status));
            }
            if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io_error("waitpid(target)"));
        }
    }

    impl TargetCleanup for PosixTargetCleanup {
        fn group_kill(&mut self, child_pid: libc::pid_t) -> io::Result<GroupSignalOutcome> {
            send_group_signal_raw(child_pid, libc::SIGKILL)
        }

        fn direct_kill(&mut self, child_pid: libc::pid_t) -> io::Result<()> {
            kill_direct_child(child_pid, libc::SIGKILL)
        }

        fn leader_exited(&mut self, child_pid: libc::pid_t) -> io::Result<bool> {
            child_has_exited(child_pid)
        }

        fn wait_leader_exit(&mut self, child_pid: libc::pid_t) -> io::Result<()> {
            while !child_has_exited(child_pid)? {
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS as u64));
            }
            Ok(())
        }

        fn reap(&mut self, child_pid: libc::pid_t) -> io::Result<ExitStatus> {
            reap_target(child_pid)
        }
    }

    fn drain_signals(pipe_read: RawFd) -> io::Result<Vec<u8>> {
        let mut bytes = [0_u8; SIGNAL_PIPE_CAPACITY];
        let count = unsafe { libc::read(pipe_read, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock
                || error.kind() == io::ErrorKind::Interrupted
            {
                return Ok(Vec::new());
            }
            return Err(error);
        }
        Ok(bytes[..count as usize].to_vec())
    }

    fn poll_signals(pipe_read: RawFd) -> io::Result<Vec<u8>> {
        let mut poll_fd = libc::pollfd {
            fd: pipe_read,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll_fd, 1, POLL_INTERVAL_MS) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                return Ok(Vec::new());
            }
            return Err(error);
        }
        if result == 0 || poll_fd.revents & libc::POLLIN == 0 {
            if poll_fd.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "poll reported an invalid signal pipe",
                ));
            }
            return Ok(Vec::new());
        }
        drain_signals(pipe_read)
    }

    fn forward_owner_stdin(
        mut target_stdin: impl Write + Send + 'static,
        sender: mpsc::Sender<OwnerEvent>,
    ) {
        thread::spawn(move || {
            let stdin = io::stdin();
            let mut stdin = stdin.lock();
            let mut buffer = [0_u8; 16 * 1024];
            let mut target_open = true;
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => {
                        // Closing the physical target pipe delivers EOF before
                        // the guardian begins the TERM/grace shutdown. This
                        // preserves transparent stdin for short-lived filters.
                        drop(target_stdin);
                        let _ = sender.send(OwnerEvent::Eof);
                        return;
                    }
                    Ok(count) => {
                        if target_open && target_stdin.write_all(&buffer[..count]).is_err() {
                            // EPIPE says only that target stdin closed. Keep
                            // draining the owner channel so it cannot be
                            // mistaken for owner EOF/disconnect.
                            target_open = false;
                            let _ = sender.send(OwnerEvent::TargetStdinClosed);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        // An unreadable owner channel is treated as owner
                        // death. This keeps the fail-closed process contract.
                        drop(target_stdin);
                        let _ = sender.send(OwnerEvent::Eof);
                        return;
                    }
                }
            }
        });
    }

    fn close_fd(fd: RawFd) {
        unsafe {
            libc::close(fd);
        }
    }

    pub fn run(args: Vec<OsString>) -> Result<i32, String> {
        let args = parse_args(args)?;
        let target_env = if let Some(fd) = args.target_env_fd {
            let result = read_target_env_fd(fd);
            close_fd(fd);
            Some(prepare_executable_candidates(
                result.map_err(|error| format!("target environment: {error}"))?,
                args.target[0].as_bytes(),
            ))
        } else {
            None
        };
        detach_guardian_group().map_err(|error| format!("guardian group: {error}"))?;
        let signal_pipe_fds = create_pipe(true).map_err(|error| format!("signal pipe: {error}"))?;
        let signal_pipe = SignalPipe {
            read: signal_pipe_fds.0,
            write: signal_pipe_fds.1,
        };
        install_signal_handlers(signal_pipe.write)
            .map_err(|error| format!("signal handlers: {error}"))?;

        let (stdin_read, stdin_write) =
            create_pipe(false).map_err(|error| format!("stdin pipe: {error}"))?;
        let (barrier_read, barrier_write) = match create_pipe(false) {
            Ok(pipe) => pipe,
            Err(error) => {
                close_fd(stdin_read);
                close_fd(stdin_write);
                return Err(format!("barrier pipe: {error}"));
            }
        };
        let (ready_read, ready_write) = match create_pipe(true) {
            Ok(pipe) => pipe,
            Err(error) => {
                close_fd(stdin_read);
                close_fd(stdin_write);
                close_fd(barrier_read);
                close_fd(barrier_write);
                return Err(format!("READY pipe: {error}"));
            }
        };
        let child = match spawn_target(
            &args.target,
            target_env.as_ref(),
            barrier_read,
            barrier_write,
            ready_read,
            ready_write,
            stdin_read,
            stdin_write,
        ) {
            Ok(child) => child,
            Err(error) => {
                close_fd(barrier_read);
                close_fd(barrier_write);
                close_fd(ready_read);
                close_fd(ready_write);
                close_fd(stdin_read);
                close_fd(stdin_write);
                return Err(format!("failed to spawn target: {error}"));
            }
        };
        let child_pid = child.pid;
        let mut target_guard = TargetGuard::new(child_pid);
        let (owner_sender, owner_receiver) = mpsc::channel();
        forward_owner_stdin(child.stdin, owner_sender);

        let readiness = match wait_for_ready(
            child_pid,
            ready_read,
            signal_pipe.read,
            barrier_write,
            &owner_receiver,
        ) {
            Ok(readiness) => readiness,
            Err(error) => {
                close_fd(ready_read);
                close_fd(barrier_write);
                return Err(format!("wait for target READY: {error}"));
            }
        };
        close_fd(ready_read);
        match readiness {
            ReadyOutcome::Aborted => {
                return Ok(exit_code(
                    target_guard
                        .terminate_and_reap()
                        .map_err(|error| error.to_string())?,
                ));
            }
            ReadyOutcome::Ready => {
                target_guard.mark_group_ready();
                if let Err(error) = release_target(barrier_write) {
                    close_fd(barrier_write);
                    return Err(format!("release target barrier: {error}"));
                }
                close_fd(barrier_write);
            }
        }

        let mut shutdown_started = None;
        loop {
            if child_has_exited(child_pid).map_err(|error| format!("poll target exit: {error}"))? {
                // Do this while waitid(WNOWAIT) still keeps the direct child
                // unreaped. The group authority is the original child PID,
                // never a value read from a state file or a descendant.
                let status = target_guard
                    .terminate_and_reap()
                    .map_err(|error| format!("cleanup target group after exit: {error}"))?;
                return Ok(exit_code(status));
            }

            match owner_receiver.try_recv() {
                Ok(OwnerEvent::Eof) | Err(TryRecvError::Disconnected) => {
                    if shutdown_started.is_none() {
                        send_group_signal(child_pid, libc::SIGTERM)
                            .map_err(|error| format!("TERM target group: {error}"))?;
                        shutdown_started = Some(Instant::now());
                    }
                }
                Ok(OwnerEvent::TargetStdinClosed) | Err(TryRecvError::Empty) => {}
            }

            for signal in poll_signals(signal_pipe.read)
                .map_err(|error| format!("poll guardian signal: {error}"))?
            {
                if (signal as libc::c_int == libc::SIGTERM || signal as libc::c_int == libc::SIGINT)
                    && shutdown_started.is_none()
                {
                    send_group_signal(child_pid, libc::SIGTERM)
                        .map_err(|error| format!("TERM target group from signal: {error}"))?;
                    shutdown_started = Some(Instant::now());
                }
            }

            if let Some(started) = shutdown_started {
                if started.elapsed() >= args.grace {
                    let status = target_guard
                        .terminate_and_reap()
                        .map_err(|error| format!("cleanup target group after grace: {error}"))?;
                    return Ok(exit_code(status));
                }
            }
        }
    }

    fn exit_code(status: ExitStatus) -> i32 {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(libc::SIGKILL))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct ScriptedCleanup {
            group_kills: Vec<GroupSignalOutcome>,
            leader_states: Vec<bool>,
            calls: Vec<&'static str>,
        }

        impl TargetCleanup for ScriptedCleanup {
            fn group_kill(&mut self, _child_pid: libc::pid_t) -> io::Result<GroupSignalOutcome> {
                self.calls.push("group-kill");
                Ok(self.group_kills.remove(0))
            }

            fn direct_kill(&mut self, _child_pid: libc::pid_t) -> io::Result<()> {
                self.calls.push("direct-kill");
                Ok(())
            }

            fn leader_exited(&mut self, _child_pid: libc::pid_t) -> io::Result<bool> {
                self.calls.push("leader-exited");
                Ok(self.leader_states.remove(0))
            }

            fn wait_leader_exit(&mut self, _child_pid: libc::pid_t) -> io::Result<()> {
                self.calls.push("wait-leader-exit");
                Ok(())
            }

            fn reap(&mut self, _child_pid: libc::pid_t) -> io::Result<ExitStatus> {
                self.calls.push("reap");
                use std::os::unix::process::ExitStatusExt;
                Ok(ExitStatus::from_raw(0))
            }
        }

        #[test]
        fn group_kill_eperm_live_leader_is_direct_killed_before_retry_and_reap() {
            let mut cleanup = ScriptedCleanup {
                group_kills: vec![
                    GroupSignalOutcome::PermissionDenied,
                    GroupSignalOutcome::Delivered,
                ],
                leader_states: vec![false],
                calls: Vec::new(),
            };
            let status = terminate_target(42, true, &mut cleanup).unwrap();
            assert_eq!(status.code(), Some(0));
            assert_eq!(
                cleanup.calls,
                [
                    "group-kill",
                    "leader-exited",
                    "direct-kill",
                    "wait-leader-exit",
                    "group-kill",
                    "reap",
                ]
            );
        }

        #[test]
        fn repeated_group_kill_eperm_while_live_retries_without_unwinding() {
            let mut cleanup = ScriptedCleanup {
                group_kills: vec![
                    GroupSignalOutcome::PermissionDenied,
                    GroupSignalOutcome::PermissionDenied,
                    GroupSignalOutcome::Delivered,
                ],
                leader_states: vec![false, false],
                calls: Vec::new(),
            };
            let status = terminate_target(42, true, &mut cleanup).unwrap();
            assert_eq!(status.code(), Some(0));
            assert_eq!(
                cleanup.calls,
                [
                    "group-kill",
                    "leader-exited",
                    "direct-kill",
                    "wait-leader-exit",
                    "group-kill",
                    "leader-exited",
                    "direct-kill",
                    "wait-leader-exit",
                    "group-kill",
                    "reap",
                ]
            );
        }

        #[test]
        fn parses_barrier_command() {
            let parsed = parse_args([
                OsString::from("--grace-ms"),
                OsString::from("250"),
                OsString::from("--"),
                OsString::from("bun"),
                OsString::from("run"),
                OsString::from("target.ts"),
            ])
            .unwrap();
            assert_eq!(parsed.grace, Duration::from_millis(250));
            assert_eq!(parsed.target_env_fd, None);
            assert_eq!(
                parsed.target,
                [
                    OsString::from("bun"),
                    OsString::from("run"),
                    OsString::from("target.ts")
                ]
            );
        }

        #[test]
        fn rejects_unbounded_or_missing_commands() {
            assert!(parse_args([
                OsString::from("--grace-ms"),
                OsString::from("60001"),
                OsString::from("--"),
                OsString::from("target")
            ])
            .is_err());
            assert!(parse_args([OsString::from("--grace-ms"), OsString::from("1")]).is_err());
            assert!(parse_args([
                OsString::from("--grace-ms"),
                OsString::from("1"),
                OsString::from("target")
            ])
            .is_err());
            let parsed = parse_args([
                OsString::from("--grace-ms"),
                OsString::from("1"),
                OsString::from("--target-env-fd"),
                OsString::from("3"),
                OsString::from("--"),
                OsString::from("target"),
            ])
            .unwrap();
            assert_eq!(parsed.target_env_fd, Some(3));
            assert!(parse_args([
                OsString::from("--grace-ms"),
                OsString::from("1"),
                OsString::from("--target-env-fd"),
                OsString::from("2"),
                OsString::from("--"),
                OsString::from("target"),
            ])
            .is_err());
        }

        #[test]
        fn reads_a_bounded_json_target_environment_from_an_inherited_fd() {
            let mut fds = [0; 2];
            assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
            let payload = br#"{"PATH":"/bin","FORGEAX_FIXTURE":"ok"}"#;
            assert_eq!(
                unsafe { libc::write(fds[1], payload.as_ptr().cast(), payload.len()) },
                payload.len() as isize
            );
            unsafe {
                libc::close(fds[1]);
            }
            let env = read_target_env_fd(fds[0]).unwrap();
            unsafe {
                libc::close(fds[0]);
            }
            assert!(env
                .entries
                .iter()
                .any(|entry| entry.as_bytes() == b"PATH=/bin"));
            assert!(env
                .entries
                .iter()
                .any(|entry| entry.as_bytes() == b"FORGEAX_FIXTURE=ok"));
        }

        #[test]
        fn target_guard_reaps_a_child_when_an_internal_path_aborts_before_ready() {
            let child_pid = unsafe { libc::fork() };
            assert!(child_pid >= 0);
            if child_pid == 0 {
                unsafe {
                    libc::sleep(60);
                    libc::_exit(0);
                }
            }
            {
                // This models waitid/poll/READY failure before group
                // ownership is established. Drop must still kill and reap
                // the direct child rather than letting it become an orphan.
                let _guard = TargetGuard::new(child_pid);
            }
            let probe = unsafe { libc::kill(child_pid, 0) };
            assert_eq!(probe, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }

        #[test]
        fn invalid_signal_pipe_is_reported_as_an_internal_error() {
            let mut fds = [0; 2];
            assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
            unsafe { libc::close(fds[0]) };
            let error = poll_signals(fds[0]).unwrap_err();
            unsafe { libc::close(fds[1]) };
            assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        }
    }
}

#[cfg(unix)]
fn main() {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    match posix::run(args) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("runtime-guardian: {error}");
            std::process::exit(64);
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("runtime-guardian is only used on POSIX; Windows uses the Job Object runtime path");
    std::process::exit(64);
}
