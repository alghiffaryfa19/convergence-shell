// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import { RuntimeDisposer } from '../utilities/runtimeDisposer.js';

/**
 * Convergence Quick Toggles — independent QS controls.
 *
 * Discovers GNOME's Quick Settings toggles by reading (never mutating)
 * the vanilla QS grid, then builds convergence circular icon buttons
 * that mirror toggle state bidirectionally.
 *
 * Designed for multi-display: a single shared cache of toggle state is
 * maintained, and each panel instance renders from that cache. GNOME's
 * own QS widgets are never reparented, restyled, or otherwise modified.
 */

const TOGGLE_ICON_OVERRIDES = {
    'keyboard': 'input-keyboard-symbolic',
    'night-light': 'night-light-symbolic',
    'auto-rotate': 'object-rotate-right-symbolic',
    'airplane-mode': 'airplane-mode-symbolic',
    'do-not-disturb': 'notifications-disabled-symbolic',
    'no-background-apps': 'background-app-ghost-symbolic',
};

const QS_SETTINGS_MAP = {
    'wi-fi': 'wifi', 'wifi': 'wifi',
    'bluetooth': 'bluetooth',
    'mobile': 'wwan', 'mobile data': 'wwan',
    'hotspot': 'wifi', 'airplane mode': 'network',
    'night light': 'display', 'dark mode': 'background', 'dark style': 'background',
    'do not disturb': 'notifications', 'dnd': 'notifications',
    'power mode': 'power', 'power saver': 'power', 'battery saver': 'power', 'power': 'power',
    'location': 'location',
    'screen cast': 'display', 'screencast': 'display', 'screen recording': 'display',
    'screen rotation': 'display', 'auto rotate': 'display',
    'vpn': 'network', 'sound': 'sound', 'volume': 'sound',
    'keyboard': 'keyboard', 'thunderbolt': 'thunderbolt', 'color': 'color',
    'no background apps': 'applications', 'background app': 'applications',
    'background apps': 'applications', 'background': 'background',
    'privacy': 'privacy', 'sharing': 'sharing',
};

// ── Shared toggle state cache (singleton across displays) ──────────

let _sharedCache = null;

class ToggleStateCache {
    constructor() {
        this._toggles = [];
        this._brightnessWidget = null;
        this._volumeWidget = null;
        this._systemButtons = [];
        this._signalIds = [];
        this._grid = null;
        this._listeners = new Set();
        this._discovered = false;
        this._runtimeDisposer = new RuntimeDisposer();
    }

    static get() {
        if (!_sharedCache)
            _sharedCache = new ToggleStateCache();
        return _sharedCache;
    }

    static destroy() {
        _sharedCache?.dispose();
        _sharedCache = null;
    }

    get toggles() { return this._toggles; }
    get brightnessWidget() { return this._brightnessWidget; }
    get volumeWidget() { return this._volumeWidget; }
    get systemButtons() { return this._systemButtons; }

    addListener(cb) { this._listeners.add(cb); }
    removeListener(cb) { this._listeners.delete(cb); }

    _notify() {
        for (let cb of this._listeners) {
            try { cb(); } catch (_e) {}
        }
    }

    /**
     * Walk GNOME's QS grid read-only and cache toggle metadata.
     * Safe to call multiple times — only rediscovers if grid changed.
     */
    discover() {
        let qs = Main.panel?.statusArea?.quickSettings;
        let grid = qs?.menu?._grid;
        if (!grid) return false;

        if (this._grid === grid && this._discovered)
            return true;

        this._cleanup();
        this._grid = grid;

        let layout = grid.layout_manager;
        let placeholder = layout?._overlay;
        let children = grid.get_children().filter(c => c !== placeholder);

        for (let child of children) {
            let classes = '';
            try { classes = child.get_style_class_name?.() || ''; } catch (_e) {}
            let isMenuToggle = child.has_style_class_name?.('quick-toggle-has-menu');
            let isToggle = !isMenuToggle && child.has_style_class_name?.('quick-toggle');
            let isSlider = child.has_style_class_name?.('quick-slider');
            let isSystemItem = child.has_style_class_name?.('quick-settings-system-item');


            if (isSlider) {
                let iconName = child.iconName || child._icon?.icon_name || '';
                if (iconName.includes('brightness'))
                    this._brightnessWidget = child;
                else if (iconName.includes('audio-volume') || iconName.includes('speaker') ||
                    iconName.includes('volume'))
                    this._volumeWidget = child;
                continue;
            }

            if (isSystemItem) {
                let innerBox = child.get_first_child();
                let allChildren = innerBox ? [...innerBox.get_children()] : [];
                // Collect reactive buttons from the system item
                let reactiveButtons = [];
                for (let ch of allChildren) {
                    let name = ch.accessible_name || ch.label || '';
                    if (!ch.reactive || name.length === 0) continue;
                    reactiveButtons.push({ widget: ch, name });
                }
                // Detect whether the first button is a battery indicator
                let hasBattery = reactiveButtons.length > 0 &&
                    /batter|charg|power\s*level|%/i.test(reactiveButtons[0].name);
                if (hasBattery) {
                    // Add battery button first, before the spacer
                    let bat = reactiveButtons[0];
                    this._systemButtons.push({
                        gnomeWidget: bat.widget,
                        parentWidget: child,
                        title: bat.name,
                        toggleId: `sys:${bat.name.toLowerCase().replace(/\s+/g, '-')}`,
                        iconName: this._extractIconName(bat.widget),
                        gicon: this._extractGicon(bat.widget),
                    });
                } else {
                    // No battery: insert a spacer in its place so action
                    // buttons stay aligned with battery-powered layouts.
                    this._systemButtons.push({
                        isSpacer: true,
                        toggleId: 'sys:battery-placeholder',
                    });
                }
                // Always insert a separator spacer after the battery
                // (or its placeholder) to separate it from action buttons.
                this._systemButtons.push({
                    isSpacer: true,
                    toggleId: 'sys:spacer',
                });
                // Add remaining buttons (skip battery if already added)
                let startIdx = hasBattery ? 1 : 0;
                for (let i = startIdx; i < reactiveButtons.length; i++) {
                    let { widget: ch, name } = reactiveButtons[i];
                    this._systemButtons.push({
                        gnomeWidget: ch,
                        parentWidget: child,
                        title: name,
                        toggleId: `sys:${name.toLowerCase().replace(/\s+/g, '-')}`,
                        iconName: this._extractIconName(ch),
                        gicon: this._extractGicon(ch),
                    });
                }
                continue;
            }

            if (!isToggle && !isMenuToggle)
                continue;

            let hasIcon = this._hasIcon(child, isMenuToggle);
            if (!hasIcon) continue;

            let title = child.title || child.accessible_name || '';
            let toggleId = title.toLowerCase().replace(/\s+/g, '-');
            let { iconName, gicon } = this._resolveIcon(child, isMenuToggle, toggleId);


            let subtitle = child.subtitle || '';
            // Prepend cellular technology label to subtitle
            let isCellular = title.toLowerCase().match(/mobile|wwan|cellular|modem/);
            if (isCellular)
                subtitle = this._cellularSubtitle(subtitle);

            let entry = {
                gnomeWidget: child,
                title,
                toggleId,
                iconName,
                gicon,
                checked: child.checked ?? false,
                visible: child.visible ?? true,
                subtitle,
                isMenuToggle,
                _isCellular: !!isCellular,
            };

            // Watch state changes on the GNOME widget (read-only)
            let sigs = [];
            sigs.push(child.connect('notify::checked', () => {
                entry.checked = child.checked;
                this._notify();
            }));
            sigs.push(child.connect('notify::visible', () => {
                entry.visible = child.visible;
                this._notify();
            }));
            if ('subtitle' in child) {
                sigs.push(child.connect('notify::subtitle', () => {
                    let sub = child.subtitle || '';
                    entry.subtitle = entry._isCellular ? this._cellularSubtitle(sub) : sub;
                    this._notify();
                }));
            }
            if ('title' in child) {
                sigs.push(child.connect('notify::title', () => {
                    entry.title = child.title || child.accessible_name || '';
                    entry.toggleId = entry.title.toLowerCase().replace(/\s+/g, '-');
                    this._notify();
                }));
            }
            // Watch icon changes
            let icon = child._icon || (isMenuToggle
                ? (child._box || child.get_first_child())?.get_first_child()?._icon
                : null);
            if (icon) {
                if ('icon_name' in icon) {
                    sigs.push(icon.connect('notify::icon-name', () => {
                        let resolved = this._resolveIcon(child, isMenuToggle, entry.toggleId);
                        entry.iconName = resolved.iconName;
                        entry.gicon = resolved.gicon;
                        this._notify();
                    }));
                }
                if ('gicon' in icon) {
                    sigs.push(icon.connect('notify::gicon', () => {
                        let resolved = this._resolveIcon(child, isMenuToggle, entry.toggleId);
                        entry.iconName = resolved.iconName;
                        entry.gicon = resolved.gicon;
                        this._notify();
                    }));
                }
            }
            for (let id of sigs)
                this._signalIds.push({ widget: child, id });

            this._toggles.push(entry);
        }

        // Inject a synthetic mobile data toggle if GNOME's QS grid
        // doesn't include one (common on gnome-shell-mobile 48).
        let hasCellularToggle = this._toggles.some(e =>
            e.toggleId.match(/mobile|wwan|cellular|modem/));
        if (!hasCellularToggle) {
            try {
                let nmClient = NM.Client.new(null);
                let devices = nmClient?.get_devices?.() ?? [];
                let hasModem = devices.some(d =>
                    d.get_device_type?.() === NM.DeviceType.MODEM);
                if (hasModem) {
                    let sub = this._cellularSubtitle('');
                    let icon = this._resolveIcon({ title: 'mobile' }, false, 'mobile-data');
                    this._toggles.push({
                        gnomeWidget: null,
                        title: 'Mobile Data',
                        toggleId: 'mobile-data',
                        iconName: icon.iconName || 'network-cellular-symbolic',
                        gicon: icon.gicon,
                        checked: false,
                        visible: true,
                        subtitle: sub,
                        isMenuToggle: false,
                        _isCellular: true,
                        _isSynthetic: true,
                    });
                    // Check if mobile data is active
                    let activeConns = nmClient.get_active_connections() ?? [];
                    for (let conn of activeConns) {
                        let connType = conn.get_connection_type?.() ?? '';
                        let cDevices = conn.get_devices?.() ?? [];
                        let devType = cDevices[0]?.get_device_type?.();
                        if (connType === 'gsm' || connType === 'cdma' ||
                            devType === NM.DeviceType.MODEM) {
                            this._toggles[this._toggles.length - 1].checked = true;
                            break;
                        }
                    }
                }
            } catch (_e) {}
        }

        // Inject flashlight toggle if torch LED exists
        let hasFlashlight = this._toggles.some(e =>
            e.toggleId.match(/flashlight|torch/));
        if (!hasFlashlight) {
            let torchPath = null;
            for (let p of ['/sys/class/leds/white:flash/brightness',
                           '/sys/class/leds/led:torch_0/brightness',
                           '/sys/class/leds/led:torch_1/brightness']) {
                if (Gio.File.new_for_path(p).query_exists(null)) {
                    torchPath = p;
                    break;
                }
            }
            if (torchPath) {
                this._torchPath = torchPath;
                let torchOn = false;
                try {
                    let [ok, contents] = GLib.file_get_contents(torchPath);
                    if (ok) torchOn = parseInt(new TextDecoder().decode(contents).trim(), 10) > 0;
                } catch (_e) {}
                this._toggles.push({
                    gnomeWidget: null,
                    title: 'Flashlight',
                    toggleId: 'flashlight',
                    iconName: 'flashlight-symbolic',
                    gicon: this._loadBundledIcon('flashlight-symbolic'),
                    checked: torchOn,
                    visible: true,
                    subtitle: '',
                    isMenuToggle: false,
                    _isSynthetic: true,
                    _syntheticType: 'flashlight',
                });
            }
        }

        // Inject hotspot toggle if wifi device exists
        let hasHotspot = this._toggles.some(e =>
            e.toggleId.match(/hotspot|tethering/));
        if (!hasHotspot) {
            try {
                let nmClient = NM.Client.new(null);
                let devices = nmClient?.get_devices?.() ?? [];
                let hasWifi = devices.some(d =>
                    d.get_device_type?.() === NM.DeviceType.WIFI);
                if (hasWifi) {
                    // Check if hotspot is currently active
                    let hotspotActive = false;
                    let activeConns = nmClient.get_active_connections() ?? [];
                    for (let conn of activeConns) {
                        let s = conn.get_connection()?.get_setting_by_name?.('802-11-wireless');
                        if (s?.get_mode?.() === 'ap') {
                            hotspotActive = true;
                            break;
                        }
                    }
                    this._toggles.push({
                        gnomeWidget: null,
                        title: 'Hotspot',
                        toggleId: 'hotspot',
                        iconName: 'network-wireless-hotspot-symbolic',
                        gicon: null,
                        checked: hotspotActive,
                        visible: true,
                        subtitle: '',
                        isMenuToggle: false,
                        _isSynthetic: true,
                        _syntheticType: 'hotspot',
                    });
                }
            } catch (_e) {}
        }

        // Inject location services toggle
        let hasLocation = this._toggles.some(e =>
            e.toggleId.match(/location/));
        if (!hasLocation) {
            let locationEnabled = false;
            try {
                let locSettings = new Gio.Settings({ schema_id: 'org.gnome.system.location' });
                locationEnabled = locSettings.get_boolean('enabled');
                this._locationSettings = locSettings;
                this._runtimeDisposer.replaceConnection(this, '_locationChangedId',
                    locSettings, 'changed::enabled', () => {
                        let entry = this._toggles.find(e => e.toggleId === 'location');
                        if (entry) {
                            entry.checked = locSettings.get_boolean('enabled');
                            this._notify();
                        }
                    });
            } catch (_e) {}
            this._toggles.push({
                gnomeWidget: null,
                title: 'Location',
                toggleId: 'location',
                iconName: 'find-location-symbolic',
                gicon: null,
                checked: locationEnabled,
                visible: true,
                subtitle: '',
                isMenuToggle: false,
                _isSynthetic: true,
                _syntheticType: 'location',
            });
        }

        // Watch for late-arriving toggles
        this._runtimeDisposer.replaceConnection(this, '_gridChildAddedId', grid, 'child-added', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._discovered = false;
                this.discover();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._discovered = true;

        // Delayed re-scans to catch toggles from extensions that load
        // after Convergence (e.g. Caffeine adding via addExternalIndicator).
        // The child-added signal may not fire on GNOME Mobile 48 for
        // toggles added via insertItemBefore, so poll at increasing intervals.
        if (!this._lateRescanDone) {
            this._lastChildCount = grid.get_n_children();
            let attempts = 0;
            let rescanCheck = () => {
                attempts++;
                let currentCount = grid.get_n_children();
                if (currentCount !== this._lastChildCount) {
                    this._lastChildCount = currentCount;
                    this._discovered = false;
                    this.discover();
                }
                // Check at 1s, 3s, 6s then stop
                if (attempts >= 3) {
                    this._lateRescanDone = true;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            };
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                rescanCheck();
                if (this._lateRescanDone) return GLib.SOURCE_REMOVE;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    rescanCheck();
                    if (this._lateRescanDone) return GLib.SOURCE_REMOVE;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, rescanCheck);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        }

        // Restore synthetic toggle checked states from before cleanup
        if (this._syntheticState) {
            for (let t of this._toggles) {
                if (t._isSynthetic && this._syntheticState.has(t.toggleId))
                    t.checked = this._syntheticState.get(t.toggleId);
            }
            this._syntheticState = null;
        }

        return true;
    }

    /** Prepend cellular technology (5G, LTE, etc.) to a subtitle string. */
    _cellularSubtitle(subtitle) {
        try {
            let bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            let result = bus.call_sync(
                'org.freedesktop.ModemManager1',
                '/org/freedesktop/ModemManager1/Modem/0',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', [
                    'org.freedesktop.ModemManager1.Modem',
                    'AccessTechnologies',
                ]),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 500, null);
            let tech = result.get_child_value(0).unpack().unpack();
            let label = '';
            if (tech & 0x8000) label = '5G';
            else if (tech & 0x4000) label = 'LTE';
            else if (tech & 0x200) label = 'H+';
            else if (tech & (0x100 | 0x80 | 0x40)) label = 'H';
            else if (tech & 0x20) label = '3G';
            else if (tech & 0x10) label = 'E';
            else if (tech & (0x8 | 0x4 | 0x2)) label = '2G';
            if (label && subtitle)
                return `${label} · ${subtitle}`;
            if (label)
                return label;
        } catch (_e) {}
        return subtitle;
    }

    _hasIcon(child, isMenuToggle) {
        if (child.iconName || child.gicon || child._icon?.icon_name || child._icon?.gicon)
            return true;
        if (isMenuToggle) {
            let inner = (child._box || child.get_first_child())?.get_first_child();
            if (inner?.iconName || inner?.gicon || inner?._icon?.icon_name || inner?._icon?.gicon)
                return true;
        }
        return false;
    }

    _resolveIcon(child, isMenuToggle, toggleId) {
        let override = TOGGLE_ICON_OVERRIDES[toggleId];
        if (override) return { iconName: override, gicon: null };

        // For cellular toggles, use signal-strength bars from ModemManager
        // instead of the technology icon (5G/LTE) that GNOME shows.
        let title = (child.title || child.accessible_name || '').toLowerCase();
        if (title.includes('mobile') || title.includes('wwan') ||
            title.includes('cellular') || title.includes('modem')) {
            try {
                let bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
                let result = bus.call_sync(
                    'org.freedesktop.ModemManager1',
                    '/org/freedesktop/ModemManager1/Modem/0',
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', [
                        'org.freedesktop.ModemManager1.Modem',
                        'SignalQuality',
                    ]),
                    new GLib.VariantType('(v)'),
                    Gio.DBusCallFlags.NONE, 500, null);
                let quality = result.get_child_value(0).unpack().get_child_value(0).unpack();
                let iconName;
                if (quality >= 80) iconName = 'network-cellular-signal-excellent-symbolic';
                else if (quality >= 60) iconName = 'network-cellular-signal-good-symbolic';
                else if (quality >= 40) iconName = 'network-cellular-signal-ok-symbolic';
                else if (quality >= 20) iconName = 'network-cellular-signal-weak-symbolic';
                else iconName = 'network-cellular-signal-none-symbolic';
                return { iconName, gicon: null };
            } catch (_e) {}
        }

        let gicon = child._icon?.gicon || child.gicon || null;
        let iconName = child._icon?.icon_name || child.iconName || '';
        if (isMenuToggle) {
            let inner = (child._box || child.get_first_child())?.get_first_child();
            if (!gicon) gicon = inner?._icon?.gicon || inner?.gicon || null;
            if (!iconName) iconName = inner?._icon?.icon_name || inner?.iconName || '';
        }
        return { iconName, gicon };
    }

    _loadBundledIcon(name) {
        try {
            // Derive extension root from this module's path
            let thisFile = import.meta.url.replace('file://', '');
            let extRoot = thisFile.replace(/\/src\/.*$/, '');
            let iconPath = `${extRoot}/icons/${name}.svg`;
            let file = Gio.File.new_for_path(iconPath);
            if (file.query_exists(null))
                return new Gio.FileIcon({ file });
        } catch (_e) {}
        return null;
    }

    _extractIconName(widget) {
        return widget._icon?.icon_name || widget.iconName || '';
    }

    _extractGicon(widget) {
        return widget._icon?.gicon || widget.gicon || null;
    }

    _cleanup() {
        // Preserve synthetic toggle checked states across re-discovery
        this._syntheticState = new Map();
        for (let t of this._toggles) {
            if (t._isSynthetic)
                this._syntheticState.set(t.toggleId, t.checked);
        }
        for (let { widget, id } of this._signalIds) {
            try { widget.disconnect(id); } catch (_e) {}
        }
        this._signalIds = [];
        this._runtimeDisposer.clearConnectionRef(this, '_gridChildAddedId', this._grid);
        this._toggles = [];
        this._brightnessWidget = null;
        this._volumeWidget = null;
        this._systemButtons = [];
        this._discovered = false;
    }

    dispose() {
        this._cleanup();
        this._runtimeDisposer?.dispose?.();
        this._listeners.clear();
        this._grid = null;
    }
}

// ── ConvergenceQuickToggles — renders convergence toggle UI ─────────────

export { QS_SETTINGS_MAP };

export class ConvergenceQuickToggles {
    /**
     * @param {Object} opts
     * @param {Gio.Settings|null} opts.settings
     * @param {number} opts.panelWidth - width of the panel in px
     */
    /**
     * @param {Object} opts
     * @param {Gio.Settings|null} opts.settings
     * @param {number} opts.panelWidth - width of the panel in px
     * @param {function|null} opts.onHeightChanged - called after expand/collapse completes
     * @param {function|null} opts.getPanel - returns the panel St.BoxLayout for synced animation
     * @param {function|null} opts.getPanelMaxH - returns the max panel height
     */
    constructor({ settings = null, panelWidth = 540, panelScale = null, hostType = null, haptics = null, onEditToggle = null, onHeightChanged = null, onClosePanel = null, getPanel = null, getPanelMaxH = null } = {}) {
        this._settings = settings;
        this._panelWidth = panelWidth;
        this._panelScale = panelScale;
        this._hostType = hostType;
        this._haptics = haptics;
        this._onEditToggle = onEditToggle;
        this._onHeightChanged = onHeightChanged;
        this._onClosePanel = onClosePanel;
        this._getPanel = getPanel;
        this._getPanelMaxH = getPanelMaxH;
        this._cache = null; // Created in populate()
        this._grid = null;
        this._cells = [];
        this._volumeRow = null;
        this._brightnessRow = null;
        this._volumeWidget = null;
        this._autoBrightnessBtn = null;
        this._volumeWidgetSignals = [];
        this._brightnessWidget = null;
        this._brightnessWidgetSignals = [];
        this._nCols = 0;
        this._scale = panelScale ?? (panelWidth / 432);
        this._cellSize = Math.round(56 * this._scale);
        this._cacheListener = () => this._onCacheChanged();
        this._runtimeDisposer = new RuntimeDisposer();
        // Listener added after populate() completes to avoid
        // _onCacheChanged firing before cells exist.
    }

    /** Discover toggles and populate the given container. */
    populate(container) {
        // Each instance owns its own cache to avoid cross-instance
        // signal handler issues during phone→desktop mode switches.
        this._cache = new ToggleStateCache();
        if (!this._cache.discover()) return false;
        this._container = container;
        this._nCols = Math.max(4, Math.min(6, Math.floor(this._panelWidth / 74)));
        this._buildGrid();
        this._buildVolumeRow();
        this._buildBrightnessRow();
        this._cache.addListener(this._cacheListener);
        for (let c of this._sysCells)
            log(`[Convergence:QS] sysCell: id="${c._toggleId}" spacer=${!!c._isSpacer}`);
        for (let c of this._cells)
            log(`[Convergence:QS] cell: id="${c._toggleId}" label="${c._toggleLabel?.text}" vis=${c.visible} cacheVis=${c._cacheEntry?.visible}`);
        return true;
    }

    /** Close any open inline toggle menu.
     *  @param {boolean} animate — false for immediate removal (panel closing) */
    closeToggleMenu(animate = true) { this._closeToggleMenu(animate); }

    /** The grid widget holding toggle cells. */
    get grid() { return this._grid; }

    /** The brightness row widget (slider + auto button). */
    get brightnessRow() { return this._brightnessRow; }

    /** The volume row widget (slider + mute button). */
    get volumeRow() { return this._volumeRow; }

    /** Whether GNOME currently exposes a usable brightness control. */
    get brightnessAvailable() {
        return this._isBrightnessAvailable();
    }

    /** Whether GNOME currently exposes a usable volume control. */
    get volumeAvailable() {
        return this._isVolumeAvailable();
    }

    /** Number of grid columns. */
    get nCols() { return this._nCols; }

    /** Current scale factor. */
    get scale() { return this._scale; }

    /** All toggle cell entries (for overflow/edit mode). */
    get cells() { return this._cells; }

    /** System button cells (row 0). */
    get sysCells() { return this._sysCells; }

    /** Ordered list of toggle info for edit mode. */
    getToggleInfoList() {
        return this._cells.map(c => ({
            toggleId: c._toggleId,
            iconName: c._iconName,
            gicon: c._gicon,
            label: c._label,
            visible: c.visible,
            hiddenByUser: !!c._hiddenByUser,
        }));
    }

    /** Reorder cells based on saved toggle order and hidden list. */
    applySavedOrder() {
        if (!this._settings || !this._grid) return;
        try {
            let savedOrder = this._settings.get_strv('qs-toggle-order');
            let hiddenIds = this._settings.get_strv('qs-hidden-toggles');
            if (!savedOrder.length && !hiddenIds.length) return;

            let hiddenSet = new Set(hiddenIds);
            let cellMap = new Map();
            for (let cell of this._cells)
                cellMap.set(cell._toggleId, cell);

            // Mark hidden
            for (let cell of this._cells) {
                if (hiddenSet.has(cell._toggleId)) {
                    cell.visible = false;
                    cell._hiddenByUser = true;
                } else {
                    delete cell._hiddenByUser;
                    // Respect GNOME's own visibility
                    let entry = cell._cacheEntry;
                    cell.visible = entry ? entry.visible : true;
                }
            }

            // Reorder
            let orderedCells = [];
            let seen = new Set();
            for (let id of savedOrder) {
                if (hiddenSet.has(id)) continue;
                let cell = cellMap.get(id);
                if (cell && cell.visible) {
                    orderedCells.push(cell);
                    seen.add(cell);
                }
            }
            // Append new toggles not in saved order
            for (let cell of this._cells) {
                if (seen.has(cell) || cell._hiddenByUser || !cell.visible) continue;
                orderedCells.push(cell);
            }

            // Include hidden cells too (they stay in grid but invisible)
            let allCells = [...orderedCells];
            for (let cell of this._cells) {
                if (!allCells.includes(cell))
                    allCells.push(cell);
            }
            this._layoutToggleCells(allCells);
        } catch (_e) {}
    }

    /** Persist toggle order to settings. */
    persistOrder(activeIds, hiddenIds) {
        if (!this._settings) return;
        try {
            this._settings.set_strv('qs-toggle-order', activeIds);
            this._settings.set_strv('qs-hidden-toggles', hiddenIds);
        } catch (_e) {}
    }

    /** Recalculate which toggle rows overflow past COLLAPSED_ROWS.
     *  System rows never overflow. Returns overflow row actors. */
    recalcOverflow(collapsedRows = 2) {
        let overflow = [];
        if (!this._rows) return overflow;
        let toggleRowIdx = 0;
        for (let entry of this._rows) {
            if (entry.isSystem) continue;
            if (toggleRowIdx >= collapsedRows)
                overflow.push(entry.row);
            toggleRowIdx++;
        }
        return overflow;
    }

    _px(value) {
        return Math.max(1, Math.round(value * this._scale));
    }

    _styleMenuSection(section) {
        if (!section)
            return;
        section.style = [
            `border-radius: ${this._px(16)}px;`,
            `padding: ${this._px(8)}px ${this._px(12)}px;`,
            `margin: ${this._px(4)}px 0;`,
        ].join(' ');
    }

    _styleMenuItem(item) {
        if (!item)
            return;
        item.style = [
            `border-radius: ${this._px(12)}px;`,
            `padding: ${this._px(10)}px ${this._px(12)}px;`,
        ].join(' ');
    }

    // ── Grid construction ──────────────────────────────────────────

    _buildGrid() {
        let s = this._scale;
        this._colSpacing = Math.round(12 * s);
        this._rowSpacing = Math.round(6 * s);

        // Vertical box of horizontal rows — allows inserting expandable
        // menu sections between toggle rows with animation.
        this._grid = new St.BoxLayout({
            vertical: true, x_expand: true,
            style: `spacing: ${this._rowSpacing}px;`,
        });
        this._rows = [];
        this._expandedSection = null;
        this._expandedEntry = null;

        // Compute dynamic button size
        let gridW = Math.round(this._panelWidth * 0.94);
        let colW = (gridW - (this._nCols - 1) * this._colSpacing) / this._nCols;
        this._btnSize = Math.max(36, Math.min(Math.round(colW * 0.76), this._cellSize));

        this._sysCells = [];
        this._cells = [];
        let toggles = this._cache.toggles;
        let sysButtons = this._cache.systemButtons;

        for (let entry of sysButtons) {
            let cell = this._createSystemCell(entry);
            this._sysCells.push(cell);
        }

        for (let entry of toggles) {
            let cell = this._createToggleCell(entry);
            this._cells.push(cell);
        }

        // Edit toggles cell — appended as the last toggle, visible only when expanded
        this._editCell = this._createEditCell();
        this._editCell.visible = false;

        this._layoutAllCells();
        this.applySavedOrder();
        this._container.add_child(this._grid);
    }

    /** Create a horizontal row widget for cells. */
    _createRow() {
        return new St.BoxLayout({
            x_expand: true,
            style: `spacing: ${this._colSpacing}px;`,
        });
    }

    /**
     * Rebuild all rows from system cells and toggle cells.
     */
    _layoutAllCells() {
        if (this._destroyed) return;
        this._closeToggleMenu();
        // Remove all cells from their parent rows before destroying rows,
        // to prevent cascade-destroying cells that are still referenced.
        for (let cell of [...this._sysCells, ...this._cells]) {
            if (cell.get_parent()) cell.get_parent().remove_child(cell);
        }
        this._grid.destroy_all_children();
        this._rows = [];

        // Row 0: system buttons
        if (this._sysCells.length > 0) {
            let sysRow = this._createRow();
            for (let cell of this._sysCells) {
                if (cell.get_parent()) cell.get_parent().remove_child(cell);
                sysRow.add_child(cell);
            }
            this._grid.add_child(sysRow);
            this._rows.push({ row: sysRow, cells: [...this._sysCells], isSystem: true });
        }

        // Toggle rows — exclude user-hidden and GNOME-hidden cells
        let visibleCells = this._cells.filter(c => !c._hiddenByUser && c._cacheEntry?.visible !== false);
        // Append edit cell if it exists
        if (this._editCell) {
            if (this._editCell.get_parent()) this._editCell.get_parent().remove_child(this._editCell);
            visibleCells = [...visibleCells, this._editCell];
        }
        for (let i = 0; i < visibleCells.length; i += this._nCols) {
            let rowCells = visibleCells.slice(i, i + this._nCols);
            let row = this._createRow();
            for (let cell of rowCells) {
                if (cell.get_parent()) cell.get_parent().remove_child(cell);
                row.add_child(cell);
            }
            this._grid.add_child(row);
            this._rows.push({ row, cells: rowCells, isSystem: false });
        }
        this._onHeightChanged?.();
    }

    /**
     * Re-layout just the toggle cells (preserving system row).
     */
    _layoutToggleCells(cells) {
        if (this._destroyed) return;
        this._closeToggleMenu();
        // Remove cells from rows before destroying rows to prevent
        // cascade-destroying cells that are still referenced.
        for (let entry of [...this._rows]) {
            if (!entry.isSystem) {
                for (let cell of entry.cells) {
                    if (cell.get_parent() === entry.row)
                        entry.row.remove_child(cell);
                }
                if (entry.row.get_parent()) entry.row.get_parent().remove_child(entry.row);
                entry.row.destroy();
            }
        }
        this._rows = this._rows.filter(e => e.isSystem);

        let visibleCells = cells.filter(c => !c._hiddenByUser && c._cacheEntry?.visible !== false);
        if (this._editCell) {
            if (this._editCell.get_parent()) this._editCell.get_parent().remove_child(this._editCell);
            visibleCells = [...visibleCells, this._editCell];
        }
        for (let i = 0; i < visibleCells.length; i += this._nCols) {
            let rowCells = visibleCells.slice(i, i + this._nCols);
            let row = this._createRow();
            for (let cell of rowCells) {
                if (cell.get_parent()) cell.get_parent().remove_child(cell);
                row.add_child(cell);
            }
            this._grid.add_child(row);
            this._rows.push({ row, cells: rowCells, isSystem: false });
        }
        this._onHeightChanged?.();
    }

    _createEditCell() {
        let s = this._scale;
        let sz = this._btnSize;

        let btn = new St.Button({
            style_class: 'convergence-qs-toggle',
            width: sz, height: sz,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.style = `height: ${sz}px; border-radius: ${Math.round(sz / 2)}px;`;
        btn.child = new St.Icon({
            icon_name: 'document-edit-symbolic',
            icon_size: Math.round(20 * s),
        });
        btn.connect('clicked', () => {
            this._haptics?.vibrate(10);
            this._onEditToggle?.();
        });

        let fontSize = Math.round(10 * s);
        let labelH = Math.round(fontSize * 2.8);
        let label = new St.Label({
            text: 'Edit Toggles',
            style_class: 'convergence-qs-cell-label',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${fontSize}px; min-height: ${labelH}px; max-height: ${labelH}px;`,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = 0;
        label.clutter_text.ellipsize = 3;
        label.clutter_text.line_alignment = 1;

        let gridW = Math.round(this._panelWidth * 0.94);
        let cellW = Math.floor((gridW - (this._nCols - 1) * this._colSpacing) / this._nCols);
        let pad = Math.round(2 * s);
        let cell = new St.BoxLayout({
            style_class: 'convergence-qs-cell',
            vertical: true, x_expand: false, y_expand: false,
            width: cellW,
            style: `padding: ${pad}px 0; spacing: ${pad}px;`,
        });
        cell.add_child(btn);
        cell.add_child(label);
        cell._toggleId = '__edit__';
        cell._isEditCell = true;
        return cell;
    }

    /** Show or hide the edit toggle cell. */
    setEditCellVisible(visible) {
        if (this._editCell) this._editCell.visible = visible;
    }

    _createToggleCell(entry) {
        let s = this._scale;
        let sz = this._btnSize;

        let btn = new St.Button({
            style_class: 'convergence-qs-toggle',
            width: sz, height: sz,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.style = `height: ${sz}px; border-radius: ${Math.round(sz / 2)}px;`;

        let icon = new St.Icon({ icon_size: Math.round(20 * s) });
        let overrideIcon = TOGGLE_ICON_OVERRIDES[entry.toggleId];
        if (overrideIcon)
            icon.gicon = new Gio.ThemedIcon({ name: overrideIcon });
        else if (entry.gicon)
            icon.gicon = entry.gicon;
        else if (entry.iconName)
            icon.gicon = new Gio.ThemedIcon({ name: entry.iconName });
        else
            icon.gicon = new Gio.ThemedIcon({ name: 'application-x-executable-symbolic' });
        btn.child = icon;
        btn._toggleIcon = icon;

        if (entry.checked) btn.add_style_class_name('checked');

        // Tap/click toggles on/off. Long-press or right-click opens menu (if available).
        if (entry.isMenuToggle && entry.gnomeWidget.menu) {
            let pressTimeoutId = 0;
            let longPressed = false;
            let startPress = () => {
                longPressed = false;
                if (pressTimeoutId) { GLib.source_remove(pressTimeoutId); pressTimeoutId = 0; }
                pressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    pressTimeoutId = 0;
                    longPressed = true;
                    log(`[Convergence:QS] toggle long-pressed: id="${entry.toggleId}" title="${entry.title}"`);
                    this._haptics?.vibrate(20);
                    this._openToggleMenu(entry, cell);
                    return GLib.SOURCE_REMOVE;
                });
            };
            let cancelPress = () => {
                if (pressTimeoutId) { GLib.source_remove(pressTimeoutId); pressTimeoutId = 0; }
            };
            btn.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 3) {
                    log(`[Convergence:QS] toggle right-clicked: id="${entry.toggleId}" title="${entry.title}"`);
                    this._haptics?.vibrate(20);
                    this._openToggleMenu(entry, cell);
                    return Clutter.EVENT_STOP;
                }
                startPress();
                return Clutter.EVENT_PROPAGATE;
            });
            btn.connect('button-release-event', () => { cancelPress(); return Clutter.EVENT_PROPAGATE; });
            btn.connect('touch-event', (_actor, event) => {
                let type = event.type();
                if (type === Clutter.EventType.TOUCH_BEGIN)
                    startPress();
                else if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL)
                    cancelPress();
                return Clutter.EVENT_PROPAGATE;
            });
            btn.connect('clicked', () => {
                cancelPress();
                if (longPressed) { longPressed = false; return; }
                log(`[Convergence:QS] toggle tapped: id="${entry.toggleId}" title="${entry.title}"`);
                this._haptics?.vibrate(10);
                if (entry._isSynthetic) {
                    this._activateSynthetic(entry);
                    if (entry.checked)
                        btn.add_style_class_name('checked');
                    else
                        btn.remove_style_class_name('checked');
                } else {
                    this._activateGnomeWidget(entry.gnomeWidget);
                }
            });
        } else {
            btn.connect('clicked', () => {
                log(`[Convergence:QS] toggle tapped: id="${entry.toggleId}" title="${entry.title}"`);
                this._haptics?.vibrate(10);
                if (entry._isSynthetic) {
                    this._activateSynthetic(entry);
                    // Directly sync button style after synthetic toggle
                    if (entry.checked)
                        btn.add_style_class_name('checked');
                    else
                        btn.remove_style_class_name('checked');
                } else {
                    this._activateGnomeWidget(entry.gnomeWidget);
                }
            });
        }

        let displayLabel = (entry.subtitle && entry.subtitle.length > 0)
            ? entry.subtitle : entry.title;
        let fontSize = Math.round(10 * s);
        let labelH = Math.round(fontSize * 2.8);
        let label = new St.Label({
            text: displayLabel,
            style_class: 'convergence-qs-cell-label',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${fontSize}px; min-height: ${labelH}px; max-height: ${labelH}px;`,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = 0; // WORD — keeps whole words together
        label.clutter_text.ellipsize = 3; // END
        label.clutter_text.line_alignment = 1; // CENTER

        // Constrain cell width so labels wrap instead of expanding the cell
        let gridW = Math.round(this._panelWidth * 0.94);
        let cellW = Math.floor((gridW - (this._nCols - 1) * this._colSpacing) / this._nCols);
        let pad = Math.round(2 * s);
        let cell = new St.BoxLayout({
            style_class: 'convergence-qs-cell',
            vertical: true, x_expand: false, y_expand: false,
            width: cellW,
            style: `padding: ${pad}px 0; spacing: ${pad}px;`,
        });
        cell.add_child(btn);
        cell.add_child(label);

        cell._toggleBtn = btn;
        cell._toggleLabel = label;
        cell._toggleId = entry.toggleId;
        cell._iconName = entry.iconName;
        cell._gicon = entry.gicon;
        cell._label = entry.title;
        cell._cacheEntry = entry;
        cell._lastVisible = entry.visible;
        cell.visible = entry.visible;

        return cell;
    }

    _createSystemCell(entry) {
        // Spacer cell — empty placeholder to separate button groups
        if (entry.isSpacer) {
            let gridW = Math.round(this._panelWidth * 0.94);
            let cellW = Math.floor((gridW - (this._nCols - 1) * this._colSpacing) / this._nCols);
            let pad = Math.round(2 * this._scale);
            let cell = new St.BoxLayout({
                style_class: 'convergence-qs-cell',
                vertical: true, x_expand: false, y_expand: false,
                width: cellW,
                style: `padding: ${pad}px 0; spacing: ${pad}px;`,
            });
            cell._toggleId = entry.toggleId;
            cell._isSpacer = true;
            return cell;
        }

        let s = this._scale;
        let sz = this._btnSize;

        let btn = new St.Button({
            style_class: 'convergence-qs-toggle',
            width: sz, height: sz,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.style = `height: ${sz}px; border-radius: ${Math.round(sz / 2)}px;`;

        let icon = new St.Icon({ icon_size: Math.round(20 * s) });
        if (entry.gicon)
            icon.gicon = entry.gicon;
        else
            icon.icon_name = entry.iconName || 'system-shutdown-symbolic';
        btn.child = icon;

        btn.connect('clicked', () => {
            log(`[Convergence:QS] system btn tapped: id="${entry.toggleId}" title="${entry.title}"`);
            this._haptics?.vibrate(10);
            try {
                if (entry.title.toLowerCase().includes('power off'))
                    this._openPowerMenu(cell);
                else {
                    this._activateGnomeWidget(entry.gnomeWidget);
                    this._onClosePanel?.();
                }
            } catch (_e) {}
        });

        let fontSize = Math.round(10 * s);
        let labelH = Math.round(fontSize * 2.8);
        let displayTitle = entry.title.toLowerCase().includes('power off')
            ? entry.title.replace(/Power Off/i, 'Power') : entry.title;
        let label = new St.Label({
            text: displayTitle,
            style_class: 'convergence-qs-cell-label',
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${fontSize}px; min-height: ${labelH}px; max-height: ${labelH}px;`,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = 0; // WORD
        label.clutter_text.ellipsize = 3; // END
        label.clutter_text.line_alignment = 1; // CENTER

        let gridW = Math.round(this._panelWidth * 0.94);
        let cellW = Math.floor((gridW - (this._nCols - 1) * this._colSpacing) / this._nCols);
        let pad = Math.round(2 * s);
        let cell = new St.BoxLayout({
            style_class: 'convergence-qs-cell',
            vertical: true, x_expand: false, y_expand: false,
            width: cellW,
            style: `padding: ${pad}px 0; spacing: ${pad}px;`,
        });
        cell.add_child(btn);
        cell.add_child(label);

        cell._toggleBtn = btn;
        cell._toggleLabel = label;
        cell._toggleId = entry.toggleId;
        cell._iconName = entry.iconName;
        cell._gicon = entry.gicon;
        cell._label = entry.title;
        cell._cacheEntry = entry;

        return cell;
    }

    // ── GNOME widget activation ──────────────────────────────────

    /**
     * Programmatically activate a GNOME QS widget.
     * Tries multiple strategies since the widgets aren't in our UI tree.
     */
    _activateGnomeWidget(w) {
        if (!w) return;
        try { w.emit('clicked', w); } catch (_e) {}
    }

    _updateSyntheticCellStyle(entry) {
        for (let cell of this._cells ?? []) {
            if (cell._toggleId !== entry.toggleId) continue;
            let btn = cell._toggleBtn;
            if (!btn) break;
            if (entry.checked)
                btn.add_style_class_name('checked');
            else
                btn.remove_style_class_name('checked');
            break;
        }
    }

    _activateSynthetic(entry) {
        switch (entry._syntheticType ?? entry.toggleId) {
            case 'flashlight': this._toggleFlashlight(entry); break;
            case 'hotspot': this._toggleHotspot(entry); break;
            case 'location': this._toggleLocation(entry); break;
            default: this._toggleMobileData(entry); break;
        }
    }

    _toggleFlashlight(entry) {
        let path = this._cache?._torchPath ?? '/sys/class/leds/white:flash/brightness';
        let newVal = entry.checked ? '0' : '200';
        try {
            // Try direct write first
            let file = Gio.File.new_for_path(path);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(newVal), null);
            stream.close(null);
        } catch (_e) {
            // Fall back to spawning a helper
            try {
                GLib.spawn_command_line_async(
                    `sh -c 'echo ${newVal} > ${path}'`);
            } catch (_e2) {}
        }
        entry.checked = !entry.checked;
        this._updateSyntheticCellStyle(entry);
        this._cache?._notify();
    }

    _toggleHotspot(entry) {
        try {
            let nmClient = NM.Client.new(null);
            if (!nmClient) return;
            if (entry.checked) {
                // Deactivate hotspot
                let activeConns = nmClient.get_active_connections() ?? [];
                for (let conn of activeConns) {
                    let s = conn.get_connection()?.get_setting_by_name?.('802-11-wireless');
                    if (s?.get_mode?.() === 'ap') {
                        nmClient.deactivate_connection(conn, null);
                        entry.checked = false;
                        entry.subtitle = '';
                        this._updateSyntheticCellStyle(entry);
                        this._cache?._notify();
                        break;
                    }
                }
            } else {
                // Activate hotspot via nmcli — use a saved Hotspot connection
                // if one exists, otherwise create one with a default SSID.
                let hasProfile = false;
                try {
                    let conns = nmClient.get_connections() ?? [];
                    for (let c of conns) {
                        let s = c.get_setting_by_name?.('802-11-wireless');
                        if (s?.get_mode?.() === 'ap') { hasProfile = true; break; }
                    }
                } catch (_e) {}
                if (hasProfile) {
                    GLib.spawn_command_line_async('nmcli connection up Hotspot');
                } else {
                    let hostname = GLib.get_host_name() || 'Phone';
                    GLib.spawn_command_line_async(
                        `nmcli device wifi hotspot ifname wlan0 ssid ${hostname} password changeme1`);
                }
                entry.checked = true;
                entry.subtitle = 'Activating...';
                this._updateSyntheticCellStyle(entry);
                this._cache?._notify();
                // Update subtitle after activation settles
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    try {
                        let nc = NM.Client.new(null);
                        let active = nc?.get_active_connections() ?? [];
                        for (let conn of active) {
                            let s = conn.get_connection()?.get_setting_by_name?.('802-11-wireless');
                            if (s?.get_mode?.() === 'ap') {
                                let ssid = s.get_ssid()?.get_data?.();
                                if (ssid) entry.subtitle = new TextDecoder().decode(ssid);
                                break;
                            }
                        }
                    } catch (_e) {}
                    this._cache?._notify();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (_e) {}
    }

    _toggleLocation(entry) {
        try {
            let locSettings = this._cache?._locationSettings ??
                new Gio.Settings({ schema_id: 'org.gnome.system.location' });
            let newState = !entry.checked;
            locSettings.set_boolean('enabled', newState);
            entry.checked = newState;
            this._updateSyntheticCellStyle(entry);
            this._cache?._notify();
        } catch (_e) {}
    }

    /** Toggle mobile data on/off for synthetic cellular toggle. */
    _toggleMobileData(entry) {
        try {
            let nmClient = NM.Client.new(null);
            if (!nmClient) return;
            if (entry.checked) {
                // Disconnect: find and deactivate the cellular connection
                let activeConns = nmClient.get_active_connections() ?? [];
                for (let conn of activeConns) {
                    let connType = conn.get_connection_type?.() ?? '';
                    let devices = conn.get_devices?.() ?? [];
                    let devType = devices[0]?.get_device_type?.();
                    if (connType === 'gsm' || connType === 'cdma' ||
                        devType === NM.DeviceType.MODEM) {
                        nmClient.deactivate_connection(conn, null);
                        entry.checked = false;
                        this._cache?._notify();
                        break;
                    }
                }
            } else {
                // Connect: find and activate a cellular connection profile
                let connections = nmClient.get_connections() ?? [];
                let modemConn = connections.find(c => {
                    let type = c.get_connection_type?.() ?? '';
                    return type === 'gsm' || type === 'cdma';
                });
                if (modemConn) {
                    nmClient.activate_connection_async(modemConn, null, null, null, null);
                    entry.checked = true;
                    this._cache?._notify();
                }
            }
        } catch (_e) {}
    }

    // ── Convergence inline expandable menu sections ────────────────

    /**
     * Find which row entry in this._rows contains the given cell.
     */
    _findRowForCell(cell) {
        for (let entry of this._rows) {
            if (entry.cells.includes(cell)) return entry;
        }
        return null;
    }

    /**
     * Open an inline expandable section that mirrors a GNOME QuickMenuToggle's
     * menu items. Reads items from the GNOME widget's .menu without modifying it.
     */
    _openToggleMenu(entry, cell) {
        // If same toggle tapped again, just collapse
        if (this._expandedEntry === entry) {
            this._closeToggleMenu();
            return;
        }
        // Skip if dismiss capture just closed this menu
        if (this._lastDismissedEntry === entry && GLib.get_monotonic_time() - this._lastDismissedTime < 300000) {
            this._lastDismissedEntry = null;
            return;
        }

        this._closeToggleMenu();

        let gnomeMenu = entry.gnomeWidget?.menu;
        if (!gnomeMenu) return;

        // Open the GNOME menu offscreen to trigger lazy population.
        // Some menus (Wi-Fi, Bluetooth) only populate their items
        // when opened via the standard open() path.
        let menuActor = gnomeMenu.actor;
        let origOpacity = menuActor?.opacity ?? 255;
        try {
            if (menuActor) {
                menuActor.opacity = 0;
                menuActor.height = 0;
            }
            gnomeMenu.open(false);
        } catch (e) {
            log(`[Convergence:QS] failed to open GNOME menu "${entry.title}": ${e.message}`);
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            // Close GNOME menu and restore actor
            try { gnomeMenu.close(false); } catch (_e) {}
            try {
                if (menuActor) {
                    menuActor.opacity = origOpacity;
                    menuActor.height = -1;
                }
            } catch (_e) {}

            this._buildInlineSection(entry, cell, gnomeMenu);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Build an inline expandable section from a GNOME menu's items and
     * insert it into the grid right after the row containing the cell.
     */
    _buildInlineSection(entry, cell, gnomeMenu) {
        let items = gnomeMenu._getMenuItems?.() ?? [];
        if (items.length === 0) return;

        let s = this._scale;

        // Build the section container
        let section = new St.BoxLayout({
            style_class: 'convergence-qs-menu-section',
            vertical: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        this._styleMenuSection(section);

        // Build content from flattened menu items
        let flatItems = this._flattenMenuItems(items).filter(item =>
            !item.constructor?.name?.includes('PopupSubMenuMenuItem'));

        for (let item of flatItems) {
            if (item instanceof PopupMenu.PopupSeparatorMenuItem) {
                section.add_child(new St.Widget({
                    style_class: 'convergence-qs-menu-separator',
                    x_expand: true, height: 1,
                }));
                continue;
            }

            // Use label.text for the display name; fall back to the first
            // St.Label found in the actor tree.  Never use accessible_name
            // as it contains descriptive text like "Secure, Signal strength 0%".
            let label = item.label?.text || '';
            if (!label) {
                let itemActor = item.actor || item;
                for (let ci = 0; ci < (itemActor.get_n_children?.() ?? 0); ci++) {
                    let ch = itemActor.get_child_at_index(ci);
                    if (ch instanceof St.Label && ch.text) { label = ch.text; break; }
                }
            }
            if (!label) continue;

            let row = new St.BoxLayout({ x_expand: true });
            let iconSize = Math.round(16 * s);

            // Extract icons from the GNOME menu item's actor tree.
            // Read ALL icons (including hidden ones) but track visibility
            // so we can replicate the icon even if GNOME hasn't rendered it yet.
            let itemActor = item.actor || item;
            let icons = this._extractAllIcons(itemActor);
            for (let iconInfo of icons.leading) {
                let iconParams = { icon_size: iconSize, y_align: Clutter.ActorAlign.CENTER };
                if (iconInfo.gicon) iconParams.gicon = iconInfo.gicon;
                else if (iconInfo.iconName) iconParams.icon_name = iconInfo.iconName;
                else continue;
                let icon = new St.Icon(iconParams);
                icon.style = `margin-right: ${Math.round(6 * s)}px;`;
                row.add_child(icon);
            }

            row.add_child(new St.Label({
                text: label, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${Math.round(13 * s)}px;`,
            }));

            for (let iconInfo of icons.trailing) {
                // Skip icons that aren't visible — trailing icons after the
                // label are typically ornaments (checkmarks) that GNOME only
                // shows for the active/connected item
                if (!iconInfo.visible) continue;
                let iconParams = { icon_size: iconSize, y_align: Clutter.ActorAlign.CENTER };
                if (iconInfo.gicon) iconParams.gicon = iconInfo.gicon;
                else if (iconInfo.iconName) iconParams.icon_name = iconInfo.iconName;
                else continue;
                let icon = new St.Icon(iconParams);
                icon.style = `margin-left: ${Math.round(6 * s)}px;`;
                row.add_child(icon);
            }

            let menuItem = new St.Button({
                style_class: 'convergence-qs-menu-item',
                x_expand: true,
                child: row,
            });
            this._styleMenuItem(menuItem);

            menuItem.connect('clicked', () => {
                try { item.emit('activate', null); } catch (_e) {
                    try { item.activate(null); } catch (_e2) {}
                }
                this._closeToggleMenu();
                this._onClosePanel?.();
            });
            section.add_child(menuItem);
        }

        // Insert section into grid right after the row containing the cell
        this._insertSectionAfterRow(section, cell);

        // Store references
        this._expandedSection = section;
        this._expandedEntry = entry;

        this._animateExpand(section);
        this._installMenuDismissCapture();
    }

    /**
     * Open the power/session menu as an inline section with
     * Log Out, Suspend, Restart, Power Off.
     */
    _openPowerMenu(cell) {
        // If power menu is already open, just collapse
        if (this._expandedEntry === '__power__') {
            this._closeToggleMenu();
            return;
        }
        // Skip if dismiss capture just closed this menu
        if (this._lastDismissedEntry === '__power__' && GLib.get_monotonic_time() - this._lastDismissedTime < 300000) {
            this._lastDismissedEntry = null;
            return;
        }

        this._closeToggleMenu();

        let s = this._scale;

        let section = new St.BoxLayout({
            style_class: 'convergence-qs-menu-section',
            vertical: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        this._styleMenuSection(section);

        let isPhone = this._hostType === 'phone';
        let _logindCall = (method) => {
            try {
                Gio.DBus.system.call(
                    'org.freedesktop.login1', '/org/freedesktop/login1',
                    'org.freedesktop.login1.Manager', method,
                    new GLib.Variant('(b)', [true]),
                    null, Gio.DBusCallFlags.NONE, 5000, null, null);
            } catch (_e) {}
        };
        let _sessionLogout = () => {
            try {
                Gio.DBus.session.call(
                    'org.gnome.SessionManager', '/org/gnome/SessionManager',
                    'org.gnome.SessionManager', 'Logout',
                    new GLib.Variant('(u)', [1]),
                    null, Gio.DBusCallFlags.NONE, 5000, null, null);
            } catch (_e) {}
        };
        let _confirm = (label, action) => {
            if (this._onClosePanel)
                this._onClosePanel();
            let mon = Main.layoutManager.primaryMonitor ?? { width: 400, height: 800 };
            let backdrop = new St.Bin({
                style: 'background-color: rgba(0,0,0,0.6);',
                reactive: true,
                x: mon.x, y: mon.y, width: mon.width, height: mon.height,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            let box = new St.BoxLayout({
                style: `background-color: rgba(30,30,36,0.95); border-radius: ${Math.round(16*s)}px; padding: ${Math.round(24*s)}px;`,
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(new St.Label({
                text: `${label}?`,
                style: `color: white; font-size: ${Math.round(18*s)}px; font-weight: bold; margin-bottom: ${Math.round(16*s)}px;`,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            let btnRow = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER, style: `spacing: ${Math.round(12*s)}px;` });
            let cancelBtn = new St.Button({
                label: 'Cancel',
                style: `background-color: rgba(255,255,255,0.1); color: white; border-radius: ${Math.round(8*s)}px; padding: ${Math.round(8*s)}px ${Math.round(20*s)}px;`,
            });
            let confirmBtn = new St.Button({
                label: label,
                style: `background-color: rgba(220,50,50,0.9); color: white; border-radius: ${Math.round(8*s)}px; padding: ${Math.round(8*s)}px ${Math.round(20*s)}px;`,
            });
            btnRow.add_child(cancelBtn);
            btnRow.add_child(confirmBtn);
            box.add_child(btnRow);
            backdrop.set_child(box);
            Main.layoutManager.uiGroup.add_child(backdrop);
            let dismiss = () => { backdrop.destroy(); };
            cancelBtn.connect('clicked', dismiss);
            backdrop.connect('button-press-event', (_a, event) => {
                let [x, y] = event.get_coords();
                let [bx, by] = box.get_transformed_position();
                let bw = box.width;
                let bh = box.height;
                if (x < bx || x > bx + bw || y < by || y > by + bh)
                    dismiss();
                return Clutter.EVENT_PROPAGATE;
            });
            backdrop.connect('touch-event', (_a, event) => {
                if (event.type() !== Clutter.EventType.TOUCH_END)
                    return Clutter.EVENT_PROPAGATE;
                let [x, y] = event.get_coords();
                let [bx, by] = box.get_transformed_position();
                let bw = box.width;
                let bh = box.height;
                if (x < bx || x > bx + bw || y < by || y > by + bh)
                    dismiss();
                return Clutter.EVENT_PROPAGATE;
            });
            confirmBtn.connect('clicked', () => { dismiss(); action(); });
        };
        let powerItems = [
            { label: 'Log Out', icon: 'system-log-out-symbolic',
              action: () => _confirm('Log Out', _sessionLogout) },
            ...(!isPhone ? [{ label: 'Suspend', icon: 'media-playback-pause-symbolic',
              action: () => _logindCall('Suspend') }] : []),
            { label: 'Restart', icon: 'system-reboot-symbolic',
              action: () => _confirm('Restart', () => _logindCall('Reboot')) },

            { label: 'Power Off', icon: 'system-shutdown-symbolic',
              action: () => _confirm('Power Off', () => _logindCall('PowerOff')) },
        ];

        for (let pi of powerItems) {
            let row = new St.BoxLayout({ x_expand: true });
            row.add_child(new St.Icon({
                icon_name: pi.icon,
                icon_size: Math.round(16 * s),
                y_align: Clutter.ActorAlign.CENTER,
                style: `margin-right: ${Math.round(12 * s)}px;`,
            }));
            row.add_child(new St.Label({
                text: pi.label, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: ${Math.round(13 * s)}px;`,
            }));
            let menuItem = new St.Button({
                style_class: 'convergence-qs-menu-item',
                x_expand: true,
                child: row,
            });
            this._styleMenuItem(menuItem);
            menuItem.connect('clicked', () => {
                this._closeToggleMenu();
                this._onClosePanel?.();
                pi.action();
            });
            section.add_child(menuItem);
        }

        // Insert section into grid right after the row containing the cell
        this._insertSectionAfterRow(section, cell);

        // Store references
        this._expandedSection = section;
        this._expandedEntry = '__power__';

        this._animateExpand(section);
        this._installMenuDismissCapture();
    }

    /**
     * Animate section expanding from 0 to natural height, with panel
     * height eased in sync to avoid stutter.
     */
    _animateExpand(section) {
        let panel = this._getPanel?.();
        let maxH = this._getPanelMaxH?.() ?? 9999;

        // Measure natural height — section is already in the tree
        // so get_preferred_height returns a meaningful value.
        let naturalHeight = section.get_preferred_height(-1)[1];
        if (naturalHeight <= 0) naturalHeight = 200;

        // Capture panel height before collapsing section to 0
        let panelStartH = panel?.height ?? 0;
        let panelTargetH = Math.min(panelStartH + naturalHeight, maxH);

        // Set section to 0 height and begin animation
        section.remove_all_transitions();
        section.set_height(0);

        if (panel) {
            panel.remove_all_transitions();
            panel.set_height(panelStartH);
        }

        // Use GLib.idle_add to start animations on the next frame,
        // after the layout has settled with section height = 0.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            section.ease({
                height: naturalHeight,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    section.set_height(-1);
                    this._onHeightChanged?.();
                },
            });
            if (panel && panelTargetH > panelStartH) {
                panel.ease({
                    height: panelTargetH,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Insert a section widget into this._grid right after the row
     * that contains the given cell.
     */
    _insertSectionAfterRow(section, cell) {
        let rowEntry = this._findRowForCell(cell);
        if (!rowEntry) {
            // Fallback: just add to end of grid
            this._grid.add_child(section);
            return;
        }

        // Find the grid child index of the row actor, then insert after it
        let gridChildren = this._grid.get_children();
        let rowIndex = gridChildren.indexOf(rowEntry.row);
        if (rowIndex >= 0 && rowIndex < gridChildren.length - 1) {
            // Insert after the row by using the next sibling
            let nextSibling = gridChildren[rowIndex + 1];
            this._grid.insert_child_below(section, nextSibling);
        } else {
            this._grid.add_child(section);
        }
    }

    _installMenuDismissCapture() {
        this._removeMenuDismissCapture();
        // Skip the first release event — it belongs to the long-press
        // touch sequence that opened the menu.
        let ignoreFirstRelease = true;
        this._runtimeDisposer.restartTimeout(this, '_dismissDelayId', GLib.PRIORITY_DEFAULT, 100, () => {
            this._runtimeDisposer.replaceConnection(this, '_dismissCaptureId', global.stage, 'captured-event', (_actor, event) => {
                if (!this._expandedSection) return Clutter.EVENT_PROPAGATE;
                let type = event.type();
                if (type !== Clutter.EventType.BUTTON_RELEASE &&
                    type !== Clutter.EventType.TOUCH_END)
                    return Clutter.EVENT_PROPAGATE;
                if (ignoreFirstRelease) {
                    ignoreFirstRelease = false;
                    return Clutter.EVENT_PROPAGATE;
                }
                let [x, y] = event.get_coords();
                let [sx, sy] = this._expandedSection.get_transformed_position();
                let sw = this._expandedSection.width;
                let sh = this._expandedSection.height;
                if (x >= sx && x <= sx + sw && y >= sy && y <= sy + sh)
                    return Clutter.EVENT_PROPAGATE;
                this._closeToggleMenu();
                return Clutter.EVENT_PROPAGATE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _removeMenuDismissCapture() {
        this._runtimeDisposer.clearTimeoutRef(this, '_dismissDelayId');
        this._runtimeDisposer.clearConnectionRef(this, '_dismissCaptureId', global.stage);
    }

    /**
     * Collapse and remove the currently expanded inline section.
     */
    _closeToggleMenu(animate = true) {
        this._removeMenuDismissCapture();
        if (this._expandedSection) {
            let section = this._expandedSection;
            this._lastDismissedEntry = this._expandedEntry;
            this._lastDismissedTime = GLib.get_monotonic_time();
            this._expandedSection = null;
            this._expandedEntry = null;

            if (!animate) {
                // Immediate removal — used when panel is closing/destroying
                try {
                    section.remove_all_transitions();
                    let parent = section.get_parent();
                    if (parent) parent.remove_child(section);
                    section.destroy();
                } catch (_e) {}
                return;
            }

            let sectionH = section.height;
            let panel = this._getPanel?.();
            let panelH = panel?.height ?? 0;

            section.ease({
                height: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    try {
                        let parent = section.get_parent();
                        if (parent) parent.remove_child(section);
                        section.destroy();
                    } catch (_e) {}
                    this._onHeightChanged?.();
                },
            });
            if (panel && sectionH > 0) {
                panel.ease({
                    height: Math.max(200, panelH - sectionH),
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        }
    }

    /**
     * Recursively flatten PopupMenuSections into a flat list of items.
     */
    _flattenMenuItems(items, depth = 0) {
        let flat = [];
        if (depth > 6) return flat;
        for (let item of items) {
            // Standard menu sections
            let subItems = item._getMenuItems?.() ?? [];
            if (subItems.length > 0) {
                flat.push(...this._flattenMenuItems(subItems, depth + 1));
                continue;
            }
            // For custom containers (like NMWirelessDeviceItem), walk
            // the actor tree to find PopupMenuItem/PopupSubMenuMenuItem children
            let actorItems = this._findMenuItemsInActor(item.actor || item);
            if (actorItems.length > 0) {
                flat.push(...actorItems);
                continue;
            }
            flat.push(item);
        }
        return flat;
    }

    /**
     * Walk an actor tree to find PopupMenuItem-like children.
     */
    _findMenuItemsInActor(actor, depth = 0) {
        let found = [];
        if (depth > 6 || !actor) return found;
        let n = actor.get_n_children?.() ?? 0;
        for (let i = 0; i < n; i++) {
            let child = actor.get_child_at_index(i);
            // Check if this child is a menu item (has label + activate)
            if (child._delegate && (child._delegate.label || child._delegate.activate)) {
                found.push(child._delegate);
                continue;
            }
            // Check by class name
            let cls = child.constructor?.name || '';
            if (cls.includes('PopupMenuItem') || cls.includes('PopupSubMenuItem') ||
                cls.includes('NMConnectionItem') || cls.includes('NetworkItem')) {
                let delegate = child._delegate || child;
                found.push(delegate);
                continue;
            }
            // Recurse into containers (BoxLayout, ScrollView content)
            if (child instanceof St.ScrollView) {
                let scrollChild = child.get_first_child?.();
                if (scrollChild)
                    found.push(...this._findMenuItemsInActor(scrollChild, depth + 1));
                continue;
            }
            found.push(...this._findMenuItemsInActor(child, depth + 1));
        }
        return found;
    }

    /**
     * Extract all icons from a GNOME menu item's actor tree.
     * Reads icons regardless of visibility, tracking whether each is
     * visible and whether it's an ornament (checkmark/dot indicator).
     */
    _extractAllIcons(actor) {
        let leading = [];
        let trailing = [];
        let foundLabel = false;

        let walk = (a, parentVisible) => {
            if (!a) return;
            let vis = parentVisible && (a.visible !== false);
            if (a instanceof St.Icon) {
                let iconName = a.icon_name || '';
                let gicon = a.gicon || null;
                if (iconName || gicon) {
                    let isOrnament = iconName.includes('ornament') ||
                        iconName.includes('emblem-ok') ||
                        iconName.includes('emblem-default') ||
                        a.has_style_class_name?.('popup-menu-ornament');
                    let info = { iconName, gicon, visible: vis, isOrnament };
                    if (foundLabel) trailing.push(info);
                    else leading.push(info);
                }
                return;
            }
            if (a instanceof St.Label && (a.text?.length > 0))
                foundLabel = true;
            let n = a.get_n_children?.() ?? 0;
            for (let i = 0; i < n; i++)
                walk(a.get_child_at_index(i), vis);
        };
        walk(actor, true);
        return { leading, trailing };
    }

    _findQuickSliderParts(widget) {
        let slider = null;
        let button = null;

        try {
            let innerBox = widget?.get_first_child?.();
            if (!innerBox)
                return { slider: null, button: null };

            for (let ch of innerBox.get_children()) {
                if (!button && ch instanceof St.Button)
                    button = ch;

                if (ch.constructor?.name === 'Slider' || ch.value !== undefined) {
                    slider = ch;
                    break;
                }

                let nested = ch.get_first_child?.();
                if (nested && (nested.constructor?.name === 'Slider' || nested.value !== undefined)) {
                    slider = nested;
                    break;
                }
            }
        } catch (_e) {}

        return { slider, button };
    }

    _createSliderRow(styleClass) {
        let pad = Math.round(8 * this._scale);
        let gridW = Math.round(this._panelWidth * 0.94);
        let cellW = Math.floor((gridW - (this._nCols - 1) * this._colSpacing) / this._nCols);
        let leftPad = Math.round((cellW - this._btnSize) / 2);
        return new St.BoxLayout({
            style_class: styleClass,
            x_expand: true,
            style: `spacing: ${pad}px; padding-left: ${leftPad}px; padding-right: ${leftPad * 2}px;`,
        });
    }

    _createRowIconButton(iconName) {
        let button = new St.Button({
            style_class: 'convergence-qs-toggle',
            child: new St.Icon({
                icon_name: iconName,
                icon_size: Math.round(16 * this._scale),
            }),
            width: this._btnSize,
            height: this._btnSize,
        });
        button.style = `height: ${this._btnSize}px; border-radius: ${Math.round(this._btnSize / 2)}px;`;
        return button;
    }

    _setButtonIcon(button, sourceIcon, fallbackName) {
        let icon = button?.child;
        if (!(icon instanceof St.Icon))
            return;

        if (sourceIcon?.gicon)
            icon.gicon = sourceIcon.gicon;
        else
            icon.gicon = null;

        icon.icon_name = sourceIcon?.icon_name || fallbackName;
    }

    _findIconActor(actor) {
        if (!actor)
            return null;
        if (actor instanceof St.Icon)
            return actor;

        let n = actor.get_n_children?.() ?? 0;
        for (let i = 0; i < n; i++) {
            let found = this._findIconActor(actor.get_child_at_index(i));
            if (found)
                return found;
        }
        return actor.get_first_child ? this._findIconActor(actor.get_first_child()) : null;
    }

    _trackSignal(store, object, signal, handler) {
        if (!object?.connect)
            return;
        try {
            store.push({ object, id: object.connect(signal, handler) });
        } catch (_e) {}
    }

    _pickVolumeIconName(value, muted) {
        if (muted || value <= 0)
            return 'audio-volume-muted-symbolic';
        if (value < 0.33)
            return 'audio-volume-low-symbolic';
        if (value < 0.66)
            return 'audio-volume-medium-symbolic';
        return 'audio-volume-high-symbolic';
    }

    _updateVolumeIcon() {
        if (!this._volumeBtn)
            return;

        let sourceIcon = this._volumeSourceIcon;
        if (sourceIcon?.icon_name || sourceIcon?.gicon) {
            this._setButtonIcon(this._volumeBtn, sourceIcon, 'audio-volume-high-symbolic');
            return;
        }

        let value = this._volumeSlider?.value ?? this._volumeGnomeSlider?.value ?? 0;
        let muted = false;
        try {
            muted = this._volumeStream?.is_muted ?? this._volumeStream?.get_is_muted?.() ?? false;
        } catch (_e) {}
        this._setButtonIcon(this._volumeBtn, { icon_name: this._pickVolumeIconName(value, muted) }, 'audio-volume-high-symbolic');
    }

    _toggleVolumeMute() {
        let button = this._volumeSourceButton;
        try {
            if (button?.clicked) {
                button.clicked();
                return;
            }
        } catch (_e) {}
        try {
            if (button) {
                button.emit('clicked');
                return;
            }
        } catch (_e) {}
        try {
            let stream = this._volumeStream;
            if (!stream)
                return;
            let muted = stream.is_muted ?? stream.get_is_muted?.() ?? false;
            if (stream.change_is_muted)
                stream.change_is_muted(!muted);
            else if (stream.set_is_muted)
                stream.set_is_muted(!muted);
        } catch (_e) {}
    }

    // ── Volume slider ──────────────────────────────────────────────

    _buildVolumeRow() {
        let gnomeVolume = this._cache.volumeWidget;
        if (!gnomeVolume)
            return;

        this._volumeWidget = gnomeVolume;

        let { slider: gnomeSlider, button: sourceButton } = this._findQuickSliderParts(gnomeVolume);
        if (!gnomeSlider)
            return;

        this._volumeRow = this._createSliderRow('convergence-qs-volume');

        let iconBtn = this._createRowIconButton('audio-volume-high-symbolic');
        this._volumeBtn = iconBtn;
        iconBtn.connect('clicked', () => this._toggleVolumeMute());
        this._volumeRow.add_child(iconBtn);

        let SliderClass = gnomeSlider.constructor;
        let slider = new SliderClass(gnomeSlider.value);
        slider.x_expand = true;
        slider.accessible_name = 'Volume';
        slider.style = `border-radius: ${this._px(18)}px; padding: ${this._px(8)}px ${this._px(12)}px;`;
        slider.connect('notify::value', () => {
            if (this._volumeSync) return;
            this._volumeSync = true;
            gnomeSlider.value = slider.value;
            this._volumeSync = false;
            this._updateVolumeIcon();
        });

        this._volumeGnomeSignal = gnomeSlider.connect('notify::value', () => {
            if (this._volumeSync) return;
            this._volumeSync = true;
            slider.value = gnomeSlider.value;
            this._volumeSync = false;
            this._updateVolumeIcon();
        });
        this._volumeGnomeSlider = gnomeSlider;
        this._volumeSlider = slider;
        this._volumeRow.add_child(slider);

        this._volumeSourceButton = sourceButton ?? null;
        this._volumeSourceIcon = this._findIconActor(sourceButton);
        this._volumeStream = gnomeVolume._stream ?? sourceButton?._stream ?? null;

        if (this._volumeSourceIcon) {
            if ('icon_name' in this._volumeSourceIcon)
                this._trackSignal(this._volumeWidgetSignals, this._volumeSourceIcon, 'notify::icon-name', () => this._updateVolumeIcon());
            if ('gicon' in this._volumeSourceIcon)
                this._trackSignal(this._volumeWidgetSignals, this._volumeSourceIcon, 'notify::gicon', () => this._updateVolumeIcon());
        }

        if (this._volumeStream) {
            this._trackSignal(this._volumeWidgetSignals, this._volumeStream, 'notify::is-muted', () => this._updateVolumeIcon());
        }

        this._trackSignal(this._volumeWidgetSignals, gnomeVolume, 'notify::visible', () => this._syncVolumeRowVisibility());
        this._trackSignal(this._volumeWidgetSignals, gnomeVolume, 'notify::reactive', () => this._syncVolumeRowVisibility());

        this._updateVolumeIcon();
        this._syncVolumeRowVisibility();
    }

    _isVolumeAvailable() {
        let widget = this._volumeWidget;
        if (!widget)
            return false;

        try {
            return widget.visible !== false && widget.reactive !== false;
        } catch (_e) {
            return false;
        }
    }

    _syncVolumeRowVisibility() {
        if (this._volumeRow)
            this._volumeRow.visible = this._isVolumeAvailable();
    }

    // ── Brightness slider ──────────────────────────────────────────

    _buildBrightnessRow() {
        let gnomeBrightness = this._cache.brightnessWidget;
        if (!gnomeBrightness) return;
        this._brightnessWidget = gnomeBrightness;

        let { slider: gnomeSlider } = this._findQuickSliderParts(gnomeBrightness);
        if (!gnomeSlider)
            return;

        this._brightnessRow = this._createSliderRow('convergence-qs-brightness');

        let iconBtn = this._createRowIconButton('display-brightness-symbolic');

        // Auto-brightness toggle — only enable if the ambient light sensor
        // is actually providing data (Qualcomm ADSP sensors may not be
        // exposed to the IIO subsystem on some devices).
        this._autoBrightnessBtn = iconBtn;
        let alsAvailable = this._checkAmbientLightAvailable();
        if (alsAvailable) {
            iconBtn.connect('clicked', () => {
                try {
                    let gsdPower = new Gio.Settings({
                        schema_id: 'org.gnome.settings-daemon.plugins.power',
                    });
                    let current = gsdPower.get_boolean('ambient-enabled');
                    gsdPower.set_boolean('ambient-enabled', !current);
                    this._syncAutoBrightnessStyle();
                } catch (_e) {}
            });
            this._syncAutoBrightnessStyle();
        } else {
            iconBtn.reactive = false;
            iconBtn.opacity = 128;
            // Ensure auto-brightness is off when sensor isn't working
            try {
                let gsdPower = new Gio.Settings({
                    schema_id: 'org.gnome.settings-daemon.plugins.power',
                });
                if (gsdPower.get_boolean('ambient-enabled'))
                    gsdPower.set_boolean('ambient-enabled', false);
            } catch (_e) {}
        }

        this._brightnessRow.add_child(iconBtn);

        // Create our own slider that mirrors GNOME's brightness slider value
        if (gnomeSlider) {
            // Import Slider from GNOME
            let SliderClass = gnomeSlider.constructor;
            let slider = new SliderClass(gnomeSlider.value);
            slider.x_expand = true;
            slider.accessible_name = 'Brightness';
            slider.style = `border-radius: ${this._px(18)}px; padding: ${this._px(8)}px ${this._px(12)}px;`;

            // Sync our slider → GNOME slider
            slider.connect('notify::value', () => {
                if (this._brightnessSync) return;
                this._brightnessSync = true;
                gnomeSlider.value = slider.value;
                this._brightnessSync = false;
            });

            // Sync GNOME slider → our slider
            this._brightnessGnomeSignal = gnomeSlider.connect('notify::value', () => {
                if (this._brightnessSync) return;
                this._brightnessSync = true;
                slider.value = gnomeSlider.value;
                this._brightnessSync = false;
            });
            this._brightnessGnomeSlider = gnomeSlider;

            this._brightnessRow.add_child(slider);
            this._brightnessSlider = slider;
        }

        this._brightnessWidgetSignals.push(
            gnomeBrightness.connect('notify::visible', () => this._syncBrightnessRowVisibility()),
        );
        this._brightnessWidgetSignals.push(
            gnomeBrightness.connect('notify::reactive', () => this._syncBrightnessRowVisibility()),
        );
        this._syncBrightnessRowVisibility();
    }

    _isBrightnessAvailable() {
        let widget = this._brightnessWidget;
        if (!widget)
            return false;

        try {
            return widget.visible !== false && !!this._brightnessGnomeSlider;
        } catch (_e) {
            return false;
        }
    }

    _syncBrightnessRowVisibility() {
        if (this._brightnessRow)
            this._brightnessRow.visible = this._isBrightnessAvailable();
    }

    _checkAmbientLightAvailable() {
        try {
            let sensorProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'net.hadess.SensorProxy',
                '/net/hadess/SensorProxy',
                'org.freedesktop.DBus.Properties', null);
            let hasALS = sensorProxy.call_sync(
                'Get',
                new GLib.Variant('(ss)', ['net.hadess.SensorProxy', 'HasAmbientLight']),
                Gio.DBusCallFlags.NONE, 1000, null);
            if (!hasALS?.deep_unpack?.()?.[0]?.deep_unpack?.())
                return false;
            // Check if the sensor is actually reporting non-zero data
            // by reading LightLevel — a perpetually-zero sensor is broken.
            let level = sensorProxy.call_sync(
                'Get',
                new GLib.Variant('(ss)', ['net.hadess.SensorProxy', 'LightLevel']),
                Gio.DBusCallFlags.NONE, 1000, null);
            let lux = level?.deep_unpack?.()?.[0]?.deep_unpack?.() ?? 0;
            // Also check if any IIO illuminance device exists
            let hasIIOLight = false;
            try {
                let iioDir = Gio.File.new_for_path('/sys/bus/iio/devices');
                let enumerator = iioDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = enumerator.next_file(null))) {
                    let devPath = `/sys/bus/iio/devices/${info.get_name()}/in_illuminance_raw`;
                    if (Gio.File.new_for_path(devPath).query_exists(null)) {
                        hasIIOLight = true;
                        break;
                    }
                }
            } catch (_e) {}
            return lux > 0 || hasIIOLight;
        } catch (_e) {
            return false;
        }
    }

    _syncAutoBrightnessStyle() {
        if (!this._autoBrightnessBtn) return;
        try {
            let gsdPower = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.power',
            });
            if (gsdPower.get_boolean('ambient-enabled'))
                this._autoBrightnessBtn.add_style_class_name('checked');
            else
                this._autoBrightnessBtn.remove_style_class_name('checked');
        } catch (_e) {}
    }

    // ── State sync ─────────────────────────────────────────────────

    _onCacheChanged() {
        if (this._destroyed || this._inCacheUpdate) return;
        if (!this._cells || this._cells.length === 0) return;
        this._inCacheUpdate = true;

        // Build a lookup from the live cache so cells always read
        // current state even after a re-discovery replaces entry objects.
        let liveEntries = new Map();
        for (let t of (this._cache?.toggles ?? []))
            liveEntries.set(t.toggleId, t);

        for (let cell of this._cells) {
            try {
                let toggleId = cell._toggleId;
                let entry = liveEntries.get(toggleId) ?? cell._cacheEntry;
                if (!entry) continue;

                // Keep cell reference up to date with the live entry
                if (entry !== cell._cacheEntry)
                    cell._cacheEntry = entry;

                let btn = cell._toggleBtn;
                if (!btn) continue;

                if (entry.checked)
                    btn.add_style_class_name('checked');
                else
                    btn.remove_style_class_name('checked');

                let icon = btn._toggleIcon;
                if (icon) {
                    let resolved = TOGGLE_ICON_OVERRIDES[entry.toggleId];
                    if (resolved) {
                        // Override icons — set via gicon to avoid being cleared
                        let gi = new Gio.ThemedIcon({ name: resolved });
                        icon.gicon = gi;
                    } else if (entry.gicon) {
                        icon.gicon = entry.gicon;
                    } else if (entry.iconName) {
                        icon.gicon = new Gio.ThemedIcon({ name: entry.iconName });
                    }
                    // Never clear to empty — keep last known good value
                }

                let label = cell._toggleLabel;
                if (label) {
                    let sub = entry.subtitle;
                    label.text = (sub && sub.length > 0) ? sub : entry.title;
                }

                if (!cell._hiddenByUser)
                    cell._lastVisible = entry.visible;
            } catch (_e) {
                // Cell or its children may be disposed — skip silently
            }
        }
        this._inCacheUpdate = false;
    }

    // ── Cleanup ────────────────────────────────────────────────────

    destroy() {
        this._destroyed = true;
        this._removeMenuDismissCapture();
        if (this._cache) {
            this._cache.removeListener(this._cacheListener);
            this._cache.dispose();
            this._cache = null;
        }
        this._cacheListener = null;
        // Clear all cell references BEFORE destroying actors to prevent
        // cache signal handlers from accessing disposed objects.
        this._cells = [];
        this._sysCells = [];
        this._rows = [];
        this._expandedSection = null;
        this._expandedEntry = null;

        this._closeToggleMenu(false);

        if (this._brightnessGnomeSignal && this._brightnessGnomeSlider) {
            try { this._brightnessGnomeSlider.disconnect(this._brightnessGnomeSignal); } catch (_e) {}
            this._brightnessGnomeSignal = 0;
            this._brightnessGnomeSlider = null;
        }
        if (this._volumeGnomeSignal && this._volumeGnomeSlider) {
            try { this._volumeGnomeSlider.disconnect(this._volumeGnomeSignal); } catch (_e) {}
            this._volumeGnomeSignal = 0;
            this._volumeGnomeSlider = null;
        }
        if (this._brightnessWidgetSignals.length > 0 && this._brightnessWidget) {
            for (let id of this._brightnessWidgetSignals) {
                try { this._brightnessWidget.disconnect(id); } catch (_e) {}
            }
        }
        for (let entry of this._volumeWidgetSignals) {
            try { entry.object.disconnect(entry.id); } catch (_e) {}
        }
        this._volumeWidgetSignals = [];
        this._volumeWidget = null;
        this._volumeSourceButton = null;
        this._volumeSourceIcon = null;
        this._volumeStream = null;
        this._brightnessWidgetSignals = [];
        this._brightnessWidget = null;
        this._runtimeDisposer?.dispose?.();
        this._runtimeDisposer = null;

        if (this._grid) {
            this._grid.destroy_all_children();
            if (this._grid.get_parent())
                this._grid.get_parent().remove_child(this._grid);
            this._grid.destroy();
            this._grid = null;
        }

        if (this._volumeRow) {
            if (this._volumeRow.get_parent())
                this._volumeRow.get_parent().remove_child(this._volumeRow);
            this._volumeRow.destroy();
            this._volumeRow = null;
        }

        if (this._brightnessRow) {
            if (this._brightnessRow.get_parent())
                this._brightnessRow.get_parent().remove_child(this._brightnessRow);
            this._brightnessRow.destroy();
            this._brightnessRow = null;
        }

        this._cells = [];
        this._container = null;
    }
}

export { ToggleStateCache };
