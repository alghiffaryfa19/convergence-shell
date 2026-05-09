// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford
//
// In-call proximity: blanks the phone display and blocks touch when
// the proximity sensor detects the phone is held to the ear during
// a voice call.  Restores the display when the phone is moved away
// or the call ends.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MM_DBUS_NAME = 'org.freedesktop.ModemManager1';
const MM_MODEM_PATH = '/org/freedesktop/ModemManager1/Modem/0';
const MM_VOICE_IFACE = 'org.freedesktop.ModemManager1.Modem.Voice';
const MM_CALL_IFACE = 'org.freedesktop.ModemManager1.Call';
const SENSOR_DBUS_NAME = 'net.hadess.SensorProxy';
const SENSOR_PATH = '/net/hadess/SensorProxy';
const SENSOR_IFACE = 'net.hadess.SensorProxy';

// ModemManager call states
const MM_CALL_STATE_ACTIVE = 4;
const MM_CALL_STATE_HELD = 5;

export class CallProximity {
    constructor() {
        this._destroyed = false;
        this._inCall = false;
        this._proximityClaimed = false;
        this._screenBlanked = false;
        this._savedBrightness = 0;
        this._sensorProxy = null;
        this._proximitySignalId = 0;
        this._inputBlocker = null;
        this._callSignals = [];
        this._voiceProxy = null;

        this._backlightPath = this._findBacklightPath();
        this._maxBrightness = this._readMaxBrightness();

        this._setupVoiceMonitor();
    }

    _setupVoiceMonitor() {
        try {
            // Watch for calls being added/removed
            this._voiceProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                MM_DBUS_NAME, MM_MODEM_PATH, MM_VOICE_IFACE, null);

            this._callAddedId = this._voiceProxy.connectSignal('CallAdded',
                (_proxy, _sender, [callPath]) => this._onCallAdded(callPath));
            this._callDeletedId = this._voiceProxy.connectSignal('CallDeleted',
                (_proxy, _sender, [callPath]) => this._onCallDeleted(callPath));

            // Check for existing active calls
            let calls = this._voiceProxy.get_cached_property('Calls');
            if (calls) {
                let paths = calls.deep_unpack();
                for (let path of paths)
                    this._onCallAdded(path);
            }
        } catch (e) {
            log(`[Convergence:CallProximity] Voice monitor setup failed: ${e.message}`);
        }
    }

    _onCallAdded(callPath) {
        if (this._destroyed)
            return;
        try {
            let callProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                MM_DBUS_NAME, callPath, MM_CALL_IFACE, null);

            let sigId = callProxy.connect('g-properties-changed', () => {
                this._syncCallState();
            });
            this._callSignals.push({ proxy: callProxy, sigId, path: callPath });
            this._syncCallState();
        } catch (e) {
            log(`[Convergence:CallProximity] Failed to monitor call ${callPath}: ${e.message}`);
        }
    }

    _onCallDeleted(callPath) {
        this._callSignals = this._callSignals.filter(entry => {
            if (entry.path === callPath) {
                entry.proxy.disconnect(entry.sigId);
                return false;
            }
            return true;
        });
        this._syncCallState();
    }

    _syncCallState() {
        let wasInCall = this._inCall;
        this._inCall = false;

        for (let entry of this._callSignals) {
            let stateProp = entry.proxy.get_cached_property('State');
            if (!stateProp)
                continue;
            let state = stateProp.get_int32();
            if (state === MM_CALL_STATE_ACTIVE || state === MM_CALL_STATE_HELD) {
                this._inCall = true;
                break;
            }
        }

        if (this._inCall && !wasInCall)
            this._startProximityMonitor();
        else if (!this._inCall && wasInCall)
            this._stopProximityMonitor();
    }

    _startProximityMonitor() {
        if (this._proximityClaimed)
            return;

        try {
            this._sensorProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                SENSOR_DBUS_NAME, SENSOR_PATH, SENSOR_IFACE, null);

            let hasProximity = this._sensorProxy.get_cached_property('HasProximity')?.get_boolean();
            if (!hasProximity) {
                this._sensorProxy = null;
                return;
            }

            Gio.DBus.system.call_sync(
                SENSOR_DBUS_NAME, SENSOR_PATH, SENSOR_IFACE,
                'ClaimProximity', null, null, Gio.DBusCallFlags.NONE, 1000, null);
            this._proximityClaimed = true;

            this._proximitySignalId = this._sensorProxy.connect('g-properties-changed',
                () => this._onProximityChanged());
            // Check initial state
            this._onProximityChanged();
        } catch (e) {
            log(`[Convergence:CallProximity] Proximity setup failed: ${e.message}`);
        }
    }

    _stopProximityMonitor() {
        if (this._screenBlanked)
            this._unblankScreen();

        if (this._proximitySignalId && this._sensorProxy) {
            this._sensorProxy.disconnect(this._proximitySignalId);
            this._proximitySignalId = 0;
        }

        if (this._proximityClaimed) {
            try {
                Gio.DBus.system.call_sync(
                    SENSOR_DBUS_NAME, SENSOR_PATH, SENSOR_IFACE,
                    'ReleaseProximity', null, null, Gio.DBusCallFlags.NONE, 1000, null);
            } catch (_e) {}
            this._proximityClaimed = false;
        }

        this._sensorProxy = null;
    }

    _onProximityChanged() {
        let near = this._sensorProxy?.get_cached_property('ProximityNear')?.get_boolean() ?? false;

        if (near && !this._screenBlanked)
            this._blankScreen();
        else if (!near && this._screenBlanked)
            this._unblankScreen();
    }

    _blankScreen() {
        if (this._screenBlanked)
            return;
        this._savedBrightness = this._readBrightness();
        if (this._savedBrightness <= 0)
            this._savedBrightness = Math.round(this._maxBrightness * 0.3);
        this._writeBrightness(0);
        this._setupInputBlocker();
        this._screenBlanked = true;
    }

    _unblankScreen() {
        if (!this._screenBlanked)
            return;
        this._writeBrightness(this._savedBrightness || Math.round(this._maxBrightness * 0.3));
        this._removeInputBlocker();
        this._screenBlanked = false;
    }

    _setupInputBlocker() {
        if (this._inputBlocker)
            return;
        let phoneIdx = 0;
        try {
            let mon = global.display.get_monitor_geometry(phoneIdx);
            this._inputBlocker = new Clutter.Actor({
                x: mon.x, y: mon.y,
                width: mon.width, height: mon.height,
                reactive: true, opacity: 0,
            });
            this._inputBlocker.connect('button-press-event', () => Clutter.EVENT_STOP);
            this._inputBlocker.connect('touch-event', () => Clutter.EVENT_STOP);
            this._inputBlocker.connect('scroll-event', () => Clutter.EVENT_STOP);
            Main.layoutManager.uiGroup.add_child(this._inputBlocker);
        } catch (_e) {}
    }

    _removeInputBlocker() {
        if (this._inputBlocker?.get_parent())
            this._inputBlocker.get_parent().remove_child(this._inputBlocker);
        this._inputBlocker?.destroy();
        this._inputBlocker = null;
    }

    // ── Backlight helpers ────────────────────────────────────────────

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
            return 4095;
        try {
            let maxPath = this._backlightPath.replace('/brightness', '/max_brightness');
            let [ok, contents] = GLib.file_get_contents(maxPath);
            if (ok)
                return parseInt(new TextDecoder().decode(contents).trim(), 10) || 4095;
        } catch (_e) {}
        return 4095;
    }

    _readBrightness() {
        if (!this._backlightPath)
            return 0;
        try {
            let [ok, contents] = GLib.file_get_contents(this._backlightPath);
            if (ok)
                return parseInt(new TextDecoder().decode(contents).trim(), 10) || 0;
        } catch (_e) {}
        return 0;
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
        this._stopProximityMonitor();
        for (let entry of this._callSignals)
            entry.proxy.disconnect(entry.sigId);
        this._callSignals = [];
        if (this._callAddedId && this._voiceProxy)
            this._voiceProxy.disconnectSignal(this._callAddedId);
        if (this._callDeletedId && this._voiceProxy)
            this._voiceProxy.disconnectSignal(this._callDeletedId);
        this._voiceProxy = null;
    }
}
