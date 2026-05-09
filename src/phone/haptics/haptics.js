// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FF_RUMBLE = 0x50;
const EV_FF = 0x15;
const FF_GAIN = 0x60;
const EVIOCSFF = 0x40304580;

/**
 * Haptics -- shared vibration utility for phone devices.
 *
 * Provides a single entry point for triggering haptic feedback across
 * the extension (keyboard, alert slider, home screen, etc.). Supports
 * three backends, tried in order:
 *
 *   1. FF_RUMBLE via /dev/input (spmi_haptics on OnePlus 6 and similar)
 *   2. sysfs LED vibrator (common on postmarketOS phones)
 *   3. feedbackd D-Bus service
 *
 * Intensity is controlled by a GSettings key (vibration-intensity, 0-100).
 * A value of 0 disables vibration entirely. This module can be removed
 * or disabled without breaking other modules.
 */
export class Haptics {
    /**
     * @param {Gio.Settings|null} settings - extension GSettings instance
     */
    constructor(settings) {
        this._settings = settings ?? null;
        this._method = 'none';
        this._ffDevPath = null;
        this._vibratorBase = null;
        this._feedbackBus = null;
        this._destroyed = false;

        this._initBackend();
    }

    /** Current intensity (0-100) from settings, or 50 as default. */
    get intensity() {
        try {
            if (this._settings?.settings_schema?.has_key?.('vibration-intensity'))
                return this._settings.get_int('vibration-intensity');
        } catch (_e) {}
        return 50;
    }

    /** Whether vibration is enabled (intensity > 0). */
    get enabled() {
        return this._method !== 'none' && this.intensity > 0;
    }

    /** Whether vibrate-on-keypress is enabled. */
    get vibrateOnKeypress() {
        try {
            if (this._settings?.settings_schema?.has_key?.('vibration-on-keypress'))
                return this._settings.get_boolean('vibration-on-keypress');
        } catch (_e) {}
        return false;
    }

    /** Whether vibrate-on-slider-change is enabled. */
    get vibrateOnSliderChange() {
        try {
            if (this._settings?.settings_schema?.has_key?.('vibration-on-slider-change'))
                return this._settings.get_boolean('vibration-on-slider-change');
        } catch (_e) {}
        return true;
    }

    // -- Backend initialization --

    _initBackend() {
        if (this._initFF()) return;
        if (this._initSysfs()) return;
        if (this._initFeedbackd()) return;
        this._method = 'none';
    }

    _initFF() {
        let devPath = this._findFFDevice();
        if (!devPath) return false;

        try {
            let file = Gio.File.new_for_path(devPath);
            let info = file.query_info('access::can-read,access::can-write',
                Gio.FileQueryInfoFlags.NONE, null);
            if (!info) return false;
        } catch (_e) {
            return false;
        }

        this._ffDevPath = devPath;
        this._method = 'ff';
        this._ffHelper = null;
        this._ffStdin = null;
        return true;
    }

    _ensureFFHelper() {
        if (this._ffStdin) return true;
        try {
            // Long-running Python helper that reads "duration magnitude\n"
            // from stdin and plays FF_RUMBLE effects.
            let script = [
                'import os,struct,fcntl,sys,time',
                `fd=os.open('${this._ffDevPath}',os.O_RDWR)`,
                'e=bytearray(48)',
                `struct.pack_into('H',e,0,${FF_RUMBLE})`,
                "struct.pack_into('h',e,2,-1)",
                'for line in sys.stdin:',
                '  parts=line.strip().split()',
                '  if len(parts)<2: continue',
                '  dur,mag=int(parts[0]),int(parts[1])',
                '  struct.pack_into("H",e,10,dur)',
                '  struct.pack_into("H",e,16,mag)',
                '  b=bytearray(e)',
                `  fcntl.ioctl(fd,${EVIOCSFF},b)`,
                '  i=struct.unpack_from("h",b,2)[0]',
                `  os.write(fd,struct.pack("QQHHi",0,0,${EV_FF},${FF_GAIN},0xFFFF))`,
                `  os.write(fd,struct.pack("QQHHi",0,0,${EV_FF},i,1))`,
            ].join('\n');
            this._ffHelper = Gio.Subprocess.new(
                ['python3', '-u', '-c', script],
                Gio.SubprocessFlags.STDIN_PIPE);
            this._ffStdin = this._ffHelper.get_stdin_pipe();
            return true;
        } catch (_e) {
            this._ffHelper = null;
            this._ffStdin = null;
            return false;
        }
    }

    /** Scan /proc/bus/input/devices for an FF-capable input device. */
    _findFFDevice() {
        try {
            let [ok, contents] = GLib.file_get_contents('/proc/bus/input/devices');
            if (!ok) return null;
            let text = new TextDecoder().decode(contents);
            let blocks = text.split('\n\n');
            for (let block of blocks) {
                let ffMatch = block.match(/^B: FF=([0-9a-f ]+)/m);
                if (!ffMatch) continue;
                let ffBits = parseInt(ffMatch[1].trim().split(' ')[0], 16);
                if (!(ffBits & (1 << 16))) continue;
                let evMatch = block.match(/Handlers=.*?(event\d+)/);
                if (evMatch)
                    return `/dev/input/${evMatch[1]}`;
            }
        } catch (_e) {}
        return null;
    }

    _initSysfs() {
        const paths = [
            '/sys/class/leds/vibrator/trigger',
            '/sys/class/leds/vibrator:blink/trigger',
        ];
        for (let path of paths) {
            let f = Gio.File.new_for_path(path);
            if (f.query_exists(null)) {
                this._vibratorBase = path.replace('/trigger', '');
                this._method = 'sysfs';
                return true;
            }
        }
        return false;
    }

    _initFeedbackd() {
        try {
            let bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
            let nameOwner = bus.call_sync(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'GetNameOwner',
                new GLib.Variant('(s)', ['org.sigxcpu.Feedback']),
                null, Gio.DBusCallFlags.NONE, 500, null);
            if (nameOwner) {
                this._feedbackBus = bus;
                this._method = 'feedbackd';
                return true;
            }
        } catch (_e) {}
        return false;
    }

    // -- Public API --

    /**
     * Trigger a short vibration buzz.
     * @param {number} durationMs - duration in milliseconds (default 15)
     */
    vibrate(durationMs = 15) {
        if (this._destroyed || !this.enabled) return;
        let magnitude = Math.round((this.intensity / 100) * 0xFFFF);
        this._doVibrate(Math.max(5, durationMs), magnitude);
    }

    /**
     * Trigger a keypress-style micro-buzz.
     * Only fires if vibrate-on-keypress setting is enabled.
     */
    keypressBuzz() {
        if (!this.vibrateOnKeypress) return;
        this.vibrate(12);
    }

    /**
     * Trigger a short confirmation buzz for hardware toggle changes.
     * Only fires if vibrate-on-slider-change setting is enabled.
     */
    sliderBuzz() {
        if (!this.vibrateOnSliderChange) return;
        this.vibrate(30);
    }

    // -- Backend dispatch --

    _doVibrate(durationMs, magnitude) {
        switch (this._method) {
            case 'ff':
                this._vibrateFF(durationMs, magnitude);
                break;
            case 'sysfs':
                this._vibrateSysfs(durationMs);
                break;
            case 'feedbackd':
                this._vibrateFeedbackd();
                break;
        }
    }

    _vibrateFF(durationMs, magnitude) {
        if (!this._ensureFFHelper()) {
            this._method = 'none';
            return;
        }
        try {
            let cmd = `${durationMs} ${magnitude}\n`;
            this._ffStdin.write_bytes(new GLib.Bytes(cmd), null);
        } catch (_e) {
            // Helper died — clear it so _ensureFFHelper re-spawns next time
            this._ffStdin = null;
            this._ffHelper = null;
        }
    }

    _vibrateSysfs(durationMs) {
        try {
            // Cache Gio.File objects on first use
            if (!this._sysfsFiles) {
                let dur = Gio.File.new_for_path(this._vibratorBase + '/duration');
                let act = Gio.File.new_for_path(this._vibratorBase + '/activate');
                if (dur.query_exists(null) && act.query_exists(null)) {
                    this._sysfsFiles = { type: 'duration', dur, act };
                } else {
                    let br = Gio.File.new_for_path(this._vibratorBase + '/brightness');
                    if (br.query_exists(null))
                        this._sysfsFiles = { type: 'brightness', br };
                    else
                        this._sysfsFiles = { type: 'none' };
                }
            }

            let f = this._sysfsFiles;
            if (f.type === 'duration') {
                f.dur.replace_contents(String(durationMs), null, false,
                    Gio.FileCreateFlags.NONE, null);
                f.act.replace_contents('1', null, false,
                    Gio.FileCreateFlags.NONE, null);
            } else if (f.type === 'brightness') {
                f.br.replace_contents('1', null, false,
                    Gio.FileCreateFlags.NONE, null);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
                    try {
                        f.br.replace_contents('0', null, false,
                            Gio.FileCreateFlags.NONE, null);
                    } catch (_e) {}
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (_e) {
            this._method = 'none';
        }
    }

    _vibrateFeedbackd() {
        try {
            this._feedbackBus.call(
                'org.sigxcpu.Feedback',
                '/org/sigxcpu/Feedback',
                'org.sigxcpu.Feedback',
                'TriggerFeedback',
                new GLib.Variant('(ssa{sv}i)', [
                    'org.gnome.shell.Convergence',
                    'button-pressed', {}, 0,
                ]),
                null, Gio.DBusCallFlags.NO_AUTO_START,
                -1, null, null);
        } catch (_e) {
            this._method = 'none';
        }
    }

    // -- Cleanup --

    destroy() {
        this._destroyed = true;
        this._feedbackBus = null;
        this._settings = null;
        this._sysfsFiles = null;
        if (this._ffStdin) {
            try { this._ffStdin.close(null); } catch (_e) {}
            this._ffStdin = null;
        }
        if (this._ffHelper) {
            try { this._ffHelper.force_exit(); } catch (_e) {}
            this._ffHelper = null;
        }
    }
}
