// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EVENT_SIZE = 24;
const EV_ABS = 0x03;
const ABS_CODE = 0x22;

const SLIDER_DEVICE_NAME = 'Alert slider';
const PROFILES = ['performance', 'balanced', 'power-saver'];
const PROFILE_LABELS = ['Performance', 'Balanced', 'Power Saver'];
const PROFILE_ICONS = [
    'power-profile-performance-symbolic',
    'power-profile-balanced-symbolic',
    'power-profile-power-saver-symbolic',
];

const PP_BUS_NAME = 'net.hadess.PowerProfiles';
const PP_OBJ_PATH = '/net/hadess/PowerProfiles';
const PP_IFACE = 'net.hadess.PowerProfiles';

/**
 * Monitors the OnePlus tri-state hardware toggle and maps its
 * three positions to power-profiles-daemon profiles.
 *
 *   Top    (value 0) -> performance
 *   Middle (value 1) -> balanced
 *   Bottom (value 2) -> power-saver
 *
 * Completely self-contained: removing this file does not break
 * any other module.
 */
export class AlertSlider {
    /**
     * @param {object} controller - Extension controller (optional haptics).
     */
    constructor(controller) {
        this._controller = controller;
        this._stream = null;
        this._cancellable = null;
        this._proxy = null;
        this._currentValue = -1;
        this._destroyed = false;
        this._toast = null;
        this._toastIcon = null;
        this._toastLabel = null;
        this._toastTimeoutId = 0;

        this._start();
    }

    _start() {
        let devPath = this._findDevice();
        if (!devPath) return;

        this._readInitialValue(devPath);

        let file = Gio.File.new_for_path(devPath);
        try {
            this._stream = file.read(null);
        } catch (_e) {
            return;
        }

        this._cancellable = new Gio.Cancellable();

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            PP_BUS_NAME,
            PP_OBJ_PATH,
            PP_IFACE,
            null,
            (_obj, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (_e) {
                    this._proxy = null;
                }
                if (this._currentValue >= 0)
                    this._applyProfile(this._currentValue);
            });

        this._readNext();
    }

    /**
     * Scan /proc/bus/input/devices for the alert slider event node.
     * @returns {string|null} Device path or null.
     */
    _findDevice() {
        try {
            let [ok, contents] = GLib.file_get_contents('/proc/bus/input/devices');
            if (!ok) return null;
            let text = new TextDecoder().decode(contents);
            let blocks = text.split('\n\n');
            for (let block of blocks) {
                if (!block.includes(SLIDER_DEVICE_NAME)) continue;
                let match = block.match(/Handlers=.*?(event\d+)/);
                if (match)
                    return `/dev/input/${match[1]}`;
            }
        } catch (_e) {}
        return null;
    }

    /** Read the current ABS axis value using a Python ioctl helper. */
    _readInitialValue(devPath) {
        let ioctlCode = 0x80184540 + ABS_CODE;
        let cmd = `python3 -c "import os,fcntl,array;fd=os.open('${devPath}',os.O_RDONLY);b=array.array('i',[0]*6);fcntl.ioctl(fd,${ioctlCode},b);os.close(fd);print(b[0])"`;
        try {
            let [ok, stdout] = GLib.spawn_command_line_sync(cmd);
            if (ok) {
                let val = parseInt(new TextDecoder().decode(stdout).trim(), 10);
                if (val >= 0 && val <= 2)
                    this._currentValue = val;
            }
        } catch (_e) {}
    }

    _readNext() {
        if (this._destroyed || !this._stream) return;

        this._stream.read_bytes_async(
            EVENT_SIZE, GLib.PRIORITY_DEFAULT, this._cancellable,
            (_stream, result) => {
                if (this._destroyed) return;
                let bytes;
                try {
                    bytes = this._stream.read_bytes_finish(result);
                } catch (_e) {
                    return;
                }
                if (!bytes || bytes.get_size() < EVENT_SIZE) {
                    this._readNext();
                    return;
                }
                this._parseEvent(bytes.get_data());
                this._readNext();
            });
    }

    _parseEvent(data) {
        if (data.length < EVENT_SIZE) return;

        let type = data[16] | (data[17] << 8);
        let code = data[18] | (data[19] << 8);
        let value = data[20] | (data[21] << 8) | (data[22] << 16) | (data[23] << 24);
        if (value & 0x80000000)
            value = value - 0x100000000;

        if (type === EV_ABS && code === ABS_CODE) {
            if (value >= 0 && value <= 2 && value !== this._currentValue) {
                this._currentValue = value;
                this._applyProfile(value);
            }
        }
    }

    _applyProfile(sliderValue) {
        let profile = PROFILES[sliderValue];
        if (!profile || !this._proxy) return;

        try {
            let current = this._proxy.get_cached_property('ActiveProfile')?.unpack();
            if (current === profile) return;

            this._proxy.call(
                'org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', [PP_IFACE, 'ActiveProfile',
                    new GLib.Variant('s', profile)]),
                Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (_e) {}

        this._showToast(sliderValue);
        this._controller?.haptics?.sliderBuzz();
    }

    _showToast(sliderValue) {
        try {
            let label = PROFILE_LABELS[sliderValue] || '';
            let iconName = PROFILE_ICONS[sliderValue] || 'battery-symbolic';

            if (this._toast && !this._toast.is_destroyed?.()) {
                this._toast.remove_all_transitions();
            } else {
                this._toast = new St.BoxLayout({
                    style_class: 'message',
                    style: 'background-color: rgba(0,0,0,0.82); '
                         + 'border-radius: 999px; '
                         + 'padding: 10px 20px; '
                         + 'spacing: 10px;',
                    vertical: false,
                    reactive: false,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._toastIcon = new St.Icon({
                    style: 'icon-size: 20px; color: white;',
                });
                this._toastLabel = new St.Label({
                    style: 'font-size: 14px; font-weight: bold; color: white;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._toast.add_child(this._toastIcon);
                this._toast.add_child(this._toastLabel);
                Main.uiGroup.add_child(this._toast);
            }

            this._toastIcon.icon_name = iconName;
            this._toastLabel.text = label;
            this._toast.opacity = 255;
            this._toast.visible = true;

            let monitor = Main.layoutManager.primaryMonitor;
            let margin = 8;
            if (monitor) {
                this._toast.set_position(
                    monitor.x + monitor.width - this._toast.width - margin,
                    monitor.y + Math.round(monitor.height * 0.15));
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._toast && !this._toast.is_destroyed?.()) {
                        this._toast.set_position(
                            monitor.x + monitor.width - this._toast.width - margin,
                            monitor.y + Math.round(monitor.height * 0.15));
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }

            if (this._toastTimeoutId) {
                GLib.source_remove(this._toastTimeoutId);
                this._toastTimeoutId = 0;
            }
            this._toastTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._toastTimeoutId = 0;
                if (this._toast && !this._toast.is_destroyed?.()) {
                    this._toast.ease({
                        opacity: 0, duration: 300,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            if (this._toast) this._toast.visible = false;
                        },
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (_e) {}
    }

    _destroyToast() {
        if (this._toastTimeoutId) {
            GLib.source_remove(this._toastTimeoutId);
            this._toastTimeoutId = 0;
        }
        if (this._toast) {
            this._toast.get_parent()?.remove_child(this._toast);
            this._toast.destroy();
            this._toast = null;
            this._toastIcon = null;
            this._toastLabel = null;
        }
    }

    /** Clean up all resources. */
    destroy() {
        this._destroyed = true;
        this._destroyToast();
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._stream) {
            try { this._stream.close(null); } catch (_e) {}
            this._stream = null;
        }
        this._proxy = null;
        this._controller = null;
    }
}
