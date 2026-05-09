// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Logger } from './logger.js';

export const HostType = Object.freeze({
    PHONE: 'phone',
    TABLET: 'tablet',
    LAPTOP: 'laptop',
    DESKTOP: 'desktop',
    UNKNOWN: 'unknown',
});

export const DisplayMode = Object.freeze({
    PHONE: 'phone',
    TABLET: 'tablet',
    DESKTOP: 'desktop',
    TV: 'tv',
});

export const Orientation = Object.freeze({
    PORTRAIT: 'portrait',
    LANDSCAPE: 'landscape',
});

export const DisplayCategory = Object.freeze({
    MONITOR: 'monitor',
    TV: 'tv',
    ULTRAWIDE: 'ultrawide',
});

export const InputMode = Object.freeze({
    TOUCH: 'touch',
    POINTER: 'pointer',
    KEYBOARD: 'keyboard',
    MIXED: 'mixed',
    UNKNOWN: 'unknown',
});

/**
 * Width-based layout tier.
 *
 * Numeric values allow comparison: `tier >= WidthTier.TABLET` means
 * tablet, desktop, or ultrawide.  Based on logical width of the
 * monitor, independent of device type or display mode.
 */
export const WidthTier = Object.freeze({
    PHONE: 0,
    TABLET: 1,
    DESKTOP: 2,
    ULTRAWIDE: 3,
});

const PHONE_TIER_MAX_WIDTH     = 600;
const TABLET_TIER_MAX_WIDTH    = 1100;
const ULTRAWIDE_TIER_MIN_WIDTH = 2200;

const CHASSIS_DESKTOP_CODES  = [3, 4, 5, 6, 7, 15, 16, 24, 34, 35, 36];
const CHASSIS_LAPTOP_CODES   = [8, 9, 10, 14, 31, 32, 33];
const CHASSIS_TABLET_CODES   = [30];
const CHASSIS_HANDSET_CODES  = [11, 12];

const PHONE_MAX_LOGICAL_WIDTH  = 600;
const TABLET_MAX_LOGICAL_WIDTH = 1100;

const ULTRAWIDE_MIN_ASPECT = 2.2;

const TV_MIN_WIDTH_CM = 85;
const HOST_UNKNOWN_CONFIDENCE = 0.4;
const ACTIVE_INPUT_WINDOW_MS = 8000;
const INPUT_NOTIFY_DEBOUNCE_MS = 60;
const CONVERGENCE_REPORT_ENV = 'CONVERGENCE_REPORT';

export class DisplayConfig {
    constructor(settings = null) {
        this._logger = new Logger('DisplayConfig', settings);
        this._settings = settings;
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._monitors = new Map();
        this._tabletMode = false;
        this._hostType = HostType.UNKNOWN;
        this._hostConfidence = HOST_UNKNOWN_CONFIDENCE;
        this._hostReasons = [];

        this._edidPaths = new Map();
        this._buildEdidPathCache();

        this._seat = null;
        this._touchModeId = 0;
        this._deviceAddedId = 0;
        this._deviceRemovedId = 0;
        this._hasTouchscreenCached = false;
        this._hasPointerCached = false;
        this._hasKeyboardCached = false;
        this._primaryInputModeCached = InputMode.UNKNOWN;
        this._activeInputModeCached = InputMode.UNKNOWN;
        this._lastInputActivityMs = {
            touch: 0,
            pointer: 0,
            keyboard: 0,
        };
        this._stageCaptureId = 0;
        this._inputNotifyTimeoutId = 0;
        try {
            this._seat = global.stage.context.get_backend().get_default_seat();
            this._tabletMode = this._seat.get_touch_mode();
            this._touchModeId = this._seat.connect('notify::touch-mode', () => {
                this._onTabletModeChanged();
            });

            this._refreshInputCapabilities();
            this._deviceAddedId = this._seat.connect('device-added', () => {
                this._onDeviceChanged();
            });
            this._deviceRemovedId = this._seat.connect('device-removed', () => {
                this._onDeviceChanged();
            });
        } catch (e) {
            // Seat API unavailable
        }

        try {
            this._stageCaptureId = global.stage.connect('captured-event',
                (_actor, event) => this._onCapturedEvent(event));
        } catch (e) {
            this._stageCaptureId = 0;
        }

        this._monitorManager = global.backend.get_monitor_manager();
        this._rebuildMonitors();

        this._monitorsChangedId = this._monitorManager.connect(
            'monitors-changed', () => this._onMonitorsChanged());

        this._logger.info(`hostType=${this._hostType}, ` +
            `hostConfidence=${this._hostConfidence.toFixed(2)}, ` +
            `tabletMode=${this._tabletMode}, ` +
            `touchscreen=${this._hasTouchscreenCached}, ` +
            `inputMode=${this._primaryInputModeCached}, ` +
            `activeInputMode=${this._activeInputModeCached}, ` +
            `monitors=${this._monitors.size}, ` +
            `primaryMode=${this.primaryDisplayMode}`);
        this._maybeLogConvergenceReport('startup');
    }

    get hostType() {
        return this._hostType;
    }

    get hostConfidence() {
        return this._hostConfidence;
    }

    get hostReasons() {
        return [...this._hostReasons];
    }

    get isTabletMode() {
        return this._tabletMode;
    }

    get primaryDisplayMode() {
        let idx = Main.layoutManager.primaryIndex;
        return this.getDisplayMode(idx);
    }

    getDisplayMode(monitorIndex) {
        let info = this._monitors.get(monitorIndex);
        return info ? info.displayMode : DisplayMode.PHONE;
    }

    getMonitorInfo(monitorIndex) {
        return this._monitors.get(monitorIndex) ?? null;
    }

    get isSingleMonitor() {
        return this._monitors.size <= 1;
    }

    get hasBuiltinMonitor() {
        for (let [, info] of this._monitors) {
            if (info.isBuiltin)
                return true;
        }
        return false;
    }

    /**
     * True when the primary display is phone-sized (narrow side <= 600px).
     */
    get isSmallDisplay() {
        let mode = this.primaryDisplayMode;
        return mode === DisplayMode.PHONE;
    }

    /**
     * True when the primary display is anything larger than phone-sized.
     */
    get isLargeDisplay() {
        return !this.isSmallDisplay;
    }

    /**
     * Width tier for the primary monitor.
     * @returns {number} WidthTier.PHONE | TABLET | DESKTOP | ULTRAWIDE
     */
    get primaryWidthTier() {
        let idx = Main.layoutManager.primaryIndex;
        return this.getWidthTier(idx);
    }

    /**
     * Width tier for a specific monitor.
     * @param {number} monitorIndex
     * @returns {number} WidthTier value
     */
    getWidthTier(monitorIndex) {
        let info = this._monitors.get(monitorIndex);
        return info ? info.widthTier : WidthTier.PHONE;
    }

    /**
     * Width tier name string for logging/debug.
     * @param {number} tier - WidthTier value
     * @returns {string}
     */
    static widthTierName(tier) {
        switch (tier) {
            case WidthTier.PHONE: return 'phone';
            case WidthTier.TABLET: return 'tablet';
            case WidthTier.DESKTOP: return 'desktop';
            case WidthTier.ULTRAWIDE: return 'ultrawide';
            default: return 'unknown';
        }
    }

    /**
     * True when any connected input device is a touchscreen.
     */
    get hasTouchscreen() {
        return this._hasTouchscreenCached;
    }

    get hasPointerDevice() {
        return this._hasPointerCached;
    }

    get hasKeyboardDevice() {
        return this._hasKeyboardCached;
    }

    get primaryInputMode() {
        return this._primaryInputModeCached;
    }

    get activeInputMode() {
        return this._activeInputModeCached;
    }

    getDetectionSnapshot() {
        return {
            hostType: this._hostType,
            hostConfidence: this._hostConfidence,
            hostReasons: [...this._hostReasons],
            primaryDisplayMode: this.primaryDisplayMode,
            hasTouchscreen: this._hasTouchscreenCached,
            hasPointer: this._hasPointerCached,
            hasKeyboard: this._hasKeyboardCached,
            primaryInputMode: this._primaryInputModeCached,
            activeInputMode: this._activeInputModeCached,
        };
    }

    getMonitorSnapshots() {
        let snapshots = [];
        for (let [, info] of this._monitors) {
            snapshots.push({
                index: info.index,
                isPrimary: info.isPrimary,
                isBuiltin: info.isBuiltin,
                connector: info.connector,
                displayName: info.displayName,
                mode: info.displayMode,
                category: info.displayCategory,
                confidence: info.displayConfidence ?? 0,
                reasons: [...(info.displayReasons ?? [])],
                widthTier: info.widthTier,
                logicalWidth: info.logicalWidth,
                logicalHeight: info.logicalHeight,
                scale: info.scale,
            });
        }
        snapshots.sort((a, b) => a.index - b.index);
        return snapshots;
    }

    buildConvergenceReportLines(tag = '') {
        let prefix = tag ? `[${tag}] ` : '';
        let lines = [];
        lines.push(`${prefix}host=${this._hostType} confidence=${this._hostConfidence.toFixed(2)} reasons=${this._hostReasons.join('; ') || 'none'}`);
        lines.push(`${prefix}input capability=${this._primaryInputModeCached} active=${this._activeInputModeCached} touch=${this._hasTouchscreenCached} pointer=${this._hasPointerCached} keyboard=${this._hasKeyboardCached}`);
        for (let mon of this.getMonitorSnapshots()) {
            let reasons = mon.reasons.length > 0 ? mon.reasons.join('; ') : 'none';
            let tierName = DisplayConfig.widthTierName(mon.widthTier ?? WidthTier.PHONE);
            lines.push(`${prefix}monitor#${mon.index} primary=${mon.isPrimary} builtin=${mon.isBuiltin} connector=${mon.connector || 'n/a'} mode=${mon.mode} widthTier=${tierName} category=${mon.category} confidence=${(mon.confidence ?? 0).toFixed(2)} size=${mon.logicalWidth}x${mon.logicalHeight}@${mon.scale} reasons=${reasons}`);
        }
        return lines;
    }

    logConvergenceReport(tag = 'report') {
        let lines = this.buildConvergenceReportLines(tag);
        for (let line of lines)
            this._logger.info(`convergence: ${line}`);
    }

    connect(signalOrCallback, callback) {
        // Support both connect(callback) and connect(signal, callback)
        // so DisplayConfig works with RuntimeDisposer.connect(obj, signal, cb).
        let cb = typeof callback === 'function' ? callback : signalOrCallback;
        let id = this._nextListenerId++;
        this._listeners.set(id, cb);
        return id;
    }

    disconnect(id) {
        this._listeners.delete(id);
    }

    destroy() {
        if (this._stageCaptureId) {
            try {
                global.stage.disconnect(this._stageCaptureId);
            } catch (e) {
                // Stage may already be finalized.
            }
            this._stageCaptureId = 0;
        }
        if (this._inputNotifyTimeoutId) {
            try {
                GLib.source_remove(this._inputNotifyTimeoutId);
            } catch (e) {
                // Source may already be removed.
            }
            this._inputNotifyTimeoutId = 0;
        }
        if (this._deviceAddedId && this._seat) {
            this._seat.disconnect(this._deviceAddedId);
            this._deviceAddedId = 0;
        }
        if (this._deviceRemovedId && this._seat) {
            this._seat.disconnect(this._deviceRemovedId);
            this._deviceRemovedId = 0;
        }
        if (this._touchModeId && this._seat) {
            this._seat.disconnect(this._touchModeId);
            this._touchModeId = 0;
        }
        this._seat = null;

        if (this._monitorsChangedId && this._monitorManager) {
            this._monitorManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._monitorManager = null;
        this._listeners.clear();
        this._monitors.clear();
        this._edidPaths.clear();
        this._logger?.destroy?.();
    }

    _refreshHostType() {
        let result = this._detectHostTypeDetailed();
        this._hostType = result.type;
        this._hostConfidence = result.confidence;
        this._hostReasons = result.reasons;
    }

    _detectHostTypeDetailed() {
        let forced = GLib.getenv('CONVERGENCE_HOST_TYPE');
        if (forced) {
            let type = forced.toLowerCase();
            if (Object.values(HostType).includes(type)) {
                return {
                    type,
                    confidence: 1.0,
                    reasons: [`forced via CONVERGENCE_HOST_TYPE=${type}`],
                };
            }
        }

        let chassisType = this._readSysfs('/sys/class/dmi/id/chassis_type');
        if (chassisType !== null) {
            let code = parseInt(chassisType, 10);
            if (!isNaN(code)) {
                if (CHASSIS_HANDSET_CODES.includes(code))
                    return { type: HostType.PHONE, confidence: 0.98, reasons: [`dmi chassis_type=${code}`] };
                if (CHASSIS_TABLET_CODES.includes(code))
                    return { type: HostType.TABLET, confidence: 0.98, reasons: [`dmi chassis_type=${code}`] };
                if (CHASSIS_LAPTOP_CODES.includes(code))
                    return { type: HostType.LAPTOP, confidence: 0.98, reasons: [`dmi chassis_type=${code}`] };
                if (CHASSIS_DESKTOP_CODES.includes(code))
                    return { type: HostType.DESKTOP, confidence: 0.98, reasons: [`dmi chassis_type=${code}`] };
            }
        }

        // ARM devices use devicetree instead of DMI
        let dtChassis = this._readSysfs('/sys/firmware/devicetree/base/chassis-type');
        if (dtChassis !== null) {
            let ct = dtChassis.toLowerCase().replace(/\0/g, '').trim();
            if (ct === 'handset')
                return { type: HostType.PHONE, confidence: 0.98, reasons: [`devicetree chassis-type=${ct}`] };
            if (ct === 'tablet')
                return { type: HostType.TABLET, confidence: 0.98, reasons: [`devicetree chassis-type=${ct}`] };
            if (ct === 'laptop' || ct === 'convertible')
                return { type: HostType.LAPTOP, confidence: 0.98, reasons: [`devicetree chassis-type=${ct}`] };
            if (ct === 'desktop')
                return { type: HostType.DESKTOP, confidence: 0.98, reasons: [`devicetree chassis-type=${ct}`] };
        }

        let metaMonitors = this._getMetaMonitors();
        let hasDSI = false;
        let hasEDP = false;
        let builtinLogicalWidth = 0;

        for (let mon of metaMonitors) {
            let connector = mon.get_connector();
            if (connector && connector.startsWith('DSI'))
                hasDSI = true;
            if (connector && connector.startsWith('eDP'))
                hasEDP = true;
            if (mon.is_builtin()) {
                let lm = this._getLayoutMonitor(mon);
                if (lm)
                    builtinLogicalWidth = Math.min(lm.width, lm.height);
            }
        }

        if (hasDSI) {
            let type = builtinLogicalWidth > 0 && builtinLogicalWidth <= PHONE_MAX_LOGICAL_WIDTH
                ? HostType.PHONE : HostType.TABLET;
            return {
                type,
                confidence: 0.8,
                reasons: ['dsi connector detected', `builtin narrowSide=${builtinLogicalWidth || 'unknown'}`],
            };
        }

        if (hasEDP) {
            return {
                type: HostType.LAPTOP,
                confidence: 0.78,
                reasons: ['edp connector detected without dsi'],
            };
        }

        if (this._hasBattery()) {
            return {
                type: HostType.LAPTOP,
                confidence: 0.7,
                reasons: ['battery present, no builtin panel connector'],
            };
        }

        return {
            type: HostType.DESKTOP,
            confidence: 0.65,
            reasons: ['no dsi/edp connector and no battery'],
        };
    }

    _rebuildMonitors() {
        this._monitors.clear();
        this._drmConnectorCache = null;
        this._refreshHostType();

        let layoutMonitors = Main.layoutManager.monitors;
        let metaMonitors = this._getMetaMonitors();
        let monitorIndexMap = this._buildMonitorIndexMap(metaMonitors, layoutMonitors);

        for (let lm of layoutMonitors) {
            let idx = lm.index;
            let metaMon = monitorIndexMap.get(idx) ?? null;
            let connector = '';
            let isBuiltin = false;
            let isPrimary = (idx === Main.layoutManager.primaryIndex);
            let displayName = '';
            let vendor = '';
            let product = '';

            if (metaMon) {
                try { connector = metaMon.get_connector() || ''; } catch (e) {}
                try { isBuiltin = metaMon.is_builtin(); } catch (e) {}
                try { displayName = metaMon.get_display_name() || ''; } catch (e) {}
                try { vendor = metaMon.get_vendor() || ''; } catch (e) {}
                try { product = metaMon.get_product() || ''; } catch (e) {}
            }

            // When MetaMonitor API is unavailable (gnome-shell-mobile 48),
            // try to resolve connector name and builtin status via fallbacks.
            if (!metaMon && !connector) {
                // Try get_monitor_connector on monitor_manager (Mutter 44+).
                if (this._monitorManager) {
                    try {
                        if (typeof this._monitorManager.get_monitor_connector === 'function')
                            connector = this._monitorManager.get_monitor_connector(idx) || '';
                    } catch (_e) {}
                }
                // Try reverse lookup: find DRM connectors via get_monitor_for_connector.
                if (!connector && this._monitorManager &&
                    typeof this._monitorManager.get_monitor_for_connector === 'function') {
                    for (let candidate of this._getDrmConnectorNames()) {
                        try {
                            if (this._monitorManager.get_monitor_for_connector(candidate) === idx) {
                                connector = candidate;
                                break;
                            }
                        } catch (_e) {}
                    }
                }
            }

            // Infer builtin status from connector name (DSI/eDP are always builtin).
            if (!isBuiltin && connector &&
                (connector.startsWith('DSI') || connector.startsWith('eDP')))
                isBuiltin = true;

            // Last resort: single-monitor phone/tablet host — primary is builtin.
            if (!isBuiltin && !metaMon && isPrimary &&
                (this._hostType === HostType.PHONE || this._hostType === HostType.TABLET) &&
                layoutMonitors.length === 1)
                isBuiltin = true;

            let logicalWidth = lm.width;
            let logicalHeight = lm.height;
            let orientation = logicalHeight > logicalWidth
                ? Orientation.PORTRAIT : Orientation.LANDSCAPE;

            let edid = this._readEdid(connector);
            let physicalWidthCm = edid ? edid.physicalWidthCm : 0;
            let physicalHeightCm = edid ? edid.physicalHeightCm : 0;

            let categoryInfo = this._detectDisplayCategoryDetailed(
                connector, displayName, vendor, product, physicalWidthCm,
                logicalWidth, logicalHeight);
            let displayCategory = categoryInfo.category;
            let isUltrawide = (displayCategory === DisplayCategory.ULTRAWIDE);

            let modeInfo = this._classifyMonitorDetailed(
                isBuiltin, logicalWidth, logicalHeight, lm.geometry_scale, displayCategory);
            let displayMode = modeInfo.mode;

            let widthTier = this._classifyWidthTier(logicalWidth);

            this._monitors.set(idx, {
                index: idx,
                displayMode,
                displayCategory,
                displayConfidence: modeInfo.confidence,
                displayReasons: [...categoryInfo.reasons, ...modeInfo.reasons],
                orientation,
                isBuiltin,
                isPrimary,
                isUltrawide,
                widthTier,
                connector,
                displayName,
                vendor,
                product,
                physicalWidthCm,
                physicalHeightCm,
                logicalWidth,
                logicalHeight,
                x: lm.x,
                y: lm.y,
                scale: lm.geometry_scale,
            });
        }
    }

    _detectDisplayCategoryDetailed(connector, displayName, vendor, product, physicalWidthCm,
        logicalWidth, logicalHeight) {
        let reasons = [];

        let longSide = Math.max(logicalWidth, logicalHeight);
        let shortSide = Math.min(logicalWidth, logicalHeight);
        if (shortSide > 0 && longSide / shortSide >= ULTRAWIDE_MIN_ASPECT) {
            reasons.push(`aspect=${(longSide / shortSide).toFixed(2)} >= ${ULTRAWIDE_MIN_ASPECT}`);
            return { category: DisplayCategory.ULTRAWIDE, reasons };
        }

        let tvNameHint = `${displayName} ${vendor} ${product}`.trim();
        if (tvNameHint && /\bTV\b|BRAVIA|AQUOS|OLED|QLED/i.test(tvNameHint)) {
            reasons.push(`tv name hint: "${tvNameHint}"`);
            return { category: DisplayCategory.TV, reasons };
        }

        if (physicalWidthCm >= TV_MIN_WIDTH_CM) {
            reasons.push(`physicalWidthCm=${physicalWidthCm} >= ${TV_MIN_WIDTH_CM}`);
            return { category: DisplayCategory.TV, reasons };
        }

        if (connector && connector.startsWith('HDMI') &&
            Math.max(logicalWidth, logicalHeight) >= 1920 &&
            Math.min(logicalWidth, logicalHeight) >= 1080) {
            reasons.push(`connector=${connector} large HDMI surface`);
        }

        if (reasons.length > 0)
            return { category: DisplayCategory.TV, reasons };
        return { category: DisplayCategory.MONITOR, reasons: ['default monitor classification'] };
    }

    _classifyMonitorDetailed(isBuiltin, logicalWidth, logicalHeight, scale, displayCategory) {
        let forced = GLib.getenv('CONVERGENCE_DISPLAY_MODE');
        if (forced) {
            let mode = forced.toLowerCase();
            if (Object.values(DisplayMode).includes(mode)) {
                return {
                    mode,
                    confidence: 1.0,
                    reasons: [`forced via CONVERGENCE_DISPLAY_MODE=${mode}`],
                };
            }
        }

        let host = this._hostType;
        let reasons = [];
        let narrowSide = Math.min(logicalWidth, logicalHeight);
        let monitorScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

        if ((host === HostType.PHONE || host === HostType.TABLET) && !isBuiltin) {
            if (displayCategory === DisplayCategory.TV)
                return {
                    mode: DisplayMode.TV,
                    confidence: 0.9,
                    reasons: ['convergence external display on mobile host + tv category'],
                };
            return {
                mode: DisplayMode.DESKTOP,
                confidence: 0.9,
                reasons: ['convergence external display on mobile host'],
            };
        }

        // Laptop builtin at high scaling with tablet-or-smaller narrow side:
        // portrait → phone, landscape → desktop.  This lets convertible
        // laptops act as phones when held upright at ≥150% scaling.
        //
        // When debug-phone-simulation is enabled, any touchscreen laptop
        // in portrait uses phone mode regardless of scaling.
        let phoneSimEnabled = this._settings?.settings_schema?.has_key?.('debug-phone-simulation') &&
            this._settings.get_boolean('debug-phone-simulation');
        let highScaleMatch = monitorScale >= 1.5 && narrowSide <= TABLET_MAX_LOGICAL_WIDTH;
        // Phone simulation requires tablet-mode (device physically held upright)
        // to avoid triggering on a saved portrait display config at login
        // when the laptop is lying flat in landscape.
        let phoneSimMatch = phoneSimEnabled && this._hasTouchscreenCached && this._tabletMode;

        if (host === HostType.LAPTOP && isBuiltin && (highScaleMatch || phoneSimMatch)) {
            let isPortrait = logicalHeight > logicalWidth;
            if (isPortrait) {
                return {
                    mode: DisplayMode.PHONE,
                    confidence: 0.9,
                    reasons: [`laptop portrait phone: ${logicalWidth}x${logicalHeight}@${monitorScale} narrow=${narrowSide}${phoneSimMatch ? ' [phone-sim]' : ''}`],
                };
            }
            return {
                mode: DisplayMode.DESKTOP,
                confidence: 0.9,
                reasons: [`laptop landscape desktop: ${logicalWidth}x${logicalHeight}@${monitorScale} narrow=${narrowSide}${phoneSimMatch ? ' [phone-sim]' : ''}`],
            };
        }

        if (host === HostType.LAPTOP && isBuiltin && this._tabletMode)
            return {
                mode: DisplayMode.TABLET,
                confidence: 0.9,
                reasons: ['laptop builtin display in tablet-mode'],
            };

        // Laptop builtin displays that didn't match convertible or tablet-mode
        // heuristics above are always desktop — don't let the generic narrow-side
        // classification misidentify a 1080p panel as a tablet.
        if (host === HostType.LAPTOP && isBuiltin)
            return {
                mode: DisplayMode.DESKTOP,
                confidence: 0.85,
                reasons: [`laptop builtin fallback desktop: ${logicalWidth}x${logicalHeight}@${monitorScale} narrow=${narrowSide}`],
            };

        // Desktop towers have no builtin display — every monitor is external.
        // Never classify them as phone/tablet based on narrow-side heuristics.
        if (host === HostType.DESKTOP)
            return {
                mode: DisplayMode.DESKTOP,
                confidence: 0.9,
                reasons: [`desktop host fallback: ${logicalWidth}x${logicalHeight}@${monitorScale} narrow=${narrowSide}`],
            };

        let normalizedNarrowSide = narrowSide;
        let isMobileHost = (host === HostType.PHONE || host === HostType.TABLET);
        if (isBuiltin && isMobileHost && this._hasTouchscreenCached && monitorScale > 1)
            normalizedNarrowSide = Math.round(narrowSide / monitorScale);

        reasons.push(`narrowSide=${narrowSide}`);
        if (normalizedNarrowSide !== narrowSide)
            reasons.push(`normalizedNarrowSide=${normalizedNarrowSide}@scale${monitorScale}`);

        if (normalizedNarrowSide <= PHONE_MAX_LOGICAL_WIDTH) {
            reasons.push(`<= phone threshold ${PHONE_MAX_LOGICAL_WIDTH}`);
            return { mode: DisplayMode.PHONE, confidence: 0.75, reasons };
        }
        if (normalizedNarrowSide <= TABLET_MAX_LOGICAL_WIDTH) {
            reasons.push(`<= tablet threshold ${TABLET_MAX_LOGICAL_WIDTH}`);
            return { mode: DisplayMode.TABLET, confidence: 0.75, reasons };
        }
        return {
            mode: DisplayMode.DESKTOP,
            confidence: 0.75,
            reasons: [...reasons, `> tablet threshold ${TABLET_MAX_LOGICAL_WIDTH}`],
        };
    }

    _classifyWidthTier(logicalWidth) {
        if (logicalWidth <= PHONE_TIER_MAX_WIDTH) return WidthTier.PHONE;
        if (logicalWidth <= TABLET_TIER_MAX_WIDTH) return WidthTier.TABLET;
        if (logicalWidth >= ULTRAWIDE_TIER_MIN_WIDTH) return WidthTier.ULTRAWIDE;
        return WidthTier.DESKTOP;
    }

    _onTabletModeChanged() {
        let newMode = this._seat ? this._seat.get_touch_mode() : false;
        if (newMode === this._tabletMode)
            return;

        this._tabletMode = newMode;
        this._logger.debug(`tablet-mode-changed: ${this._tabletMode}`);

        this._rebuildMonitors();
        this._notifyListeners();
    }

    _refreshInputCapabilities() {
        let caps = this._scanInputDevices();
        this._hasTouchscreenCached = caps.hasTouchscreen;
        this._hasPointerCached = caps.hasPointer;
        this._hasKeyboardCached = caps.hasKeyboard;
        this._primaryInputModeCached = this._derivePrimaryInputMode(caps);
        this._recomputeActiveInputMode();
    }

    _scanInputDevices() {
        let caps = {
            hasTouchscreen: false,
            hasPointer: false,
            hasKeyboard: false,
        };

        if (!this._seat)
            return caps;

        try {
            let devices = this._seat.list_devices();
            for (let dev of devices) {
                let t = dev.get_device_type();
                if (t === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE)
                    caps.hasTouchscreen = true;
                if (t === Clutter.InputDeviceType.KEYBOARD_DEVICE)
                    caps.hasKeyboard = true;
                if (t === Clutter.InputDeviceType.POINTER_DEVICE ||
                    t === Clutter.InputDeviceType.MOUSE_DEVICE ||
                    t === Clutter.InputDeviceType.TABLET_DEVICE ||
                    t === Clutter.InputDeviceType.PEN_DEVICE ||
                    t === Clutter.InputDeviceType.ERASER_DEVICE ||
                    t === Clutter.InputDeviceType.CURSOR_DEVICE ||
                    t === Clutter.InputDeviceType.TOUCHPAD_DEVICE)
                    caps.hasPointer = true;
            }
        } catch (e) {
            // list_devices may not be available
        }

        return caps;
    }

    _derivePrimaryInputMode(caps) {
        if (caps.hasTouchscreen && (caps.hasPointer || caps.hasKeyboard))
            return InputMode.MIXED;
        if (caps.hasTouchscreen)
            return InputMode.TOUCH;
        if (caps.hasPointer)
            return InputMode.POINTER;
        if (caps.hasKeyboard)
            return InputMode.KEYBOARD;
        return InputMode.UNKNOWN;
    }

    _onCapturedEvent(event) {
        if (!event)
            return Clutter.EVENT_PROPAGATE;

        let type = event.type();
        let mode;
        if (type === Clutter.EventType.KEY_PRESS ||
            type === Clutter.EventType.KEY_RELEASE) {
            mode = InputMode.KEYBOARD;
        } else if (type === Clutter.EventType.TOUCH_BEGIN ||
            type === Clutter.EventType.TOUCH_UPDATE ||
            type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            mode = InputMode.TOUCH;
        } else if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.MOTION ||
            type === Clutter.EventType.SCROLL ||
            type === Clutter.EventType.ENTER ||
            type === Clutter.EventType.LEAVE) {
            mode = InputMode.POINTER;
        }

        if (mode !== undefined)
            this._recordInputActivity(mode);

        return Clutter.EVENT_PROPAGATE;
    }

    _recordInputActivity(mode) {
        let nowMs = GLib.get_monotonic_time() / 1000;

        let bucket;
        if (mode === InputMode.TOUCH)
            bucket = 'touch';
        else if (mode === InputMode.POINTER)
            bucket = 'pointer';
        else if (mode === InputMode.KEYBOARD)
            bucket = 'keyboard';
        else
            return;

        let prev = this._lastInputActivityMs[bucket];
        this._lastInputActivityMs[bucket] = nowMs;

        if (nowMs - prev < INPUT_NOTIFY_DEBOUNCE_MS)
            return;

        this._scheduleActiveInputNotify();
    }

    _scheduleActiveInputNotify() {
        if (this._inputNotifyTimeoutId)
            return;

        this._inputNotifyTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, INPUT_NOTIFY_DEBOUNCE_MS, () => {
                this._inputNotifyTimeoutId = 0;
                if (this._recomputeActiveInputMode())
                    this._notifyListeners();
                return GLib.SOURCE_REMOVE;
            });
    }

    _recomputeActiveInputMode() {
        let nowMs = GLib.get_monotonic_time() / 1000;
        let active = [];
        if (nowMs - this._lastInputActivityMs.touch <= ACTIVE_INPUT_WINDOW_MS)
            active.push(InputMode.TOUCH);
        if (nowMs - this._lastInputActivityMs.pointer <= ACTIVE_INPUT_WINDOW_MS)
            active.push(InputMode.POINTER);
        if (nowMs - this._lastInputActivityMs.keyboard <= ACTIVE_INPUT_WINDOW_MS)
            active.push(InputMode.KEYBOARD);

        let newMode;
        if (active.length === 0)
            newMode = this._primaryInputModeCached;
        else if (active.length > 1)
            newMode = InputMode.MIXED;
        else
            newMode = active[0];

        if (newMode === this._activeInputModeCached)
            return false;
        this._activeInputModeCached = newMode;
        return true;
    }

    _onDeviceChanged() {
        let oldTouch = this._hasTouchscreenCached;
        let oldPointer = this._hasPointerCached;
        let oldKeyboard = this._hasKeyboardCached;
        let oldMode = this._primaryInputModeCached;
        this._refreshInputCapabilities();
        this._recomputeActiveInputMode();

        if (oldTouch === this._hasTouchscreenCached &&
            oldPointer === this._hasPointerCached &&
            oldKeyboard === this._hasKeyboardCached &&
            oldMode === this._primaryInputModeCached)
            return;

        this._logger.debug(`input-changed: touch=${this._hasTouchscreenCached}, pointer=${this._hasPointerCached}, keyboard=${this._hasKeyboardCached}, mode=${this._primaryInputModeCached}`);
        this._notifyListeners();
    }

    _onMonitorsChanged() {
        this._buildEdidPathCache();
        this._rebuildMonitors();

        this._logger.info(`monitors-changed: ` +
            `monitors=${this._monitors.size}, ` +
            `primaryMode=${this.primaryDisplayMode}, ` +
            `hasBuiltin=${this.hasBuiltinMonitor}, ` +
            `hostType=${this._hostType}, ` +
            `hostConfidence=${this._hostConfidence.toFixed(2)}, ` +
            `inputMode=${this._primaryInputModeCached}, ` +
            `activeInputMode=${this._activeInputModeCached}`);
        this._maybeLogConvergenceReport('monitors-changed');

        this._notifyListeners();
    }

    _maybeLogConvergenceReport(tag) {
        let enabled = GLib.getenv(CONVERGENCE_REPORT_ENV);
        if (!enabled || enabled === '0' || enabled.toLowerCase() === 'false')
            return;
        this.logConvergenceReport(tag);
    }

    _notifyListeners() {
        for (let [, callback] of this._listeners) {
            try {
                callback();
            } catch (e) {
                logError(e, '[ConvergenceDesktop DisplayConfig] listener error');
            }
        }
    }

    /**
     * Build a mapping from connector suffix to sysfs EDID path.
     */
    _buildEdidPathCache() {
        this._edidPaths.clear();
        try {
            let dir = Gio.File.new_for_path('/sys/class/drm');
            let enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                let dashIdx = name.indexOf('-');
                if (dashIdx < 0)
                    continue;
                let connectorPart = name.substring(dashIdx + 1);
                let edidPath = `/sys/class/drm/${name}/edid`;
                this._edidPaths.set(connectorPart, edidPath);
            }
        } catch (e) {
            // /sys/class/drm may not exist on some platforms
        }
    }

    /**
     * Read and parse EDID for a Mutter connector name.
     * Returns { physicalWidthCm, physicalHeightCm } or null.
     */
    _readEdid(connector) {
        if (!connector)
            return null;

        let variants = [connector];
        let match = connector.match(/^HDMI-(\d+)$/);
        if (match)
            variants.push(`HDMI-A-${match[1]}`);
        match = connector.match(/^HDMI-A-(\d+)$/);
        if (match)
            variants.push(`HDMI-${match[1]}`);

        for (let variant of variants) {
            let path = this._edidPaths.get(variant);
            if (!path)
                continue;

            let bytes = this._readSysfsBytes(path);
            if (!bytes || bytes.length < 128)
                continue;

            if (bytes[0] !== 0x00 || bytes[1] !== 0xFF || bytes[2] !== 0xFF ||
                bytes[3] !== 0xFF || bytes[4] !== 0xFF || bytes[5] !== 0xFF ||
                bytes[6] !== 0xFF || bytes[7] !== 0x00)
                continue;

            let hSize = bytes[0x15];
            let vSize = bytes[0x16];
            if (hSize === 0 || vSize === 0)
                return { physicalWidthCm: 0, physicalHeightCm: 0 };

            return { physicalWidthCm: hSize, physicalHeightCm: vSize };
        }

        return null;
    }

    _buildMonitorIndexMap(metaMonitors, layoutMonitors) {
        let map = new Map();
        let usedMeta = new Set();

        for (let mon of metaMonitors) {
            let conn = '';
            try { conn = mon.get_connector() || ''; } catch (e) {}
            if (!conn || !this._monitorManager)
                continue;
            try {
                let idx = this._monitorManager.get_monitor_for_connector(conn);
                if (idx >= 0) {
                    map.set(idx, mon);
                    usedMeta.add(mon);
                }
            } catch (e) {
                // Continue with fallback mapping
            }
        }

        for (let lm of layoutMonitors) {
            if (map.has(lm.index))
                continue;
            for (let mon of metaMonitors) {
                if (usedMeta.has(mon))
                    continue;
                let linked = this._getLayoutMonitor(mon);
                if (!linked)
                    continue;
                if (linked.index === lm.index ||
                    (linked.x === lm.x && linked.y === lm.y &&
                        linked.width === lm.width && linked.height === lm.height)) {
                    map.set(lm.index, mon);
                    usedMeta.add(mon);
                    break;
                }
            }
        }

        return map;
    }

    _getDrmConnectorNames() {
        if (this._drmConnectorCache)
            return this._drmConnectorCache;
        let names = [];
        try {
            let drmDir = Gio.File.new_for_path('/sys/class/drm');
            let enumerator = drmDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                let name = info.get_name();
                // Match card0-DSI-1, card0-DP-1, card0-HDMI-A-1, etc.
                let match = name.match(/^card\d+-(.+)$/);
                if (match && match[1] !== 'Writeback-1')
                    names.push(match[1]);
            }
        } catch (_e) {}
        this._drmConnectorCache = names;
        return names;
    }

    _getMetaMonitors() {
        try {
            let mgr = this._monitorManager ?? global.backend.get_monitor_manager();
            if (mgr && typeof mgr.get_monitors === 'function')
                return mgr.get_monitors();
        } catch (e) {
            // Fallback
        }
        return [];
    }

    _getLayoutMonitor(metaMon) {
        let connector = metaMon.get_connector();
        if (!connector)
            return null;

        try {
            let mgr = this._monitorManager ?? global.backend.get_monitor_manager();
            let idx = mgr.get_monitor_for_connector(connector);
            if (idx >= 0) {
                for (let lm of Main.layoutManager.monitors) {
                    if (lm.index === idx)
                        return lm;
                }
            }
        } catch (e) {
            // Fallback
        }
        return null;
    }

    _readSysfs(path) {
        try {
            let file = Gio.File.new_for_path(path);
            let [ok, contents] = file.load_contents(null);
            if (ok && contents)
                return new TextDecoder().decode(contents).trim();
        } catch (e) {
            // File doesn't exist or unreadable
        }
        return null;
    }

    _readSysfsBytes(path) {
        try {
            let file = Gio.File.new_for_path(path);
            let [ok, contents] = file.load_contents(null);
            if (ok && contents && contents.length > 0)
                return contents;
        } catch (e) {
            // File doesn't exist or unreadable
        }
        return null;
    }

    _hasBattery() {
        try {
            let dir = Gio.File.new_for_path('/sys/class/power_supply');
            let enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let typePath = `/sys/class/power_supply/${info.get_name()}/type`;
                let typeVal = this._readSysfs(typePath);
                if (typeVal && typeVal === 'Battery')
                    return true;
            }
        } catch (e) {
            // /sys/class/power_supply may not exist
        }
        return false;
    }
}
