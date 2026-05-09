// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford
//
// Auto-brightness: adjusts the phone backlight based on ambient light
// sensor readings from iio-sensor-proxy.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const POLL_INTERVAL_MS = 2000;
const SMOOTHING_FACTOR = 0.3;  // EMA weight for new readings (0–1)
const MIN_BRIGHTNESS = 10;     // Never go fully dark
const MAX_BRIGHTNESS = 4095;

/**
 * Map lux to a 0–4095 brightness value.  The curve is designed for
 * a phone display: aggressive at low lux (indoor), gentle at high lux
 * (outdoor).
 *
 *   0–5 lux    → very dim (10–80)
 *   5–50 lux   → indoor (80–600)
 *   50–300 lux → bright indoor (600–2000)
 *   300+ lux   → outdoor (2000–4095)
 */
function luxToBrightness(lux) {
    if (lux <= 0)
        return MIN_BRIGHTNESS;
    if (lux <= 5)
        return Math.round(MIN_BRIGHTNESS + (lux / 5) * 70);
    if (lux <= 50)
        return Math.round(80 + ((lux - 5) / 45) * 520);
    if (lux <= 300)
        return Math.round(600 + ((lux - 50) / 250) * 1400);
    if (lux <= 1000)
        return Math.round(2000 + ((lux - 300) / 700) * 2095);
    return MAX_BRIGHTNESS;
}

export class AutoBrightness {
    constructor(settings) {
        this._settings = settings;
        this._destroyed = false;
        this._enabled = false;
        this._smoothedLux = -1;
        this._pollId = 0;
        this._proxy = null;
        this._claimed = false;
        this._backlightPath = this._findBacklightPath();
        this._maxBrightness = this._readMaxBrightness();

        // Watch the GNOME setting
        try {
            this._gsdSettings = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.power'});
            this._settingsId = this._gsdSettings.connect('changed::ambient-enabled', () => {
                this._syncEnabled();
            });
        } catch (_e) {
            this._gsdSettings = null;
            this._settingsId = 0;
        }

        this._syncEnabled();
    }

    _syncEnabled() {
        let shouldEnable = this._gsdSettings?.get_boolean('ambient-enabled') ?? false;
        if (shouldEnable && !this._enabled)
            this._start();
        else if (!shouldEnable && this._enabled)
            this._stop();
    }

    _start() {
        if (this._enabled || this._destroyed)
            return;
        this._enabled = true;

        try {
            this._proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, 0, null,
                'net.hadess.SensorProxy', '/net/hadess/SensorProxy',
                'net.hadess.SensorProxy', null);
        } catch (_e) {
            this._enabled = false;
            return;
        }

        // Claim the light sensor
        try {
            Gio.DBus.system.call_sync(
                'net.hadess.SensorProxy', '/net/hadess/SensorProxy',
                'net.hadess.SensorProxy', 'ClaimLight',
                null, null, Gio.DBusCallFlags.NONE, 1000, null);
            this._claimed = true;
        } catch (_e) {
            this._enabled = false;
            return;
        }

        this._smoothedLux = -1;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            if (this._destroyed || !this._enabled) {
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        // Initial reading
        this._update();
    }

    _stop() {
        this._enabled = false;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._claimed) {
            try {
                Gio.DBus.system.call_sync(
                    'net.hadess.SensorProxy', '/net/hadess/SensorProxy',
                    'net.hadess.SensorProxy', 'ReleaseLight',
                    null, null, Gio.DBusCallFlags.NONE, 1000, null);
            } catch (_e) {}
            this._claimed = false;
        }
        this._proxy = null;
    }

    _update() {
        let lux = this._proxy?.get_cached_property('LightLevel')?.get_double() ?? -1;
        if (lux < 0)
            return;

        // Exponential moving average for smooth transitions
        if (this._smoothedLux < 0)
            this._smoothedLux = lux;
        else
            this._smoothedLux = SMOOTHING_FACTOR * lux + (1 - SMOOTHING_FACTOR) * this._smoothedLux;

        let target = luxToBrightness(this._smoothedLux);
        // Scale to actual max brightness
        if (this._maxBrightness !== MAX_BRIGHTNESS)
            target = Math.round(target * this._maxBrightness / MAX_BRIGHTNESS);
        target = Math.max(MIN_BRIGHTNESS, Math.min(target, this._maxBrightness));

        this._writeBrightness(target);
    }

    _findBacklightPath() {
        try {
            let dir = Gio.File.new_for_path('/sys/class/backlight');
            let enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                let path = `/sys/class/backlight/${info.get_name()}/brightness`;
                if (Gio.File.new_for_path(path).query_exists(null))
                    return path;
            }
        } catch (_e) {}
        return null;
    }

    _readMaxBrightness() {
        if (!this._backlightPath)
            return MAX_BRIGHTNESS;
        try {
            let maxPath = this._backlightPath.replace('/brightness', '/max_brightness');
            let [ok, contents] = GLib.file_get_contents(maxPath);
            if (ok)
                return parseInt(new TextDecoder().decode(contents).trim(), 10) || MAX_BRIGHTNESS;
        } catch (_e) {}
        return MAX_BRIGHTNESS;
    }

    _writeBrightness(value) {
        if (!this._backlightPath)
            return;
        try {
            let file = Gio.File.new_for_path(this._backlightPath);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new TextEncoder().encode(`${value}\n`);
            stream.write_bytes(new GLib.Bytes(bytes), null);
            stream.close(null);
        } catch (_e) {}
    }

    destroy() {
        this._destroyed = true;
        this._stop();
        if (this._settingsId && this._gsdSettings) {
            this._gsdSettings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._gsdSettings = null;
    }
}
