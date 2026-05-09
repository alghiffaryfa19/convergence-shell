// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * GNOME 48 compat: is_maximized() was replaced by get_maximized() in Mutter 16.
 * Returns true when the window is fully maximized (both axes).
 */
export function isWindowMaximized(metaWindow) {
    if (typeof metaWindow.is_maximized === 'function')
        return metaWindow.is_maximized();
    if (typeof metaWindow.get_maximized === 'function')
        return metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH;
    return false;
}

const CURSOR_POINTER = (() => {
    try { return Meta.Cursor.POINTER ?? Meta.Cursor.DEFAULT; }
    catch (_e) { return 0; }
})();

export function addClickCursor(actor, runtimeDisposer = null) {
    // On GNOME 50+, set_cursor may not exist on display. Skip gracefully.
    if (typeof global.display?.set_cursor !== 'function')
        return;

    let connect = (signal, callback) => {
        if (runtimeDisposer?.connect)
            runtimeDisposer.connect(actor, signal, callback);
        else
            actor.connect(signal, callback);
    };

    connect('enter-event', () => {
        try { global.display.set_cursor(CURSOR_POINTER); } catch (_e) {}
        return Clutter.EVENT_PROPAGATE;
    });
    connect('leave-event', () => {
        try { global.display.set_cursor(Meta.Cursor?.DEFAULT ?? 0); } catch (_e) {}
        return Clutter.EVENT_PROPAGATE;
    });
}

export function createLongPressController(delayMs, onFire) {
    let timeoutId = 0;

    return {
        start(...args) {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                timeoutId = 0;
                onFire(...args);
                return GLib.SOURCE_REMOVE;
            });
        },

        cancel() {
            if (!timeoutId)
                return;
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        },
    };
}

function _getMonitors() {
    let lm = Main.layoutManager;
    let monitors = lm?.monitors ?? [];
    let primaryIndex = lm?.primaryIndex ?? 0;
    if (_monitorCache.sig !== '' &&
        monitors === _monitorCache._ref &&
        primaryIndex === _monitorCache._pri)
        return _monitorCache.monitors;
    let sig = `${primaryIndex}::${monitors.map(m =>
        `${m.x},${m.y},${m.width},${m.height},${m.geometry_scale ?? 1}`).join('|')}`;
    if (_monitorCache.sig !== sig) {
        _monitorCache.sig = sig;
        _monitorCache.monitors = monitors;
        _monitorCache.primaryMonitor = lm?.primaryMonitor ?? monitors[0] ?? null;
        _monitorQueryCache.sig = '';
    }
    _monitorCache._ref = monitors;
    _monitorCache._pri = primaryIndex;
    return _monitorCache.monitors;
}

let _monitorCache = {
    sig: '',
    monitors: [],
    primaryMonitor: null,
    _ref: null,
    _pri: -1,
};

let _monitorQueryCache = {
    sig: '',
    x: 0,
    y: 0,
    monitor: null,
};

const SCALE_PROFILE_KEYS = {
    grid: ['ui-scale-grid-min', 'ui-scale-grid-max'],
    widget: ['ui-scale-widget-min', 'ui-scale-widget-max'],
    gesture: ['ui-scale-gesture-min', 'ui-scale-gesture-max'],
    keyboard: ['ui-scale-keyboard-min', 'ui-scale-keyboard-max'],
    panel: ['ui-scale-panel-min', 'ui-scale-panel-max'],
    recent: ['ui-scale-recent-min', 'ui-scale-recent-max'],
};

let _scaleSettings = null;
let _scaleSettingsConnected = false;
let _scaleClampCache = Object.create(null);

function _getScaleSettings() {
    if (_scaleSettings !== null)
        return _scaleSettings;
    try {
        _scaleSettings = new Gio.Settings({
            schema_id: 'org.gnome.shell.extensions.convergence',
        });
    } catch (_e) {
        _scaleSettings = false;
    }
    if (_scaleSettings && !_scaleSettingsConnected) {
        _scaleSettingsConnected = true;
        try {
            _scaleSettings.connect('changed', (_, key) => {
                for (let profile in SCALE_PROFILE_KEYS) {
                    let [k0, k1] = SCALE_PROFILE_KEYS[profile];
                    if (key === k0 || key === k1) {
                        delete _scaleClampCache[profile];
                        break;
                    }
                }
            });
        } catch (_e) {}
    }
    return _scaleSettings;
}

function _readScaleClamp(profile, fallbackMin, fallbackMax) {
    if (profile && profile in _scaleClampCache)
        return _scaleClampCache[profile];

    let min = fallbackMin;
    let max = fallbackMax;
    let fromSettings = false;
    let keys = profile ? SCALE_PROFILE_KEYS[profile] : null;
    let settings = _getScaleSettings();
    if (keys && settings) {
        try {
            let schema = settings.settings_schema;
            if (schema?.has_key(keys[0]) && schema?.has_key(keys[1])) {
                min = settings.get_int(keys[0]) / 100;
                max = settings.get_int(keys[1]) / 100;
                fromSettings = true;
            }
        } catch (_e) {
            min = fallbackMin;
            max = fallbackMax;
        }
    }
    min = Math.max(0.4, Math.min(2.2, min));
    max = Math.max(0.4, Math.min(2.2, max));
    if (min > max)
        [min, max] = [max, min];
    let result = [min, max];
    // Only cache when values came from settings (stable).
    // Fallback values may change between calls so must not be cached.
    if (profile && fromSettings)
        _scaleClampCache[profile] = result;
    return result;
}

export function getMonitorForCoords(x, y) {
    let monitors = _getMonitors();
    let sig = _monitorCache.sig;
    if (_monitorQueryCache.sig === sig &&
        _monitorQueryCache.x === x &&
        _monitorQueryCache.y === y &&
        _monitorQueryCache.monitor)
        return _monitorQueryCache.monitor;
    for (let m of monitors) {
        if (x >= m.x && x < m.x + m.width &&
            y >= m.y && y < m.y + m.height) {
            _monitorQueryCache.sig = sig;
            _monitorQueryCache.x = x;
            _monitorQueryCache.y = y;
            _monitorQueryCache.monitor = m;
            return m;
        }
    }
    let fallback = _monitorCache.primaryMonitor ?? monitors[0] ?? null;
    _monitorQueryCache.sig = sig;
    _monitorQueryCache.x = x;
    _monitorQueryCache.y = y;
    _monitorQueryCache.monitor = fallback;
    return fallback;
}

export function getMonitorScale(monitorOrIndex = null) {
    let monitor = monitorOrIndex;
    if (Number.isInteger(monitorOrIndex)) {
        let monitors = _getMonitors();
        monitor = monitors[monitorOrIndex] ?? null;
    }
    if (!monitor)
        monitor = _monitorCache.primaryMonitor ?? _getMonitors()[0] ?? null;
    let scale = monitor?.geometry_scale ?? 1;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function snapToPixel(value, monitorOrIndex = null) {
    let numeric = Number(value);
    if (!Number.isFinite(numeric))
        return 0;
    let scale = getMonitorScale(monitorOrIndex);
    return Math.round(numeric * scale) / scale;
}

export function snapRectToPixel(rect, monitorOrIndex = null) {
    if (!rect)
        return null;
    return {
        x: snapToPixel(rect.x, monitorOrIndex),
        y: snapToPixel(rect.y, monitorOrIndex),
        width: Math.max(0, snapToPixel(rect.width, monitorOrIndex)),
        height: Math.max(0, snapToPixel(rect.height, monitorOrIndex)),
    };
}

export function getAdaptiveScale({
    profile = null,
    monitor = null,
    logicalWidth = null,
    referenceWidth = 432,
    min = 0.7,
    max = 1.6,
} = {}) {
    let resolvedMonitor = monitor;
    if (Number.isInteger(monitor)) {
        let monitors = _getMonitors();
        resolvedMonitor = monitors[monitor] ?? null;
    }
    if (!resolvedMonitor)
        resolvedMonitor = _monitorCache.primaryMonitor ?? _getMonitors()[0] ?? null;

    let width = logicalWidth;
    if (!Number.isFinite(width) || width <= 0)
        width = resolvedMonitor?.width ?? global.stage.width ?? referenceWidth;

    // Use logical width directly so that phones with the same physical
    // resolution but different fractional scaling (e.g. 1080p@2x →
    // 540 logical vs 1080p@2.57x → 476 logical) produce proportionally
    // different UI sizes that match the available logical space.
    let s = width / Math.max(1, referenceWidth);
    [min, max] = _readScaleClamp(profile, min, max);
    return Math.max(min, Math.min(max, s));
}
