// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';

/**
 * Run a subprocess asynchronously and resolve with stdout/stderr + exit status.
 * Intended for optional non-UI work that should not block the shell's main thread.
 */
export function runSubprocess(argv, flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, flags);
        } catch (e) {
            reject(e);
            return;
        }

        proc.communicate_utf8_async(null, null, (_self, res) => {
            try {
                let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                resolve({
                    ok: proc.get_successful(),
                    status: proc.get_exit_status(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}
