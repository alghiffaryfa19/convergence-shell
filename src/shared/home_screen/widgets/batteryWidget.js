// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { RuntimeDisposer } from '../../utilities/runtimeDisposer.js';

let Clutter = null;
let St = null;

function _bindShellEnv(runtimeEnv) {
    Clutter = runtimeEnv?.Clutter ?? Clutter;
    St = runtimeEnv?.St ?? St;
    if (!Clutter || !St)
        throw new Error('Battery widget requires shell runtime env');
}

// ── Constants ───────────────────────────────────────────────────────
const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';

const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_DISCHARGING = 2;
const UPOWER_STATE_FULLY_CHARGED = 4;

const POLL_INTERVAL_S = 60;
const MAX_SAMPLES = 1440;       // 24h at 1/min (in-memory session data)
const MAX_CYCLES = 50;          // persisted discharge/charge cycle records
const SAVE_DEBOUNCE_S = 300;    // flush history to disk every 5 min

const _utf8Enc = new TextEncoder();
const _utf8Dec = new TextDecoder();

const HISTORY_FILE = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'convergence-battery-history.json',
]);

// ── sysfs helpers ───────────────────────────────────────────────────

function _findBatterySysfs() {
    try {
        let dir = Gio.File.new_for_path('/sys/class/power_supply');
        let en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            let name = info.get_name();
            let typePath = `/sys/class/power_supply/${name}/type`;
            try {
                let [ok, raw] = GLib.file_get_contents(typePath);
                if (ok && _utf8Dec.decode(raw).trim() === 'Battery')
                    return `/sys/class/power_supply/${name}`;
            } catch (_e) {}
        }
        en.close(null);
    } catch (_e) {}
    return null;
}

let _batterySysfs = null;

function _sysfs(name) {
    if (!_batterySysfs) _batterySysfs = _findBatterySysfs();
    if (!_batterySysfs) return null;
    try {
        let [ok, raw] = GLib.file_get_contents(`${_batterySysfs}/${name}`);
        if (ok && raw) return _utf8Dec.decode(raw).trim();
    } catch (_e) {}
    return null;
}

function _sysfsInt(name) {
    let v = _sysfs(name);
    return v !== null ? parseInt(v, 10) : NaN;
}

// ── Formatting ──────────────────────────────────────────────────────

function _fmtDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--';
    let h = Math.floor(seconds / 3600);
    let m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function _fmtRate(pctPerHour) {
    if (!isFinite(pctPerHour)) return '--';
    let sign = pctPerHour >= 0 ? '+' : '';
    return `${sign}${pctPerHour.toFixed(1)}%/hr`;
}

// ── Persistent history ──────────────────────────────────────────────

function _loadHistory() {
    try {
        let [ok, data] = GLib.file_get_contents(HISTORY_FILE);
        if (ok && data) {
            let obj = JSON.parse(_utf8Dec.decode(data));
            if (obj && obj.version === 1) return obj;
        }
    } catch (_e) {}
    return _emptyHistory();
}

function _emptyHistory() {
    return {
        version: 1,
        discharge: { totalHours: 0, totalPctDrained: 0 },
        charge: { totalHours: 0, totalPctCharged: 0 },
        cycles: [],
        lastPct: NaN,
        lastState: 0,
        lastWallTime: 0,
    };
}

function _saveHistory(history) {
    try {
        let json = JSON.stringify(history);
        let file = Gio.File.new_for_path(HISTORY_FILE);
        file.replace_contents(_utf8Enc.encode(json), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (_e) {}
}

// ── Shared battery poller (always-on singleton) ─────────────────────

let _sharedPoller = null;

class BatteryPoller {
    constructor() {
        this._proxy = null;
        this._timerId = 0;
        this._listeners = new Set();

        // In-memory session samples (monotonic time, not persisted)
        this._samples = [];
        this._unplugTime = 0;
        this._plugTime = 0;
        this._lastState = -1;
        this._pct = NaN;
        this._state = 0;
        this._energyRate = 0;
        this._temp = NaN;
        this._ready = false;

        // Current cycle tracking (for persistence)
        this._cycleStartPct = NaN;
        this._cycleStartWall = 0;

        // Load persisted history
        this._history = _loadHistory();
        this._savePending = false;
        this._saveTimerId = 0;

        this._initProxy();
        this._startPolling();
    }

    static get() {
        if (!_sharedPoller) _sharedPoller = new BatteryPoller();
        return _sharedPoller;
    }

    static shutdown() {
        if (_sharedPoller) {
            _sharedPoller._flushHistory();
            _sharedPoller._stopPolling();
            _sharedPoller._listeners.clear();
            _sharedPoller._proxy = null;
            _sharedPoller = null;
        }
    }

    subscribe(listener) {
        this._listeners.add(listener);
        if (this._ready) listener.onBatteryUpdate(this);
    }

    unsubscribe(listener) {
        this._listeners.delete(listener);
    }

    // ── Proxy & polling ─────────────────────────────────────────────

    _initProxy() {
        try {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                UPOWER_BUS, UPOWER_DEVICE_PATH, UPOWER_DEVICE_IFACE,
                null, (_src, res) => {
                    try {
                        this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                        this._proxy.connect('g-properties-changed', () => this._poll());
                        this._poll();
                    } catch (e) {
                        console.log(`[Convergence:Battery] proxy error: ${e.message}`);
                    }
                });
        } catch (e) {
            console.log(`[Convergence:Battery] init error: ${e.message}`);
        }
    }

    _startPolling() {
        if (this._timerId) return;
        this._poll();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_S, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._timerId) { GLib.source_remove(this._timerId); this._timerId = 0; }
        if (this._saveTimerId) { GLib.source_remove(this._saveTimerId); this._saveTimerId = 0; }
    }

    _poll() {
        let now = GLib.get_monotonic_time() / 1e6;
        let wallNow = Math.floor(GLib.get_real_time() / 1e6);
        let pct = NaN;
        let state = 0;
        let energyRate = 0;

        if (this._proxy) {
            let pv = this._proxy.get_cached_property('Percentage');
            let sv = this._proxy.get_cached_property('State');
            let ev = this._proxy.get_cached_property('EnergyRate');
            if (pv) pct = pv.unpack();
            if (sv) state = sv.unpack();
            if (ev) energyRate = ev.unpack();
        }

        if (isNaN(pct)) {
            let cap = _sysfsInt('capacity');
            if (!isNaN(cap)) pct = cap;
        }
        if (state === 0) {
            let st = _sysfs('status');
            if (st === 'Charging') state = UPOWER_STATE_CHARGING;
            else if (st === 'Discharging') state = UPOWER_STATE_DISCHARGING;
            else if (st === 'Full') state = UPOWER_STATE_FULLY_CHARGED;
        }

        let temp = _sysfsInt('temp');
        if (!isNaN(temp)) this._temp = temp / 10;

        this._pct = pct;
        this._state = state;
        this._energyRate = energyRate;

        // ── State transitions & cycle tracking ──────────────────────
        let charging = (state === UPOWER_STATE_CHARGING);
        let wasCharging = (this._lastState === UPOWER_STATE_CHARGING ||
                           this._lastState === UPOWER_STATE_FULLY_CHARGED);

        if (this._lastState >= 0 && !isNaN(pct)) {
            if (wasCharging && !charging) {
                this._finishCycle('charge', pct, wallNow);
                this._unplugTime = now;
                this._cycleStartPct = pct;
                this._cycleStartWall = wallNow;
                this._samples = [];
            } else if (!wasCharging && charging) {
                this._finishCycle('discharge', pct, wallNow);
                this._plugTime = now;
                this._cycleStartPct = pct;
                this._cycleStartWall = wallNow;
                this._samples = [];
            }
        } else if (!isNaN(pct)) {
            // First poll — seed cycle start
            if (charging)
                this._plugTime = now;
            else
                this._unplugTime = now;
            this._cycleStartPct = pct;
            this._cycleStartWall = wallNow;
        }
        this._lastState = state;

        // Record session sample
        if (!isNaN(pct)) {
            this._samples.push({ t: now, pct, state });
            if (this._samples.length > MAX_SAMPLES)
                this._samples.splice(0, this._samples.length - MAX_SAMPLES);
        }

        // Update rolling history totals (for long-term average)
        if (!isNaN(pct) && isFinite(this._history.lastPct) && this._history.lastState > 0) {
            let dtHours = (wallNow - this._history.lastWallTime) / 3600;
            if (dtHours > 0 && dtHours < 1) { // sanity: skip gaps > 1h (sleep/reboot)
                let dpct = Math.abs(pct - this._history.lastPct);
                if (this._history.lastState === UPOWER_STATE_DISCHARGING) {
                    this._history.discharge.totalHours += dtHours;
                    this._history.discharge.totalPctDrained += dpct;
                } else if (this._history.lastState === UPOWER_STATE_CHARGING) {
                    this._history.charge.totalHours += dtHours;
                    this._history.charge.totalPctCharged += dpct;
                }
            }
        }
        this._history.lastPct = pct;
        this._history.lastState = state;
        this._history.lastWallTime = wallNow;
        this._scheduleSave();

        this._ready = true;
        for (let l of this._listeners) {
            try { l.onBatteryUpdate(this); } catch (_e) {}
        }
    }

    // ── Cycle persistence ───────────────────────────────────────────

    _finishCycle(type, endPct, wallNow) {
        if (!isFinite(this._cycleStartPct) || this._cycleStartWall === 0)
            return;
        let hours = (wallNow - this._cycleStartWall) / 3600;
        if (hours < 0.05) return; // ignore < 3 min cycles
        let dpct = endPct - this._cycleStartPct;
        let rate = dpct / hours;

        this._history.cycles.push({
            type,
            startPct: Math.round(this._cycleStartPct),
            endPct: Math.round(endPct),
            hours: Math.round(hours * 100) / 100,
            rate: Math.round(rate * 10) / 10,
            wallTime: wallNow,
        });
        if (this._history.cycles.length > MAX_CYCLES)
            this._history.cycles.splice(0, this._history.cycles.length - MAX_CYCLES);

        this._flushHistory();
    }

    _scheduleSave() {
        if (this._saveTimerId) return;
        this._saveTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAVE_DEBOUNCE_S, () => {
            this._saveTimerId = 0;
            _saveHistory(this._history);
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushHistory() {
        if (this._saveTimerId) { GLib.source_remove(this._saveTimerId); this._saveTimerId = 0; }
        _saveHistory(this._history);
    }

    // ── Computed stats ──────────────────────────────────────────────

    get percentage() { return this._pct; }
    get state() { return this._state; }
    get isCharging() { return this._state === UPOWER_STATE_CHARGING; }
    get isFullyCharged() { return this._state === UPOWER_STATE_FULLY_CHARGED; }
    get energyRate() { return this._energyRate; }
    get temperature() { return this._temp; }

    /** Current drain/charge rate (%/hr) from last 15 min of session samples. */
    get currentRate() {
        return this._rateOverWindow(15 * 60);
    }

    /** Session average: drain/charge rate since last state change. */
    get sessionAverageRate() {
        if (this._samples.length < 2) return NaN;
        let first = this._samples[0];
        let last = this._samples[this._samples.length - 1];
        let dt = (last.t - first.t) / 3600;
        if (dt < 0.01) return NaN;
        return (last.pct - first.pct) / dt;
    }

    /** Long-term average drain rate (%/hr) across boots (discharging only). */
    get lifetimeDrainRate() {
        let h = this._history.discharge;
        if (h.totalHours < 0.1) return NaN;
        return -(h.totalPctDrained / h.totalHours);
    }

    /** Long-term average charge rate (%/hr) across boots (charging only). */
    get lifetimeChargeRate() {
        let h = this._history.charge;
        if (h.totalHours < 0.1) return NaN;
        return h.totalPctCharged / h.totalHours;
    }

    /** Recent discharge cycles (newest first). */
    get recentDischargeCycles() {
        return this._history.cycles
            .filter(c => c.type === 'discharge')
            .reverse();
    }

    /** Seconds since charger was disconnected (or connected). */
    get secondsSinceStateChange() {
        let now = GLib.get_monotonic_time() / 1e6;
        let anchor = this.isCharging ? this._plugTime : this._unplugTime;
        return anchor > 0 ? now - anchor : NaN;
    }

    /** Estimated seconds until flat (discharging) or full (charging). */
    get estimatedSecondsRemaining() {
        if (this.isCharging) {
            let ttf = _sysfsInt('time_to_full_avg');
            if (!isNaN(ttf) && ttf > 0) return ttf;
        } else {
            let tte = _sysfsInt('time_to_empty_avg');
            if (!isNaN(tte) && tte > 0) return tte;
        }
        let rate = this.currentRate;
        if (!isFinite(rate) || Math.abs(rate) < 0.01) return NaN;
        if (this.isCharging)
            return ((100 - this._pct) / rate) * 3600;
        return (this._pct / -rate) * 3600;
    }

    _rateOverWindow(windowSec) {
        if (this._samples.length < 2) return NaN;
        let now = this._samples[this._samples.length - 1].t;
        let cutoff = now - windowSec;
        let first = null;
        for (let s of this._samples) {
            if (s.t >= cutoff) { first = s; break; }
        }
        if (!first) first = this._samples[0];
        let last = this._samples[this._samples.length - 1];
        let dt = (last.t - first.t) / 3600;
        if (dt < 0.01) return NaN;
        return (last.pct - first.pct) / dt;
    }
}

// Start the poller immediately when the module is loaded so data
// accumulates regardless of whether a widget instance exists.
GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    BatteryPoller.get();
    return GLib.SOURCE_REMOVE;
});

// ── Widget class ────────────────────────────────────────────────────

export class BatteryWidget {
    constructor(settings, item) {
        this._settings = settings ?? null;
        this._item = item ?? null;
        this._runtimeEnv = null;
        this._runtimeDisposer = new RuntimeDisposer();
        this._poller = BatteryPoller.get();
        this._labels = {};
        this._barBg = null;
        this._barFill = null;
        this._s = 1;
        this._barH = 8;
        this._barRad = 4;
    }

    buildContent(w, h, _colSpan, rowSpan, monitor, _gridMetrics, runtimeEnv = null) {
        _bindShellEnv(runtimeEnv);

        // ── Scale (matches systemMonitorWidget) ─────────────────
        let refWidgetW = 188;
        let wScale = w / refWidgetW;
        let maxScaleForH = h / 85;
        let s = Math.max(0.7, Math.min(1.6, Math.min(wScale, maxScaleForH)));
        this._s = s;

        let gs = monitor?.geometry_scale ?? 1;
        let snap = v => Math.round(v * gs) / gs;

        let fontSize = snap(11 * s);
        let barH = Math.max(snap(6), snap(8 * s));
        let barRad = snap(barH / 2);
        let spacing = snap(4 * s);
        let padV = snap(12 * s);
        let padH = snap(16 * s);
        let rad = snap(12 * s);
        let compact = rowSpan < 2;

        this._barH = barH;
        this._barRad = barRad;

        let box = new St.BoxLayout({
            vertical: true, x_expand: true, y_expand: true,
            clip_to_allocation: true,
            style: `background-color: rgba(0,0,0,0.50); border-radius: ${rad}px;`
                + ` padding: ${padV}px ${padH}px; spacing: ${spacing}px;`,
        });

        // ── Header row: percentage + current rate ───────────────
        let headerRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${snap(8 * s)}px;`,
        });
        box.add_child(headerRow);

        this._labels.pct = new St.Label({
            style: `color: rgba(255,255,255,0.95); font-size: ${snap(16 * s)}px; font-weight: 600;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(this._labels.pct);

        this._labels.status = new St.Label({
            style: `color: rgba(255,255,255,0.5); font-size: ${fontSize}px;`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(this._labels.status);

        this._labels.rate = new St.Label({
            style: `color: rgba(255,255,255,0.8); font-size: ${fontSize}px;`,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(this._labels.rate);

        // ── Battery bar ─────────────────────────────────────────
        let barRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${snap(8 * s)}px;`,
        });
        box.add_child(barRow);

        let barLabel = new St.Label({
            text: 'BAT',
            style: `color: rgba(255,255,255,0.7); font-size: ${fontSize}px; min-width: ${snap(30 * s)}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        barRow.add_child(barLabel);

        this._barBg = new St.Widget({
            x_expand: true, height: barH,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: rgba(255,255,255,0.15); border-radius: ${barRad}px;`,
        });
        barRow.add_child(this._barBg);

        this._barFill = new St.Widget({
            width: 0, height: barH,
            style: `border-radius: ${barRad}px;`,
        });
        this._barBg.add_child(this._barFill);

        this._labels.barPct = new St.Label({
            text: '--',
            style: `color: rgba(255,255,255,0.8); font-size: ${fontSize}px; min-width: ${snap(32 * s)}px; text-align: right;`,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        barRow.add_child(this._labels.barPct);

        // ── Info rows (non-compact) ─────────────────────────────
        let infoStyle = `color: rgba(255,255,255,0.65); font-size: ${fontSize}px;`;
        let sections = [];

        if (!compact) {
            // Section: session avg | lifetime avg
            sections.push(box.get_n_children());
            let avgRow = new St.BoxLayout({ x_expand: true, style: `spacing: ${snap(8 * s)}px;` });
            box.add_child(avgRow);

            this._labels.sessionAvg = new St.Label({
                style: infoStyle, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            avgRow.add_child(this._labels.sessionAvg);

            this._labels.lifetimeAvg = new St.Label({
                style: infoStyle,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            avgRow.add_child(this._labels.lifetimeAvg);

            // Section: unplugged/charging duration | estimate
            sections.push(box.get_n_children());
            let timeRow = new St.BoxLayout({ x_expand: true, style: `spacing: ${snap(8 * s)}px;` });
            box.add_child(timeRow);

            this._labels.stateTime = new St.Label({
                style: infoStyle, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            timeRow.add_child(this._labels.stateTime);

            this._labels.estimate = new St.Label({
                style: infoStyle,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            timeRow.add_child(this._labels.estimate);

            // Section: power draw + temp
            sections.push(box.get_n_children());
            this._labels.power = new St.Label({
                style: infoStyle, x_expand: true,
            });
            box.add_child(this._labels.power);

            // Insert expanding spacers between sections for even distribution
            for (let i = sections.length - 1; i >= 0; i--) {
                let idx = sections[i];
                let spacer = new St.Widget({ y_expand: true });
                let sibling = box.get_child_at_index(idx);
                if (sibling)
                    box.insert_child_below(spacer, sibling);
                else
                    box.add_child(spacer);
            }
        }

        this._poller.subscribe(this);
        return box;
    }

    onBatteryUpdate(p) {
        let pct = p.percentage;
        let charging = p.isCharging;
        let fullyCharged = p.isFullyCharged;

        // Percentage header
        if (this._labels.pct) {
            let icon = charging || fullyCharged ? '\u26A1 ' : '';
            this._labels.pct.set_text(isFinite(pct) ? `${icon}${Math.round(pct)}%` : '--%');
        }

        // Status text
        if (this._labels.status) {
            if (fullyCharged) this._labels.status.set_text('Full');
            else if (charging) this._labels.status.set_text('Charging');
            else this._labels.status.set_text('Discharging');
        }

        // Current rate
        if (this._labels.rate) {
            let rate = p.currentRate;
            this._labels.rate.set_text(isFinite(rate) ? _fmtRate(rate) : '');
        }

        // Battery bar
        if (this._barBg && this._barFill && isFinite(pct)) {
            let frac = Math.max(0, Math.min(1, pct / 100));
            let barW = this._barBg.width;
            if (barW > 0) this._barFill.width = Math.round(barW * frac);

            let color;
            if (charging || fullyCharged)     color = 'rgba(76, 175, 80, 0.95)';
            else if (pct <= 15)               color = 'rgba(244, 67, 54, 0.95)';
            else if (pct <= 30)               color = 'rgba(255, 152, 0, 0.95)';
            else                              color = 'rgba(66, 165, 245, 0.95)';

            this._barFill.set_style(
                `background-color: ${color}; border-radius: ${this._barRad}px; height: ${this._barH}px;`);
        }

        // Bar percentage label
        if (this._labels.barPct)
            this._labels.barPct.set_text(isFinite(pct) ? `${Math.round(pct)}%` : '--');

        // Session average
        if (this._labels.sessionAvg) {
            let avg = p.sessionAverageRate;
            this._labels.sessionAvg.set_text(isFinite(avg) ? `Session ${_fmtRate(avg)}` : '');
        }

        // Lifetime average
        if (this._labels.lifetimeAvg) {
            let lt = charging ? p.lifetimeChargeRate : p.lifetimeDrainRate;
            this._labels.lifetimeAvg.set_text(isFinite(lt) ? `Avg ${_fmtRate(lt)}` : '');
        }

        // State duration
        if (this._labels.stateTime) {
            let elapsed = p.secondsSinceStateChange;
            if (isFinite(elapsed) && elapsed >= 0) {
                let label = charging ? 'Charging' : 'Unplugged';
                this._labels.stateTime.set_text(`${label}: ${_fmtDuration(elapsed)}`);
            } else {
                this._labels.stateTime.set_text('');
            }
        }

        // Time estimate
        if (this._labels.estimate) {
            if (fullyCharged) {
                this._labels.estimate.set_text('Fully charged');
            } else {
                let est = p.estimatedSecondsRemaining;
                if (isFinite(est) && est > 0) {
                    let label = charging ? 'Full in' : 'Remaining';
                    this._labels.estimate.set_text(`${label}: ${_fmtDuration(est)}`);
                } else {
                    this._labels.estimate.set_text('Estimating...');
                }
            }
        }

        // Power draw
        if (this._labels.power) {
            let rate = p.energyRate;
            let temp = p.temperature;
            let parts = [];
            if (rate > 0) parts.push(`${rate.toFixed(2)} W`);
            if (isFinite(temp)) parts.push(`${temp.toFixed(0)}\u00B0C`);
            this._labels.power.set_text(parts.join('  \u00B7  '));
        }
    }

    destroy() {
        this._poller?.unsubscribe(this);
        this._runtimeDisposer?.dispose?.();
        this._runtimeDisposer = null;
        this._settings = null;
        this._labels = {};
        this._barBg = null;
        this._barFill = null;
    }
}

// ── Preview ─────────────────────────────────────────────────────────

function _buildBatteryPreview({ runtimeEnv }) {
    _bindShellEnv(runtimeEnv);
    let box = new St.BoxLayout({
        vertical: true, x_expand: true, y_expand: true,
        style: 'background-color: rgba(0,0,0,0.50); border-radius: 8px; padding: 8px; spacing: 3px;',
    });

    // Header
    let header = new St.BoxLayout({ x_expand: true, style: 'spacing: 4px;' });
    box.add_child(header);
    header.add_child(new St.Label({
        text: '85%',
        style: 'color: rgba(255,255,255,0.95); font-size: 13px; font-weight: 600;',
    }));
    header.add_child(new St.Label({
        text: 'Discharging',
        style: 'color: rgba(255,255,255,0.5); font-size: 9px;',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    header.add_child(new St.Label({
        text: '-2.1%/hr',
        style: 'color: rgba(255,255,255,0.8); font-size: 9px;',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    // Bar row
    let barRow = new St.BoxLayout({ x_expand: true, style: 'spacing: 4px;' });
    box.add_child(barRow);
    barRow.add_child(new St.Label({
        text: 'BAT',
        style: 'color: rgba(255,255,255,0.7); font-size: 9px; min-width: 24px;',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    let barBg = new St.Widget({
        x_expand: true, height: 6,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'background-color: rgba(255,255,255,0.15); border-radius: 3px;',
    });
    barRow.add_child(barBg);
    barBg.add_child(new St.Widget({
        width: 60, height: 6,
        style: 'background-color: rgba(66,165,245,0.95); border-radius: 3px;',
    }));
    barRow.add_child(new St.Label({
        text: '85%',
        style: 'color: rgba(255,255,255,0.8); font-size: 9px; min-width: 24px; text-align: right;',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    }));

    // Info
    box.add_child(new St.Label({
        text: 'Unplugged: 2h 15m  \u00B7  Remaining: 8h 30m',
        style: 'color: rgba(255,255,255,0.65); font-size: 8px;',
    }));

    return box;
}

// ── Widget definition ───────────────────────────────────────────────

export const BATTERY_WIDGET_DEFINITION = {
    widgetType: 'battery',
    label: 'Battery',
    description: 'Battery stats, usage rate, and time remaining',
    defaultColSpan: 3,
    defaultRowSpan: 2,
    minColSpan: 2,
    minRowSpan: 1,
    maxColSpan: 5,
    maxRowSpan: 3,
    unique: true,

    createInstance({ settings, widgetItem, runtimeEnv }) {
        let widget = new BatteryWidget(settings, widgetItem);
        widget._runtimeEnv = runtimeEnv ?? null;
        return widget;
    },

    buildPreview({ runtimeEnv }) {
        return _buildBatteryPreview({ runtimeEnv });
    },

    onActivate() {
        return false;
    },
};
