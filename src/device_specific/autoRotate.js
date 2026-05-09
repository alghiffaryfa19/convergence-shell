// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford
//
// Auto-rotate via iio-sensor-proxy — replaces the missing
// gsd-orientation plugin on postmarketOS. Monitors the accelerometer
// and applies display transforms via Mutter's ApplyMonitorsConfig
// D-Bus API using an out-of-process gdbus call (in-process calls
// deadlock because Mutter runs in the same main loop as gnome-shell).
//
// Completely self-contained: removing this file does not break
// any other module.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOCK_SCHEMA = 'org.gnome.settings-daemon.peripherals.touchscreen';
const LOCK_KEY = 'orientation-lock';

// Sensor orientation -> Mutter MetaMonitorTransform
const TRANSFORM_MAP = {
    'normal':    0,  // no rotation
    'left-up':   1,  // 90° CCW
    'bottom-up': 2,  // 180°
    'right-up':  3,  // 90° CW (270° CCW)
};

const DEBOUNCE_MS = 300;
const ROTATION_ANIM_MS = 300;

// Transform → rotation angle (degrees) for the crossfade snapshot.
// The snapshot shows the OLD content; we rotate it from oldAngle→newAngle.
const TRANSFORM_ANGLE = {
    0: 0,    // normal (portrait)
    1: 90,   // 90° CCW (left-up)
    2: 180,  // upside-down
    3: 270,  // 90° CW (right-up)
};

const EXT_SCHEMA = 'org.gnome.shell.extensions.convergence';
const TILT_LOCK_KEY = 'auto-rotate-tilt-lock';

// Tilt values that indicate the phone is flat
const FLAT_TILTS = new Set(['face-up', 'face-down']);

// When tilt-lock is enabled, require the new orientation to be stable
// for this duration before applying. Intentional rotation produces a
// brief transition through intermediate readings, while lying-down
// orientation changes are instant and stable — so a longer hold time
// filters out the lying-down case less reliably than checking if the
// orientation CHANGED recently (indicating physical movement).
const TILT_LOCK_DEBOUNCE_MS = 1500;

export class AutoRotate {
    constructor(settings) {
        this._destroyed = false;
        this._sensorProxy = null;
        this._propsChangedId = 0;
        this._lockSettings = null;
        this._lockChangedId = 0;
        this._extSettings = settings ?? null;
        this._lastAppliedTransform = -1;
        this._debounceId = 0;
        this._applying = false;

        try {
            this._lockSettings = new Gio.Settings({ schema_id: LOCK_SCHEMA });
            this._lockChangedId = this._lockSettings.connect(
                `changed::${LOCK_KEY}`, () => this._onLockChanged());
        } catch (_e) {
            return;
        }

        this._initSensorProxy();
    }

    _initSensorProxy() {
        try {
            this._sensorProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'net.hadess.SensorProxy',
                '/net/hadess/SensorProxy',
                'net.hadess.SensorProxy',
                null);
        } catch (_e) {
            return;
        }

        if (!this._sensorProxy)
            return;

        let hasAccel = this._sensorProxy.get_cached_property('HasAccelerometer');
        if (!hasAccel || !hasAccel.unpack())
            return;

        // Claim the accelerometer so sensor-proxy keeps reporting
        try {
            this._sensorProxy.call_sync(
                'ClaimAccelerometer', null,
                Gio.DBusCallFlags.NONE, 1000, null);
            this._accelerometerClaimed = true;
        } catch (_e) {}

        this._propsChangedId = this._sensorProxy.connect(
            'g-properties-changed', () => this._onSensorChanged());

        // Apply initial orientation
        if (!this._lockSettings.get_boolean(LOCK_KEY))
            this._scheduleApply();
    }

    _onLockChanged() {
        if (this._destroyed) return;
        if (!this._lockSettings.get_boolean(LOCK_KEY))
            this._scheduleApply();
    }

    _onSensorChanged() {
        if (this._destroyed) return;
        if (this._lockSettings?.get_boolean(LOCK_KEY)) return;

        // Track orientation changes to detect physical movement
        let orientProp = this._sensorProxy.get_cached_property('AccelerometerOrientation');
        if (orientProp) {
            let orient = orientProp.unpack();
            if (orient !== this._lastSeenOrientation) {
                this._orientChangeCount = (this._orientChangeCount ?? 0) + 1;
                this._lastSeenOrientation = orient;
            }
        }

        this._scheduleApply();
    }

    _scheduleApply() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }

        let tiltLockEnabled = false;
        try {
            if (this._extSettings?.settings_schema?.has_key?.(TILT_LOCK_KEY))
                tiltLockEnabled = this._extSettings.get_boolean(TILT_LOCK_KEY);
        } catch (_e) {}

        // Use a longer debounce when tilt-lock is active to give the
        // user time to settle the phone in its new orientation
        let delay = tiltLockEnabled ? TILT_LOCK_DEBOUNCE_MS : DEBOUNCE_MS;

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._debounceId = 0;
            this._applyCurrentOrientation();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyCurrentOrientation() {
        if (this._destroyed || !this._sensorProxy || this._applying) return;

        let orientProp = this._sensorProxy.get_cached_property('AccelerometerOrientation');
        if (!orientProp) return;
        let orientation = orientProp.unpack();

        let transform = TRANSFORM_MAP[orientation];
        if (transform === undefined) return;
        if (transform === this._lastAppliedTransform) return;

        // Tilt lock: for non-portrait rotations, check if the phone
        // is flat OR if there hasn't been enough physical movement.
        // When lying on your side, the orientation flips once and stays
        // stable. When intentionally rotating, multiple orientation
        // changes happen in quick succession as the phone moves through
        // intermediate angles.
        if (transform !== 0) {
            let tiltLockEnabled = false;
            try {
                if (this._extSettings?.settings_schema?.has_key?.(TILT_LOCK_KEY))
                    tiltLockEnabled = this._extSettings.get_boolean(TILT_LOCK_KEY);
            } catch (_e) {}

            if (tiltLockEnabled) {
                // Check flat tilt
                let tiltProp = this._sensorProxy.get_cached_property('AccelerometerTilt');
                if (tiltProp && FLAT_TILTS.has(tiltProp.unpack())) {
                    this._orientChangeCount = 0;
                    return;
                }

                // Require at least 2 orientation changes (physical movement)
                // before applying a non-portrait rotation
                if ((this._orientChangeCount ?? 0) < 2) {
                    return;
                }
            }
        }

        this._orientChangeCount = 0;
        this._applyTransform(transform);
    }

    _applyTransform(transform) {
        this._applying = true;
        let oldTransform = this._lastAppliedTransform ?? 0;

        // Capture a screenshot of the phone display before rotating.
        // The snapshot is shown on top during the transition.
        this._captureRotationSnapshot(oldTransform, transform);

        let getStateCmd = [
            'gdbus', 'call', '--session',
            '--dest', 'org.gnome.Mutter.DisplayConfig',
            '--object-path', '/org/gnome/Mutter/DisplayConfig',
            '--method', 'org.gnome.Mutter.DisplayConfig.GetCurrentState',
        ];

        try {
            let proc = Gio.Subprocess.new(
                getStateCmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            proc.communicate_utf8_async(null, null, (p, res) => {
                this._applying = false;
                if (this._destroyed) return;
                try {
                    let [, stdout] = p.communicate_utf8_finish(res);
                    if (!stdout) return;
                    this._parseAndApply(stdout, transform);
                } catch (e) {
                    log(`[Convergence:AutoRotate] GetCurrentState error: ${e.message}`);
                }
            });
        } catch (e) {
            this._applying = false;
            log(`[Convergence:AutoRotate] spawn error: ${e.message}`);
        }
    }

    /**
     * Capture the phone display into a snapshot actor that is shown
     * on top during the orientation change, then crossfade/rotate it
     * out to reveal the new layout underneath.
     */
    _captureRotationSnapshot(oldTransform, newTransform) {
        try {
            let monIdx = 0;
            let mon = global.display.get_monitor_geometry(monIdx);
            if (!mon)
                return;

            let screenshot = new Shell.Screenshot();
            screenshot.screenshot_stage_to_content(
                (obj, result) => {
                    try {
                        let content = obj.screenshot_stage_to_content_finish(result);
                        if (content)
                            this._animateRotationSnapshot(content, mon, oldTransform, newTransform);
                    } catch (_e) {}
                });
        } catch (_e) {}
    }

    _animateRotationSnapshot(content, monGeo, oldTransform, newTransform) {
        let actor = new Clutter.Actor({
            x: monGeo.x,
            y: monGeo.y,
            width: monGeo.width,
            height: monGeo.height,
            opacity: 255,
        });
        actor.set_content(content);
        // Clip to the phone display area so the desktop isn't affected
        actor.set_clip(0, 0, monGeo.width, monGeo.height);
        actor.set_pivot_point(0.5, 0.5);
        Main.layoutManager.uiGroup.add_child(actor);

        // Shortest-path rotation delta
        let oldAngle = TRANSFORM_ANGLE[oldTransform] ?? 0;
        let newAngle = TRANSFORM_ANGLE[newTransform] ?? 0;
        let delta = newAngle - oldAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;

        actor.ease({
            opacity: 0,
            rotation_angle_z: delta,
            duration: ROTATION_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (actor.get_parent())
                    actor.get_parent().remove_child(actor);
                actor.destroy();
            },
        });
    }

    _parseAndApply(stateOutput, transform) {
        try {
            // Extract serial (first uint32 in the output)
            let serialMatch = stateOutput.match(/^\(uint32 (\d+),/);
            if (!serialMatch) return;
            let serial = parseInt(serialMatch[1]);

            // Extract connector and mode from the monitors section
            let connMatch = stateOutput.match(/\('([^']+)',\s*'[^']*',\s*'[^']*',\s*'[^']*'\),\s*\[\('([^']+)'/);
            if (!connMatch) return;
            let connector = connMatch[1];
            let modeId = connMatch[2];

            // Extract current scale from logical monitors
            let scaleMatch = stateOutput.match(/\[\(\d+,\s*\d+,\s*([\d.]+),/);
            if (!scaleMatch) return;
            let scale = parseFloat(scaleMatch[1]);

            let applyCmd = [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Mutter.DisplayConfig',
                '--object-path', '/org/gnome/Mutter/DisplayConfig',
                '--method', 'org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig',
                String(serial), '1',
                `[(0, 0, ${scale}, uint32 ${transform}, true, [('${connector}', '${modeId}', {})])]`,
                '{}',
            ];

            let proc = Gio.Subprocess.new(
                applyCmd,
                Gio.SubprocessFlags.STDERR_PIPE);

            proc.wait_async(null, (p, res) => {
                try {
                    p.wait_finish(res);
                    if (p.get_successful()) {
                        this._lastAppliedTransform = transform;
                    } else {
                        log(`[Convergence:AutoRotate] ApplyMonitorsConfig failed`);
                    }
                } catch (e) {
                    log(`[Convergence:AutoRotate] apply error: ${e.message}`);
                }
            });
        } catch (e) {
            log(`[Convergence:AutoRotate] parse error: ${e.message}`);
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }

        if (this._propsChangedId && this._sensorProxy) {
            this._sensorProxy.disconnect(this._propsChangedId);
            this._propsChangedId = 0;
        }

        if (this._accelerometerClaimed && this._sensorProxy) {
            try {
                this._sensorProxy.call_sync(
                    'ReleaseAccelerometer', null,
                    Gio.DBusCallFlags.NONE, 1000, null);
            } catch (_e) {}
        }

        if (this._lockChangedId && this._lockSettings) {
            this._lockSettings.disconnect(this._lockChangedId);
            this._lockChangedId = 0;
        }

        this._sensorProxy = null;
        this._lockSettings = null;
    }
}
