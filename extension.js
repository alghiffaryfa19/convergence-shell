// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

// ── Shared utilities ─────────────────────────────────────────────────
import { DisplayConfig, DisplayMode, HostType } from './src/shared/utilities/displayConfig.js';
import { Logger } from './src/shared/utilities/logger.js';
import { RuntimeDisposer } from './src/shared/utilities/runtimeDisposer.js';
import { SignalTracker } from './src/shared/utilities/signalTracker.js';

// ── Phone modules ────────────────────────────────────────────────────
import { GestureBar } from './src/phone/gesture_bar/gestureBar.js';
import { EdgeGestures } from './src/phone/edge_gestures/edgeGestures.js';
import { WindowStack } from './src/phone/window_manager/windowStack.js';
import { PhoneWorkspaces } from './src/phone/window_manager/workspaces.js';
import { AppDrawer } from './src/phone/app_drawer/appDrawer.js';
import { StatusBar } from './src/phone/status_bar/statusBar.js';
import { NotificationPanelManager } from './src/shared/notification_panel/notificationPanel.js';
import { RecentApps } from './src/phone/recent_apps/recentApps.js';
import { SplashScreen } from './src/phone/window_manager/splashScreen.js';
import { Haptics } from './src/phone/haptics/haptics.js';
import { ConvergenceKeyboard } from './src/phone/keyboard/keyboard.js';
import { VolumeOsd } from './src/phone/volume_osd/volumeOsd.js';
import { DrawerTests } from './src/phone/app_drawer/drawerTests.js';
import { BannerSwipeDismiss } from './src/shared/notification_panel/bannerSwipe.js';

// ── Desktop modules ──────────────────────────────────────────────────
import { Taskbar } from './src/desktop/taskbar/taskbar.js';
import { TaskbarIcons } from './src/desktop/taskbar/taskbarIcons.js';
import { TaskbarPreviews } from './src/desktop/taskbar/taskbarPreviews.js';
import { TaskbarAnimations } from './src/desktop/taskbar/taskbarAnimations.js';
import { AppMenu } from './src/desktop/app_menu/appMenu.js';
import { WindowEffects } from './src/desktop/window_manager/windowEffects.js';
import { DesktopWorkspaces } from './src/desktop/workspaces/workspaces.js';
import { DesktopTray } from './src/desktop/tray_area/desktopTray.js';
import { DesktopNotifIcons } from './src/desktop/tray_area/desktopNotifIcons.js';

// ── Shared UI modules ────────────────────────────────────────────────
import { HomeScreen } from './src/shared/home_screen/homeScreen.js';
import { TrayManager } from './src/shared/tray_area/trayManager.js';

// ── Device-specific modules ──────────────────────────────────────────
import { AlertSlider } from './src/device_specific/alertSlider.js';
import { AutoRotate } from './src/device_specific/autoRotate.js';
import { AutoBrightness } from './src/device_specific/autoBrightness.js';
import { CallProximity } from './src/device_specific/callProximity.js';


// ═══════════════════════════════════════════════════════════════════════
// Quick Settings toggle — allows enabling/disabling Convergence from
// the GNOME Quick Settings panel.
// ═══════════════════════════════════════════════════════════════════════

const ConvergenceToggle = GObject.registerClass(
class ConvergenceToggle extends QuickToggle {
    _init() {
        super._init({
            title: 'Convergence',
            iconName: 'phone-symbolic',
            toggleMode: true,
        });
    }
});

const ConvergenceIndicator = GObject.registerClass(
class ConvergenceIndicator extends SystemIndicator {
    _init(extensionObj) {
        super._init();
        this._extensionObj = extensionObj;
        this._toggle = new ConvergenceToggle();
        this._toggle.checked = true;
        this._toggle.connect('clicked', () => {
            if (this._toggle.checked)
                this._extensionObj._setupUI();
            else
                this._extensionObj._teardownUI();
        });
        this.quickSettingsItems.push(this._toggle);
    }
});


// ═══════════════════════════════════════════════════════════════════════
// Bluetooth power indicator — shows bluetooth icon in panel when any
// adapter is powered on.
// ═══════════════════════════════════════════════════════════════════════

const BLUEZ_NAME = 'org.bluez';
const BLUEZ_ROOT_PATH = '/';
const BLUEZ_ADAPTER_IFACE = 'org.bluez.Adapter1';

const BluetoothPowerIndicator = GObject.registerClass(
class BluetoothPowerIndicator extends SystemIndicator {
    _init() {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'bluetooth-active-symbolic';
        this._indicator.visible = false;
        this.visible = false;

        this._bluezManager = null;
        this._adapterSignalIds = [];
        this._managerSignalIds = [];
        this._nameWatchId = Gio.bus_watch_name(
            Gio.BusType.SYSTEM,
            BLUEZ_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._connectBluezManager(),
            () => this._disconnectBluezManager()
        );
    }

    _connectBluezManager() {
        if (this._bluezManager)
            return;

        try {
            this._bluezManager = Gio.DBusObjectManagerClient.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
                BLUEZ_NAME,
                BLUEZ_ROOT_PATH,
                null,
                null
            );
        } catch (_e) {
            this._bluezManager = null;
            this._setVisible(false);
            return;
        }

        this._managerSignalIds.push(
            this._bluezManager.connect('object-added', () => this._rebuildAdapterSignals()),
            this._bluezManager.connect('object-removed', () => this._rebuildAdapterSignals()),
            this._bluezManager.connect('interface-added', () => this._rebuildAdapterSignals()),
            this._bluezManager.connect('interface-removed', () => this._rebuildAdapterSignals())
        );

        this._rebuildAdapterSignals();
    }

    _disconnectBluezManager() {
        this._disconnectAdapterSignals();
        if (this._bluezManager) {
            for (let id of this._managerSignalIds) {
                try {
                    this._bluezManager.disconnect(id);
                } catch (_e) {}
            }
        }
        this._managerSignalIds = [];
        this._bluezManager = null;
        this._setVisible(false);
    }

    _disconnectAdapterSignals() {
        for (let [proxy, id] of this._adapterSignalIds) {
            try {
                proxy.disconnect(id);
            } catch (_e) {}
        }
        this._adapterSignalIds = [];
    }

    _rebuildAdapterSignals() {
        this._disconnectAdapterSignals();

        for (let proxy of this._getAdapterProxies()) {
            let id = proxy.connect('g-properties-changed', () => this._syncState());
            this._adapterSignalIds.push([proxy, id]);
        }

        this._syncState();
    }

    _getAdapterProxies() {
        if (!this._bluezManager)
            return [];

        let proxies = [];
        for (let obj of this._bluezManager.get_objects()) {
            let proxy = obj.get_interface(BLUEZ_ADAPTER_IFACE);
            if (proxy)
                proxies.push(proxy);
        }
        return proxies;
    }

    _syncState() {
        let visible = false;
        for (let proxy of this._getAdapterProxies()) {
            let powered = proxy.get_cached_property('Powered');
            if (powered?.unpack?.()) {
                visible = true;
                break;
            }
        }
        this._setVisible(visible);
    }

    _setVisible(visible) {
        this._indicator.visible = visible;
        this.visible = visible;
    }

    destroy() {
        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }

        this._disconnectBluezManager();
        this._indicator = null;
        super.destroy();
    }
});


// ═══════════════════════════════════════════════════════════════════════
// Debug D-Bus service — allows taking screenshots from SSH for testing.
// Call via: gdbus call --session --dest org.gnome.Shell \
//   --object-path /com/convergence/Debug \
//   --method com.convergence.Debug.Screenshot "/tmp/screenshot.png"
// ═══════════════════════════════════════════════════════════════════════

const DebugDbusIface = `
<node>
  <interface name="com.convergence.Debug">
    <method name="Screenshot">
      <arg type="s" direction="in" name="path"/>
      <arg type="b" direction="out" name="success"/>
    </method>
    <method name="Eval">
      <arg type="s" direction="in" name="code"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

class ConvergenceDebugService {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DebugDbusIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/com/convergence/Debug');
    }

    ScreenshotAsync(params, invocation) {
        let [path] = params;
        try {
            let file = Gio.File.new_for_path(path);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let screenshot = new Shell.Screenshot();
            screenshot.screenshot(false, stream, (obj, result) => {
                try {
                    obj.screenshot_finish(result);
                    stream.close(null);
                    invocation.return_value(new GLib.Variant('(b)', [true]));
                } catch (e) {
                    try { stream.close(null); } catch (_) {}
                    invocation.return_value(new GLib.Variant('(b)', [false]));
                }
            });
        } catch (_e) {
            invocation.return_value(new GLib.Variant('(b)', [false]));
        }
    }

    EvalAsync(params, invocation) {
        let [code] = params;
        try {
            let result = Function('Main', 'global', code)(Main, global);
            invocation.return_value(new GLib.Variant('(s)', [String(result)]));
        } catch (e) {
            invocation.return_value(new GLib.Variant('(s)', [`ERROR: ${e.message}`]));
        }
    }

    destroy() {
        try { this._dbusImpl.unexport(); } catch (_e) {}
    }
}

const MonitorRole = Object.freeze({
    PHONE: 'phone',
    DESKTOP: 'desktop',
    UNKNOWN: 'unknown',
});

class MonitorRoleManager {
    constructor(displayConfig) {
        this._displayConfig = displayConfig;
        this.refresh();
    }

    refresh() {
        let snapshots = this._displayConfig?.getMonitorSnapshots?.() ?? [];
        this._roles = new Map();
        this._phoneMonitorIndex = -1;
        this._phoneMonitorIndices = [];
        this._desktopMonitorIndices = [];
        this._primaryDesktopMonitorIndex = -1;
        this._primaryPhoneMonitorIndex = -1;
        this._builtinPhoneMonitorIndex = -1;

        for (let snapshot of snapshots) {
            let role = this._resolveRole(snapshot);
            this._roles.set(snapshot.index, role);

            if (role === MonitorRole.PHONE) {
                this._phoneMonitorIndices.push(snapshot.index);
                if (snapshot.isPrimary)
                    this._primaryPhoneMonitorIndex = snapshot.index;
                if (snapshot.isBuiltin && this._builtinPhoneMonitorIndex < 0)
                    this._builtinPhoneMonitorIndex = snapshot.index;
            } else if (role === MonitorRole.DESKTOP) {
                this._desktopMonitorIndices.push(snapshot.index);
                if (snapshot.isPrimary)
                    this._primaryDesktopMonitorIndex = snapshot.index;
            }
        }

        if (this._builtinPhoneMonitorIndex >= 0)
            this._phoneMonitorIndex = this._builtinPhoneMonitorIndex;
        if (this._phoneMonitorIndex < 0)
            this._phoneMonitorIndex = this._primaryPhoneMonitorIndex;
        if (this._phoneMonitorIndex < 0 && this._phoneMonitorIndices.length > 0)
            this._phoneMonitorIndex = this._phoneMonitorIndices[0];

        if (this._primaryDesktopMonitorIndex < 0 && this._desktopMonitorIndices.length > 0)
            this._primaryDesktopMonitorIndex = this._desktopMonitorIndices[0];

        this._signature = snapshots.map(snapshot =>
            `${snapshot.index}:${this.getMonitorRole(snapshot.index)}:${snapshot.mode}:${snapshot.isPrimary ? 1 : 0}`
        ).join('|');
    }

    _resolveRole(snapshot) {
        switch (snapshot?.mode) {
            case DisplayMode.PHONE:
            case DisplayMode.TABLET:
                return MonitorRole.PHONE;
            case DisplayMode.DESKTOP:
            case DisplayMode.TV:
                return MonitorRole.DESKTOP;
            default:
                return MonitorRole.UNKNOWN;
        }
    }

    get signature() {
        return this._signature ?? '';
    }

    get hasPhoneRole() {
        return this._phoneMonitorIndices.length > 0;
    }

    get hasDesktopRole() {
        return this._desktopMonitorIndices.length > 0;
    }

    get isMixedMode() {
        return this.hasPhoneRole && this.hasDesktopRole;
    }

    get phoneMonitorIndex() {
        return this._phoneMonitorIndex;
    }

    get primaryPhoneMonitorIndex() {
        return this._primaryPhoneMonitorIndex;
    }

    get phoneMonitorIndices() {
        return [...this._phoneMonitorIndices];
    }

    get primaryDesktopMonitorIndex() {
        return this._primaryDesktopMonitorIndex;
    }

    get desktopMonitorIndices() {
        return [...this._desktopMonitorIndices];
    }

    getMonitorRole(monitorIndex) {
        return this._roles.get(monitorIndex) ?? MonitorRole.UNKNOWN;
    }

    shouldSuppressOverview() {
        return this.hasPhoneRole && !this.hasDesktopRole;
    }
}


// ═══════════════════════════════════════════════════════════════════════
// Main extension entry point
// ═══════════════════════════════════════════════════════════════════════

export default class ConvergenceExtension extends Extension {

    // ── Device detection (thin helpers for module loading decisions) ──

    _readDeviceModelString() {
        let envModel = GLib.getenv('CONVERGENCE_DEVICE_MODEL');
        if (envModel && envModel.trim().length > 0)
            return envModel.trim();

        let modelPaths = [
            '/proc/device-tree/model',
            '/sys/firmware/devicetree/base/model',
            '/sys/class/dmi/id/product_name',
            '/sys/class/dmi/id/board_name',
        ];
        for (let path of modelPaths) {
            try {
                let [ok, bytes] = GLib.file_get_contents(path);
                if (!ok || !bytes)
                    continue;
                let text = new TextDecoder('utf-8').decode(bytes).replace(/\u0000/g, '').trim();
                if (text.length > 0)
                    return text;
            } catch (_e) {}
        }
        return '';
    }

    _isOnePlus6Device() {
        if (this._isOnePlus6Cached !== undefined)
            return this._isOnePlus6Cached;

        let model = this._readDeviceModelString().toLowerCase();
        let isOnePlus = model.includes('oneplus') || model.includes('one plus');
        let isSix = model.includes('oneplus 6') ||
            model.includes('oneplus6') ||
            model.includes('a600') ||
            model.includes('enchilada');
        this._isOnePlus6Cached = isOnePlus && isSix;
        return this._isOnePlus6Cached;
    }

    _isFLX1Device() {
        if (this._isFLX1Cached !== undefined)
            return this._isFLX1Cached;

        let model = this._readDeviceModelString().toLowerCase();
        if (model.includes('flx1') || model.includes('furiphone')) {
            this._isFLX1Cached = true;
            return true;
        }
        try {
            let [ok, bytes] = GLib.file_get_contents('/sys/firmware/devicetree/base/compatible');
            if (ok && bytes) {
                let compat = new TextDecoder('utf-8').decode(bytes).toLowerCase();
                this._isFLX1Cached = compat.includes('furilabs,flx1');
                return this._isFLX1Cached;
            }
        } catch (_) {}
        this._isFLX1Cached = false;
        return false;
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    enable() {
        this._settings = this.getSettings();
        this._settingsSignals = new SignalTracker();
        this._runtimeDisposer = new RuntimeDisposer();
        this._logger = new Logger('Convergence');
        this._isOnePlus6Cached = undefined;
        this._isFLX1Cached = undefined;

        // Quick Settings toggle (opt-in via env var)
        this._setupQuickSettingsToggle();

        // Bluetooth panel indicator
        this._setupBluetoothIndicator();

        // Debug D-Bus service (screenshot support for testing)
        this._debugService = new ConvergenceDebugService();

        this._setupUI();
    }

    disable() {
        this._teardownUI();

        // Destroy Quick Settings toggle
        if (this._indicator) {
            let items = [];
            try {
                items = [...(this._indicator.quickSettingsItems ?? [])];
            } catch (_e) {}
            for (let item of items) {
                try { item.destroy(); } catch (_e) {}
            }
            try { this._indicator.destroy(); } catch (_e) {}
            this._indicator = null;
        }

        // Destroy Bluetooth indicator
        if (this._bluetoothIndicator) {
            try { this._bluetoothIndicator.destroy(); } catch (_e) {}
            this._bluetoothIndicator = null;
        }

        // Destroy debug D-Bus service
        if (this._debugService) {
            this._debugService.destroy();
            this._debugService = null;
        }

        this._settingsSignals = null;
        this._runtimeDisposer = null;
        this._logger = null;
        this._settings = null;
    }

    // ── Quick Settings toggle setup ──────────────────────────────────

    _setupQuickSettingsToggle() {
        let enableQsIndicator = /^(1|true|yes|on)$/i.test(
            (GLib.getenv('CONVERGENCE_QS_INDICATOR') ?? '').trim());
        if (!enableQsIndicator)
            return;

        let qs = Main.panel?.statusArea?.quickSettings;
        let qsGridReady = !!(qs?.menu?._grid?.layout_manager);
        if (!qs || typeof qs.addExternalIndicator !== 'function') {
            this._logger.warn('Quick Settings API unavailable; skipping indicator.');
            return;
        }
        if (!qsGridReady) {
            this._logger.warn('Quick Settings grid unavailable; skipping indicator.');
            return;
        }

        try {
            this._indicator = new ConvergenceIndicator(this);
            qs.addExternalIndicator(this._indicator);
        } catch (e) {
            this._logger.warn('Failed to add Quick Settings indicator.', e);
            if (this._indicator) {
                try { this._indicator.destroy(); } catch (_e) {}
                this._indicator = null;
            }
        }
    }

    _setupBluetoothIndicator() {
        let qs = Main.panel?.statusArea?.quickSettings;
        if (!qs || typeof qs.addExternalIndicator !== 'function') {
            this._logger.warn('Quick Settings API unavailable; skipping Bluetooth indicator.');
            return;
        }

        try {
            this._bluetoothIndicator = new BluetoothPowerIndicator();
            qs.addExternalIndicator(this._bluetoothIndicator);
        } catch (e) {
            this._logger.warn('Failed to add Bluetooth panel indicator.', e);
            if (this._bluetoothIndicator) {
                try { this._bluetoothIndicator.destroy(); } catch (_e) {}
                this._bluetoothIndicator = null;
            }
        }
    }

    // ── UI setup (called from enable() and from the QS toggle) ───────

    _setupUI() {
        if (this._controller) return; // idempotent guard

        // Detect host device and classify connected monitors
        this._displayConfig = new DisplayConfig(this._settings);
        this._monitorRoles = new MonitorRoleManager(this._displayConfig);
        let topology = this._getTopologyState(this._monitorRoles);

        log(`[Convergence] Setup: mode=${topology.primaryMode} host=${topology.hostType} small=${topology.isSmallDisplay} phoneRole=${topology.hasPhoneRole} desktopRole=${topology.hasDesktopRole}`);

        // ── Overview suppression (phone mode) ────────────────────────
        if (topology.shouldSuppressOverview && topology.isSmallDisplay)
            this._syncOverviewSuppression(true);

        // ── Suppress overview at startup ─────────────────────────────
        this._suppressOverviewAtStartup();

        // ── Hide vanilla GNOME dash ──────────────────────────────────
        this._hideDash();

        // ── Disable GNOME Mobile's built-in phone mode (we handle it) ─
        if ('forceInvertIsPhone' in Main.layoutManager &&
            Main.layoutManager.is_phone) {
            this._didInvertIsPhone = true;
            Main.layoutManager.forceInvertIsPhone = true;
        }

        // ── Hide GNOME Mobile bottom panel pill (we have our own) ────
        if (Main.layoutManager.inhibitShowBottomPanel)
            Main.layoutManager.inhibitShowBottomPanel();
        if (Main.layoutManager.bottomPanelBox) {
            this._bottomPanelWasVisible = Main.layoutManager.bottomPanelBox.visible;
            Main.layoutManager.bottomPanelBox.visible = false;
        }

        // ── Override overlay key (Super) ─────────────────────────────
        this._overrideOverlayKey();

        // ── Build controller object (wires modules together) ─────────
        this._controller = this._buildController();

        // ── Shared tray manager (both modes) ────────────────────────
        this._trayManager = new TrayManager();
        this._trayManager.enable();

        // ── Notification panels (shared, multi-instance) ────────────
        this._notificationPanel = new NotificationPanelManager(
            this._controller, this._settings, this._trayManager);

        // ── Instantiate monitor-role modules ─────────────────────────
        if (topology.hasPhoneRole) {
            log(`[Convergence] Setting up PHONE modules`);
            this._setupPhoneModules();
        }
        if (topology.hasDesktopRole) {
            log(`[Convergence] Setting up DESKTOP modules`);
            this._setupDesktopModules();
            if (topology.hostType === HostType.PHONE || topology.hostType === HostType.TABLET) {
                this._promoteDesktopToPrimary(this._monitorRoles.primaryDesktopMonitorIndex);
                this._restoreGnomePanelForDesktop();
                this._applyDesktopPanelLayout();
                this._enableConvergencePowerButton();
            }
        }

        // ── Home surfaces (per role) ─────────────────────────────────
        this._setupHomeSurfaces();

        // ── Device-specific modules ──────────────────────────────────
        this._syncPhoneHostModules(topology.hostType);
        this._syncDeviceSpecificModules(topology.hostType);

        // ── Overview / workspace signals ─────────────────────────────
        this._connectOverviewSignals();
        this._connectSessionModeSignals();

        // ── Monitor change relayout ──────────────────────────────────
        this._runtimeDisposer.connect(
            Main.layoutManager, 'monitors-changed', () => this._onMonitorsChangedRelayout());

        // ── Dynamic mode switching (display config listener) ─────────
        this._modeChangeDebounceId = 0;
        this._appliedTopology = topology;
        this._runtimeDisposer.connect(this._displayConfig, 'changed', () => {
            this._onDisplayConfigChanged();
        });

        // ── Settings-driven tray/notification panel refresh ───────────
        try {
            this._runtimeDisposer.connect(this._settings, 'changed::desktop-tray-location', () => {
                this._refreshTrayAndNotifPanelSettings({ trayLocationChanged: true });
            });
        } catch (_e) {}
        try {
            this._runtimeDisposer.connect(this._settings, 'changed::desktop-notification-panel-enabled', () => {
                this._refreshTrayAndNotifPanelSettings({ desktopNotifChanged: true });
            });
        } catch (_e) {}

        // ── Show and relayout home screen ────────────────────────────
        if (this._phoneHomeScreen && !this._phoneHomeScreen._visible)
            this._phoneHomeScreen.show();
        for (let entry of this._phoneHomeMirrors ?? []) {
            if (entry.homeScreen && !entry.homeScreen._visible)
                entry.homeScreen.show();
        }
        if (this._desktopHomeScreen && !this._desktopHomeScreen._visible)
            this._desktopHomeScreen.show();
        for (let entry of this._desktopHomeMirrors ?? []) {
            if (entry.homeScreen && !entry.homeScreen._visible)
                entry.homeScreen.show();
        }
        this._relayout();

        this._displayConfig.logConvergenceReport?.('setup');
    }

    _onDisplayConfigChanged() {
        let newRoles = new MonitorRoleManager(this._displayConfig);
        let topology = this._getTopologyState(newRoles);
        if (!topology.primaryMode)
            return;
        if (topology.key === this._appliedTopology?.key)
            return;

        log(`[Convergence] Display topology change detected: ${this._appliedTopology?.key ?? 'none'} → ${topology.key}`);

        // Debounce — GNOME fires monitors-changed multiple times during
        // resolution/scaling transitions.
        this._runtimeDisposer.restartTimeout(
            this, '_modeChangeDebounceId',
            GLib.PRIORITY_DEFAULT, 300, () => {
                this._modeChangeDebounceId = 0;
                this._performModeSwitch();
                return GLib.SOURCE_REMOVE;
            });
    }

    _onMonitorsChangedRelayout() {
        // Re-enforce overview suppression — GNOME resets
        // sessionMode.hasOverview during display-config changes even
        // when the topology (phone/desktop role) hasn't changed.
        if (this._overviewSuppressed)
            this._enforceOverviewHidden();

        let topology = null;
        try {
            let roles = new MonitorRoleManager(this._displayConfig);
            topology = this._getTopologyState(roles);
        } catch (_e) {}

        if (topology?.primaryMode && topology.key !== this._appliedTopology?.key)
            return;

        this._relayout();

        // Mutter may reset primary to the built-in display when it
        // encounters an external monitor with no monitors.xml entry.
        // Re-promote the desktop monitor if it lost primary status.
        this._ensureDesktopPrimary();
    }

    _ensureDesktopPrimary() {
        let roles = this._monitorRoles;
        if (!roles?.hasDesktopRole)
            return;
        let hostType = this._displayConfig?.hostType;
        if (hostType !== HostType.PHONE && hostType !== HostType.TABLET)
            return;
        let desktopIdx = roles.primaryDesktopMonitorIndex;
        if (desktopIdx >= 0 && desktopIdx !== Main.layoutManager.primaryIndex)
            this._promoteDesktopToPrimary(desktopIdx);
    }

    _performModeSwitch() {
        let newRoles = new MonitorRoleManager(this._displayConfig);
        let topology = this._getTopologyState(newRoles);
        if (!topology.primaryMode)
            return;
        if (topology.key === this._appliedTopology?.key)
            return;

        if (this._tryIncrementalTopologySync(topology, newRoles)) {
            this._appliedTopology = topology;
            // Delayed relayout to catch components that read stale
            // monitor dimensions during the initial topology sync
            // (e.g. notification panel after screen rotation).
            this._runtimeDisposer.restartTimeout(
                this, '_postSwitchRelayoutId',
                GLib.PRIORITY_DEFAULT, 500, () => {
                    this._postSwitchRelayoutId = 0;
                    this._relayout();
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }

        log(`[Convergence] Performing topology switch: ${this._appliedTopology?.key ?? 'none'} → ${topology.key}`);
        this._teardownUI();
        this._setupUI();
    }

    _tryIncrementalTopologySync(topology, newRoles) {
        if (!this._controller || !this._monitorRoles)
            return false;

        let oldRoles = this._monitorRoles;
        let oldHasPhoneRole = oldRoles.hasPhoneRole;
        let oldHasDesktopRole = oldRoles.hasDesktopRole;
        let newHasPhoneRole = topology.hasPhoneRole;
        let newHasDesktopRole = topology.hasDesktopRole;

        let oldHostType = this._appliedTopology?.hostType ?? this._displayConfig?.hostType;
        if (!oldHostType)
            return false;

        let oldPhoneMonitorIndex = oldRoles.phoneMonitorIndex;
        let newPhoneMonitorIndex = newRoles.phoneMonitorIndex;
        let oldPhoneMonitorIndices = oldRoles.phoneMonitorIndices ?? [];
        let newPhoneMonitorIndices = newRoles.phoneMonitorIndices ?? [];
        let oldPrimaryDesktopMonitorIndex = oldRoles.primaryDesktopMonitorIndex;
        let newPrimaryDesktopMonitorIndex = newRoles.primaryDesktopMonitorIndex;
        let oldDesktopMonitorIndices = oldRoles.desktopMonitorIndices ?? [];
        let newDesktopMonitorIndices = newRoles.desktopMonitorIndices ?? [];
        let addedPhoneRole = !oldHasPhoneRole && newHasPhoneRole;
        let removedPhoneRole = oldHasPhoneRole && !newHasPhoneRole;
        let addedDesktopRole = !oldHasDesktopRole && newHasDesktopRole;
        let removedDesktopRole = oldHasDesktopRole && !newHasDesktopRole;
        let phoneMonitorChanged = newHasPhoneRole && oldPhoneMonitorIndex !== newPhoneMonitorIndex;
        let desktopAnchorChanged = newHasDesktopRole &&
            oldPrimaryDesktopMonitorIndex !== newPrimaryDesktopMonitorIndex;
        let desktopMonitorSetChanged =
            oldDesktopMonitorIndices.length !== newDesktopMonitorIndices.length ||
            oldDesktopMonitorIndices.some((monitorIndex, index) => monitorIndex !== newDesktopMonitorIndices[index]);
        let phoneMonitorSetChanged =
            oldPhoneMonitorIndices.length !== newPhoneMonitorIndices.length ||
            oldPhoneMonitorIndices.some((monitorIndex, index) => monitorIndex !== newPhoneMonitorIndices[index]);
        let removedPhoneMonitorIndices = oldPhoneMonitorIndices.filter(
            monitorIndex => !newPhoneMonitorIndices.includes(monitorIndex));
        let shouldRebuildPhoneModules = false;

        if (newHasPhoneRole && removedPhoneMonitorIndices.length > 0) {
            this._windowStack?.migrateRecords?.(removedPhoneMonitorIndices, newPhoneMonitorIndex);
            if (removedPhoneMonitorIndices.includes(this._pendingPhoneLaunchMonitorIndex))
                this._pendingPhoneLaunchMonitorIndex = newPhoneMonitorIndex;
        }

        this._monitorRoles = newRoles;

        if (addedPhoneRole) {
            this._setupPhoneModules();
            this._syncPhoneHostModules(topology.hostType);
        } else if (removedPhoneRole) {
            this._teardownPhoneModules();
        } else if (shouldRebuildPhoneModules) {
            this._teardownPhoneModules();
            this._setupPhoneModules();
            this._syncPhoneHostModules(topology.hostType);
        } else if (phoneMonitorChanged) {
            this._retargetPhoneModules(newPhoneMonitorIndex);
        } else if (phoneMonitorSetChanged) {
            this._edgeGestures?.relayout?.();
        }

        if (addedDesktopRole) {
            this._setupDesktopModules();
            if (topology.hostType === HostType.PHONE || topology.hostType === HostType.TABLET) {
                this._promoteDesktopToPrimary(newPrimaryDesktopMonitorIndex);
                this._restoreGnomePanelForDesktop();
                this._applyDesktopPanelLayout();
                this._enableConvergencePowerButton();
            }
        } else if (removedDesktopRole) {
            this._disableConvergencePowerButton();
            this._revertDesktopPanelLayout();
            this._teardownDesktopModules();
        } else if (desktopAnchorChanged || desktopMonitorSetChanged) {
            this._refreshDesktopModulesForTopology();
            if (topology.hostType === HostType.PHONE || topology.hostType === HostType.TABLET)
                this._promoteDesktopToPrimary(newPrimaryDesktopMonitorIndex);
        }

        if (newHasPhoneRole)
            this._syncPhoneAuxiliaryInteractiveSurfaces(newPhoneMonitorIndices, newPhoneMonitorIndex);

        if (newHasPhoneRole && !addedPhoneRole &&
            oldHostType !== topology.hostType && !shouldRebuildPhoneModules) {
            this._syncPhoneHostModules(topology.hostType);
        }

        if (oldHostType !== topology.hostType)
            this._syncDeviceSpecificModules(topology.hostType);

        let phoneTopologyChanged = addedPhoneRole || removedPhoneRole ||
            phoneMonitorChanged || shouldRebuildPhoneModules;
        let phoneGeometryHandledInRefresh = phoneMonitorChanged && !addedPhoneRole &&
            !removedPhoneRole && !shouldRebuildPhoneModules;
        let desktopTopologyChanged = addedDesktopRole || removedDesktopRole ||
            desktopAnchorChanged || desktopMonitorSetChanged;
        let phoneHomeTopologyChanged = addedPhoneRole || removedPhoneRole ||
            phoneMonitorChanged || phoneMonitorSetChanged;
        let desktopHomeTopologyChanged = addedDesktopRole || removedDesktopRole ||
            desktopAnchorChanged || desktopMonitorSetChanged;
        let homeTopologyChanged = phoneHomeTopologyChanged || desktopHomeTopologyChanged;
        let notificationTopologyChanged = addedPhoneRole || removedPhoneRole ||
            addedDesktopRole || removedDesktopRole ||
            phoneMonitorChanged || desktopAnchorChanged ||
            desktopMonitorSetChanged;
        let notificationGeometryHandledInRefresh = notificationTopologyChanged;
        let overviewSuppressionChanged =
            this._shouldSuppressOverviewForRoles(oldRoles) !==
            this._shouldSuppressOverviewForRoles(newRoles);

        if (homeTopologyChanged)
            this._refreshHomeSurfacesForTopology(oldRoles, newRoles);
        if (overviewSuppressionChanged)
            this._syncOverviewSuppression(this._shouldSuppressOverviewForRoles(newRoles));
        if (notificationTopologyChanged)
            this._notificationPanel?.refreshTopology?.();
        this._relayoutAfterIncrementalSync({
            phoneChanged: phoneTopologyChanged,
            phoneGeometryHandledInRefresh,
            desktopChanged: desktopTopologyChanged,
            phoneHomesChanged: phoneHomeTopologyChanged,
            desktopHomesChanged: desktopHomeTopologyChanged,
            notificationChanged: notificationTopologyChanged,
            notificationGeometryHandledInRefresh,
        });
        this._displayConfig?.logConvergenceReport?.('incremental-sync');
        return true;
    }

    _retargetPhoneModules(phoneMonitorIndex) {
        this._windowStack?.setMonitorIndex?.(phoneMonitorIndex);
        this._gestureBar?.refreshTopology?.(phoneMonitorIndex);
        this._edgeGestures?.relayout?.();
        this._phoneWorkspaces?.refreshTopology?.(phoneMonitorIndex);
        this._appDrawer?.refreshTopology?.(phoneMonitorIndex);
        this._statusBar?.refreshTopology?.(phoneMonitorIndex);
        this._recentApps?.refreshTopology?.(phoneMonitorIndex);
        this._notificationPanel?.selectPhoneMonitor?.(phoneMonitorIndex);
    }

    _refreshDesktopModulesForTopology() {
        this._taskbar?.refreshTopology?.();
        this._desktopWorkspaces?.refreshTopology?.();
        if (this._appMenu?.isExpanded)
            this._appMenu.expand(this._monitorRoles?.primaryDesktopMonitorIndex ?? Main.layoutManager.primaryIndex);
    }

    _refreshTrayAndNotifPanelSettings({
        trayLocationChanged = false,
        desktopNotifChanged = false,
    } = {}) {
        let trayLocation = 'top-panel';
        try { trayLocation = this._settings.get_string('desktop-tray-location'); } catch (_e) {}
        let hasDesktopRole = this._monitorRoles?.hasDesktopRole ?? false;
        let shouldHaveTopPanelTray = hasDesktopRole &&
            (trayLocation === 'top-panel' || trayLocation === 'both');

        if (trayLocationChanged) {
            if (!shouldHaveTopPanelTray && this._desktopTray) {
                this._desktopTray.destroy();
                this._desktopTray = null;
            } else if (shouldHaveTopPanelTray && !this._desktopTray) {
                this._desktopTray = new DesktopTray(this._settings, this._trayManager);
            }
        }

        if (desktopNotifChanged || trayLocationChanged)
            this._notificationPanel?.refreshSettings?.();
    }

    _setupPhoneModules() {
        // Window stack (workspace-free window management)
        let phoneMonitorIndex = this._monitorRoles?.phoneMonitorIndex ?? Main.layoutManager.primaryIndex;

        this._windowStack = new WindowStack(this._controller, {
            monitorIndex: phoneMonitorIndex,
        });
        this._windowStack._onActiveChanged = (_activeWindow, isHome, monitorIndex = null) => {
            this._onPhoneStackActiveChanged(_activeWindow, isHome, monitorIndex);
        };

        // Gesture bar (bottom swipe handle)
        this._gestureBar = new GestureBar(this._controller, this._settings, {
            monitorIndex: phoneMonitorIndex,
        });
        this._gestureBar.showBar?.();

        // Edge gestures (left/right edge swipes)
        let edgeEnabled = true;
        try { edgeEnabled = this._settings?.get_boolean('edge-back-gesture-enabled') ?? true; } catch (_e) {}
        if (edgeEnabled)
            this._edgeGestures = new EdgeGestures(this._controller);

        // Phone workspaces
        this._phoneWorkspaces = new PhoneWorkspaces(this._controller, this._settings, {
            monitorIndex: phoneMonitorIndex,
        });

        // App drawer
        this._appDrawer = new AppDrawer(this._controller, this._settings, {
            monitorIndex: phoneMonitorIndex,
        });

        // Drawer test runner (activated via /tmp/convergence-drawer-cmd)
        try {
            this._drawerTests = new DrawerTests(
                this._appDrawer, this._controller, this._settings);
        } catch (_e) {}

        // Hide the Activities/workspace indicator on phone-sized displays
        // — it's not relevant when the phone stack manages windows.
        this._activitiesBtn = Main.panel?.statusArea?.activities;
        if (this._activitiesBtn?.container)
            this._activitiesBtn.container.hide();

        // Status bar
        this._statusBar = new StatusBar(this._controller, this._settings, {
            monitorIndex: this._monitorRoles?.phoneMonitorIndex ?? Main.layoutManager.primaryIndex,
        });

        // Recent apps view
        this._recentApps = new RecentApps(this._controller, {
            monitorIndex: phoneMonitorIndex,
        });

        this._syncPhoneAuxiliaryInteractiveSurfaces(
            this._monitorRoles?.phoneMonitorIndices ?? [],
            phoneMonitorIndex);

        // Swipe-to-dismiss for notification banners
        this._bannerSwipe = new BannerSwipeDismiss();

        // Splash screen (app launch feedback)
        this._splashScreen = new SplashScreen(this._controller);

        // Volume OSD (Android-style vertical slider, replaces GNOME OSD on phone)
        try {
            this._volumeOsd = new VolumeOsd(this._controller, this._settings);
        } catch (_e) {
            this._volumeOsd = null;
        }

        // Convergence keyboard (patches GNOME OSK)
        try {
            this._convergenceKeyboard = new ConvergenceKeyboard(this._controller, this._settings, this.path);
        } catch (_e) {
            this._convergenceKeyboard = null;
        }
    }

    _syncPhoneHostModules(hostType) {
        let shouldEnableHaptics = hostType === HostType.PHONE || hostType === HostType.TABLET;

        if (this._haptics) {
            this._haptics.destroy();
            this._haptics = null;
        }

        if (!shouldEnableHaptics)
            return;

        try {
            this._haptics = new Haptics(this._settings);
        } catch (_e) {
            this._haptics = null;
        }
    }

    _setupDesktopModules() {
        // Taskbar and related components
        this._taskbar = new Taskbar(this._controller, this._settings);
        this._taskbarIcons = new TaskbarIcons(this._taskbar, this._controller, this._settings);
        this._taskbarPreviews = new TaskbarPreviews(this._taskbar, this._settings);
        this._taskbarAnimations = new TaskbarAnimations(this._taskbar, this._controller, this._settings);

        // Application menu
        this._appMenu = new AppMenu(this._controller, this._settings);

        // Window effects (rounded corners, minimize-to-icon, etc.)
        this._windowEffects = new WindowEffects(this._controller, this._settings);
        this._windowEffects.connectMinimizeSignals();

        // Desktop workspaces
        this._desktopWorkspaces = new DesktopWorkspaces(this._controller, this._settings, this._displayConfig);

        // Tray area location: 'top-panel', 'notification-panel', or 'none'
        let trayLocation = 'top-panel';
        try { trayLocation = this._settings.get_string('desktop-tray-location'); } catch (_e) {}

        // Desktop tray in top panel
        if (trayLocation === 'top-panel' || trayLocation === 'both')
            this._desktopTray = new DesktopTray(this._settings, this._trayManager);

        // Notification icons in top panel
        this._desktopNotifIcons = new DesktopNotifIcons(this._settings, () => {
            if (this._notificationPanel?.isOpen) {
                this._notificationPanel.close();
            } else {
                this._notificationPanel?.selectPointerMonitor?.();
                this._notificationPanel?.open?.();
            }
        });

        // NotificationPanelManager is already role-aware and will be
        // refreshed through its lighter topology/settings paths.
    }

    _syncDeviceSpecificModules(hostType) {
        let isPhone = hostType === HostType.PHONE;
        let shouldEnableAlertSlider = isPhone && this._isOnePlus6Device();

        // Alert slider (OnePlus devices only)
        if (shouldEnableAlertSlider && !this._alertSlider) {
            try {
                this._alertSlider = new AlertSlider(this._controller);
            } catch (_e) {
                this._alertSlider = null;
            }
        } else if (!shouldEnableAlertSlider && this._alertSlider) {
            this._alertSlider.destroy();
            this._alertSlider = null;
        }

        // Auto-rotate — workaround for Mutter builds that don't apply
        // sensor-driven rotation despite PanelOrientationManaged=true.
        // Available on all phone/tablet hosts, not just OnePlus.
        if (isPhone && !this._autoRotate) {
            try {
                this._autoRotate = new AutoRotate(this._settings);
            } catch (_e) {
                this._autoRotate = null;
            }
        } else if (!isPhone && this._autoRotate) {
            this._autoRotate.destroy();
            this._autoRotate = null;
        }

        // Auto-brightness — adjusts backlight based on ambient light sensor.
        if (isPhone && !this._autoBrightness) {
            try {
                this._autoBrightness = new AutoBrightness(this._settings);
            } catch (_e) {
                this._autoBrightness = null;
            }
        } else if (!isPhone && this._autoBrightness) {
            this._autoBrightness.destroy();
            this._autoBrightness = null;
        }

        // In-call proximity — blanks screen when phone is held to ear.
        if (isPhone && !this._callProximity) {
            try {
                this._callProximity = new CallProximity();
            } catch (_e) {
                this._callProximity = null;
            }
        } else if (!isPhone && this._callProximity) {
            this._callProximity.destroy();
            this._callProximity = null;
        }
    }

    // ── UI teardown (called from disable() and from the QS toggle) ───

    _teardownUI() {
        if (!this._controller) return; // idempotent guard

        // ── Device-specific (tear down first) ────────────────────────
        this._teardownDeviceSpecificModules();

        // ── Shared modules ───────────────────────────────────────────
        this._destroyHomeSurfaces();
        if (this._trayManager) {
            this._trayManager.disable();
            this._trayManager = null;
        }

        // ── Desktop modules (reverse order) ──────────────────────────
        this._disableConvergencePowerButton();
        this._revertDesktopPanelLayout();
        this._teardownDesktopModules();

        // ── Phone modules (reverse order) ────────────────────────────
        if (this._notificationPanel) {
            this._notificationPanel.destroy();
            this._notificationPanel = null;
        }
        this._teardownPhoneModules();

        // ── Disconnect settings signals ──────────────────────────────
        this._settingsSignals?.disconnectAll();

        // ── Restore Activities button ─────────────────────────────────
        if (this._activitiesBtn) {
            this._activitiesBtn.container.show();
            this._activitiesBtn = null;
        }

        // ── Restore GNOME Mobile phone mode ──────────────────────────
        if (this._didInvertIsPhone) {
            Main.layoutManager.forceInvertIsPhone = false;
            this._didInvertIsPhone = false;
        }

        // ── Restore GNOME Mobile bottom panel pill ─────────────────
        if (Main.layoutManager.uninhibitShowBottomPanel)
            Main.layoutManager.uninhibitShowBottomPanel();
        if (Main.layoutManager.bottomPanelBox && this._bottomPanelWasVisible)
            Main.layoutManager.bottomPanelBox.visible = true;

        // ── Restore GNOME state ──────────────────────────────────────
        this._restoreOverlayKey();
        this._restoreDash();
        this._restoreOverview();

        // ── Clean up mode-switch debounce ───────────────────────────
        this._runtimeDisposer?.clearTimeoutRef(this, '_modeChangeDebounceId');
        // ── Clean up display config ──────────────────────────────────
        if (this._displayConfig) {
            this._displayConfig.destroy();
            this._displayConfig = null;
        }
        this._monitorRoles = null;
        this._appliedTopology = null;

        // ── Dispose all runtime signal connections ───────────────────
        this._runtimeDisposer?.dispose();
        this._controller = null;
    }

    // ── Controller factory ───────────────────────────────────────────
    // The controller is a plain object that modules use to communicate.
    // It provides accessor-style getters so modules always see the
    // current live instances even across teardown/re-setup cycles.

    _buildController() {
        let ext = this;
        return {
            get settings() { return ext._settings; },
            get displayConfig() { return ext._displayConfig; },
            get monitorRoles() { return ext._monitorRoles; },
            get logger() { return ext._logger; },
            get runtimeDisposer() { return ext._runtimeDisposer; },

            // Module accessors (populated during setup)
            get homeScreen() { return ext._phoneHomeScreen ?? ext._desktopHomeScreen; },
            get phoneHomeScreen() { return ext._phoneHomeScreen; },
            get phoneHomeScreens() {
                let screens = [];
                if (ext._phoneHomeScreen)
                    screens.push(ext._phoneHomeScreen);
                for (let entry of ext._phoneHomeMirrors ?? []) {
                    if (entry?.homeScreen)
                        screens.push(entry.homeScreen);
                }
                return screens;
            },
            get desktopHomeScreen() { return ext._desktopHomeScreen; },
            get appDrawer() { return ext._appDrawer; },
            get phoneAppDrawers() {
                let drawers = [];
                if (ext._appDrawer)
                    drawers.push(ext._appDrawer);
                for (let entry of ext._phoneAppDrawerMirrors ?? []) {
                    if (entry?.appDrawer)
                        drawers.push(entry.appDrawer);
                }
                return drawers;
            },
            get windowStack() { return ext._windowStack; },
            get gestureBar() { return ext._gestureBar; },
            get bottomBar() { return ext._gestureBar; },
            get phoneGestureBars() {
                let bars = [];
                if (ext._gestureBar)
                    bars.push(ext._gestureBar);
                for (let entry of ext._phoneGestureBarMirrors ?? []) {
                    if (entry?.gestureBar)
                        bars.push(entry.gestureBar);
                }
                return bars;
            },
            get edgeGestures() { return ext._edgeGestures; },
            get statusBar() { return ext._statusBar; },
            get phoneStatusBars() {
                let bars = [];
                if (ext._statusBar)
                    bars.push(ext._statusBar);
                for (let entry of ext._phoneStatusBarMirrors ?? []) {
                    if (entry?.statusBar)
                        bars.push(entry.statusBar);
                }
                return bars;
            },
            get notificationPanel() { return ext._notificationPanel; },
            get recentApps() { return ext._recentApps; },
            get phoneRecentApps() {
                let overlays = [];
                if (ext._recentApps)
                    overlays.push(ext._recentApps);
                for (let entry of ext._phoneRecentAppsMirrors ?? []) {
                    if (entry?.recentApps)
                        overlays.push(entry.recentApps);
                }
                return overlays;
            },
            get recentCardsStrip() { return ext._recentApps?._cardsStrip ?? null; },
            get recentCardsBox() { return ext._recentApps?._cardsStrip ?? null; },
            get splashScreen() { return ext._splashScreen; },
            get haptics() { return ext._haptics; },
            get taskbar() { return ext._taskbar; },
            get taskbarIcons() { return ext._taskbarIcons; },
            get taskbarPreviews() { return ext._taskbarPreviews; },
            get taskbarAnimations() { return ext._taskbarAnimations; },
            get appMenu() { return ext._appMenu; },
            get windowEffects() { return ext._windowEffects; },
            get desktopWorkspaces() { return ext._desktopWorkspaces; },
            get phoneWorkspaces() { return ext._phoneWorkspaces; },
            get alertSlider() { return ext._alertSlider; },
            get volumeOsd() { return ext._volumeOsd; },
            getPhoneMonitorIndex: () => ext._monitorRoles?.phoneMonitorIndex ?? Main.layoutManager.primaryIndex,
            getPhoneMonitorIndices: () => ext._monitorRoles?.phoneMonitorIndices ?? [Main.layoutManager.primaryIndex],
            getPrimaryPhoneMonitorIndex: () => ext._monitorRoles?.primaryPhoneMonitorIndex
                ?? ext._monitorRoles?.phoneMonitorIndex
                ?? Main.layoutManager.primaryIndex,
            getDesktopMonitorIndices: () => ext._monitorRoles?.desktopMonitorIndices ?? [Main.layoutManager.primaryIndex],
            getPrimaryDesktopMonitorIndex: () => ext._monitorRoles?.primaryDesktopMonitorIndex ?? Main.layoutManager.primaryIndex,
            getMonitorRole: (monitorIndex) => ext._monitorRoles?.getMonitorRole(monitorIndex) ?? MonitorRole.UNKNOWN,
            getPhoneTopInset: (monitorIndex = null) => ext._getPhoneTopInsetForMonitor(monitorIndex),
            getDockRectForMonitor: (monitorIndex) => ext._taskbar?.getTaskbarRectForMonitor?.(monitorIndex) ?? null,
            monitorIndexForCoords: (x, y) => ext._monitorIndexForCoords(x, y),
            getRecentAppsBounds: (monitorIndex = null) => ext._getMonitorBounds(
                Number.isInteger(monitorIndex) ? monitorIndex : ext._monitorRoles?.phoneMonitorIndex),
            getMonitorBoundsForMonitor: (monitorIndex) => ext._getMonitorBounds(monitorIndex),
            getHomeScreenForMonitor: (monitorIndex) => ext._getHomeScreenForMonitor(monitorIndex),
            getPhoneHomeScreenForMonitor: (monitorIndex) => ext._getPhoneHomeScreenForMonitor(monitorIndex),
            getPhoneStatusBarForMonitor: (monitorIndex) => ext._getPhoneStatusBarForMonitor(monitorIndex),
            getPhoneAppDrawerForMonitor: (monitorIndex) => ext._getPhoneAppDrawerForMonitor(monitorIndex),
            getPhoneGestureBarForMonitor: (monitorIndex) => ext._getPhoneGestureBarForMonitor(monitorIndex),
            getPhoneRecentAppsForMonitor: (monitorIndex) => ext._getPhoneRecentAppsForMonitor(monitorIndex),
            getHomeScreenForCoords: (x, y) => ext._getHomeScreenForMonitor(ext._monitorIndexForCoords(x, y)),
            windowManager: {
                showRecentApps: (monitorIndex = null) =>
                    ext._getPhoneRecentAppsForMonitor(monitorIndex)?.show?.(),
                hideRecentApps: (monitorIndex = null) =>
                    ext._getPhoneRecentAppsForMonitor(monitorIndex)?.hide?.(),
            },
            setPendingPhoneLaunchMonitorIndex: (monitorIndex = null) => {
                ext._pendingPhoneLaunchMonitorIndex = Number.isInteger(monitorIndex)
                    ? monitorIndex
                    : null;
            },
            consumePendingPhoneLaunchMonitorIndex: () => {
                let monitorIndex = ext._pendingPhoneLaunchMonitorIndex;
                ext._pendingPhoneLaunchMonitorIndex = null;
                return Number.isInteger(monitorIndex) ? monitorIndex : null;
            },

            // App activation (phone mode: route through stack, show splash)
            activateApp: (app, monitorIndex = null) => {
                ext._haptics?.vibrate(10);
                let ps = ext._windowStack;
                let targetPhoneMonitorIndex = Number.isInteger(monitorIndex)
                    ? monitorIndex
                    : (ext._monitorRoles?.phoneMonitorIndex ?? Main.layoutManager.primaryIndex);
                if (ps?.isActive) {
                    // Check for existing window in the phone stack
                    let windows = app.get_windows?.() ?? [];
                    for (let w of windows) {
                        if (ps.hasWindow(w, targetPhoneMonitorIndex)) {
                            ps.activateWindow(w, targetPhoneMonitorIndex);
                            return;
                        }
                        let existingPhoneMonitorIndex = ps.getWindowMonitorIndex?.(w);
                        if (Number.isInteger(existingPhoneMonitorIndex)) {
                            ps.activateWindow(w, existingPhoneMonitorIndex);
                            return;
                        }
                    }
                    // No existing window — show splash and launch
                    ext._pendingPhoneLaunchMonitorIndex = targetPhoneMonitorIndex;
                    ext._splashScreen?.show?.(app);
                    app.activate();
                    return;
                }
                // Non-phone: show splash and launch
                ext._splashScreen?.show?.(app);
                app.activate();
            },

            // Splash screen shortcut
            showAppSplash: (app) => ext._splashScreen?.show?.(app),

            // Drawer ↔ home screen opacity sync
            onDrawerDragProgress: (progress, monitorIndex = null) => {
                let hs = ext._getPhoneHomeScreenForMonitor(monitorIndex)?._actor;
                if (hs) hs.opacity = Math.round(255 * (1 - progress));
            },
            onDrawerExpanding: (durationMs, monitorIndex = null) => {
                let hs = ext._getPhoneHomeScreenForMonitor(monitorIndex)?._actor;
                if (hs) {
                    hs.remove_all_transitions();
                    hs.ease({ opacity: 0, duration: durationMs,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                }
            },
            onDrawerCollapsing: (durationMs, monitorIndex = null) => {
                let hs = ext._getPhoneHomeScreenForMonitor(monitorIndex)?._actor;
                if (hs && hs.opacity < 255) {
                    hs.remove_all_transitions();
                    hs.ease({ opacity: 255, duration: durationMs,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                }
            },

            // Home screen drawer reveal (phone mode: swipe up to open app drawer)
            startHomeDrawerReveal: (monitorIndex = null) =>
                ext._getPhoneAppDrawerForMonitor(monitorIndex)?.startHomeRevealGesture?.(),
            updateHomeDrawerReveal: (progress, monitorIndex = null) =>
                ext._getPhoneAppDrawerForMonitor(monitorIndex)?.updateHomeRevealGesture?.(progress),
            endHomeDrawerReveal: (commit, monitorIndex = null) =>
                ext._getPhoneAppDrawerForMonitor(monitorIndex)?.endHomeRevealGesture?.(commit),
            getHomeDrawerRevealRange: (monitorIndex = null) =>
                ext._getPhoneAppDrawerForMonitor(monitorIndex)?.getHomeRevealRange?.() ?? 0,

            // Phone gesture bar → PhoneWorkspaces wiring
            get phoneWindowStack() { return ext._windowStack; },
            get isPhoneDisplayOff() { return ext._phoneDisplayOff ?? false; },
            setPendingDesktopLaunch: () => { ext._pendingDesktopLaunch = true; },
            consumePendingDesktopLaunch: () => {
                if (ext._pendingDesktopLaunch) {
                    ext._pendingDesktopLaunch = false;
                    return true;
                }
                return false;
            },
            startHomeGesture: (monitorIndex = null) => ext._phoneWorkspaces?.startHomeGesture?.(monitorIndex),
            updateHomeGesture: (p, monitorIndex = null) => ext._phoneWorkspaces?.updateHomeGesture?.(p, monitorIndex),
            endHomeGesture: (commit, monitorIndex = null) => ext._phoneWorkspaces?.endHomeGesture?.(commit, monitorIndex),
            startWorkspaceSwipe: (x, y, monitorIndex = null) => ext._phoneWorkspaces?.startWorkspaceSwipe?.(x, y, monitorIndex),
            updateWorkspaceSwipe: (x, monitorIndex = null) => ext._phoneWorkspaces?.updateWorkspaceSwipe?.(x, monitorIndex),
            endWorkspaceSwipe: (x, v, monitorIndex = null) => ext._phoneWorkspaces?.endWorkspaceSwipe?.(x, v, monitorIndex),
            goBack: (monitorIndex = null) => ext._phoneWorkspaces?.goBack?.(monitorIndex),
            showKeyboard: () => { try { Main.keyboard?.open?.(Main.layoutManager.focusIndex); } catch (_e) {} },

            // Phone gesture bar → RecentApps wiring
            prepareRecentApps: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.prepareFromApp?.(),
            prepareRecentAppsFromHome: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.prepareFromHome?.(),
            updateRecentAppsProgress: (p, monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.updateFromAppProgress?.(p),
            updateRecentAppsFromHomeProgress: (p, monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.updateFromHomeProgress?.(p),
            commitRecentApps: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.commitFromApp?.(),
            commitRecentAppsFromHome: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.commitFromHome?.(),
            cancelRecentApps: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.cancelFromApp?.(),
            cancelRecentAppsFromHome: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.cancelFromHome?.(),
            cancelPreparedRecentApps: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.cancelFromApp?.(),
            scrollRecentAppsByDelta: (dx, monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.scrollByDelta?.(dx),
            snapRecentAppsScroll: (velocity = 0, monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.snapScroll?.(velocity),
            getActiveWindowCardRect: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.getActiveWindowCardRect?.(),
            revealActiveCard: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.revealActiveCard?.(),
            getCenteredRecentWindow: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.getCenteredWindow?.(),
            getCenteredRecentCardRect: (monitorIndex = null) =>
                ext._getPhoneRecentAppsForMonitor(monitorIndex)?.getCenteredCardRect?.(),
            quickSwitchToWindow: (metaWindow, cardRect, monitorIndex = null) =>
                ext._phoneWorkspaces?.quickSwitchToWindow?.(metaWindow, cardRect, monitorIndex),

            // Device detection
            isOnePlus6Device: () => ext._isOnePlus6Device(),
            isFLX1Device: () => ext._isFLX1Device(),
        };
    }

    // ── Desktop panel layout ──────────────────────────────────────────

    /**
     * Restore vanilla GNOME top-panel layout for the desktop display
     * in convergence mode.  gnome-shell-mobile moves dateMenu to the
     * left box and hides activities; move them back so the desktop
     * panel has the clock centred and a workspace indicator on the left.
     */
    _applyDesktopPanelLayout() {
        let panel = Main.panel;
        if (!panel)
            return;

        // Move dateMenu from left to center (vanilla GNOME position).
        let dm = panel.statusArea?.dateMenu;
        if (dm?.container) {
            let parent = dm.container.get_parent();
            if (parent && parent !== panel._centerBox) {
                this._savedDateMenuParent = parent;
                parent.remove_child(dm.container);
                panel._centerBox.add_child(dm.container);
            }
        }

        // Show the Activities/workspace indicator on the desktop.
        let activities = panel.statusArea?.activities;
        if (activities?.container) {
            activities.container.show();
            this._desktopActivitiesShown = true;
        }
    }

    /**
     * Reverse _applyDesktopPanelLayout — restore the mobile panel
     * layout when the desktop role is removed.
     */
    _revertDesktopPanelLayout() {
        let panel = Main.panel;
        if (!panel)
            return;

        // Move dateMenu back to its original parent.
        let dm = panel.statusArea?.dateMenu;
        if (dm?.container && this._savedDateMenuParent) {
            let parent = dm.container.get_parent();
            if (parent)
                parent.remove_child(dm.container);
            this._savedDateMenuParent.add_child(dm.container);
            this._savedDateMenuParent = null;
        }

        // Re-hide activities if we showed it.
        if (this._desktopActivitiesShown) {
            let activities = panel.statusArea?.activities;
            if (activities?.container && this._monitorRoles?.hasPhoneRole)
                activities.container.hide();
            this._desktopActivitiesShown = false;
        }
    }

    // ── Convergence power button (phone display toggle) ───────────────

    /**
     * In convergence mode, override the power button so it toggles
     * the phone display's backlight on/off without locking the session.
     * The desktop display stays on and usable.
     */
    _enableConvergencePowerButton() {
        if (this._convergencePowerBtnOverridden)
            return;

        // Replace GNOME Mobile's power-button keybinding handler with
        // our own so the power button toggles the phone display instead
        // of locking the session.
        try {
            Main.wm.removeKeybinding('power-button');
        } catch (_e) {}

        let kbSettings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        Main.wm.addKeybinding('power-button', kbSettings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL,
            () => this._togglePhoneDisplay());

        this._convergencePowerBtnOverridden = true;
        this._phoneDisplayOff = false;
        this._savedBrightness = null;
    }

    _disableConvergencePowerButton() {
        if (this._convergencePowerBtnOverridden) {
            try { Main.wm.removeKeybinding('power-button'); } catch (_e) {}
            this._convergencePowerBtnOverridden = false;
        }
        if (this._phoneDisplayOff)
            this._enablePhoneDisplay();
        this._savedBrightness = null;
    }

    _togglePhoneDisplay() {
        if (this._phoneDisplayOff)
            this._enablePhoneDisplay();
        else
            this._disablePhoneDisplay();
    }

    /**
     * Disable the phone display by removing it from Mutter's logical
     * monitor configuration and turning off the backlight.  No GPU
     * rendering or input processing for the phone display.
     */
    _disablePhoneDisplay() {
        if (this._phoneDisplayOff)
            return;

        this._savedBrightness = this._getPhoneBrightness();
        if (this._savedBrightness <= 0)
            this._savedBrightness = 1335;

        this._setPhoneBrightness(0);
        this._setupPointerConfinement();
        this._setupTouchBlocker();
        this._phoneDisplayOff = true;
    }

    _enablePhoneDisplay() {
        if (!this._phoneDisplayOff)
            return;

        this._removePointerConfinement();
        this._removeTouchBlocker();
        this._setPhoneBrightness(this._savedBrightness ?? 1335);
        this._phoneDisplayOff = false;
    }

    /**
     * Confine the pointer to the desktop monitor by warping it back
     * whenever it crosses into the phone area.
     */
    _setupPointerConfinement() {
        if (this._pointerConfineId)
            return;
        let desktopIdx = this._monitorRoles?.primaryDesktopMonitorIndex ?? 1;
        let desktopGeo = global.display.get_monitor_geometry(desktopIdx);
        this._pointerConfineId = global.stage.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.MOTION)
                return Clutter.EVENT_PROPAGATE;
            let [x, y] = event.get_coords();
            if (x < desktopGeo.x) {
                Clutter.get_default_backend().get_default_seat()
                    .warp_pointer(desktopGeo.x, y);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _removePointerConfinement() {
        if (this._pointerConfineId) {
            global.stage.disconnect(this._pointerConfineId);
            this._pointerConfineId = 0;
        }
    }

    /**
     * Place a transparent reactive actor over the phone display to
     * consume all touch events while the screen is off.
     */
    _setupTouchBlocker() {
        if (this._phoneInputBlocker)
            return;
        let phoneIdx = this._monitorRoles?.phoneMonitorIndex ?? 0;
        let mon = global.display.get_monitor_geometry(phoneIdx);
        this._phoneInputBlocker = new Clutter.Actor({
            x: mon.x, y: mon.y,
            width: mon.width, height: mon.height,
            reactive: true, opacity: 0,
        });
        this._phoneInputBlocker.connect('button-press-event', () => Clutter.EVENT_STOP);
        this._phoneInputBlocker.connect('touch-event', () => Clutter.EVENT_STOP);
        this._phoneInputBlocker.connect('scroll-event', () => Clutter.EVENT_STOP);
        Main.layoutManager.uiGroup.add_child(this._phoneInputBlocker);
    }

    _removeTouchBlocker() {
        if (this._phoneInputBlocker?.get_parent())
            this._phoneInputBlocker.get_parent().remove_child(this._phoneInputBlocker);
        this._phoneInputBlocker?.destroy();
        this._phoneInputBlocker = null;
    }

    _findBacklightPath() {
        if (this._backlightPath !== undefined)
            return this._backlightPath;
        // Look for a DSI or built-in backlight
        try {
            let dir = Gio.File.new_for_path('/sys/class/backlight');
            let enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                let name = info.get_name();
                let path = `/sys/class/backlight/${name}/brightness`;
                let file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    this._backlightPath = path;
                    return path;
                }
            }
        } catch (_e) {}
        this._backlightPath = null;
        return null;
    }

    _getPhoneBrightness() {
        let path = this._findBacklightPath();
        if (!path)
            return 0;
        try {
            let [ok, contents] = GLib.file_get_contents(path);
            if (ok)
                return parseInt(new TextDecoder().decode(contents).trim(), 10) || 0;
        } catch (_e) {}
        return 0;
    }

    _setPhoneBrightness(value) {
        let path = this._findBacklightPath();
        if (!path)
            return;
        try {
            let file = Gio.File.new_for_path(path);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new TextEncoder().encode(`${value}\n`);
            stream.write_bytes(new GLib.Bytes(bytes), null);
            stream.close(null);
        } catch (_e) {
            log(`[Convergence] Failed to write backlight: ${_e.message}`);
        }
    }

    // ── Auto-primary desktop monitor ──────────────────────────────────

    /**
     * When a desktop-role monitor appears, promote it to the Mutter
     * primary display so new windows and panels land on the big screen
     * rather than the phone.  No-op if it is already primary.
     *
     * Uses GetCurrentState / ApplyMonitorsConfig to re-apply the
     * current layout with only the is-primary flag changed.
     */
    _promoteDesktopToPrimary(desktopMonitorIndex) {
        if (!Number.isInteger(desktopMonitorIndex) || desktopMonitorIndex < 0)
            return;
        if (desktopMonitorIndex === Main.layoutManager.primaryIndex)
            return;

        Gio.DBus.session.call(
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig',
            'GetCurrentState',
            null, null, Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try {
                    let reply = conn.call_finish(res);
                    this._applyPrimarySwitch(reply, desktopMonitorIndex);
                } catch (e) {
                    log(`[Convergence] Failed to get display state for primary switch: ${e.message}`);
                }
            });
    }

    _applyPrimarySwitch(stateReply, desktopMonitorIndex) {
        try {
            let serial = stateReply.get_child_value(0).get_uint32();
            let monitors = stateReply.get_child_value(1);  // a((ssss)a(siiddad a{sv})a{sv})
            let logicalMonitors = stateReply.get_child_value(2);  // a(iiduba(ssa{sv}))

            // Build a connector→mode lookup from the monitors array.
            let connectorModes = new Map();
            for (let i = 0; i < monitors.n_children(); i++) {
                let mon = monitors.get_child_value(i);
                let ids = mon.get_child_value(0);  // (ssss)
                let connector = ids.get_child_value(0).get_string()[0];
                let modes = mon.get_child_value(1);  // a(siiddad a{sv})
                for (let m = 0; m < modes.n_children(); m++) {
                    let mode = modes.get_child_value(m);
                    let props = mode.get_child_value(6);  // a{sv}
                    let isCurrent = false;
                    for (let p = 0; p < props.n_children(); p++) {
                        let entry = props.get_child_value(p);
                        let key = entry.get_child_value(0).get_string()[0];
                        if (key === 'is-current') {
                            isCurrent = entry.get_child_value(1).get_variant().get_boolean();
                            break;
                        }
                    }
                    if (isCurrent) {
                        let modeId = mode.get_child_value(0).get_string()[0];
                        connectorModes.set(connector, modeId);
                        break;
                    }
                }
            }

            // Rebuild logical monitor list, flipping the primary flag.
            // Map each logical monitor to its Mutter monitor index by
            // matching the connector from the assigned monitors list.
            let desktopConnector = this._displayConfig?.getMonitorInfo(desktopMonitorIndex)?.connector;
            let newLogical = [];
            for (let i = 0; i < logicalMonitors.n_children(); i++) {
                let lm = logicalMonitors.get_child_value(i);
                let x = lm.get_child_value(0).get_int32();
                let y = lm.get_child_value(1).get_int32();
                let scale = lm.get_child_value(2).get_double();
                let transform = lm.get_child_value(3).get_uint32();
                // let isPrimary = lm.get_child_value(4).get_boolean();
                let assigned = lm.get_child_value(5);  // a(ssa{sv})

                let monEntries = [];
                let isDesktopMonitor = false;
                for (let a = 0; a < assigned.n_children(); a++) {
                    let entry = assigned.get_child_value(a);
                    let conn = entry.get_child_value(0).get_string()[0];
                    let modeId = connectorModes.get(conn) || entry.get_child_value(1).get_string()[0];
                    monEntries.push([conn, modeId, {}]);

                    if (desktopConnector && conn === desktopConnector)
                        isDesktopMonitor = true;
                }

                newLogical.push(new GLib.Variant('(iiduba(ssa{sv}))', [
                    x, y, scale, transform, isDesktopMonitor, monEntries,
                ]));
            }

            Gio.DBus.session.call(
                'org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig',
                'org.gnome.Mutter.DisplayConfig',
                'ApplyMonitorsConfig',
                new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
                    serial, 2, newLogical, {},
                ]),
                null, Gio.DBusCallFlags.NONE, 5000, null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                        log(`[Convergence] Promoted monitor ${desktopMonitorIndex} to primary`);
                        // The phone status bar may have hidden the GNOME
                        // panel while the phone was still primary.  Now
                        // that the desktop is primary, restore it so the
                        // top panel appears on the external display.
                        this._restoreGnomePanelForDesktop();
                    } catch (e) {
                        log(`[Convergence] ApplyMonitorsConfig failed: ${e.message}`);
                    }
                });
        } catch (e) {
            log(`[Convergence] Failed to apply primary switch: ${e.message}`);
        }
    }

    /**
     * Isolate the phone display from the desktop overview.
     * @param {boolean} isolate — true when overview is showing,
     *   false when it has fully hidden.
     */
    _isolatePhoneFromOverview(isolate) {
        let og = Main.layoutManager.overviewGroup;
        if (!og)
            return;

        if (isolate) {
            let desktopIdx = this._monitorRoles?.primaryDesktopMonitorIndex ?? -1;
            if (desktopIdx < 0)
                return;
            let desktopGeo = global.display.get_monitor_geometry(desktopIdx);

            // Clip the overview to the desktop monitor only.
            og.set_clip(desktopGeo.x, desktopGeo.y, desktopGeo.width, desktopGeo.height);

            // Hide GNOME's secondary-monitor overview display for the
            // phone monitor (it renders workspace thumbnails there).
            for (let i = 0; i < og.get_n_children(); i++) {
                let child = og.get_child_at_index(i);
                if (child.name === 'SecondaryMonitorDisplay' ||
                    child.constructor?.name?.includes?.('SecondaryMonitor'))
                    child.hide();
            }

            // Keep window_group visible so phone window actors paint
            // behind the clipped overview.
            this._keepWindowGroupVisible = true;
            if (this._windowGroupEnforceId)
                return;
            this._windowGroupEnforceId = GLib.timeout_add(
                GLib.PRIORITY_HIGH, 16, () => {
                    if (!this._keepWindowGroupVisible) {
                        this._windowGroupEnforceId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    if (!global.window_group.visible)
                        global.window_group.show();
                    return GLib.SOURCE_CONTINUE;
                });
            this._runtimeDisposer?.trackTimeout(this._windowGroupEnforceId);
        } else {
            og.remove_clip();

            for (let i = 0; i < og.get_n_children(); i++) {
                let child = og.get_child_at_index(i);
                if (child.name === 'SecondaryMonitorDisplay' ||
                    child.constructor?.name?.includes?.('SecondaryMonitor'))
                    child.show();
            }

            this._keepWindowGroupVisible = false;
        }
    }

    _restoreGnomePanelForDesktop() {
        if (Main.panel) {
            Main.panel.opacity = 255;
            Main.panel.visible = true;
            Main.panel.reactive = true;
        }
        Main.layoutManager?.panelBox?.show?.();

        // The overview's workspace display may have been initialised
        // while the phone was still primary.  Re-point it at the
        // desktop monitor so workspace thumbnails use the correct
        // dimensions.
        let wsView = Main.overview?._overview?.controls?._workspacesDisplay;
        if (wsView) {
            let desktopIdx = Main.layoutManager.primaryIndex;
            if (wsView._primaryIndex !== desktopIdx) {
                wsView._primaryIndex = desktopIdx;
                try { wsView._updateWorkspacesViews?.(); } catch (_e) {}
            }
        }
    }

    // ── Overview suppression helpers ─────────────────────────────────

    _getTopologyState(roles = this._monitorRoles) {
        let primaryMode = this._displayConfig?.primaryDisplayMode ?? null;
        let hostType = this._displayConfig?.hostType ?? HostType.UNKNOWN;
        let isSmallDisplay = this._displayConfig?.isSmallDisplay ?? false;
        let hasPhoneRole = roles?.hasPhoneRole ?? false;
        let hasDesktopRole = roles?.hasDesktopRole ?? false;
        let roleSignature = roles?.signature ?? '';
        let shouldSuppressOverview = this._shouldSuppressOverviewForRoles(roles);

        return {
            primaryMode,
            hostType,
            isSmallDisplay,
            hasPhoneRole,
            hasDesktopRole,
            shouldSuppressOverview,
            roleSignature,
            key: `${primaryMode}|${hostType}|${isSmallDisplay ? 1 : 0}|${roleSignature}`,
        };
    }

    _shouldSuppressOverviewForRoles(roles = this._monitorRoles) {
        return !!roles?.shouldSuppressOverview?.();
    }

    _syncOverviewSuppression(shouldSuppress) {
        if (shouldSuppress)
            this._suppressOverview();
        else
            this._restoreOverview();
    }

    _suppressOverview() {
        if (this._overviewSuppressed)
            return;

        this._enforceOverviewHidden();

        try {
            this._runtimeDisposer.replaceConnection(
                this, '_overviewShowingId',
                Main.overview, 'showing',
                () => this._enforceOverviewHidden());
        } catch (_e) {
            this._overviewShowingId = 0;
        }

        // GNOME resets sessionMode.hasOverview during display-config
        // changes (e.g. scaling).  Re-enforce our suppression whenever
        // the session mode is updated.
        try {
            this._runtimeDisposer.replaceConnection(
                this, '_sessionModeUpdatedId',
                Main.sessionMode, 'updated',
                () => this._enforceOverviewHidden());
        } catch (_e) {
            this._sessionModeUpdatedId = 0;
        }

        this._overviewSuppressed = true;
    }

    /**
     * Force-hide the overview and clear hasOverview so GNOME won't
     * try to show it again.  Called both on initial suppression and
     * whenever something (e.g. a display-config change) resets the
     * session-mode flag behind our back.
     */
    _enforceOverviewHidden() {
        if ('hasOverview' in Main.sessionMode) {
            if (this._savedHasOverview === undefined)
                this._savedHasOverview = Main.sessionMode.hasOverview;
            Main.sessionMode.hasOverview = false;
        }

        let ov = Main.overview;
        if (!ov?.visible)
            return;

        // overview.hide() starts an animated transition that can stall
        // during display-config changes (Clutter drops the transition
        // when the stage is reconfigured).  Force-complete the hiding by
        // snapping the state adjustment to 0 and calling _hideDone().
        ov.hide();
        if (ov.animationInProgress || ov.visible) {
            let adj = ov._overview?.controls?._stateAdjustment;
            if (adj) {
                adj.remove_transition('value');
                adj.value = 0;
            }
            try { ov._hideDone(); } catch (_e) {}
        }

        // _hideDone() emits 'hidden' which re-shows our home screens,
        // but the overview's 'shown' signal may fire later in the same
        // event cycle and hide them again.  Defer the re-show so it
        // wins the race.
        this._runtimeDisposer?.restartTimeout(
            this, '_enforceHomeShowId',
            GLib.PRIORITY_DEFAULT_IDLE, 50, () => {
                this._enforceHomeShowId = 0;
                if (this._overviewSuppressed && !Main.overview?.visible)
                    this._showHomeScreens();
                return GLib.SOURCE_REMOVE;
            });
    }

    _showHomeScreens() {
        this._forEachPhoneHomeScreen(hs => hs?.show?.());
        this._desktopHomeScreen?.show?.();
        for (let e of this._desktopHomeMirrors ?? [])
            e.homeScreen?.show?.();
    }

    _suppressOverviewAtStartup(shouldSuppress = true) {
        if (!shouldSuppress || !Main.layoutManager?._startingUp)
            return;

        if (this._savedHasOverview === undefined && 'hasOverview' in Main.sessionMode)
            this._savedStartupHasOverview = Main.sessionMode.hasOverview;

        Main.sessionMode.hasOverview = false;
        Main.layoutManager.startInOverview = false;

        try {
            let controls = Main.overview?._overview?.controls;
            if (controls && OverviewControls.ControlsState)
                controls._stateAdjustment.value = OverviewControls.ControlsState.HIDDEN;
        } catch (_e) {}

        this._runtimeDisposer.replaceConnection(
            this, '_startupCompleteId',
            Main.layoutManager, 'startup-complete', () => {
            if (this._savedStartupHasOverview !== undefined) {
                if (this._savedHasOverview === undefined)
                    Main.sessionMode.hasOverview = this._savedStartupHasOverview;
                delete this._savedStartupHasOverview;
            }
            if (Main.overview?.visible)
                Main.overview.hide();
        });
    }

    _restoreOverview() {
        this._runtimeDisposer?.clearConnectionRef(this, '_overviewShowingId', Main.overview);
        this._runtimeDisposer?.clearConnectionRef(this, '_sessionModeUpdatedId', Main.sessionMode);

        // Disconnect startup-complete handler
        this._runtimeDisposer?.clearConnectionRef(this, '_startupCompleteId', Main.layoutManager);
        if (this._savedStartupHasOverview !== undefined) {
            Main.sessionMode.hasOverview = this._savedStartupHasOverview;
            delete this._savedStartupHasOverview;
        }

        // Restore overview capability
        if (this._savedHasOverview !== undefined) {
            Main.sessionMode.hasOverview = this._savedHasOverview;
            this._savedHasOverview = undefined;
        }

        this._overviewSuppressed = false;
    }

    _teardownDeviceSpecificModules() {
        if (this._alertSlider) {
            this._alertSlider.destroy();
            this._alertSlider = null;
        }
        if (this._autoRotate) {
            this._autoRotate.destroy();
            this._autoRotate = null;
        }
        if (this._autoBrightness) {
            this._autoBrightness.destroy();
            this._autoBrightness = null;
        }
        if (this._callProximity) {
            this._callProximity.destroy();
            this._callProximity = null;
        }
    }

    // ── Dash visibility helpers ──────────────────────────────────────

    _hideDash() {
        try {
            let dash = Main.overview?.dash;
            if (dash) {
                this._savedDashOpacity = dash.opacity;
                this._savedDashReactive = dash.reactive;
                this._savedDashHeight = dash.height;
                dash.opacity = 0;
                dash.reactive = false;
            }
        } catch (_e) {}
    }

    _restoreDash() {
        try {
            let dash = Main.overview?.dash;
            if (dash && this._savedDashOpacity !== undefined) {
                dash.opacity = this._savedDashOpacity;
                dash.reactive = this._savedDashReactive ?? true;
                dash.height = this._savedDashHeight ?? -1;
            }
        } catch (_e) {}
        this._savedDashOpacity = undefined;
        this._savedDashReactive = undefined;
        this._savedDashHeight = undefined;
    }

    // ── Overlay key override ─────────────────────────────────────────

    _overrideOverlayKey() {
        try {
            this._defaultOverlayKeyId = GObject.signal_handler_find(
                global.display, {signalId: 'overlay-key'});
            if (this._defaultOverlayKeyId) {
                GObject.signal_handler_block(global.display, this._defaultOverlayKeyId);
                Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.ALL);
            }
            this._overlayKeyId = this._runtimeDisposer.connect(
                global.display, 'overlay-key', () => {
                    let monitorIndex = this._getPointerMonitorIndex();
                    let role = this._monitorRoles?.getMonitorRole(monitorIndex) ?? MonitorRole.UNKNOWN;
                    let phoneDrawer = this._getPhoneAppDrawerForMonitor(monitorIndex)
                        ?? this._appDrawer;

                    if (role === MonitorRole.PHONE && phoneDrawer) {
                        if (phoneDrawer.isExpanded)
                            phoneDrawer.collapse();
                        else
                            phoneDrawer.expand?.();
                    } else if (this._appMenu) {
                        let desktopMonitorIndex = role === MonitorRole.DESKTOP
                            ? monitorIndex
                            : this._monitorRoles?.primaryDesktopMonitorIndex ?? Main.layoutManager.primaryIndex;
                        this._appMenu.toggle(desktopMonitorIndex);
                    } else if (phoneDrawer) {
                        if (phoneDrawer.isExpanded)
                            phoneDrawer.collapse();
                        else
                            phoneDrawer.expand?.();
                    }
                    Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.ALL);
                });
        } catch (e) {
            this._logger.warn('overlay-key override failed; Super shortcut disabled.', e);
        }
    }

    _restoreOverlayKey() {
        this._runtimeDisposer?.clearConnectionRef(this, '_overlayKeyId', global.display);
        if (this._defaultOverlayKeyId) {
            try {
                GObject.signal_handler_unblock(global.display, this._defaultOverlayKeyId);
            } catch (_e) {}
            this._defaultOverlayKeyId = null;
        }
        Main.wm?.allowKeybinding?.('overlay-key',
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }

    // ── Overview signal connections ──────────────────────────────────

    _connectOverviewSignals() {
        let hasDesktop = () => this._monitorRoles?.hasDesktopRole ?? false;

        this._runtimeDisposer.connect(
            Main.overview, 'showing', () => {
                // In convergence mode, phone UI is independent of the
                // desktop overview — only collapse drawers when the
                // phone is the sole display.
                if (!hasDesktop()) {
                    this._forEachPhoneAppDrawer(appDrawer => {
                        if (appDrawer?.isExpanded)
                            appDrawer.collapse();
                    });
                }
            });

        this._runtimeDisposer.connect(
            Main.overview, 'shown', () => {
                // Only hide home screens for monitors that participate
                // in the desktop overview.  Phone home screens stay
                // visible so the phone UI is unaffected.
                if (!hasDesktop()) {
                    this._forEachPhoneHomeScreen(homeScreen => homeScreen?.hide?.());
                }
                this._desktopHomeScreen?.hide?.();
                for (let e of this._desktopHomeMirrors ?? [])
                    e.homeScreen?.hide?.();
            });

        this._runtimeDisposer.connect(
            Main.overview, 'hidden', () => {
                if (!hasDesktop()) {
                    this._forEachPhoneHomeScreen(homeScreen => homeScreen?.show?.());
                }
                this._desktopHomeScreen?.show?.();
                for (let e of this._desktopHomeMirrors ?? [])
                    e.homeScreen?.show?.();
            });

        // ── Phone UI isolation during desktop overview ───────────────
        // GNOME's overview hides global.window_group and paints
        // overviewGroup across ALL monitors.  In convergence mode:
        //  • Clip overviewGroup to the desktop monitor so the phone
        //    area is not covered by the overview UI.
        //  • Keep window_group visible so phone window actors paint.
        //  • Hide the SecondaryMonitorDisplay that GNOME creates for
        //    the phone monitor inside the overview.
        this._runtimeDisposer.connect(
            Main.overview, 'showing', () => {
                if (!hasDesktop() || !this._monitorRoles?.hasPhoneRole)
                    return;
                this._isolatePhoneFromOverview(true);
            });
        this._runtimeDisposer.connect(
            Main.overview, 'hidden', () => {
                this._isolatePhoneFromOverview(false);
            });

        // ── Workspace-change → home screen fade ─────────────────────
        let wsManager = global.workspace_manager;
        if (wsManager) {
            this._runtimeDisposer.connect(wsManager, 'active-workspace-changed', () => {
                this._onDesktopWorkspaceChanged();
            });
        }
    }

    // ── Session mode signals (lock screen handling) ────────────────

    _connectSessionModeSignals() {
        this._runtimeDisposer.connect(
            Main.sessionMode, 'updated', () => {
                let mode = Main.sessionMode.currentMode;
                if (mode === 'unlock-dialog' || mode === 'lock-screen') {
                    this._onScreenLocked();
                } else if (mode === 'user') {
                    this._onScreenUnlocked();
                }
            });
    }

    _onScreenLocked() {
        this._screenLocked = true;

        // ── Phone UI ────────────────────────────────────────────────
        // Immediately hide all phone UI — no animations behind lock screen.
        // We avoid calling the components' own hide() methods because they
        // start timed animations and guard timers that race with the
        // subsequent show() on unlock.
        this._forEachPhoneAppDrawer(appDrawer => {
            if (!appDrawer?._actor) return;
            appDrawer._actor.remove_all_transitions();
            appDrawer._actor.visible = false;
            if (appDrawer._backdrop)
                appDrawer._backdrop.visible = false;
        });
        this._forEachPhoneHomeScreen(homeScreen => {
            if (!homeScreen?._actor) return;
            homeScreen._actor.remove_all_transitions();
            homeScreen._actor.visible = false;
            homeScreen._visible = false;
        });
        this._forEachPhoneGestureBar(gestureBar => {
            if (!gestureBar) return;
            gestureBar.remove_all_transitions();
            gestureBar.visible = false;
            if (gestureBar._zone)
                gestureBar._zone.visible = false;
        });
        this._forEachPhoneStatusBar(statusBar => {
            if (!statusBar) return;
            if (statusBar._bar) statusBar._bar.visible = false;
            if (statusBar._topStrut) statusBar._topStrut.visible = false;
            if (statusBar._panelCornerLeft) statusBar._panelCornerLeft.visible = false;
            if (statusBar._panelCornerRight) statusBar._panelCornerRight.visible = false;
            if (statusBar._gestureOverlay) statusBar._gestureOverlay.visible = false;
        });

        // ── Desktop UI ──────────────────────────────────────────────
        if (this._taskbar?._actor)
            this._taskbar._actor.visible = false;
        if (this._taskbar?._taskbarStrut)
            this._taskbar._taskbarStrut.visible = false;
        for (let m of this._taskbar?._mirrorTaskbars ?? []) {
            if (m.actor) m.actor.visible = false;
            if (m.strut) m.strut.visible = false;
        }

        if (this._appMenu?.isExpanded)
            this._appMenu.collapse();
        if (this._appMenu?._panel)
            this._appMenu._panel.visible = false;
        if (this._appMenu?._backdrop)
            this._appMenu._backdrop.visible = false;

        if (this._desktopHomeScreen?._actor) {
            this._desktopHomeScreen._actor.visible = false;
            this._desktopHomeScreen._visible = false;
        }
        for (let e of this._desktopHomeMirrors ?? []) {
            if (e.homeScreen?._actor) {
                e.homeScreen._actor.visible = false;
                e.homeScreen._visible = false;
            }
        }
    }

    _onScreenUnlocked() {
        if (!this._screenLocked)
            return;
        this._screenLocked = false;

        // ── Phone UI ────────────────────────────────────────────────
        let phoneMonitorIndex = this._monitorRoles?.phoneMonitorIndex
            ?? Main.layoutManager.primaryIndex;
        let phoneMode = this._displayConfig?.getDisplayMode?.(phoneMonitorIndex) ?? null;
        let isPhone = phoneMode === DisplayMode.PHONE || phoneMode === DisplayMode.TABLET;

        if (isPhone) {
            this._forEachPhoneStatusBar(statusBar => {
                if (!statusBar) return;
                if (statusBar._bar) statusBar._bar.visible = true;
                if (statusBar._topStrut) statusBar._topStrut.visible = true;
                if (statusBar._panelCornerLeft) statusBar._panelCornerLeft.visible = true;
                if (statusBar._panelCornerRight) statusBar._panelCornerRight.visible = true;
                if (statusBar._gestureOverlay) statusBar._gestureOverlay.visible = true;
            });
            this._statusBar?.refreshTopology?.(phoneMonitorIndex);

            this._forEachPhoneGestureBar(gestureBar => {
                if (!gestureBar) return;
                gestureBar.visible = true;
                if (gestureBar._zone)
                    gestureBar._zone.visible = true;
                gestureBar.showBar?.();
            });

            let isHome = !this._windowStack?.getActiveWindow?.(phoneMonitorIndex);
            if (isHome) {
                this._forEachPhoneHomeScreen(homeScreen => {
                    if (!homeScreen?._actor) return;
                    homeScreen._actor.visible = true;
                    homeScreen.show?.();
                });
                this._forEachPhoneAppDrawer(appDrawer => {
                    if (!appDrawer?._actor) return;
                    appDrawer._actor.visible = true;
                    appDrawer._showDock?.();
                });
            }
        }

        // ── Desktop UI ──────────────────────────────────────────────
        if (this._taskbar?._actor)
            this._taskbar._actor.visible = true;
        if (this._taskbar?._taskbarStrut)
            this._taskbar._taskbarStrut.visible = true;
        for (let m of this._taskbar?._mirrorTaskbars ?? []) {
            if (m.actor) m.actor.visible = true;
            if (m.strut) m.strut.visible = true;
        }

        if (this._desktopHomeScreen?._actor) {
            this._desktopHomeScreen._actor.visible = true;
            this._desktopHomeScreen.show?.();
        }
        for (let e of this._desktopHomeMirrors ?? []) {
            if (e.homeScreen?._actor) {
                e.homeScreen._actor.visible = true;
                e.homeScreen.show?.();
            }
        }
    }

    _onDesktopWorkspaceChanged() {
        if (!this._desktopHomeScreen) return;
        if (Main.overview.visible) return;

        // On desktop, the home screen is always visible as the wallpaper/
        // widget background behind windows on every workspace.  Fade it
        // in after a workspace switch so the transition feels smooth.
        this._desktopHomeScreen.showAfterWorkspaceSwitch(200);

        for (let e of this._desktopHomeMirrors ?? []) {
            let m = e.homeScreen;
            if (m)
                m.showAfterWorkspaceSwitch(200);
        }
    }

    // ── Phone stack active-window callback ─────────────────────────

    _onPhoneStackActiveChanged(_activeWindow, isHome, monitorIndex = null) {
        let phoneMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (this._monitorRoles?.phoneMonitorIndex ?? Main.layoutManager.primaryIndex);
        let phoneMode = this._displayConfig?.getDisplayMode?.(phoneMonitorIndex) ?? null;
        let shouldHidePhoneHome = phoneMode === DisplayMode.PHONE || phoneMode === DisplayMode.TABLET;

        if (isHome) {
            // Going to home: show dock and gesture bar
            this._getPhoneHomeScreenForMonitor(phoneMonitorIndex)?.show?.();
            this._getPhoneAppDrawerForMonitor(phoneMonitorIndex)?.show?.();
            this._getPhoneGestureBarForMonitor(phoneMonitorIndex)?.showBar?.();
        } else {
            // App in foreground: hide home screen and dock, show gesture bar
            if (shouldHidePhoneHome) {
                this._getPhoneHomeScreenForMonitor(phoneMonitorIndex)?.hide?.();
                this._getPhoneAppDrawerForMonitor(phoneMonitorIndex)?.hide?.();
            }
            this._getPhoneGestureBarForMonitor(phoneMonitorIndex)?.showBar?.();
        }
    }

    _setupHomeSurfaces() {
        let phoneMonitorIndex = this._monitorRoles?.phoneMonitorIndex;
        let phoneMonitorIndices = this._monitorRoles?.phoneMonitorIndices ?? [];
        let primaryDesktopMonitorIndex = this._monitorRoles?.primaryDesktopMonitorIndex;

        this._phoneHomeScreen = null;
        this._phoneHomeMirrors = [];
        this._phoneStatusBarMirrors = [];
        this._desktopHomeScreen = null;
        this._desktopHomeMirrors = [];

        if (Number.isInteger(phoneMonitorIndex) && phoneMonitorIndex >= 0) {
            this._phoneHomeScreen = new HomeScreen(this._controller, {
                monitorIndex: phoneMonitorIndex,
            });
            this._phoneHomeScreen.setSettings(this._settings);
        }

        this._syncPhoneAuxiliarySurfaces(phoneMonitorIndices, phoneMonitorIndex);

        if (Number.isInteger(primaryDesktopMonitorIndex) && primaryDesktopMonitorIndex >= 0) {
            this._desktopHomeScreen = new HomeScreen(this._controller, {
                monitorIndex: primaryDesktopMonitorIndex,
            });
            this._desktopHomeScreen.setSettings(this._settings);
        }

        if (this._desktopWorkspaces)
            this._syncDesktopHomeMirrors();
    }

    _refreshHomeSurfacesForTopology(oldRoles, newRoles) {
        let oldPhoneMonitorIndex = oldRoles?.phoneMonitorIndex;
        let newPhoneMonitorIndex = newRoles?.phoneMonitorIndex;
        let newPhoneMonitorIndices = newRoles?.phoneMonitorIndices ?? [];
        let oldPrimaryDesktopMonitorIndex = oldRoles?.primaryDesktopMonitorIndex;
        let newPrimaryDesktopMonitorIndex = newRoles?.primaryDesktopMonitorIndex;
        let oldDesktopMonitors = oldRoles?.desktopMonitorIndices ?? [];
        let newDesktopMonitors = newRoles?.desktopMonitorIndices ?? [];
        let desktopTopologyChanged =
            !Number.isInteger(oldPrimaryDesktopMonitorIndex) !== !Number.isInteger(newPrimaryDesktopMonitorIndex) ||
            oldPrimaryDesktopMonitorIndex !== newPrimaryDesktopMonitorIndex ||
            oldDesktopMonitors.length !== newDesktopMonitors.length ||
            oldDesktopMonitors.some((monitorIndex, index) => monitorIndex !== newDesktopMonitors[index]);

        if (Number.isInteger(newPhoneMonitorIndex) && newPhoneMonitorIndex >= 0) {
            if (!this._phoneHomeScreen) {
                this._phoneHomeScreen = new HomeScreen(this._controller, {
                    monitorIndex: newPhoneMonitorIndex,
                });
                this._phoneHomeScreen.setSettings(this._settings);
            } else if (oldPhoneMonitorIndex !== newPhoneMonitorIndex) {
                this._phoneHomeScreen.refreshTopology?.(newPhoneMonitorIndex);
            }
        } else if (this._phoneHomeScreen) {
            this._phoneHomeScreen.destroy();
            this._phoneHomeScreen = null;
        }

        this._syncPhoneAuxiliarySurfaces(newPhoneMonitorIndices, newPhoneMonitorIndex);

        if (Number.isInteger(newPrimaryDesktopMonitorIndex) && newPrimaryDesktopMonitorIndex >= 0) {
            if (!this._desktopHomeScreen) {
                this._desktopHomeScreen = new HomeScreen(this._controller, {
                    monitorIndex: newPrimaryDesktopMonitorIndex,
                });
                this._desktopHomeScreen.setSettings(this._settings);
            } else if (oldPrimaryDesktopMonitorIndex !== newPrimaryDesktopMonitorIndex) {
                this._desktopHomeScreen.refreshTopology?.(newPrimaryDesktopMonitorIndex);
            }
        } else if (this._desktopHomeScreen) {
            this._desktopHomeScreen.destroy();
            this._desktopHomeScreen = null;
        }

        if (this._phoneHomeScreen && !this._phoneHomeScreen._visible)
            this._phoneHomeScreen.show();
        for (let entry of this._phoneHomeMirrors ?? []) {
            if (entry.homeScreen && !entry.homeScreen._visible)
                entry.homeScreen.show();
        }
        if (this._desktopHomeScreen && !this._desktopHomeScreen._visible)
            this._desktopHomeScreen.show();

        if (desktopTopologyChanged)
            this._syncDesktopHomeMirrors();
    }

    // ── Secondary home screens (one per non-primary desktop monitor) ──

    _syncPhoneAuxiliarySurfaces(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        this._syncPhoneHomeMirrors(phoneMonitorIndices, primaryPhoneMonitorIndex);
        this._syncPhoneStatusBarMirrors(phoneMonitorIndices, primaryPhoneMonitorIndex);
    }

    _syncPhoneAuxiliaryInteractiveSurfaces(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        this._syncPhoneGestureBarMirrors(phoneMonitorIndices, primaryPhoneMonitorIndex);
        this._syncPhoneAppDrawerMirrors(phoneMonitorIndices, primaryPhoneMonitorIndex);
        this._syncPhoneRecentAppsMirrors(phoneMonitorIndices, primaryPhoneMonitorIndex);
    }

    _syncPhoneHomeMirrors(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        let phoneMonitors = new Set(phoneMonitorIndices);
        let existing = new Map();
        for (let entry of this._phoneHomeMirrors ?? []) {
            if (Number.isInteger(entry?.monitorIndex) && entry?.homeScreen)
                existing.set(entry.monitorIndex, entry.homeScreen);
        }

        let next = [];
        for (let monitorIndex of phoneMonitors) {
            if (monitorIndex === primaryPhoneMonitorIndex)
                continue;

            let hs = existing.get(monitorIndex) ?? null;
            let isNewMirror = false;
            if (!hs) {
                hs = new HomeScreen(this._controller, { monitorIndex });
                hs.setSettings(this._settings);
                isNewMirror = true;
            } else {
                existing.delete(monitorIndex);
            }

            if (!isNewMirror)
                hs.relayout?.();
            hs.show?.();
            next.push({ monitorIndex, homeScreen: hs });
        }

        for (let stale of existing.values())
            stale.destroy?.();
        this._phoneHomeMirrors = next;
    }

    _syncPhoneStatusBarMirrors(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        let phoneMonitors = new Set(phoneMonitorIndices);
        let existing = new Map();
        for (let entry of this._phoneStatusBarMirrors ?? []) {
            if (Number.isInteger(entry?.monitorIndex) && entry?.statusBar)
                existing.set(entry.monitorIndex, entry.statusBar);
        }

        let next = [];
        for (let monitorIndex of phoneMonitors) {
            if (monitorIndex === primaryPhoneMonitorIndex)
                continue;

            let statusBar = existing.get(monitorIndex) ?? null;
            if (!statusBar) {
                statusBar = new StatusBar(this._controller, this._settings, {
                    monitorIndex,
                });
            } else {
                existing.delete(monitorIndex);
                statusBar.refreshTopology?.(monitorIndex);
            }

            next.push({ monitorIndex, statusBar });
        }

        for (let stale of existing.values())
            stale.destroy?.();
        this._phoneStatusBarMirrors = next;
    }

    _syncPhoneGestureBarMirrors(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        let phoneMonitors = new Set(phoneMonitorIndices);
        let existing = new Map();
        for (let entry of this._phoneGestureBarMirrors ?? []) {
            if (Number.isInteger(entry?.monitorIndex) && entry?.gestureBar)
                existing.set(entry.monitorIndex, entry.gestureBar);
        }

        let next = [];
        for (let monitorIndex of phoneMonitors) {
            if (monitorIndex === primaryPhoneMonitorIndex)
                continue;

            let gestureBar = existing.get(monitorIndex) ?? null;
            if (!gestureBar) {
                gestureBar = new GestureBar(this._controller, this._settings, {
                    monitorIndex,
                });
            } else {
                existing.delete(monitorIndex);
                gestureBar.refreshTopology?.(monitorIndex);
            }

            gestureBar.showBar?.();
            next.push({ monitorIndex, gestureBar });
        }

        for (let stale of existing.values())
            stale.destroy?.();
        this._phoneGestureBarMirrors = next;
    }

    _syncPhoneAppDrawerMirrors(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        let phoneMonitors = new Set(phoneMonitorIndices);
        let existing = new Map();
        for (let entry of this._phoneAppDrawerMirrors ?? []) {
            if (Number.isInteger(entry?.monitorIndex) && entry?.appDrawer)
                existing.set(entry.monitorIndex, entry.appDrawer);
        }

        let next = [];
        for (let monitorIndex of phoneMonitors) {
            if (monitorIndex === primaryPhoneMonitorIndex)
                continue;

            let appDrawer = existing.get(monitorIndex) ?? null;
            if (!appDrawer) {
                appDrawer = new AppDrawer(this._controller, this._settings, {
                    monitorIndex,
                });
            } else {
                existing.delete(monitorIndex);
                appDrawer.refreshTopology?.(monitorIndex);
            }

            appDrawer.show?.();
            next.push({ monitorIndex, appDrawer });
        }

        for (let stale of existing.values())
            stale.destroy?.();
        this._phoneAppDrawerMirrors = next;
    }

    _syncPhoneRecentAppsMirrors(phoneMonitorIndices = [], primaryPhoneMonitorIndex = null) {
        let phoneMonitors = new Set(phoneMonitorIndices);
        let existing = new Map();
        for (let entry of this._phoneRecentAppsMirrors ?? []) {
            if (Number.isInteger(entry?.monitorIndex) && entry?.recentApps)
                existing.set(entry.monitorIndex, entry.recentApps);
        }

        let next = [];
        for (let monitorIndex of phoneMonitors) {
            if (monitorIndex === primaryPhoneMonitorIndex)
                continue;

            let recentApps = existing.get(monitorIndex) ?? null;
            if (!recentApps) {
                recentApps = new RecentApps(this._controller, {
                    monitorIndex,
                });
            } else {
                existing.delete(monitorIndex);
                recentApps.refreshTopology?.(monitorIndex);
            }

            next.push({ monitorIndex, recentApps });
        }

        for (let stale of existing.values())
            stale.destroy?.();
        this._phoneRecentAppsMirrors = next;
    }

    _syncDesktopHomeMirrors() {
        if (!this._desktopWorkspaces) {
            this._destroyDesktopHomeMirrors();
            return;
        }

        let monitors = Main.layoutManager.monitors ?? [];
        let desktopMonitorIndices = new Set(
            this._monitorRoles?.desktopMonitorIndices ?? [Main.layoutManager.primaryIndex]);
        let primaryDesktopMonitorIndex = this._monitorRoles?.primaryDesktopMonitorIndex ?? Main.layoutManager.primaryIndex;

        let existing = new Map();
        for (let entry of this._desktopHomeMirrors ?? []) {
            if (Number.isInteger(entry?.monitorIndex) && entry?.homeScreen)
                existing.set(entry.monitorIndex, entry.homeScreen);
        }
        let next = [];

        for (let i = 0; i < monitors.length; i++) {
            if (i === primaryDesktopMonitorIndex)
                continue;
            if (!desktopMonitorIndices.has(i))
                continue;

            let hs = existing.get(i) ?? null;
            let isNewMirror = false;
            if (!hs) {
                hs = new HomeScreen(this._controller, { monitorIndex: i });
                hs.setSettings(this._settings);
                isNewMirror = true;
            } else {
                existing.delete(i);
            }
            if (!isNewMirror)
                hs.relayout?.();
            if (this._desktopHomeScreen?._visible)
                hs.show?.();
            else
                hs.hide?.();
            next.push({ monitorIndex: i, homeScreen: hs });
        }

        for (let stale of existing.values())
            stale.destroy?.();
        this._desktopHomeMirrors = next;
    }

    _destroyDesktopHomeMirrors() {
        if (!this._desktopHomeMirrors) return;
        for (let entry of this._desktopHomeMirrors)
            entry.homeScreen?.destroy?.();
        this._desktopHomeMirrors = [];
    }

    _destroyPhoneHomeMirrors() {
        if (!this._phoneHomeMirrors) return;
        for (let entry of this._phoneHomeMirrors)
            entry.homeScreen?.destroy?.();
        this._phoneHomeMirrors = [];
    }

    _destroyPhoneStatusBarMirrors() {
        if (!this._phoneStatusBarMirrors) return;
        for (let entry of this._phoneStatusBarMirrors)
            entry.statusBar?.destroy?.();
        this._phoneStatusBarMirrors = [];
    }

    _destroyPhoneGestureBarMirrors() {
        if (!this._phoneGestureBarMirrors) return;
        for (let entry of this._phoneGestureBarMirrors)
            entry.gestureBar?.destroy?.();
        this._phoneGestureBarMirrors = [];
    }

    _destroyPhoneAppDrawerMirrors() {
        if (!this._phoneAppDrawerMirrors) return;
        for (let entry of this._phoneAppDrawerMirrors)
            entry.appDrawer?.destroy?.();
        this._phoneAppDrawerMirrors = [];
    }

    _destroyPhoneRecentAppsMirrors() {
        if (!this._phoneRecentAppsMirrors) return;
        for (let entry of this._phoneRecentAppsMirrors)
            entry.recentApps?.destroy?.();
        this._phoneRecentAppsMirrors = [];
    }

    _destroyHomeSurfaces() {
        this._destroyPhoneStatusBarMirrors();
        this._destroyPhoneHomeMirrors();
        this._destroyDesktopHomeMirrors();
        if (this._desktopHomeScreen) {
            this._desktopHomeScreen.destroy();
            this._desktopHomeScreen = null;
        }
        if (this._phoneHomeScreen) {
            this._phoneHomeScreen.destroy();
            this._phoneHomeScreen = null;
        }
    }

    _teardownPhoneModules() {
        if (this._volumeOsd) {
            this._volumeOsd.destroy();
            this._volumeOsd = null;
        }
        if (this._convergenceKeyboard) {
            this._convergenceKeyboard.destroy();
            this._convergenceKeyboard = null;
        }
        if (this._haptics) {
            this._haptics.destroy();
            this._haptics = null;
        }
        if (this._bannerSwipe) {
            this._bannerSwipe.destroy();
            this._bannerSwipe = null;
        }
        if (this._splashScreen) {
            this._splashScreen.destroy();
            this._splashScreen = null;
        }
        if (this._recentApps) {
            this._recentApps.destroy();
            this._recentApps = null;
        }
        this._destroyPhoneRecentAppsMirrors();
        if (this._statusBar) {
            this._statusBar.destroy();
            this._statusBar = null;
        }
        this._destroyPhoneAppDrawerMirrors();
        if (this._drawerTests) {
            this._drawerTests.destroy();
            this._drawerTests = null;
        }
        if (this._appDrawer) {
            this._appDrawer.destroy();
            this._appDrawer = null;
        }
        if (this._phoneWorkspaces) {
            this._phoneWorkspaces.destroy();
            this._phoneWorkspaces = null;
        }
        if (this._edgeGestures) {
            this._edgeGestures.destroy();
            this._edgeGestures = null;
        }
        this._destroyPhoneGestureBarMirrors();
        if (this._gestureBar) {
            this._gestureBar.destroy();
            this._gestureBar = null;
        }
        if (this._windowStack) {
            this._windowStack.destroy();
            this._windowStack = null;
        }
        if (this._activitiesBtn) {
            this._activitiesBtn.container?.show?.();
            this._activitiesBtn = null;
        }
    }

    _teardownDesktopModules() {
        if (this._desktopNotifIcons) {
            this._desktopNotifIcons.destroy();
            this._desktopNotifIcons = null;
        }
        if (this._desktopTray) {
            this._desktopTray.destroy();
            this._desktopTray = null;
        }
        if (this._desktopWorkspaces) {
            this._desktopWorkspaces.destroy();
            this._desktopWorkspaces = null;
        }
        if (this._windowEffects) {
            this._windowEffects.destroy();
            this._windowEffects = null;
        }
        if (this._appMenu) {
            this._appMenu.destroy();
            this._appMenu = null;
        }
        if (this._taskbarAnimations) {
            this._taskbarAnimations.destroy();
            this._taskbarAnimations = null;
        }
        if (this._taskbarPreviews) {
            this._taskbarPreviews.destroy();
            this._taskbarPreviews = null;
        }
        if (this._taskbarIcons) {
            this._taskbarIcons.destroy();
            this._taskbarIcons = null;
        }
        if (this._taskbar) {
            this._taskbar.destroy();
            this._taskbar = null;
        }
    }

    // ── Relayout on monitor changes ──────────────────────────────────

    _relayout() {
        this._monitorRoles?.refresh?.();
        this._phoneHomeScreen?.relayout();
        for (let entry of this._phoneHomeMirrors ?? []) {
            entry.homeScreen?.relayout?.();
        }
        for (let entry of this._phoneStatusBarMirrors ?? []) {
            entry.statusBar?.relayout?.();
        }
        for (let entry of this._phoneGestureBarMirrors ?? []) {
            entry.gestureBar?.relayout?.();
        }
        for (let entry of this._phoneAppDrawerMirrors ?? []) {
            entry.appDrawer?.relayout?.();
        }
        for (let entry of this._phoneRecentAppsMirrors ?? []) {
            entry.recentApps?.relayout?.();
        }
        this._desktopHomeScreen?.relayout();
        for (let entry of this._desktopHomeMirrors ?? []) {
            entry.homeScreen?.relayout?.();
        }
        this._gestureBar?.relayout?.();
        this._statusBar?.relayout?.();
        this._appDrawer?.relayout?.();
        this._recentApps?.relayout?.();
        this._edgeGestures?.relayout?.();
        this._volumeOsd?.relayout?.();
        this._taskbar?.relayout?.();
        this._notificationPanel?.relayout?.();
    }

    _relayoutAfterIncrementalSync({
        phoneChanged = false,
        phoneGeometryHandledInRefresh = false,
        desktopChanged = false,
        phoneHomesChanged = false,
        desktopHomesChanged = false,
        notificationChanged = false,
        notificationGeometryHandledInRefresh = false,
    } = {}) {
        this._monitorRoles?.refresh?.();

        if (phoneHomesChanged || phoneChanged) {
            this._phoneHomeScreen?.relayout?.();
            for (let entry of this._phoneHomeMirrors ?? [])
                entry.homeScreen?.relayout?.();
            for (let entry of this._phoneStatusBarMirrors ?? [])
                entry.statusBar?.relayout?.();
            for (let entry of this._phoneGestureBarMirrors ?? [])
                entry.gestureBar?.relayout?.();
            for (let entry of this._phoneAppDrawerMirrors ?? [])
                entry.appDrawer?.relayout?.();
            for (let entry of this._phoneRecentAppsMirrors ?? [])
                entry.recentApps?.relayout?.();
        }

        if (desktopHomesChanged || desktopChanged) {
            this._desktopHomeScreen?.relayout?.();
            if (this._desktopWorkspaces)
                this._syncDesktopHomeMirrors();
        }

        if (phoneChanged && !phoneGeometryHandledInRefresh) {
            this._gestureBar?.relayout?.();
            this._statusBar?.relayout?.();
            this._appDrawer?.relayout?.();
            this._recentApps?.relayout?.();
            this._edgeGestures?.relayout?.();
        }

        if (desktopChanged)
            this._taskbar?.relayout?.();

        if (notificationChanged && !notificationGeometryHandledInRefresh)
            this._notificationPanel?.relayout?.();
    }

    _getHomeScreenForMonitor(monitorIndex) {
        let phoneHomeScreen = this._getPhoneHomeScreenForMonitor(monitorIndex);
        if (phoneHomeScreen)
            return phoneHomeScreen;

        if (Number.isInteger(monitorIndex) &&
            monitorIndex === (this._monitorRoles?.primaryDesktopMonitorIndex ?? -1))
            return this._desktopHomeScreen;

        for (let entry of this._desktopHomeMirrors ?? []) {
            if (entry.monitorIndex === monitorIndex)
                return entry.homeScreen;
        }

        return this._phoneHomeScreen ?? this._desktopHomeScreen ?? null;
    }

    _getPhoneHomeScreenForMonitor(monitorIndex) {
        if (Number.isInteger(monitorIndex) &&
            monitorIndex === (this._monitorRoles?.phoneMonitorIndex ?? -1))
            return this._phoneHomeScreen;

        for (let entry of this._phoneHomeMirrors ?? []) {
            if (entry.monitorIndex === monitorIndex)
                return entry.homeScreen;
        }

        return null;
    }

    _getPhoneStatusBarForMonitor(monitorIndex = null) {
        let resolvedMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (this._monitorRoles?.phoneMonitorIndex ?? -1);
        if (resolvedMonitorIndex === (this._monitorRoles?.phoneMonitorIndex ?? -1))
            return this._statusBar ?? null;

        for (let entry of this._phoneStatusBarMirrors ?? []) {
            if (entry.monitorIndex === resolvedMonitorIndex)
                return entry.statusBar;
        }

        return this._statusBar ?? null;
    }

    _getPhoneGestureBarForMonitor(monitorIndex = null) {
        let resolvedMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (this._monitorRoles?.phoneMonitorIndex ?? -1);
        if (resolvedMonitorIndex === (this._monitorRoles?.phoneMonitorIndex ?? -1))
            return this._gestureBar ?? null;

        for (let entry of this._phoneGestureBarMirrors ?? []) {
            if (entry.monitorIndex === resolvedMonitorIndex)
                return entry.gestureBar;
        }

        return this._gestureBar ?? null;
    }

    _getPhoneAppDrawerForMonitor(monitorIndex = null) {
        let resolvedMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (this._monitorRoles?.phoneMonitorIndex ?? -1);
        if (resolvedMonitorIndex === (this._monitorRoles?.phoneMonitorIndex ?? -1))
            return this._appDrawer ?? null;

        for (let entry of this._phoneAppDrawerMirrors ?? []) {
            if (entry.monitorIndex === resolvedMonitorIndex)
                return entry.appDrawer;
        }

        return this._appDrawer ?? null;
    }

    _getPhoneRecentAppsForMonitor(monitorIndex = null) {
        let resolvedMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (this._monitorRoles?.phoneMonitorIndex ?? -1);
        if (resolvedMonitorIndex === (this._monitorRoles?.phoneMonitorIndex ?? -1))
            return this._recentApps ?? null;

        for (let entry of this._phoneRecentAppsMirrors ?? []) {
            if (entry.monitorIndex === resolvedMonitorIndex)
                return entry.recentApps;
        }

        return this._recentApps ?? null;
    }

    _getPhoneTopInsetForMonitor(monitorIndex = null) {
        return Math.max(0, this._getPhoneStatusBarForMonitor(monitorIndex)?.height ?? 0);
    }

    _forEachPhoneHomeScreen(callback) {
        if (typeof callback !== 'function')
            return;
        if (this._phoneHomeScreen)
            callback(this._phoneHomeScreen, this._monitorRoles?.phoneMonitorIndex ?? null);
        for (let entry of this._phoneHomeMirrors ?? [])
            callback(entry.homeScreen, entry.monitorIndex);
    }

    _forEachPhoneAppDrawer(callback) {
        if (typeof callback !== 'function')
            return;
        if (this._appDrawer)
            callback(this._appDrawer, this._monitorRoles?.phoneMonitorIndex ?? null);
        for (let entry of this._phoneAppDrawerMirrors ?? [])
            callback(entry.appDrawer, entry.monitorIndex);
    }

    _forEachPhoneGestureBar(callback) {
        if (typeof callback !== 'function')
            return;
        if (this._gestureBar)
            callback(this._gestureBar, this._monitorRoles?.phoneMonitorIndex ?? null);
        for (let entry of this._phoneGestureBarMirrors ?? [])
            callback(entry.gestureBar, entry.monitorIndex);
    }

    _forEachPhoneStatusBar(callback) {
        if (typeof callback !== 'function')
            return;
        if (this._statusBar)
            callback(this._statusBar, this._monitorRoles?.phoneMonitorIndex ?? null);
        for (let entry of this._phoneStatusBarMirrors ?? [])
            callback(entry.statusBar, entry.monitorIndex);
    }

    _getPointerMonitorIndex() {
        let monitors = Main.layoutManager.monitors ?? [];
        if (monitors.length === 0)
            return Main.layoutManager.primaryIndex;

        let [x, y] = global.get_pointer?.() ?? [0, 0];
        for (let i = 0; i < monitors.length; i++) {
            let monitor = monitors[i];
            if (x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y && y < monitor.y + monitor.height)
                return i;
        }

        return Main.layoutManager.primaryIndex;
    }

    _monitorIndexForCoords(x, y) {
        let monitors = Main.layoutManager.monitors ?? [];
        for (let i = 0; i < monitors.length; i++) {
            let monitor = monitors[i];
            if (x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y && y < monitor.y + monitor.height)
                return i;
        }
        return Main.layoutManager.primaryIndex;
    }

    _getMonitorBounds(monitorIndex) {
        let monitors = Main.layoutManager.monitors ?? [];
        let resolvedIndex = Number.isInteger(monitorIndex) && monitorIndex >= 0 && monitorIndex < monitors.length
            ? monitorIndex
            : Main.layoutManager.primaryIndex;
        let monitor = monitors[resolvedIndex] ?? Main.layoutManager.primaryMonitor ?? monitors[0] ?? null;
        if (!monitor) {
            return {
                monitorIndex: resolvedIndex,
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
            };
        }
        return {
            monitorIndex: resolvedIndex,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        };
    }
}
