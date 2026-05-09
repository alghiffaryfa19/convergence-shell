// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';
import Cairo from 'cairo';
import NM from 'gi://NM';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';

/**
 * Concave quarter-circle corner drawn with Cairo.
 * Placed at the bottom of the phone status bar to create a smooth
 * curve between the panel and the content below.
 */
const PanelCornerActor = GObject.registerClass(
class PanelCornerActor extends St.DrawingArea {
    _init(hSide) {
        super._init({ style_class: 'convergence-phone-panel-corner' });
        this._hSide = hSide; // 'left' or 'right'
        this._cornerRadius = 0;
        this._r = 0;
        this._g = 0;
        this._b = 0;
        this._a = 0;
    }

    setCornerParams(radius, r, g, b, a) {
        let changed = this._cornerRadius !== radius ||
            this._r !== r || this._g !== g || this._b !== b || this._a !== a;
        this._cornerRadius = radius;
        this._r = r;
        this._g = g;
        this._b = b;
        this._a = a;
        if (changed) {
            this.set_size(radius, radius);
            this.queue_repaint();
        }
    }

    vfunc_repaint() {
        let r = this._cornerRadius;
        if (r <= 0) return;

        let cr = this.get_context();
        cr.setOperator(Cairo.Operator.SOURCE);

        // Concave quarter-circle: arc center at the opposite corner
        if (this._hSide === 'left') {
            // Junction at top-left (0,0); arc center at (r,r)
            cr.moveTo(0, 0);
            cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
        } else {
            // Junction at top-right (r,0); arc center at (0,r)
            cr.moveTo(r, 0);
            cr.arc(0, r, r, 3 * Math.PI / 2, 2 * Math.PI);
        }
        cr.closePath();

        cr.setSourceRGBA(this._r, this._g, this._b, this._a);
        cr.fill();
        cr.$dispose();
    }
});

const STATUS_BAR_SWIPE_CLAIM_PX = 10;
const STATUS_BAR_SWIPE_COMMIT_PX = 60;
const MAX_NOTIF_ICONS = 5;
const NOTIF_ICON_SIZE = 14;
const BATTERY_ICON_SIZE = 16;
const NETWORK_ICON_SIZE = 16;
const POWER_MODE_ICON_SIZE = 16;
const NOTIF_FALLBACK_ICON = 'notification-symbolic';
const CAFFEINE_ICON_BASE_PATH = `${GLib.get_home_dir()}/.local/share/gnome-shell/extensions/caffeine@patapon.info/icons/hicolor/scalable/actions`;
const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';

/**
 * StatusBar -- phone-specific status bar modifications to the native GNOME panel.
 *
 * Provides a standalone phone status bar actor scoped to the phone monitor.
 * It owns the phone-side clock, notification icons, swipe-down gesture,
 * and top inset without mutating GNOME's shared panel widget tree.
 */
export class StatusBar {
    /**
     * @param {Object} controller - convergence controller instance
     * @param {Gio.Settings|null} settings - extension settings
     * @param {Object} [opts]
     * @param {number} [opts.monitorIndex] - preferred phone monitor index
     */
    constructor(controller, settings, opts = {}) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._monitorIndex = Number.isInteger(opts.monitorIndex) ? opts.monitorIndex : null;
        this._runtimeDisposer = new RuntimeDisposer();
        this._bar = null;
        this._barContent = null;
        this._leftBox = null;
        this._rightBox = null;
        this._clockLabel = null;
        this._wallClock = null;
        this._wallClockId = 0;
        this._networkMonitor = null;
        this._nmClient = null;
        this._networkChangedId = 0;
        this._networkConnectivityId = 0;
        this._networkBox = null;
        this._networkTransportBox = null;
        this._networkTransportIcons = [];
        this._networkBluetoothIcon = null;
        this._networkVpnIcon = null;
        this._dndIcon = null;
        this._airplaneModeIcon = null;
        this._nightLightIcon = null;
        this._recordingIcon = null;
        this._caffeineIcon = null;
        this._powerModeIcon = null;
        this._networkIndicatorsBox = null;
        this._networkIndicatorSignals = [];
        this._batteryBox = null;
        this._batteryIcon = null;
        this._batteryLabel = null;
        this._batteryProxy = null;
        this._batteryProxyChangedId = 0;
        this._topStrut = null;
        this._savedPanelBoxVisible = null;
        this._savedPanelReactive = null;
        this._savedPanelOpacity = null;

        // Notification icon tracking state
        this._notifIconBox = null;
        this._notifIconMap = new Map();
        this._notifIconSourceTracked = null;
        this._notifIconSyncQueued = false;
        this._notifIconSyncTimeoutId = 0;

        // Swipe gesture state
        this._swipeState = null;
        this._gestureOverlay = null;
        this._brightnessProxy = null;

        this._active = false;
        this._setup();
    }

    /** Whether the status bar modifications are currently applied. */
    get isActive() {
        return this._active;
    }

    // ── Setup ────────────────────────────────────────────────────────

    _setup() {
        this._active = true;

        this._buildBar();
        this._addNotifIconBox();
        this._setupClock();
        this._setupNetwork();
        this._setupBattery();
        this._setupStatusMirrors();
        this._setupCaffeine();
        this._setupPowerMode();
        this._applyBarStyle();
        this._maybeHidePrimaryPanel();
        this._setupSwipeGesture();
        this._setupNotifIconTracking();
        this._setupSettingsTracking();
        this._createPanelCorners();
        this.relayout();
    }

    _setupSettingsTracking() {
        if (!this._settings)
            return;

        for (let key of ['panel-height', 'panel-padding-left', 'panel-padding-right']) {
            this._runtimeDisposer.connect(this._settings, `changed::${key}`, () => this.relayout());
        }

        if (this._settings.settings_schema?.has_key?.('statusbar-max-notification-icons')) {
            this._runtimeDisposer.connect(this._settings,
                'changed::statusbar-max-notification-icons', () => this._syncNotifIcons());
        }
    }

    _getTargetMonitorIndex() {
        let monitors = Main.layoutManager.monitors ?? [];
        let preferredIndex = this._monitorIndex;
        if (!Number.isInteger(preferredIndex))
            preferredIndex = this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex;
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < monitors.length)
            return preferredIndex;
        return Main.layoutManager.primaryIndex;
    }

    _getTargetMonitor() {
        let monitors = Main.layoutManager.monitors ?? [];
        let monitorIndex = this._getTargetMonitorIndex();
        return monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor ?? monitors[0] ?? null;
    }

    setMonitorIndex(monitorIndex = null) {
        this._restorePrimaryPanel();
        this._monitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        this._maybeHidePrimaryPanel();
        this.relayout();
    }

    refreshTopology(monitorIndex = null) {
        this.setMonitorIndex(monitorIndex);
    }

    // ── Standalone bar ───────────────────────────────────────────────

    _buildBar() {
        let monitor = this._getTargetMonitor();
        if (!monitor)
            return;

        this._bar = new St.Widget({
            name: 'convergence-phone-statusbar',
            style_class: 'panel convergence-phone-statusbar',
            reactive: false,
            layout_manager: new Clutter.BinLayout(),
        });

        this._barContent = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bar.add_child(this._barContent);

        this._leftBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let spacer = new St.Widget({ x_expand: true });
        this._rightBox = new St.BoxLayout({
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._barContent.add_child(this._leftBox);
        this._barContent.add_child(spacer);
        this._barContent.add_child(this._rightBox);

        Main.layoutManager.addTopChrome(this._bar, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._bar, null);

        this._topStrut = new St.Widget({
            name: 'convergence-phone-statusbar-strut',
            reactive: false,
            opacity: 0,
        });
        Main.layoutManager.addTopChrome(this._topStrut, {
            affectsStruts: true,
            trackFullscreen: true,
        });
    }

    _setupClock() {
        if (!this._leftBox)
            return;

        this._clockLabel = new St.Label({
            style_class: 'clock convergence-phone-statusbar-clock',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._leftBox.insert_child_at_index(this._clockLabel, 0);
        this._wallClock = new GnomeDesktop.WallClock();
        this._runtimeDisposer.replaceConnection(this, '_wallClockId', this._wallClock, 'notify::clock', () => this._syncClock());
        this._syncClock();
    }

    _setupBattery() {
        if (!this._rightBox)
            return;

        this._batteryBox = new St.BoxLayout({
            style_class: 'convergence-phone-battery-box',
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryIcon = new St.Icon({
            style_class: 'convergence-phone-battery-icon',
            icon_name: 'battery-missing-symbolic',
            icon_size: BATTERY_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryLabel = new St.Label({
            style_class: 'convergence-phone-battery-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });
        this._batteryBox.add_child(this._batteryLabel);
        this._batteryBox.add_child(this._batteryIcon);
        this._rightBox.add_child(this._batteryBox);
        this._setupBatteryProxy();
    }

    _setupNetwork() {
        if (!this._rightBox)
            return;

        this._networkBox = new St.BoxLayout({
            style_class: 'convergence-phone-network-box',
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._networkTransportBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._networkTransportIcons = [];
        this._networkBluetoothIcon = new St.Icon({
            style_class: 'convergence-phone-network-icon',
            icon_name: 'bluetooth-active-symbolic',
            icon_size: NETWORK_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._networkVpnIcon = new St.Icon({
            style_class: 'convergence-phone-network-icon',
            icon_name: 'network-vpn-symbolic',
            icon_size: NETWORK_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._networkBox.add_child(this._networkTransportBox);
        this._networkBox.add_child(this._networkBluetoothIcon);
        this._networkBox.add_child(this._networkVpnIcon);
        this._rightBox.insert_child_at_index(this._networkBox, 0);

        this._networkMonitor = Gio.NetworkMonitor.get_default?.() ?? null;
        this._networkIndicatorsBox = Main.panel?.statusArea?.quickSettings?._indicators ?? null;

        if (this._networkIndicatorsBox) {
            this._runtimeDisposer.replaceConnection(
                this, '_networkIndicatorsChildAddedId', this._networkIndicatorsBox, 'child-added',
                () => this._queueSyncNetwork());
            this._runtimeDisposer.replaceConnection(
                this, '_networkIndicatorsChildRemovedId', this._networkIndicatorsBox, 'child-removed',
                () => this._queueSyncNetwork());
            this._trackNetworkIndicatorActors(this._networkIndicatorsBox);
        }

        if (this._networkMonitor) {
            try {
                this._runtimeDisposer.replaceConnection(
                    this, '_networkChangedId', this._networkMonitor, 'network-changed', () => this._syncNetwork());
            } catch (_e) {}
            try {
                this._runtimeDisposer.replaceConnection(
                    this, '_networkConnectivityId', this._networkMonitor, 'notify::connectivity', () => this._syncNetwork());
            } catch (_e) {}
        }

        // NetworkManager client for direct active-connection queries
        try {
            this._nmClient = NM.Client.new(null);
            if (this._nmClient) {
                this._runtimeDisposer.replaceConnection(
                    this, '_nmActiveConnsChangedId', this._nmClient,
                    'notify::active-connections', () => this._queueSyncNetwork());
                this._runtimeDisposer.replaceConnection(
                    this, '_nmStateChangedId', this._nmClient,
                    'notify::state', () => this._queueSyncNetwork());
            }
        } catch (_e) {
            this._nmClient = null;
        }

        this._syncNetwork();
        this._syncPowerMode();
    }

    _setupPowerMode() {
        if (!this._rightBox)
            return;

        this._powerModeIcon = new St.Icon({
            style_class: 'convergence-phone-power-mode-icon',
            icon_name: 'power-profile-balanced-symbolic',
            icon_size: POWER_MODE_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        let batteryIndex = this._batteryBox
            ? this._rightBox.get_children().indexOf(this._batteryBox)
            : -1;
        if (batteryIndex >= 0)
            this._rightBox.insert_child_at_index(this._powerModeIcon, batteryIndex);
        else
            this._rightBox.add_child(this._powerModeIcon);
    }

    _setupStatusMirrors() {
        if (!this._rightBox)
            return;

        this._dndIcon = this._createStatusMirrorIcon(
            'convergence-phone-status-mirror-icon',
            'notifications-disabled-symbolic',
            1
        );
        this._airplaneModeIcon = this._createStatusMirrorIcon(
            'convergence-phone-status-mirror-icon',
            'airplane-mode-symbolic',
            2
        );
        this._nightLightIcon = this._createStatusMirrorIcon(
            'convergence-phone-status-mirror-icon',
            'night-light-symbolic',
            3
        );
        this._recordingIcon = this._createStatusMirrorIcon(
            'convergence-phone-status-mirror-icon',
            'media-record-symbolic',
            4
        );
    }

    _createStatusMirrorIcon(styleClass, iconName, index) {
        let icon = new St.Icon({
            style_class: styleClass,
            icon_name: iconName,
            icon_size: NETWORK_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._rightBox.insert_child_at_index(icon, index);
        return icon;
    }

    _setupCaffeine() {
        if (!this._rightBox)
            return;

        this._caffeineIcon = new St.Icon({
            style_class: 'convergence-phone-caffeine-icon',
            icon_name: 'my-caffeine-on-symbolic',
            icon_size: NETWORK_ICON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._rightBox.insert_child_at_index(this._caffeineIcon, 1);
        this._syncCaffeine();
    }

    _collectVisibleQuickSettingsIcons(actor, results = [], { includeHidden = false } = {}) {
        if (!actor)
            return results;
        if (!includeHidden && actor.visible === false)
            return results;

        if (actor instanceof St.Icon) {
            let iconName = actor.icon_name || '';
            let gicon = actor.gicon || null;
            if (iconName || gicon)
                results.push({ iconName, gicon });
            return results;
        }

        let n = actor.get_n_children?.() ?? 0;
        for (let i = 0; i < n; i++)
            this._collectVisibleQuickSettingsIcons(actor.get_child_at_index(i), results, { includeHidden });
        return results;
    }

    _trackNetworkIndicatorActors(actor) {
        let walk = a => {
            if (!a)
                return;

            if (typeof a.connect === 'function') {
                for (let signal of ['notify::visible', 'notify::icon-name', 'notify::gicon']) {
                    try {
                        this._networkIndicatorSignals.push({
                            actor: a,
                            id: a.connect(signal, () => this._queueSyncNetwork()),
                        });
                    } catch (_e) {}
                }
            }

            let n = a.get_n_children?.() ?? 0;
            for (let i = 0; i < n; i++)
                walk(a.get_child_at_index(i));
        };

        this._clearNetworkIndicatorSignals();
        walk(actor);
    }

    _clearNetworkIndicatorSignals() {
        for (let { actor, id } of this._networkIndicatorSignals) {
            try { actor.disconnect(id); } catch (_e) {}
        }
        this._networkIndicatorSignals = [];
    }

    _queueSyncNetwork() {
        this._runtimeDisposer.restartTimeout(
            this,
            '_networkIconSyncTimeoutId',
            GLib.PRIORITY_DEFAULT,
            16,
            () => {
                this._networkIconSyncTimeoutId = 0;
                this._trackNetworkIndicatorActors(this._networkIndicatorsBox);
                this._syncNetwork();
                this._syncStatusMirrors();
                this._syncCaffeine();
                this._syncPowerMode();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _iconSearchText(info) {
        let iconName = info?.iconName || '';
        let giconString = '';
        try {
            giconString = info?.gicon?.to_string?.() ?? '';
        } catch (_e) {}
        return `${iconName} ${giconString}`.toLowerCase();
    }

    _classifyQuickSettingsIcon(info) {
        let iconText = this._iconSearchText(info);
        if (!iconText)
            return null;

        if (iconText.includes('bluetooth'))
            return 'bluetooth';
        if (iconText.includes('network-wireless') || iconText.includes('wifi'))
            return 'wifi';
        if (iconText.includes('network-wired') || iconText.includes('ethernet'))
            return 'ethernet';
        if (iconText.includes('network-cellular') || iconText.includes('wwan') || iconText.includes('mobile'))
            return 'cellular';
        if (iconText.includes('network-vpn') || iconText.includes('vpn'))
            return 'vpn';
        if (iconText.includes('notifications-disabled') ||
            iconText.includes('do-not-disturb') ||
            iconText.includes('dnd'))
            return 'dnd';
        if (iconText.includes('airplane-mode') ||
            iconText.includes('flight-mode') ||
            iconText.includes('airplane'))
            return 'airplane-mode';
        if (iconText.includes('night-light'))
            return 'night-light';
        if (iconText.includes('media-record') ||
            iconText.includes('screencast') ||
            iconText.includes('screen-record') ||
            iconText.includes('recording'))
            return 'recording';
        if (iconText.includes('my-caffeine-on') ||
            iconText.includes('my-caffeine-off') ||
            iconText.includes('caffeine-short-timer') ||
            iconText.includes('caffeine-medium-timer') ||
            iconText.includes('caffeine-long-timer') ||
            iconText.includes('caffeine-infinite-timer'))
            return 'caffeine';
        if (iconText.includes('power-profile-performance') ||
            iconText.includes('power-profile-power-saver') ||
            iconText.includes('power-profile-balanced'))
            return 'power-profile';
        if (iconText.includes('network-offline') ||
            iconText.includes('network-no-route') ||
            iconText.includes('network-error') ||
            iconText.includes('dialog-warning'))
            return 'status';

        return null;
    }

    _pickQuickSettingsNetworkIcons() {
        // Query NetworkManager directly for active transports so we can
        // show all active connections side by side (wifi + cellular, etc.)
        // regardless of which one GNOME Shell chooses to display.
        let transports = this._getActiveNmTransports();

        // Collect visible GNOME indicators for non-transport icons only
        // (bluetooth, DnD, VPN, etc.) — these should only show when enabled.
        let visibleIcons = this._collectVisibleQuickSettingsIcons(
            this._networkIndicatorsBox, []);
        let visibleKinds = new Map();
        for (let info of visibleIcons) {
            let kind = this._classifyQuickSettingsIcon(info);
            if (kind && !visibleKinds.has(kind))
                visibleKinds.set(kind, info);
        }

        return {
            primary: transports[0] ?? null,
            transports,
            bluetooth: visibleKinds.get('bluetooth') ?? null,
            vpn: visibleKinds.get('vpn') ?? null,
            dnd: visibleKinds.get('dnd') ?? null,
            airplaneMode: visibleKinds.get('airplane-mode') ?? null,
            nightLight: visibleKinds.get('night-light') ?? null,
            recording: visibleKinds.get('recording') ?? null,
            caffeine: visibleKinds.get('caffeine') ?? null,
            powerProfile: visibleKinds.get('power-profile') ?? null,
        };
    }

    /**
     * Query NetworkManager for active connections and return an icon info
     * object for each active transport type (ethernet, wifi, cellular).
     */
    _getActiveNmTransports() {
        if (!this._nmClient) return [];
        let activeConns;
        try { activeConns = this._nmClient.get_active_connections() ?? []; }
        catch (_e) { return []; }

        let seen = new Set();
        let transports = [];

        for (let conn of activeConns) {
            let state;
            try { state = conn.get_state(); } catch (_e) { continue; }
            if (state !== NM.ActiveConnectionState.ACTIVATED &&
                state !== NM.ActiveConnectionState.ACTIVATING)
                continue;

            let type = null;
            let iconName = null;
            let gicon = null;
            try {
                let connType = conn.get_connection_type?.() ?? '';
                let devices = conn.get_devices?.() ?? [];
                let deviceType = devices.length > 0 ? devices[0]?.get_device_type?.() : null;

                if (connType === '802-3-ethernet' || deviceType === NM.DeviceType.ETHERNET) {
                    // Skip USB gadget interfaces (usb0, rndis0, etc.) — these
                    // appear when charging and aren't real ethernet connections.
                    let iface = devices[0]?.get_iface?.() ?? '';
                    if (iface.startsWith('usb') || iface.startsWith('rndis') ||
                        iface.startsWith('ncm') || iface.startsWith('ecm'))
                        continue;
                    type = 'ethernet';
                    iconName = 'network-wired-symbolic';
                } else if (connType === '802-11-wireless' || deviceType === NM.DeviceType.WIFI) {
                    type = 'wifi';
                    iconName = this._nmWifiIconName(devices[0]);
                } else if (connType === 'gsm' || connType === 'cdma' ||
                           deviceType === NM.DeviceType.MODEM) {
                    type = 'cellular';
                    let cellIcon = this._nmCellularIcon();
                    iconName = cellIcon.iconName;
                    gicon = cellIcon.gicon;
                } else if (connType === 'vpn' || connType === 'wireguard') {
                    continue; // VPN handled via GNOME indicators
                } else {
                    continue;
                }
            } catch (_e) { continue; }

            if (type && !seen.has(type)) {
                seen.add(type);
                transports.push({ iconName, gicon, _type: type });
            }
        }

        // Show cellular signal even when mobile data is off — check for
        // modem devices with a SIM present (GNOME's panel does the same).
        if (!seen.has('cellular')) {
            try {
                let devices = this._nmClient.get_devices() ?? [];
                for (let dev of devices) {
                    if (dev.get_device_type?.() !== NM.DeviceType.MODEM) continue;
                    // Device exists = SIM is present or modem is registered
                    let cellIcon = this._nmCellularIcon();
                    transports.push({
                        iconName: cellIcon.iconName || 'network-cellular-symbolic',
                        gicon: cellIcon.gicon,
                        _type: 'cellular',
                    });
                    seen.add('cellular');
                    break;
                }
            } catch (_e) {}
        }

        // Stable display order: ethernet, wifi, cellular
        let order = { ethernet: 0, wifi: 1, cellular: 2 };
        transports.sort((a, b) => (order[a._type] ?? 99) - (order[b._type] ?? 99));
        return transports;
    }

    _nmWifiIconName(device) {
        if (!device) return 'network-wireless-symbolic';
        try {
            let ap = device.get_active_access_point?.();
            if (!ap) return 'network-wireless-acquiring-symbolic';
            let strength = ap.get_strength?.() ?? 0;
            if (strength > 80) return 'network-wireless-signal-excellent-symbolic';
            if (strength > 55) return 'network-wireless-signal-good-symbolic';
            if (strength > 30) return 'network-wireless-signal-ok-symbolic';
            if (strength > 5) return 'network-wireless-signal-weak-symbolic';
            return 'network-wireless-signal-none-symbolic';
        } catch (_e) {
            return 'network-wireless-symbolic';
        }
    }

    _nmCellularIcon() {
        // Read signal quality directly from ModemManager via D-Bus and
        // map it to the standard GNOME signal bar icons. This avoids
        // depending on QS toggle icons which show technology (5G/LTE)
        // instead of signal strength.
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
            let inner = result.get_child_value(0).unpack();
            let quality = inner.get_child_value(0).unpack();
            let iconName;
            if (quality >= 80)
                iconName = 'network-cellular-signal-excellent-symbolic';
            else if (quality >= 60)
                iconName = 'network-cellular-signal-good-symbolic';
            else if (quality >= 40)
                iconName = 'network-cellular-signal-ok-symbolic';
            else if (quality >= 20)
                iconName = 'network-cellular-signal-weak-symbolic';
            else
                iconName = 'network-cellular-signal-none-symbolic';
            return { iconName, gicon: null };
        } catch (_e) {}
        // Fallback: generic cellular icon
        return { iconName: 'network-cellular-symbolic', gicon: null };
    }

    /** Read the access technology from ModemManager and return a short
     *  label like '5G', 'LTE', '4G', '3G', '2G', or null. */
    _nmCellularTechLabel() {
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
            // Prefer the highest technology
            if (tech & 0x8000) return '5G';
            if (tech & 0x4000) return 'LTE';
            if (tech & 0x200) return 'H+';
            if (tech & (0x100 | 0x80 | 0x40)) return 'H';
            if (tech & 0x20) return '3G';
            if (tech & 0x10) return 'E';
            if (tech & (0x8 | 0x4 | 0x2)) return '2G';
        } catch (_e) {}
        return null;
    }

    _setupBatteryProxy() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            UPOWER_BUS,
            UPOWER_DISPLAY_DEVICE_PATH,
            UPOWER_DEVICE_IFACE,
            null,
            (_obj, result) => {
                try {
                    this._batteryProxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (_e) {
                    this._batteryProxy = null;
                }
                if (!this._batteryProxy)
                    return;
                this._runtimeDisposer.replaceConnection(
                    this,
                    '_batteryProxyChangedId',
                    this._batteryProxy,
                    'g-properties-changed',
                    () => this._syncBattery()
                );
                this._syncBattery();
            });
    }

    _batteryIconName(percentage, state) {
        if (!Number.isFinite(percentage))
            return 'battery-missing-symbolic';

        let level = 100;
        if (percentage < 10)
            level = 0;
        else if (percentage < 30)
            level = 20;
        else if (percentage < 50)
            level = 40;
        else if (percentage < 70)
            level = 60;
        else if (percentage < 90)
            level = 80;

        let charging = state === 1 || state === 5;
        return charging
            ? `battery-level-${level}-charging-symbolic`
            : `battery-level-${level}-symbolic`;
    }

    _syncBattery() {
        if (!this._batteryIcon || !this._batteryLabel || !this._batteryProxy)
            return;

        let percentage = null;
        let state = 0;
        let isPresent = true;
        try { percentage = this._batteryProxy.get_cached_property('Percentage')?.unpack?.() ?? null; } catch (_e) {}
        try { state = this._batteryProxy.get_cached_property('State')?.unpack?.() ?? 0; } catch (_e) {}
        try { isPresent = this._batteryProxy.get_cached_property('IsPresent')?.unpack?.() ?? true; } catch (_e) {}

        if (!isPresent || !Number.isFinite(percentage)) {
            this._batteryBox?.hide?.();
            return;
        }

        this._batteryBox?.show?.();
        this._batteryIcon.icon_name = this._batteryIconName(percentage, state);
        this._batteryLabel.text = `${Math.round(percentage)}%`;
    }

    _networkIconName(connectivity, networkAvailable) {
        if (!networkAvailable || connectivity === Gio.NetworkConnectivity.NONE)
            return 'network-offline-symbolic';

        if (connectivity === Gio.NetworkConnectivity.PORTAL ||
            connectivity === Gio.NetworkConnectivity.LIMITED)
            return 'dialog-warning-symbolic';

        return 'network-transmit-receive-symbolic';
    }

    _syncNetwork() {
        if (!this._networkTransportBox)
            return;

        let mirrored = this._pickQuickSettingsNetworkIcons();

        // Rebuild transport icons to match active transports
        let transports = mirrored.transports ?? [];
        if (transports.length === 0 && !mirrored.primary) {
            // No QuickSettings icons — fall back to NetworkMonitor
            let connectivity = Gio.NetworkConnectivity.FULL;
            let networkAvailable = true;
            try { connectivity = this._networkMonitor?.connectivity ?? Gio.NetworkConnectivity.FULL; } catch (_e) {}
            try { networkAvailable = this._networkMonitor?.network_available ?? true; } catch (_e) {}
            transports = [{ iconName: this._networkIconName(connectivity, networkAvailable), gicon: null }];
        }

        // Reuse existing icons where possible, add/remove as needed
        while (this._networkTransportIcons.length > transports.length) {
            let icon = this._networkTransportIcons.pop();
            this._networkTransportBox.remove_child(icon);
            icon.destroy();
        }
        while (this._networkTransportIcons.length < transports.length) {
            let icon = new St.Icon({
                style_class: 'convergence-phone-network-icon',
                icon_size: NETWORK_ICON_SIZE,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._networkTransportIcons.push(icon);
            this._networkTransportBox.add_child(icon);
        }
        let hasCellular = false;
        for (let i = 0; i < transports.length; i++) {
            let info = transports[i];
            let icon = this._networkTransportIcons[i];
            icon.gicon = info.gicon ?? null;
            icon.icon_name = info.iconName || 'network-transmit-receive-symbolic';
            icon.visible = true;
            if (info._type === 'cellular') hasCellular = true;
        }

        // Show cellular technology label (5G, LTE, etc.) to the left of signal bars
        if (hasCellular) {
            let tech = this._nmCellularTechLabel();
            if (tech) {
                if (!this._cellularTechLabel) {
                    this._cellularTechLabel = new St.Label({
                        style_class: 'convergence-phone-network-tech',
                        y_align: Clutter.ActorAlign.CENTER,
                        style: 'font-size: 9px; font-weight: bold; margin-right: 2px;',
                    });
                }
                // Ensure the label is positioned before the cellular icon
                if (this._cellularTechLabel.get_parent())
                    this._cellularTechLabel.get_parent().remove_child(this._cellularTechLabel);
                // Find the cellular icon index and insert before it
                let cellIdx = this._networkTransportBox.get_children().findIndex(
                    (c, i) => i < this._networkTransportIcons.length &&
                              transports[i]?._type === 'cellular');
                if (cellIdx >= 0)
                    this._networkTransportBox.insert_child_at_index(this._cellularTechLabel, cellIdx);
                else
                    this._networkTransportBox.add_child(this._cellularTechLabel);
                this._cellularTechLabel.text = tech;
                this._cellularTechLabel.visible = true;
            } else if (this._cellularTechLabel) {
                this._cellularTechLabel.visible = false;
            }
        } else if (this._cellularTechLabel) {
            this._cellularTechLabel.visible = false;
        }

        // Keep QS cellular toggle icon in sync with the status bar
        if (hasCellular) {
            try {
                let np = this._controller?.notificationPanel;
                let panels = [np?._phonePanel, np?._desktopPanel];
                for (let panel of panels) {
                    let cache = panel?._convergenceToggles?._cache;
                    if (!cache) continue;
                    for (let entry of cache._toggles ?? []) {
                        if (!entry._isCellular) continue;
                        let resolved = cache._resolveIcon(
                            entry.gnomeWidget, entry.isMenuToggle, entry.toggleId);
                        if (resolved.iconName !== entry.iconName || resolved.gicon !== entry.gicon) {
                            entry.iconName = resolved.iconName;
                            entry.gicon = resolved.gicon;
                        }
                        let sub = entry.gnomeWidget?.subtitle || '';
                        entry.subtitle = cache._cellularSubtitle(sub);
                        cache._notify();
                        break;
                    }
                }
            } catch (_e) {}
        }

        if (this._networkBluetoothIcon) {
            if (mirrored.bluetooth) {
                this._networkBluetoothIcon.gicon = mirrored.bluetooth.gicon ?? null;
                this._networkBluetoothIcon.icon_name = mirrored.bluetooth.iconName || 'bluetooth-active-symbolic';
                this._networkBluetoothIcon.visible = true;
            } else {
                this._networkBluetoothIcon.visible = false;
            }
        }

        if (this._networkVpnIcon) {
            if (mirrored.vpn) {
                this._networkVpnIcon.gicon = mirrored.vpn.gicon ?? null;
                this._networkVpnIcon.icon_name = mirrored.vpn.iconName || 'network-vpn-symbolic';
                this._networkVpnIcon.visible = true;
            } else {
                this._networkVpnIcon.visible = false;
            }
        }
    }

    _syncPowerMode() {
        if (!this._powerModeIcon)
            return;

        let mirrored = this._pickQuickSettingsNetworkIcons();
        let powerProfile = mirrored.powerProfile;
        if (!powerProfile) {
            this._powerModeIcon.visible = false;
            return;
        }

        let iconText = this._iconSearchText(powerProfile);
        if (!iconText.includes('power-profile-performance') &&
            !iconText.includes('power-profile-power-saver')) {
            this._powerModeIcon.visible = false;
            return;
        }

        this._powerModeIcon.gicon = powerProfile.gicon ?? null;
        this._powerModeIcon.icon_name = powerProfile.iconName || 'power-profile-performance-symbolic';
        this._powerModeIcon.visible = true;
    }

    _syncStatusMirrors() {
        let mirrored = this._pickQuickSettingsNetworkIcons();
        this._syncMirrorIcon(this._dndIcon, mirrored.dnd, 'notifications-disabled-symbolic');
        this._syncMirrorIcon(this._airplaneModeIcon, mirrored.airplaneMode, 'airplane-mode-symbolic');
        this._syncMirrorIcon(this._nightLightIcon, mirrored.nightLight, 'night-light-symbolic');
        this._syncMirrorIcon(this._recordingIcon, mirrored.recording, 'media-record-symbolic');
    }

    _syncMirrorIcon(icon, mirroredInfo, fallbackIcon) {
        if (!icon)
            return;

        if (!mirroredInfo) {
            icon.visible = false;
            return;
        }

        icon.gicon = mirroredInfo.gicon ?? null;
        icon.icon_name = mirroredInfo.iconName || fallbackIcon;
        icon.visible = true;
    }

    _syncCaffeine() {
        if (!this._caffeineIcon)
            return;

        let mirrored = this._pickQuickSettingsNetworkIcons();
        let caffeine = mirrored.caffeine;
        if (!caffeine) {
            this._caffeineIcon.visible = false;
            return;
        }

        let gicon = this._resolveCaffeineGicon(caffeine);
        if (gicon) {
            this._caffeineIcon.gicon = gicon;
            this._caffeineIcon.icon_name = '';
        } else {
            this._caffeineIcon.gicon = null;
            this._caffeineIcon.icon_name = caffeine.iconName || 'my-caffeine-on-symbolic';
        }
        this._caffeineIcon.visible = true;
    }

    _resolveCaffeineGicon(caffeine) {
        if (!caffeine)
            return null;

        if (caffeine.gicon)
            return caffeine.gicon;

        let iconName = caffeine.iconName || '';
        if (!iconName)
            return null;

        let file = Gio.File.new_for_path(`${CAFFEINE_ICON_BASE_PATH}/${iconName}.svg`);
        if (!file.query_exists(null))
            return null;

        try {
            return Gio.icon_new_for_string(file.get_path());
        } catch (_e) {
            return null;
        }
    }

    _syncClock() {
        if (!this._clockLabel)
            return;

        let wallClockText = '';
        try {
            wallClockText = this._wallClock?.clock ?? '';
        } catch (_e) {}

        if (wallClockText) {
            this._clockLabel.text = wallClockText;
            return;
        }

        let now = GLib.DateTime.new_now_local();
        this._clockLabel.text = now?.format('%H:%M') ?? '';
    }

    // ── Notification icons ───────────────────────────────────────────

    /** Add a BoxLayout for notification icons to the panel's left box. */
    _addNotifIconBox() {
        let leftBox = this._leftBox;
        if (!leftBox) return;

        this._notifIconBox = new St.BoxLayout({
            style_class: 'convergence-phone-notif-icons',
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });

        leftBox.add_child(this._notifIconBox);
    }

    /** Remove the notification icon box from the panel. */
    _removeNotifIconBox() {
        if (!this._notifIconBox) return;

        // Destroy all tracked icons
        for (let [, icon] of this._notifIconMap) {
            if (icon.get_parent())
                icon.get_parent().remove_child(icon);
            icon.destroy();
        }
        this._notifIconMap.clear();

        if (this._notifIconBox.get_parent())
            this._notifIconBox.get_parent().remove_child(this._notifIconBox);
        this._notifIconBox.destroy();
        this._notifIconBox = null;
    }

    _setupNotifIconTracking() {
        let tray = Main.messageTray;
        if (!tray) return;

        this._notifIconSyncQueued = false;

        this._runtimeDisposer.connect(tray, 'source-added', (_tray, source) => {
            this._trackNotifIconSource(source);
            this._queueNotifIconSync();
        });
        this._runtimeDisposer.connect(tray, 'source-removed', () => this._queueNotifIconSync());
        this._runtimeDisposer.connect(tray, 'queue-changed', () => this._queueNotifIconSync());

        for (let source of (tray.getSources?.() ?? []))
            this._trackNotifIconSource(source);

        this._syncNotifIcons();
    }

    _trackNotifIconSource(source) {
        if (!source || this._notifIconSourceTracked?.has(source))
            return;
        if (!this._notifIconSourceTracked)
            this._notifIconSourceTracked = new Set();
        this._notifIconSourceTracked.add(source);

        let handler = () => this._queueNotifIconSync();
        try {
            source.connectObject(
                'notification-added', handler,
                'notification-removed', handler,
                'notify::count', handler,
                this);
        } catch (_e) {
            try {
                source.connect('notification-added', handler);
                source.connect('notification-removed', handler);
            } catch (_e2) {}
        }
    }

    _queueNotifIconSync() {
        if (this._notifIconSyncQueued) return;
        this._notifIconSyncQueued = true;
        this._runtimeDisposer.restartTimeout(
            this,
            '_notifIconSyncTimeoutId',
            GLib.PRIORITY_DEFAULT,
            100,
            () => {
                this._notifIconSyncTimeoutId = 0;
                this._notifIconSyncQueued = false;
                this._syncNotifIcons();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _syncNotifIcons() {
        let container = this._notifIconBox;
        if (!container) return;

        let tray = Main.messageTray;
        if (!tray) return;

        // Exclude sources whose notifications have been swiped away
        // in the notification panel but not yet fully destroyed.
        let dismissedSources = this._controller?.notificationPanel?.pendingDismissSources;

        let activeEntries = [];
        let sources = tray.getSources?.() ?? [];
        for (let source of sources) {
            if (dismissedSources?.has(source)) continue;
            let notifications = source.notifications ?? [];
            if (notifications.length === 0) continue;

            // Resolve a monochrome symbolic icon for the status bar.
            // Try: source.iconName → app-id-symbolic → notification gicon → fallback
            let iconName = null;
            let fallbackIcon = NOTIF_FALLBACK_ICON;
            try { iconName = source.iconName ?? null; } catch (_e) {}

            // Derive the -symbolic variant from the app ID
            // (e.g. sm.puri.Chatty → sm.puri.Chatty-symbolic)
            if (!iconName) {
                try {
                    let appId = source.app?.get_id?.() ?? source.icon?.to_string?.() ?? '';
                    let baseName = appId.replace(/\.desktop$/, '');
                    if (baseName) {
                        iconName = `${baseName}-symbolic`;
                        // Keep the coloured icon as fallback in case -symbolic doesn't exist
                        fallbackIcon = baseName;
                    }
                } catch (_e) {}
            }

            if (!iconName) {
                let latest = notifications[notifications.length - 1];
                try { iconName = latest?.gicon?.to_string?.() ?? null; } catch (_e) {}
            }
            if (!iconName) iconName = NOTIF_FALLBACK_ICON;
            activeEntries.push({source, iconName, fallbackIcon});
        }

        let maxIcons = MAX_NOTIF_ICONS;
        try {
            let settingsMax = this._settings?.get_int('statusbar-max-notification-icons');
            if (Number.isFinite(settingsMax) && settingsMax >= 1)
                maxIcons = settingsMax;
        } catch (_e) {}
        let visible = activeEntries.slice(0, maxIcons);
        let overflow = activeEntries.length > maxIcons;

        let existingMap = this._notifIconMap;
        let newMap = new Map();
        container.remove_all_children();

        for (let entry of visible) {
            let existing = existingMap.get(entry.source);
            if (existing) {
                newMap.set(entry.source, existing);
                container.add_child(existing);
            } else {
                let icon = new St.Icon({
                    style_class: 'convergence-phone-notif-icon',
                    icon_name: entry.iconName,
                    fallback_icon_name: entry.fallbackIcon ?? NOTIF_FALLBACK_ICON,
                    icon_size: NOTIF_ICON_SIZE,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                newMap.set(entry.source, icon);
                container.add_child(icon);
            }
        }

        if (overflow) {
            let more = new St.Label({
                style_class: 'convergence-phone-notif-overflow',
                text: '\u00B7',
                y_align: Clutter.ActorAlign.CENTER,
            });
            container.add_child(more);
        }

        for (let [src, icon] of existingMap) {
            if (!newMap.has(src)) {
                if (icon.get_parent()) icon.get_parent().remove_child(icon);
                icon.destroy();
            }
        }
        this._notifIconMap = newMap;
        this._applyContentScale();
        this._applyStatusIconSpacing();
    }

    _teardownNotifIconTracking() {
        this._runtimeDisposer.clearTimeoutRef(this, '_notifIconSyncTimeoutId');
        if (this._notifIconSourceTracked) {
            for (let source of this._notifIconSourceTracked) {
                try { source.disconnectObject(this); } catch (_e) {}
            }
            this._notifIconSourceTracked.clear();
        }
        this._notifIconSourceTracked = null;
        this._notifIconSyncQueued = false;
    }

    get height() {
        let configured = 0;
        try {
            configured = this._settings?.get_int('panel-height') ?? 0;
        } catch (_e) {}
        return configured > 0 ? configured : (Main.panel?.height ?? 40);
    }

    _applyBarStyle() {
        if (!this._bar || !this._barContent)
            return;
        let left = 0;
        let right = 0;
        try {
            left = Math.max(0, this._settings?.get_int('panel-padding-left') ?? 0);
            right = Math.max(0, this._settings?.get_int('panel-padding-right') ?? 0);
        } catch (_e) {}

        this._barContent.set_style(`padding-left: ${left}px; padding-right: ${right}px;`);
        this._applyContentScale();
        this._applyStatusIconSpacing();
    }

    _getStatusBarScale() {
        return Math.max(0.75, Math.min(1.75, this.height / 40));
    }

    _getVanillaPanelMetrics() {
        // GNOME's panel theme commonly uses a 2.2em-tall panel. Derive an
        // equivalent "em" from the current bar height so spacing scales the
        // same way the vanilla panel does as vertical space changes.
        let em = this.height / 2.2;
        return {
            em,
            iconMargin: Math.max(2, em * 0.25),
            groupSpacing: Math.max(2, em * 0.25),
            groupPadding: Math.max(6, em * 0.75),
            systemIconSize: Math.max(16, Math.min(24, em * 1.091)),
            clockFont: Math.max(13, Math.min(24, em * 0.95)),
            overflowFont: Math.max(14, Math.min(22, em * 0.90)),
        };
    }

    _applyContentScale() {
        let h = this.height;
        let metrics = this._getVanillaPanelMetrics();
        let clockFont = metrics.clockFont;
        let statusIconSize = metrics.systemIconSize;
        let notifIconSize = metrics.systemIconSize;
        let batteryFont = metrics.clockFont;
        let overflowFont = metrics.overflowFont;

        if (this._clockLabel) {
            this._clockLabel.set_style([
                `font-size: ${clockFont.toFixed(2)}px;`,
                `line-height: ${Math.round(h)}px;`,
                'font-feature-settings: "tnum";',
            ].join(' '));
        }

        for (let icon of [
            ...(this._networkTransportIcons ?? []),
            this._networkBluetoothIcon,
            this._networkVpnIcon,
            this._dndIcon,
            this._airplaneModeIcon,
            this._nightLightIcon,
            this._recordingIcon,
            this._caffeineIcon,
            this._powerModeIcon,
            this._batteryIcon,
        ]) {
            if (icon)
                icon.icon_size = Math.round(statusIconSize);
        }

        if (this._batteryLabel)
            this._batteryLabel.set_style(`font-size: ${batteryFont.toFixed(2)}px;`);

        if (this._notifIconBox) {
            for (let child of this._notifIconBox.get_children()) {
                if (child instanceof St.Icon)
                    child.icon_size = Math.round(notifIconSize);
                else if (child instanceof St.Label)
                    child.set_style(`font-size: ${overflowFont.toFixed(2)}px;`);
            }
        }
    }

    _applyStatusIconSpacing() {
        let metrics = this._getVanillaPanelMetrics();
        let iconMarginPx = `${metrics.iconMargin.toFixed(2)}px`;
        let groupSpacingPx = `${metrics.groupSpacing.toFixed(2)}px`;
        let groupPaddingPx = `${metrics.groupPadding.toFixed(2)}px`;

        if (this._leftBox)
            this._leftBox.set_style(`padding-right: ${groupPaddingPx};`);
        if (this._rightBox)
            this._rightBox.set_style(`padding-left: ${groupPaddingPx};`);

        if (this._clockLabel)
            this._clockLabel.set_style(`${this._clockLabel.style || ''} margin-right: ${iconMarginPx};`);

        if (this._notifIconBox)
            this._notifIconBox.set_style(`spacing: ${groupSpacingPx};`);

        for (let child of this._notifIconBox?.get_children?.() ?? []) {
            if (child instanceof St.Icon)
                child.set_style(`margin-left: ${iconMarginPx}; margin-right: ${iconMarginPx};`);
            else if (child instanceof St.Label)
                child.set_style(`${child.style || ''} margin-left: ${iconMarginPx}; margin-right: ${iconMarginPx};`);
        }

        for (let icon of [
            ...(this._networkTransportIcons ?? []),
            this._networkBluetoothIcon,
            this._networkVpnIcon,
            this._dndIcon,
            this._airplaneModeIcon,
            this._nightLightIcon,
            this._recordingIcon,
            this._caffeineIcon,
            this._powerModeIcon,
        ]) {
            if (icon)
                icon.set_style(`margin-left: ${iconMarginPx}; margin-right: ${iconMarginPx};`);
        }

        if (this._batteryBox)
            this._batteryBox.set_style(`spacing: ${groupSpacingPx}; margin-left: ${iconMarginPx}; margin-right: ${iconMarginPx};`);
    }

    _maybeHidePrimaryPanel() {
        let targetMonitorIndex = this._getTargetMonitorIndex();
        if (targetMonitorIndex !== Main.layoutManager.primaryIndex)
            return;
        if (this._controller?.getMonitorRole?.(targetMonitorIndex) !== 'phone')
            return;

        if (this._savedPanelBoxVisible === null)
            this._savedPanelBoxVisible = Main.layoutManager?.panelBox?.visible ?? true;
        if (this._savedPanelReactive === null)
            this._savedPanelReactive = Main.panel?.reactive ?? true;
        if (this._savedPanelOpacity === null)
            this._savedPanelOpacity = Main.panel?.opacity ?? 255;

        Main.layoutManager?.panelBox?.hide?.();
        if (Main.panel) {
            Main.panel.reactive = false;
            Main.panel.opacity = 0;
        }
    }

    _restorePrimaryPanel() {
        if (this._savedPanelBoxVisible !== null) {
            if (this._savedPanelBoxVisible)
                Main.layoutManager?.panelBox?.show?.();
            else
                Main.layoutManager?.panelBox?.hide?.();
        }
        if (Main.panel) {
            if (this._savedPanelReactive !== null)
                Main.panel.reactive = this._savedPanelReactive;
            if (this._savedPanelOpacity !== null)
                Main.panel.opacity = this._savedPanelOpacity;
        }
        this._savedPanelBoxVisible = null;
        this._savedPanelReactive = null;
        this._savedPanelOpacity = null;
    }

    // ── Swipe-down gesture ───────────────────────────────────────────

    _setupSwipeGesture() {
        this._swipeState = {
            active: false,
            startX: 0,
            startY: 0,
            claimed: false,
            side: null,
        };

        // Transparent overlay sits on top of the panel to intercept all
        // touch/click events before panel children consume them.
        this._gestureOverlay = new St.Widget({
            name: 'convergence-statusbar-gesture-overlay',
            reactive: true,
            can_focus: false,
            opacity: 0,
        });
        Main.layoutManager.addTopChrome(this._gestureOverlay);
        this._positionGestureOverlay();

        let uiGroup = Main.layoutManager.uiGroup;
        if (uiGroup.contains(this._gestureOverlay))
            uiGroup.set_child_above_sibling(this._gestureOverlay, null);

        this._gestureOverlay.connect('captured-event',
            (_actor, event) => this._onSwipeCaptured(event));
    }

    _positionGestureOverlay() {
        if (!this._gestureOverlay)
            return;

        let monitor = this._getTargetMonitor();
        let panelH = this.height;
        this._gestureOverlay.set_position(
            monitor?.x ?? 0,
            monitor?.y ?? 0);
        this._gestureOverlay.set_size(
            monitor?.width ?? 0,
            panelH);
    }

    _onSwipeCaptured(event) {
        let type = event.type();
        let s = this._swipeState;
        if (!s) return Clutter.EVENT_PROPAGATE;

        let np = this._controller.notificationPanel;
        let phoneMonitorIndex = this._getTargetMonitorIndex();
        np?.selectPhoneMonitor?.(phoneMonitorIndex);

        // ── Press ──
        if (type === Clutter.EventType.TOUCH_BEGIN ||
            type === Clutter.EventType.BUTTON_PRESS) {
            let [x, y] = event.get_coords();
            s.active = true;
            s.claimed = false;
            s.startX = x;
            s.startY = y;
            s.touchCount = (s.touchCount || 0) + 1;

            let panelX = this._bar?.x ?? 0;
            let panelW = this._bar?.width ?? 1;
            s.side = (x - panelX) < panelW / 2 ? 'left' : 'right';

            return Clutter.EVENT_PROPAGATE;
        }

        // ── Motion ──
        if (type === Clutter.EventType.TOUCH_UPDATE ||
            type === Clutter.EventType.MOTION) {
            let [x, y] = event.get_coords();

            // Some touch drivers deliver MOTION without PRESS
            if (!s.active) {
                let panelY = this._bar?.y ?? 0;
                let panelH = this.height;
                if (y < panelY || y > panelY + panelH)
                    return Clutter.EVENT_PROPAGATE;

                s.active = true;
                s.claimed = false;
                s.startX = x;
                s.startY = y;
                let panelX = this._bar?.x ?? 0;
                let panelW = this._bar?.width ?? 1;
                s.side = (x - panelX) < panelW / 2 ? 'left' : 'right';
                return Clutter.EVENT_PROPAGATE;
            }

            let dx = x - s.startX;
            let dy = y - s.startY;

            if (!s.claimed) {
                let adx = Math.abs(dx);
                let ady = Math.abs(dy);
                let dist = Math.max(adx, ady);
                if (dist < STATUS_BAR_SWIPE_CLAIM_PX)
                    return Clutter.EVENT_PROPAGATE;

                // Determine direction: horizontal = brightness, vertical = panel
                if (adx > ady) {
                    s.claimed = true;
                    s.direction = 'horizontal';
                    s.brightnessStart = this._getBrightness();
                    if (s.brightnessStart < 0) {
                        s.active = false;
                        s.claimed = false;
                        return Clutter.EVENT_PROPAGATE;
                    }
                } else {
                    if (dy <= 0) {
                        s.active = false;
                        return Clutter.EVENT_PROPAGATE;
                    }
                    s.claimed = true;
                    s.direction = 'vertical';

                    // If notification panel is already open and collapsed,
                    // expand it (Android: second swipe-down expands)
                    if (np?.isOpen) {
                        if (!np._isExpanded && np._overflowItems?.length)
                            np._toggleExpand();
                        s.active = false;
                        s.claimed = false;
                        return Clutter.EVENT_STOP;
                    }

                    np?.progressiveOpenBegin(false, s.touchCount || 1);
                }
            }

            if (s.direction === 'horizontal') {
                // Map horizontal drag across panel width to 0-100% brightness
                let panelW = this._bar?.width ?? 1;
                let delta = (dx / panelW) * 100;
                this._setBrightness(s.brightnessStart + delta);
                return Clutter.EVENT_STOP;
            }

            // Vertical: panel bottom edge tracks the finger position exactly.
            let panelH = np?._progressivePanelH || np?._panel?.height || 300;
            let progress = Math.max(0, Math.min(1, dy / panelH));
            np?.progressiveOpenUpdate(progress);

            return Clutter.EVENT_STOP;
        }

        // ── Release ──
        if (type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.BUTTON_RELEASE) {
            if (!s.active) return Clutter.EVENT_PROPAGATE;

            let wasClaimed = s.claimed;
            let direction = s.direction;
            let [, y] = event.get_coords();
            let dy = y - s.startY;

            s.active = false;
            s.claimed = false;
            s.touchCount = 0;
            s.direction = null;

            if (wasClaimed && direction === 'horizontal') {
                // Brightness swipe done — nothing to finalize
                return Clutter.EVENT_STOP;
            }

            if (wasClaimed) {
                np?.progressiveOpenEnd(dy >= STATUS_BAR_SWIPE_COMMIT_PX);
                return Clutter.EVENT_STOP;
            }

            // Tap — toggle notification panel (collapsed)
            if (!wasClaimed && dy < STATUS_BAR_SWIPE_CLAIM_PX) {
                this._toggleNotificationPanel();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        // ── Cancel ──
        if (type === Clutter.EventType.TOUCH_CANCEL) {
            if (s.claimed) np?.progressiveOpenEnd(false);
            s.active = false;
            s.claimed = false;
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _toggleNotificationPanel() {
        let np = this._controller?.notificationPanel;
        if (np) {
            np.selectPhoneMonitor?.(this._getTargetMonitorIndex());
            if (np.isOpen)
                np.close();
            else
                np.open();
            return;
        }
        // Fallback to vanilla QS menu if convergence panel not available
        let menu = Main.panel?.statusArea?.quickSettings?.menu;
        if (!menu) return;
        if (menu.isOpen)
            menu.close?.(0);
        else
            menu.open?.(0);
    }

    _teardownSwipeGesture() {
        this._swipeState = null;

        if (this._gestureOverlay) {
            Main.layoutManager.removeChrome(this._gestureOverlay);
            this._gestureOverlay.destroy();
            this._gestureOverlay = null;
        }
    }

    // ── Brightness swipe ────────────────────────────────────────────

    _ensureBrightnessProxy() {
        if (this._brightnessProxy) return this._brightnessProxy;
        try {
            this._brightnessProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power',
                'org.gnome.SettingsDaemon.Power.Screen',
                null);
        } catch (_e) {
            this._brightnessProxy = null;
        }
        return this._brightnessProxy;
    }

    _getBrightness() {
        try {
            let proxy = this._ensureBrightnessProxy();
            if (!proxy) return -1;
            let v = proxy.get_cached_property('Brightness');
            return v ? v.unpack() : -1;
        } catch (_e) { return -1; }
    }

    _setBrightness(value) {
        try {
            let proxy = this._ensureBrightnessProxy();
            if (!proxy) return;
            let clamped = Math.max(0, Math.min(100, Math.round(value)));
            proxy.call_sync('org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', [
                    'org.gnome.SettingsDaemon.Power.Screen',
                    'Brightness',
                    new GLib.Variant('i', clamped),
                ]),
                Gio.DBusCallFlags.NONE, -1, null);
        } catch (_e) {}
    }

    // ── Panel corners ───────────────────────────────────────────────

    /** Create concave rounded corners at the bottom of the panel. */
    _createPanelCorners() {
        if (!this._bar) return;

        let radius = 0;
        try {
            radius = this._settings?.get_int('window-corner-radius') ?? 0;
        } catch (_e) {}
        if (radius <= 0) return;

        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let r = Math.round(radius * scale);
        let monitor = this._getTargetMonitor();
        if (!monitor) return;

        // Read panel background color for the corners
        let cornerColor = { r: 0, g: 0, b: 0, a: 0.92 };
        try {
            let node = this._bar.get_theme_node();
            if (node) {
                let bg = node.get_background_color();
                cornerColor = {
                    r: bg.red / 255,
                    g: bg.green / 255,
                    b: bg.blue / 255,
                    a: bg.alpha / 255,
                };
            }
        } catch (_e) {}

        // Add corners to uiGroup (same container as the notification
        // panel overlay).  The notification panel raises them above
        // its overlay each time it opens via _raiseOverlayAboveCorners.
        let uiGroup = Main.layoutManager.uiGroup;

        this._panelCornerLeft = new PanelCornerActor('left');
        this._panelCornerLeft.setCornerParams(r,
            cornerColor.r, cornerColor.g, cornerColor.b, cornerColor.a);
        uiGroup.add_child(this._panelCornerLeft);

        this._panelCornerRight = new PanelCornerActor('right');
        this._panelCornerRight.setCornerParams(r,
            cornerColor.r, cornerColor.g, cornerColor.b, cornerColor.a);
        uiGroup.add_child(this._panelCornerRight);
        this._positionPanelCorners();
    }

    _positionPanelCorners() {
        if (!this._panelCornerLeft && !this._panelCornerRight)
            return;

        let monitor = this._getTargetMonitor();
        if (!monitor)
            return;

        let radius = 0;
        try {
            radius = this._settings?.get_int('window-corner-radius') ?? 0;
        } catch (_e) {}
        if (radius <= 0)
            return;

        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let scaledRadius = Math.round(radius * scale);
        let panelH = this._bar?.height ?? this.height;

        this._panelCornerLeft?.set_position(monitor.x, monitor.y + panelH);
        this._panelCornerRight?.set_position(
            monitor.x + monitor.width - scaledRadius,
            monitor.y + panelH);
    }

    relayout() {
        let monitor = this._getTargetMonitor();
        if (this._bar && monitor) {
            this._bar.set_position(monitor.x, monitor.y);
            this._bar.set_size(monitor.width, this.height);
        }
        if (this._topStrut && monitor) {
            this._topStrut.set_position(monitor.x, monitor.y);
            this._topStrut.set_size(monitor.width, this.height);
        }
        this._applyBarStyle();
        this._positionGestureOverlay();
        this._positionPanelCorners();
    }

    /** Remove the panel corner actors. */
    _removePanelCorners() {
        for (let corner of [this._panelCornerLeft, this._panelCornerRight]) {
            if (!corner) continue;
            try {
                if (corner.get_parent())
                    corner.get_parent().remove_child(corner);
            } catch (_e) {}
            corner.destroy();
        }
        this._panelCornerLeft = null;
        this._panelCornerRight = null;
    }

    _destroyBar() {
        this._runtimeDisposer.clearConnectionRef(this, '_wallClockId', this._wallClock);
        this._wallClock = null;
        this._runtimeDisposer.clearConnectionRef(this, '_networkChangedId', this._networkMonitor);
        this._runtimeDisposer.clearConnectionRef(this, '_networkConnectivityId', this._networkMonitor);
        this._networkMonitor = null;
        this._nmClient = null;
        this._runtimeDisposer.clearConnectionRef(this, '_batteryProxyChangedId', this._batteryProxy);
        this._batteryProxy = null;
        this._runtimeDisposer.clearTimeoutRef(this, '_notifIconSyncTimeoutId');
        if (this._topStrut) {
            try { Main.layoutManager.removeChrome(this._topStrut); } catch (_e) {}
            this._topStrut.destroy();
            this._topStrut = null;
        }
        if (this._bar) {
            try { Main.layoutManager.removeChrome(this._bar); } catch (_e) {}
            this._bar.destroy();
            this._bar = null;
        }
        this._barContent = null;
        this._leftBox = null;
        this._rightBox = null;
        this._clockLabel = null;
        this._networkBox = null;
        this._networkTransportBox = null;
        this._networkTransportIcons = [];
        this._networkBluetoothIcon = null;
        this._networkVpnIcon = null;
        this._dndIcon = null;
        this._airplaneModeIcon = null;
        this._nightLightIcon = null;
        this._recordingIcon = null;
        this._caffeineIcon = null;
        this._powerModeIcon = null;
        this._batteryBox = null;
        this._batteryIcon = null;
        this._batteryLabel = null;
    }

    // ── Cleanup ──────────────────────────────────────────────────────

    destroy() {
        if (!this._active) return;
        this._active = false;

        this._removePanelCorners();
        this._teardownNotifIconTracking();
        this._removeNotifIconBox();
        this._teardownSwipeGesture();
        this._destroyBar();
        this._restorePrimaryPanel();

        this._controller = null;
        this._settings = null;
    }
}
