// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { populateDbusMenu, populateFallbackMenu, connectTrayInput } from '../tray_area/trayInputHandler.js';
import { ConvergenceQuickToggles, ToggleStateCache, QS_SETTINGS_MAP } from './convergenceQuickToggles.js';
import { DisplayMode, WidthTier } from '../utilities/displayConfig.js';
import { getAdaptiveScale, snapToPixel } from '../utilities/uiUtils.js';
import { RuntimeDisposer } from '../utilities/runtimeDisposer.js';

const PANEL_ANIM_MS = 250;
const BACKDROP_OPACITY = 160;
const SWIPE_THRESHOLD = 60;
const SWIPE_CLAIM_THRESHOLD = 12;
const LONG_PRESS_MS = 400;
const LONG_PRESS_MOVE_TOLERANCE = 30;
const COLLAPSED_ROWS = 1;
const NOTIF_SWIPE_DISMISS_THRESHOLD = 0.35;
const NOTIF_SWIPE_VELOCITY_THRESHOLD = 0.6; // px/ms — fast flick dismisses
const NOTIF_ACTION_REVEAL_MAX = 80; // px — max partial-swipe reveal
const BOTTOM_RUBBERBAND_MAX = 60; // px before transitioning to overscroll
const NOTIF_SWIPE_ANIM_MS = 200;
const EXPAND_ANIM_MS = 200;
const MENU_LAYOUT_ANIM_MS = 150;
const EDIT_COLUMNS = 6;
const EDIT_LONG_PRESS_MS = 400;
const EDIT_DRAG_THRESHOLD = 12;
const UNDO_TOAST_MS = 5000;
const SNOOZE_DEFAULT_MS = 3600000; // 1 hour
const PANEL_BASE_WIDTH = 432;
const PANEL_BASE_HEIGHT = 912;
const PANEL_SCALE_PHONE_KEY = 'notification-panel-scale-phone';
const PANEL_SCALE_DESKTOP_KEY = 'notification-panel-scale-desktop';

/**
 * NotificationPanel -- convergence quick settings and notification shade.
 *
 * Builds independent QS toggle buttons via ConvergenceQuickToggles that
 * mirror GNOME's toggle state without modifying the vanilla QS widgets.
 * Includes collapse/expand, brightness slider, notification list with
 * swipe-to-dismiss, edit/reorder mode, and progressive finger-tracking
 * open from the status bar.
 */
export class NotificationPanel {
    /**
     * @param {Object} controller - convergence controller instance
     * @param {Gio.Settings|null} settings - extension settings
     */
    constructor(controller, settings, trayManager, opts = {}) {
        this._controller = controller;
        this._settings = settings;
        this._trayManager = trayManager;
        this._monitorIndex = opts.monitorIndex ?? Main.layoutManager.primaryIndex ?? 0;
        this._hijackEnabled = opts.hijackEnabled ?? true;
        this._manageGlobalHooks = opts.manageGlobalHooks ?? this._hijackEnabled;
        this._isOpen = false;
        this._isExpanded = false;
        this._hijacked = false;
        this._origOpen = null;
        this._origClose = null;
        this._convergenceToggles = null;
        this._progressiveActive = false;
        this._signalDisposer = new RuntimeDisposer();
        this._scaleSignalDisposer = new RuntimeDisposer();
        this._notifSignalDisposer = new RuntimeDisposer();
        this._traySignalDisposer = new RuntimeDisposer();
        this._editSignalDisposer = new RuntimeDisposer();

        if (this._hijackEnabled) {
            this._signalDisposer.restartTimeout(
                this,
                '_initId',
                GLib.PRIORITY_DEFAULT,
                200,
                () => {
                    this._hijack();
                    return GLib.SOURCE_REMOVE;
                }
            );

            this._signalDisposer.replaceConnection(this, '_sessionModeId', Main.sessionMode, 'updated', () => {
                if (Main.sessionMode.currentMode === 'unlock-dialog' ||
                    Main.sessionMode.currentMode === 'lock-screen') {
                    if (this._isOpen) this.close();
                    this._unhijack();
                } else if (Main.sessionMode.currentMode === 'user' && !this._hijacked) {
                    this._scheduleRehijackRetry(300);
                }
            });

            this._lastMonitorW = 0;
            this._signalDisposer.replaceConnection(this, '_monitorsChangedId', Main.layoutManager, 'monitors-changed', () => {
                let monW = global.display?.get_monitor_geometry(0)?.width ?? 0;
                if (monW > 0 && monW !== this._lastMonitorW) {
                    this._lastMonitorW = monW;
                    if (this._isOpen) this.close();
                    this._unhijack();
                    this._scheduleRehijackRetry(500);
                }
            });
        } else {
            this._buildStandalone();
        }

        if (this._manageGlobalHooks) {
            this._setupScreencastNotification();
            this._wrapScreenshotOpen();
        }
        this._signalDisposer.replaceConnection(
            this,
            '_focusWindowChangedId',
            global.display,
            'notify::focus-window',
            () => this._onFocusWindowChanged()
        );
        this._connectScaleSettings();
    }

    /** Whether the panel is currently open. */
    get isOpen() {
        return this._isOpen;
    }

    // -- Hijack / unhijack GNOME quick settings --

    _hijack() {
        if (this._hijacked) return;
        let qs = Main.panel?.statusArea?.quickSettings;
        if (!qs?.menu) { this._scheduleHijackRetry(); return; }
        let menu = qs.menu;
        this._menu = menu;
        let proto = Object.getPrototypeOf(menu);
        this._origOpen = proto.open.bind(menu);
        this._origClose = proto.close.bind(menu);
        this._build();
        if (!this._overlay || !this._panel || !this._gridContainer) { this._scheduleHijackRetry(); return; }
        let panelW = this._panel.width;
        this._qsScale = this._panelScale ?? (panelW / PANEL_BASE_WIDTH);
        this._convergenceToggles = new ConvergenceQuickToggles({
            settings: this._settings,
            panelWidth: panelW,
            panelScale: this._qsScale,
            hostType: this._controller?.displayConfig?.hostType ?? null,
            haptics: this._controller?.haptics ?? null,
            onEditToggle: () => this._enterEditMode(),
            onHeightChanged: () => { this._recalcOverflow(); this._syncPanelHeight(); },
            onClosePanel: () => this.close(),
            getPanel: () => this._panel,
            getPanelMaxH: () => this._panelMaxH,
        });
        if (!this._convergenceToggles.populate(this._gridContainer)) {
            this._convergenceToggles.destroy();
            this._convergenceToggles = null;
            this._scheduleHijackRetry();
            return;
        }
        // Override the QS menu's open/close methods to redirect to our panel.
        // This prevents the vanilla QS menu from ever appearing.
        menu.open = (_animate) => {
            if (!this._hijacked) return;
            this.selectPointerMonitor();
            this.open();
        };
        menu.close = (_animate) => {
            if (!this._hijacked) return;
            if (this._isOpen) this.close();
        };
        this._setupCollapse();
        this._hijacked = true;
        this._signalDisposer.clearTimeoutRef(this, '_rehijackId');
    }

    _scheduleRehijackRetry(delayMs = 350) {
        this._signalDisposer.restartTimeout(
            this,
            '_rehijackId',
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._hijack();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scheduleHijackRetry() {
        if (!this._hijackEnabled)
            return;
        if (this._hijacked || this._rehijackId) return;
        this._scheduleRehijackRetry(350);
    }

    _buildStandalone() {
        this._build();
        if (!this._overlay || !this._panel || !this._gridContainer)
            return;
        let panelW = this._panel.width;
        this._qsScale = this._panelScale ?? (panelW / PANEL_BASE_WIDTH);
        this._convergenceToggles = new ConvergenceQuickToggles({
            settings: this._settings,
            panelWidth: panelW,
            panelScale: this._qsScale,
            hostType: this._controller?.displayConfig?.hostType ?? null,
            haptics: this._controller?.haptics ?? null,
            onEditToggle: () => this._enterEditMode(),
            onHeightChanged: () => { this._recalcOverflow(); this._syncPanelHeight(); },
            onClosePanel: () => this.close(),
            getPanel: () => this._panel,
            getPanelMaxH: () => this._panelMaxH,
        });
        if (!this._convergenceToggles.populate(this._gridContainer)) {
            this._convergenceToggles.destroy();
            this._convergenceToggles = null;
            return;
        }
        this._setupCollapse();
        this._hijacked = true;
    }

    _unhijack() {
        if (!this._hijacked) return;
        if (this._inEditMode) this._exitEditMode();
        this._teardownCollapse();
        // Restore original QS menu open/close methods
        if (this._menu && this._origOpen) {
            let proto = Object.getPrototypeOf(this._menu);
            this._menu.open = proto.open;
            this._menu.close = proto.close;
        }
        if (this._convergenceToggles) {
            this._convergenceToggles.destroy();
            this._convergenceToggles = null;
        }
        this._hijacked = false;
    }

    // -- UI build --

    /**
     * Compute panel geometry based on monitor size and width tier.
     * Phone tier: full-width centered.  Tablet+: inset and right-aligned.
     */
    _computePanelGeometry(monitor) {
        let panelH = Main.panel?.height ?? 0;
        let tier = this._controller?.displayConfig?.getWidthTier?.(this._monitorIndex)
            ?? this._controller?.displayConfig?.primaryWidthTier
            ?? WidthTier.PHONE;

        let adaptiveScale = getAdaptiveScale({
            profile: 'panel', monitor, logicalWidth: monitor.width,
            referenceWidth: PANEL_BASE_WIDTH, min: 0.9, max: 1.35,
        });
        let uiScale = adaptiveScale * this._getPanelScaleMultiplier();
        let maxPanelW = Math.round(PANEL_BASE_WIDTH * uiScale);
        let maxPanelH = Math.round(PANEL_BASE_HEIGHT * uiScale);
        let edgePad = Math.max(this._px(8, uiScale), Math.round(snapToPixel(16 * uiScale, monitor)));
        let panelW = Math.min(monitor.width, maxPanelW);
        let panelContentH = Math.min(monitor.height, maxPanelH) - panelH;
        let isInset = panelW < monitor.width;
        if (isInset) {
            panelW = Math.min(panelW, monitor.width - edgePad * 2);
            panelContentH = Math.min(panelContentH, monitor.height - panelH - edgePad);
        }

        let panelX;
        if (tier === WidthTier.PHONE) {
            panelW = Math.min(panelW, monitor.width);
            panelX = Math.round((monitor.width - panelW) / 2);
        } else {
            panelX = monitor.width - panelW - edgePad;
        }

        let radius = isInset ? this._px(24, uiScale) : 0;
        let panelY = isInset ? panelH + edgePad : panelH;
        if (isInset)
            panelContentH = Math.min(panelContentH, monitor.height - panelY - edgePad);

        return { panelX, panelY, panelW, panelContentH, radius, isInset, panelH, edgePad, uiScale };
    }

    _build() {
        this._signalDisposer.clearConnectionRef(this, '_stageCapturedEventId', global.stage);
        if (this._overlay) {
            Main.layoutManager.removeChrome(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
        }
        this._panel = null;
        this._backdrop = null;
        this._gridContainer = null;

        let monitor = this._getCurrentMonitor();
        if (!monitor) return;
        let geo = this._computePanelGeometry(monitor);

        this._overlay = new St.Widget({
            reactive: false, visible: false,
            x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height,
        });

        this._backdrop = new St.Widget({
            style_class: 'convergence-qs-backdrop',
            reactive: false, x: 0, y: 0,
            width: monitor.width, height: monitor.height, opacity: 0,
        });
        this._overlay.add_child(this._backdrop);

        this._panelMaxH = geo.panelContentH;
        this._panelScale = geo.uiScale;
        let panelStyle;
        if (geo.isInset) {
            panelStyle = `border-radius: ${geo.radius}px; background-color: rgba(24, 26, 32, 0.96);`;
        } else {
            let cornerRadius = 0;
            try { cornerRadius = this._settings?.get_int('window-corner-radius') ?? 0; } catch (_e) {}
            panelStyle = cornerRadius > 0
                ? `border-radius: ${this._px(cornerRadius, geo.uiScale)}px; background-color: rgba(24, 26, 32, 0.96);`
                : 'background-color: rgba(24, 26, 32, 0.96);';
        }

        this._panel = new St.BoxLayout({
            style_class: 'convergence-qs-panel',
            vertical: true, reactive: true,
            x: geo.panelX, y: geo.panelY, width: geo.panelW, height: geo.panelContentH,
            clip_to_allocation: true, style: panelStyle,
        });

        this._gridContainer = new St.BoxLayout({
            vertical: true, x_expand: true,
            clip_to_allocation: true,
            style_class: 'convergence-qs-grid-container',
        });
        this._panel.add_child(this._gridContainer);
        this._overlay.add_child(this._panel);
        this._applyPanelScaleStyles();

        this._swipeState = {
            active: false, startX: 0, startY: 0, lastY: 0,
            claimed: false, onQsGrid: false, direction: null,
            messageActor: null, overscrollAccum: 0,
            longPressFired: false, notifExpandTarget: false,
        };
        this._outsideClickPassThrough = geo.isInset;
        this._signalDisposer.replaceConnection(
            this,
            '_stageCapturedEventId',
            global.stage,
            'captured-event',
            (_a, event) => this._onCapturedEvent(event)
        );

        Main.layoutManager.addTopChrome(this._overlay);
        Main.layoutManager.uiGroup.set_child_below_sibling(
            this._overlay, Main.layoutManager.modalDialogGroup);
    }

    // -- Helper utilities --

    _isActorAlive(actor) {
        if (!actor) return false;
        try { actor.get_parent?.(); return true; } catch (_e) { return false; }
    }

    _isPointInsideActor(actor, x, y) {
        if (!this._isActorAlive(actor))
            return false;
        try {
            let [ax, ay] = actor.get_transformed_position();
            return x >= ax && x <= ax + actor.width && y >= ay && y <= ay + actor.height;
        } catch (_e) {
            return false;
        }
    }

    _isPointInQuickSettingsToggle(x, y) {
        let toggleActor = Main.panel?.statusArea?.quickSettings?.container ??
            Main.panel?.statusArea?.quickSettings;
        return this._isPointInsideActor(toggleActor, x, y);
    }

    _isPointInNotifIconsIndicator(x, y) {
        let indicator = Main.panel?.statusArea?.['convergence-desktop-notif-icons'];
        let actor = indicator?.container ?? indicator;
        return this._isPointInsideActor(actor, x, y);
    }

    _isTouchInNotifArea(x, y) {
        // Check notifContainer first, then notifScroll, then fall back to
        // checking if the touch is in the lower half of the panel.
        if (this._notifContainer?.visible && this._isPointInsideActor(this._notifContainer, x, y))
            return true;
        if (this._notifScroll?.visible && this._isPointInsideActor(this._notifScroll, x, y))
            return true;
        // Fallback: if touch is inside the panel and below the top 40%, treat as notif area
        if (this._panel) {
            try {
                let [px, py] = this._panel.get_transformed_position();
                let pH = this._panel.height;
                if (x >= px && x <= px + this._panel.width &&
                    y >= py + pH * 0.4 && y <= py + pH)
                    return true;
            } catch (_e) {}
        }
        return false;
    }

    _startNotifFling(velocity) {
        this._stopNotifFling();
        // Minimum fling velocity threshold (px/ms)
        if (Math.abs(velocity) < 0.15)
            return;
        let v = velocity; // px/ms, positive = scroll down (content moves up)
        const FRICTION = 0.97; // per-frame deceleration
        const FRAME_MS = 16; // ~60fps
        const MIN_V = 0.05; // stop threshold (px/ms)
        this._notifFlingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            let adj = this._notifScroll?.vadjustment ??
                this._notifScroll?.get_vscroll_bar?.()?.get_adjustment?.();
            if (!adj) {
                this._notifFlingId = 0;
                return GLib.SOURCE_REMOVE;
            }
            let upper = adj.upper - adj.page_size;
            if (upper <= adj.lower) {
                this._notifFlingId = 0;
                return GLib.SOURCE_REMOVE;
            }
            let delta = v * FRAME_MS;
            let newVal = adj.value + delta;
            if (newVal <= adj.lower || newVal >= upper) {
                newVal = Math.max(adj.lower, Math.min(upper, newVal));
                adj.set_value(newVal);
                this._notifFlingId = 0;
                return GLib.SOURCE_REMOVE;
            }
            adj.set_value(newVal);
            v *= FRICTION;
            if (Math.abs(v) < MIN_V) {
                this._notifFlingId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopNotifFling() {
        if (this._notifFlingId) {
            GLib.source_remove(this._notifFlingId);
            this._notifFlingId = 0;
        }
    }

    _resetSwipeState() {
        this._swipeState = {
            active: false, startX: 0, startY: 0, lastX: 0, lastY: 0,
            claimed: false, onQsGrid: false, direction: null,
            messageActor: null, overscrollAccum: 0, rubberbandAccum: 0,
            longPressFired: false, notifExpandTarget: false,
            actionBinNatH: 0, swipeVelocity: 0, swipeLastTime: 0,
            hSwipeVelocity: 0, hSwipeLastTime: 0,
            bodyClipH: 0, bodyNatH: 0,
            bottomBounceAccum: 0,
            outsidePanel: false, outsideClosing: false,
            outsideStartY: 0, inNotifScroll: false,
        };
    }

    _safeLayout() {
        try {
            let grid = this._convergenceToggles?.grid;
            if (!this._isActorAlive(grid)) return null;
            return grid.layout_manager ?? null;
        } catch (_e) { return null; }
    }

    _syncBrightnessRowVisibility() {
        if (!this._brightnessRow)
            return;

        let available = this._convergenceToggles?.brightnessAvailable ?? false;
        this._brightnessRow.visible = available && this._isExpanded;
    }

    _syncVolumeRowVisibility() {
        if (!this._volumeRow)
            return;

        let available = this._convergenceToggles?.volumeAvailable ?? false;
        this._volumeRow.visible = available && this._isExpanded;
    }

    _syncExpandedSliderRowsVisibility() {
        this._syncVolumeRowVisibility();
        this._syncBrightnessRowVisibility();
    }

    _px(value, scale = null) {
        let s = scale ?? this._qsScale ?? this._panelScale ?? 1;
        return Math.max(1, Math.round(value * s));
    }

    _getPanelScaleMultiplier() {
        let mode = this._controller?.displayConfig?.getDisplayMode?.(this._monitorIndex)
            ?? this._controller?.displayConfig?.primaryDisplayMode
            ?? DisplayMode.PHONE;
        let key = mode === DisplayMode.DESKTOP || mode === DisplayMode.TV
            ? PANEL_SCALE_DESKTOP_KEY
            : PANEL_SCALE_PHONE_KEY;
        try {
            let percent = this._settings?.get_int(key) ?? 100;
            return Math.max(0.5, Math.min(2.0, percent / 100));
        } catch (_e) {
            return key === PANEL_SCALE_DESKTOP_KEY ? 0.9 : 1.0;
        }
    }

    _getCurrentMonitor() {
        let monitors = Main.layoutManager.monitors ?? [];
        return monitors[this._monitorIndex] ?? Main.layoutManager.primaryMonitor ?? monitors[0] ?? null;
    }

    _getPointerMonitorIndex() {
        try {
            let [x, y] = global.get_pointer();
            if (typeof global.display?.get_monitor_at_point === 'function')
                return global.display.get_monitor_at_point(x, y);
            let monitors = Main.layoutManager.monitors ?? [];
            for (let i = 0; i < monitors.length; i++) {
                let m = monitors[i];
                if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                    return i;
            }
        } catch (_e) {}
        return Main.layoutManager.primaryIndex ?? 0;
    }

    _getPreferredPhoneMonitorIndex() {
        let snapshots = this._controller?.displayConfig?.getMonitorSnapshots?.() ?? [];
        for (let snapshot of snapshots) {
            if (snapshot.isBuiltin)
                return snapshot.index;
        }
        for (let snapshot of snapshots) {
            if (snapshot.mode === DisplayMode.PHONE || snapshot.mode === DisplayMode.TABLET)
                return snapshot.index;
        }
        return Main.layoutManager.primaryIndex ?? 0;
    }

    _isDesktopLikeMode() {
        let mode = this._controller?.displayConfig?.getDisplayMode?.(this._monitorIndex)
            ?? this._controller?.displayConfig?.primaryDisplayMode
            ?? DisplayMode.PHONE;
        return mode === DisplayMode.DESKTOP || mode === DisplayMode.TV;
    }

    _onFocusWindowChanged() {
        if (!this._isOpen || !this._isDesktopLikeMode())
            return;

        let focusWindow = global.display?.get_focus_window?.() ?? null;
        if (!focusWindow)
            return;

        let windowMonitor = focusWindow.get_monitor?.();
        if (Number.isInteger(windowMonitor) && windowMonitor !== this._monitorIndex)
            return;

        this.close();
    }

    _retargetMonitor(index) {
        let normalized = Number.isInteger(index) ? index : Main.layoutManager.primaryIndex ?? 0;
        if (normalized === this._monitorIndex)
            return;
        let wasOpen = this._isOpen;
        if (wasOpen)
            this.close();
        this._monitorIndex = normalized;
        this._unhijack();
        if (this._hijackEnabled)
            this._hijack();
        else
            this._buildStandalone();
    }

    selectPointerMonitor() {
        this._retargetMonitor(this._getPointerMonitorIndex());
    }

    selectPhoneMonitor(monitorIndex = null) {
        this._retargetMonitor(
            Number.isInteger(monitorIndex)
                ? monitorIndex
                : this._getPreferredPhoneMonitorIndex()
        );
    }

    _connectScaleSettings() {
        if (!this._settings?.connect)
            return;
        for (let key of [PANEL_SCALE_PHONE_KEY, PANEL_SCALE_DESKTOP_KEY]) {
            try {
                this._scaleSignalDisposer.connect(this._settings, `changed::${key}`, () => {
                    this._rebuildScaledPanel();
                });
            } catch (_e) {}
        }
    }

    _disconnectScaleSettings() {
        this._scaleSignalDisposer?.dispose?.();
        this._scaleSignalDisposer = new RuntimeDisposer();
    }

    _rebuildScaledPanel() {
        if (!this._hijacked)
            return;
        if (this._isOpen)
            this.close();
        this._unhijack();
        this._hijack();
    }

    _applyPanelScaleStyles() {
        if (!this._panel)
            return;
        if (this._gridContainer)
            this._gridContainer.style = `padding: ${this._px(16)}px;`;
    }

    _styleNotificationSubtree(actor) {
        if (!actor)
            return;
        let s = this._qsScale ?? this._panelScale ?? 1;

        let setStyle = style => {
            try { actor.style = style; } catch (_e) {}
        };

        if (actor.has_style_class_name?.('message-close-button')) {
            setStyle('min-width: 0; min-height: 0; max-width: 0; max-height: 0; padding: 0; margin: 0;');
        }

        // Zero out padding/margin on all wrapper layers so notifications
        // fill the panel width.  GNOME's theme adds generous spacing on
        // message-list-section, notification-group, message-group, etc.
        if (actor.has_style_class_name?.('message-list-section') ||
            actor.has_style_class_name?.('message-list-section-list') ||
            actor.has_style_class_name?.('notification-group') ||
            actor.has_style_class_name?.('message-notification-group') ||
            actor.has_style_class_name?.('message-group')) {
            setStyle('padding: 0; margin: 0; spacing: 0;');
            try { actor.x_expand = true; } catch (_e) {}
        }

        // Scale notification card padding and margins to match panel width
        if (actor.has_style_class_name?.('message')) {
            try { actor.x_expand = true; } catch (_e) {}
            setStyle(
                `background-color: rgb(39, 41, 48); border: none; box-shadow: none; ` +
                `color: rgba(255, 255, 255, 0.9); ` +
                `margin: 0 0 ${this._px(6, s)}px 0; ` +
                `padding: ${this._px(8, s)}px ${this._px(10, s)}px; ` +
                `border-radius: ${this._px(12, s)}px;`);
        }
        if (actor.has_style_class_name?.('message-content')) {
            setStyle(`padding: ${this._px(4, s)}px 0; margin: 0; spacing: ${this._px(4, s)}px;`);
        }
        if (actor.has_style_class_name?.('message-icon-bin')) {
            setStyle(`padding: ${this._px(4, s)}px ${this._px(8, s)}px ${this._px(4, s)}px 0; margin: 0;`);
        }
        if (actor.has_style_class_name?.('message-title') ||
            actor.has_style_class_name?.('message-body')) {
            setStyle(`font-size: ${this._px(13, s)}px; padding: 0; margin: 0;`);
        }
        if (actor.has_style_class_name?.('message-source-title') ||
            actor.has_style_class_name?.('event-time')) {
            setStyle(`font-size: ${this._px(11, s)}px; padding: 0; margin: 0;`);
        }
        if (actor.has_style_class_name?.('message-source-icon')) {
            setStyle(`padding: 0; margin: 0 ${this._px(4, s)}px 0 0;`);
        }

        let nChildren = actor.get_n_children?.() ?? 0;
        for (let i = 0; i < nChildren; i++)
            this._styleNotificationSubtree(actor.get_child_at_index(i));
    }

    _refreshNotificationScale() {
        let s = this._qsScale ?? this._panelScale ?? 1;
        this._applyPanelScaleStyles();

        if (this._chevron?.child)
            this._chevron.child.icon_size = this._px(16, s);
        if (this._chevron)
            this._chevron.style = `padding: ${this._px(4, s)}px ${this._px(24, s)}px; min-width: ${this._px(48, s)}px; min-height: ${this._px(18, s)}px; border-radius: ${this._px(999, s)}px;`;
        if (this._chevronRow)
            this._chevronRow.style = `padding: 0 ${this._px(20, s)}px;`;
        if (this._notifContainer)
            this._notifContainer.style = `margin: 0 ${this._px(16, s)}px ${this._px(8, s)}px ${this._px(16, s)}px;`;
        if (this._notifHeader)
            this._notifHeader.style = `padding: ${this._px(8, s)}px ${this._px(4, s)}px;`;
        if (this._notifHeaderLabel)
            this._notifHeaderLabel.style = `font-size: ${this._px(13, s)}px;`;
        if (this._notifClearBtn)
            this._notifClearBtn.style = `font-size: ${this._px(13, s)}px; padding: ${this._px(3, s)}px ${this._px(14, s)}px; border-radius: ${this._px(999, s)}px; min-height: 0; min-width: 0;`;
        if (this._notifScroll)
            this._notifScroll.style = `min-height: ${this._px(80, s)}px; padding: 0; margin: 0;`;
        if (this._notifPlaceholder) {
            this._notifPlaceholder.style = `background-color: transparent; border-radius: ${this._px(16, s)}px; padding: ${this._px(12, s)}px ${this._px(16, s)}px; margin-bottom: ${this._px(6, s)}px;`;
        }
        if (this._notifPlaceholderLabel)
            this._notifPlaceholderLabel.style = `font-size: ${this._px(13, s)}px; padding: ${this._px(32, s)}px 0;`;
        if (this._trayCard)
            this._trayCard.style = `border-radius: ${this._px(16, s)}px; padding: ${this._px(12, s)}px ${this._px(16, s)}px; margin-bottom: ${this._px(6, s)}px;`;
        if (this._trayTitleLabel)
            this._trayTitleLabel.style = `font-size: ${this._px(13, s)}px;`;
        if (this._trayIconsBox)
            this._trayIconsBox.style = `spacing: ${this._px(8, s)}px; padding: ${this._px(8, s)}px 0 ${this._px(4, s)}px 0;`;
        if (this._trayIconsBox) {
            for (let child of this._trayIconsBox.get_children())
                child.style = `border-radius: ${this._px(12, s)}px; padding: ${this._px(8, s)}px;`;
        }

        this._styleNotificationSubtree(this._notifMessageView);
    }

    _scheduleNotificationScaleRefresh() {
        if (this._notifScaleRefreshId)
            return;
        this._notifScaleRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            let currentId = this._notifScaleRefreshId;
            this._notifSignalDisposer.untrackTimeout(currentId);
            this._notifScaleRefreshId = 0;
            this._refreshNotificationScale();
            return GLib.SOURCE_REMOVE;
        });
        this._notifSignalDisposer.trackTimeout(this._notifScaleRefreshId);
    }

    // -- Collapse / Expand --

    _setupCollapse() {
        if (!this._convergenceToggles) return;
        this._isExpanded = false;
        this._overflowItems = [];

        // Brightness row from convergence toggles
        this._volumeRow = this._convergenceToggles.volumeRow;
        if (this._volumeRow) {
            this._gridContainer.add_child(this._volumeRow);
            this._syncVolumeRowVisibility();
        }

        this._brightnessRow = this._convergenceToggles.brightnessRow;
        if (this._brightnessRow) {
            this._gridContainer.add_child(this._brightnessRow);
            this._syncExpandedSliderRowsVisibility();
        }

        this._chevron = new St.Button({
            style_class: 'convergence-qs-chevron',
            child: new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 16 }),
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
        });
        this._chevron.connect('clicked', () => {
            this._controller?.haptics?.vibrate(10);
            this._toggleExpand();
        });

        this._chevronRow = new St.BoxLayout({
            x_expand: true, y_expand: false,
            style: 'padding: 0 20px;',
        });
        this._chevronRow.add_child(this._chevron);
        this._panel.add_child(this._chevronRow);

        this._buildNotificationList();
        this._recalcOverflow();
        this._refreshNotificationScale();
    }

    _teardownCollapse() {
        if (this._overflowItems) {
            for (let actor of this._overflowItems)
                actor.visible = true;
            this._overflowItems = [];
        }
        if (this._gridContainer)
            this._gridContainer.set_height(-1);
        this._volumeRow = null;
        this._brightnessRow = null;
        if (this._chevronRow) { this._chevronRow.destroy(); this._chevronRow = null; }
        this._chevron = null;
        this._destroyNotificationList();
    }

    _toggleExpand() {
        this._isExpanded = !this._isExpanded;
        if (this._chevron?.child)
            this._chevron.child.icon_name = this._isExpanded ? 'pan-up-symbolic' : 'pan-down-symbolic';

        let gc = this._gridContainer;
        if (!gc) {
            for (let actor of (this._overflowItems ?? []))
                actor.visible = this._isExpanded;
            this._syncExpandedSliderRowsVisibility();
            this._syncEditBtnVisible();
            this._syncPanelHeight();
            return;
        }

        let panel = this._panel;
        let maxH = this._panelMaxH || 1100;

        if (this._isExpanded) {
            // Expand: measure collapsed, show items, measure expanded, animate both
            let collapsedGcH = gc.height;
            let collapsedPanelH = panel?.height ?? 0;
            for (let actor of (this._overflowItems ?? []))
                if (!actor?._hiddenByUser) actor.visible = true;
            this._syncExpandedSliderRowsVisibility();
            this._syncEditBtnVisible();
            gc.set_height(-1);
            let expandedGcH = gc.get_preferred_height(-1)?.[1] ?? collapsedGcH;
            gc.height = collapsedGcH;

            // Calculate target panel height
            let targetPanelH;
            {
                let contentH = 0;
                for (let i = 0; i < panel.get_n_children(); i++) {
                    let ch = panel.get_child_at_index(i);
                    if (!ch.visible) continue;
                    if (ch === gc) contentH += expandedGcH;
                    else if (ch.y_expand) contentH += ch.get_preferred_height(-1)?.[1] ?? ch.height;
                    else contentH += ch.height;
                }
                targetPanelH = Math.max(200, Math.min(contentH + 16, maxH));
            }

            gc.ease({
                height: expandedGcH,
                duration: EXPAND_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    gc.set_height(-1);
                    this._syncPanelHeight();
                },
            });
            if (panel) {
                panel.remove_all_transitions();
                panel.ease({
                    height: targetPanelH,
                    duration: EXPAND_ANIM_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        } else {
            // Collapse: measure expanded, calculate collapsed, animate both
            let expandedGcH = gc.height;
            let expandedPanelH = panel?.height ?? 0;
            gc.set_height(-1);
            for (let actor of (this._overflowItems ?? []))
                actor.visible = false;
            this._syncExpandedSliderRowsVisibility();
            this._convergenceToggles?.setEditCellVisible(false);
            let collapsedGcH = gc.get_preferred_height(-1)?.[1] ?? expandedGcH;
            // Show items again for the duration of the animation
            for (let actor of (this._overflowItems ?? []))
                if (!actor?._hiddenByUser) actor.visible = true;
            this._syncExpandedSliderRowsVisibility();
            this._convergenceToggles?.setEditCellVisible(true);
            gc.height = expandedGcH;

            // Calculate target panel height
            let targetPanelH;
            {
                let contentH = 0;
                for (let i = 0; i < panel.get_n_children(); i++) {
                    let ch = panel.get_child_at_index(i);
                    if (!ch.visible) continue;
                    if (ch === gc) contentH += collapsedGcH;
                    else if (ch.y_expand) contentH += ch.get_preferred_height(-1)?.[1] ?? ch.height;
                    else contentH += ch.height;
                }
                targetPanelH = Math.max(200, Math.min(contentH + 16, maxH));
            }

            gc.ease({
                height: collapsedGcH,
                duration: EXPAND_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    for (let actor of (this._overflowItems ?? []))
                        actor.visible = false;
                    this._syncExpandedSliderRowsVisibility();
                    this._syncEditBtnVisible();
                    gc.set_height(-1);
                    // Snap panel to correct height now that gc has its final size
                    this._syncPanelHeight();
                },
            });
            if (panel) {
                panel.remove_all_transitions();
                panel.ease({
                    height: targetPanelH,
                    duration: EXPAND_ANIM_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        }
    }

    /** Ensure the overlay renders above the status bar panel corners. */
    _raiseOverlayAboveCorners() {
        // Raise the panel corners above the notification overlay so
        // the corners are always visible on top of the panel content.
        let statusBars = this._controller?.phoneStatusBars ?? [];
        if (!this._overlay) return;
        for (let sb of statusBars) {
            let parent = sb?._panelCornerLeft?.get_parent?.();
            if (parent && sb._panelCornerLeft)
                parent.set_child_above_sibling(sb._panelCornerLeft, null);
            parent = sb?._panelCornerRight?.get_parent?.();
            if (parent && sb._panelCornerRight)
                parent.set_child_above_sibling(sb._panelCornerRight, null);
        }
    }

    _syncEditBtnVisible() {
        let vis = this._isExpanded && !this._inEditMode;
        this._convergenceToggles?.setEditCellVisible(vis);
    }

    _recalcOverflow() {
        if (!this._convergenceToggles) return;
        this._overflowItems = this._convergenceToggles.recalcOverflow(COLLAPSED_ROWS);
        for (let actor of this._overflowItems)
            actor.visible = this._isExpanded;
        if (this._chevron)
            this._chevron.visible = true;
        this._syncEditBtnVisible();
    }

    // -- Notification list --

    _buildNotificationList() {
        this._notifMessageView = new MessageList.MessageView();
        this._notifMessageView.style = 'padding: 0; margin: 0;';
        this._notifScroll = new St.ScrollView({
            style_class: 'convergence-qs-notif-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true, overlay_scrollbars: true,
            child: this._notifMessageView,
        });
        this._notifScroll.style = 'padding: 0; margin: 0;';
        let vscroll = this._notifScroll.get_vscroll_bar?.();
        if (vscroll) vscroll.hide();

        // Placeholder matching notification card dimensions but transparent
        let s = this._qsScale ?? 1;
        let cardPadV = Math.round(12 * s);
        let cardPadH = Math.round(16 * s);
        this._notifPlaceholder = new St.BoxLayout({
            x_expand: true, y_expand: false,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: transparent; border-radius: ${Math.round(16 * s)}px; padding: ${cardPadV}px ${cardPadH}px; margin-bottom: ${Math.round(6 * s)}px;`,
        });
        this._notifPlaceholderLabel = new St.Label({
            style_class: 'convergence-qs-notif-placeholder',
            text: 'No notifications', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        this._notifPlaceholder.add_child(this._notifPlaceholderLabel);

        this._notifContainer = new St.BoxLayout({
            style_class: 'convergence-qs-notif-container',
            vertical: true, x_expand: true, y_expand: false,
        });

        this._notifHeader = new St.BoxLayout({
            style_class: 'convergence-qs-notif-header', x_expand: true,
        });
        this._notifHeaderLabel = new St.Label({
            style_class: 'convergence-qs-notif-header-label',
            text: 'Notifications', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notifClearBtn = new St.Button({
            style_class: 'convergence-qs-notif-clear-btn',
            label: 'Clear all', y_align: Clutter.ActorAlign.CENTER,
        });
        this._notifClearBtn.connect('clicked', () => {
            this._controller?.haptics?.vibrate(10);
            this._clearUndoToast();
            this._clearDismissibleNotifications();
        });
        this._notifHeader.add_child(this._notifHeaderLabel);
        this._notifHeader.add_child(this._notifClearBtn);

        this._notifContainer.add_child(this._notifHeader);
        this._buildTrayNotification();
        this._notifContainer.add_child(this._notifScroll);
        this._notifContainer.add_child(this._notifPlaceholder);
        this._panel.add_child(this._notifContainer);

        try {
            this._notifSignalDisposer.connect(this._notifMessageView, 'child-added', () => {
                this._scheduleNotificationScaleRefresh();
                if (this._isOpen) {
                    this._sortNotificationsByPriority();
                    this._applyOngoingNotifStyle();
                    this._setupGroupHeaderTaps();
                    this._autoExpandFirstNotifGroup(true);
                }
            });
        } catch (_e) {}
        try {
            this._notifSignalDisposer.connect(this._notifMessageView, 'child-removed', () => {
                this._scheduleNotificationScaleRefresh();
                if (this._isOpen) this._autoExpandFirstNotifGroup(true);
            });
        } catch (_e) {}

        this._syncNotifEmpty();
        this._notifSignalDisposer.connect(
            this._notifMessageView, 'notify::empty', () => this._syncNotifEmpty());

        // Mock notifications for testing
        this._mockSources = null;
        if (this._settings?.settings_schema?.has_key?.('debug-mock-notifications')) {
            this._notifSignalDisposer.connect(this._settings,
                'changed::debug-mock-notifications', () => this._syncMockNotifications());
            this._syncMockNotifications();
        }
    }

    _syncNotifEmpty() {
        let empty = this._notifMessageView?.empty ?? true;
        // After dismissals, MessageView.empty may be stale because we
        // hide groups without destroying them.  Only override when we
        // have actually dismissed something (pendingDismissSources > 0
        // or all children are hidden).
        if (!empty && this._pendingDismissSources?.size > 0 && this._notifMessageView) {
            let hasVisible = false;
            let n = this._notifMessageView.get_n_children();
            for (let i = 0; i < n; i++) {
                let child = this._notifMessageView.get_child_at_index(i);
                if (child.visible) {
                    hasVisible = true;
                    break;
                }
            }
            if (!hasVisible) empty = true;
        }
        if (this._notifScroll) this._notifScroll.visible = !empty;
        if (this._notifPlaceholder) this._notifPlaceholder.visible = empty;
        if (this._notifClearBtn) this._notifClearBtn.visible = !empty;
        if (this._notifContainer) this._notifContainer.y_expand = !empty;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshNotificationScale();
            this._syncPanelHeight();
            return GLib.SOURCE_REMOVE;
        });
    }

    // -- Mock notifications for testing --

    _syncMockNotifications() {
        let enabled = this._settings.get_boolean('debug-mock-notifications');
        if (enabled)
            this._injectMockNotifications();
        else
            this._removeMockNotifications();
    }

    _injectMockNotifications() {
        this._removeMockNotifications();
        this._mockSources = [];

        const mocks = [
            {
                sourceTitle: 'Messages',
                sourceIcon: 'chat-message-new-symbolic',
                notifications: [
                    { title: 'Alice', body: 'Hey, are you free tonight?' },
                ],
            },
            {
                sourceTitle: 'Email',
                sourceIcon: 'mail-unread-symbolic',
                notifications: [
                    { title: 'Meeting Tomorrow', body: 'Reminder: standup at 10am in Room 3B.' },
                    { title: 'Invoice #4021', body: 'Your invoice for March is ready to download.' },
                    { title: 'Welcome to the team!', body: 'Hi there, just wanted to say welcome aboard. Looking forward to working with you on the new project.' },
                ],
            },
            {
                sourceTitle: 'News',
                sourceIcon: 'application-rss+xml-symbolic',
                notifications: [
                    {
                        title: 'Breaking: Major Update Released',
                        body: 'GNOME Shell 50 has been released with significant improvements to the quick settings panel, notification system, and overall performance. The update includes new APIs for extension developers and better touchscreen support across all form factors.',
                    },
                ],
            },
            {
                sourceTitle: 'System',
                sourceIcon: 'dialog-warning-symbolic',
                notifications: [
                    {
                        title: 'Low Battery',
                        body: '15% remaining. Connect charger soon.',
                        urgency: MessageTray.Urgency.CRITICAL,
                    },
                ],
            },
            {
                sourceTitle: 'Calendar',
                sourceIcon: 'x-office-calendar-symbolic',
                notifications: [
                    {
                        title: 'Lunch with Bob',
                        body: 'Starts in 15 minutes at Café Roma',
                        actions: [['Dismiss', null], ['Snooze', null]],
                    },
                ],
            },
            {
                sourceTitle: 'Music',
                sourceIcon: 'audio-headphones-symbolic',
                notifications: [
                    { title: 'Now Playing', body: 'Daft Punk \u2014 Around the World' },
                ],
            },
            {
                sourceTitle: 'Phone',
                sourceIcon: 'call-missed-symbolic',
                notifications: [
                    { title: 'Missed Call', body: '+44 7700 900123 (2 minutes ago)' },
                ],
            },
            {
                sourceTitle: 'Downloads',
                sourceIcon: 'folder-download-symbolic',
                notifications: [
                    { title: 'Download Complete', body: 'linux-firmware-2026.tar.xz (148 MB)' },
                ],
            },
            {
                sourceTitle: 'Social',
                sourceIcon: 'user-available-symbolic',
                notifications: [
                    { title: 'Charlie liked your post', body: 'Great photo from the hike yesterday!' },
                    { title: 'Dana commented', body: 'Wow, where is this? I need to visit!' },
                ],
            },
            {
                sourceTitle: 'Navigation',
                sourceIcon: 'find-location-symbolic',
                notifications: [
                    {
                        title: 'Navigating to Work',
                        body: '12 min \u2014 4.2 km via A40',
                        resident: true,
                        actions: [['Stop', null]],
                    },
                ],
            },
            {
                sourceTitle: 'Reminders',
                sourceIcon: 'alarm-symbolic',
                notifications: [
                    { title: 'Take out the bins', body: '', useTimestamp: true },
                ],
            },
            {
                sourceTitle: 'Updates',
                sourceIcon: 'software-update-available-symbolic',
                notifications: [
                    {
                        title: 'System Update Available',
                        body: '3 packages ready to install (48 MB)',
                        actions: [['Later', null], ['Details', null], ['Install', null]],
                    },
                ],
            },
            {
                sourceTitle: 'Screenshot',
                sourceIcon: 'screenshot-recorded-symbolic',
                notifications: [
                    {
                        title: 'Screenshot Captured',
                        body: 'Saved to ~/Pictures/Screenshots',
                        isTransient: true,
                    },
                ],
            },
            {
                sourceTitle: 'Phone',
                sourceIcon: 'call-start-symbolic',
                notifications: [
                    {
                        title: 'Incoming Call',
                        body: 'John Smith',
                        urgency: MessageTray.Urgency.CRITICAL,
                        resident: true,
                        actions: [['Decline', null], ['Answer', null]],
                    },
                ],
            },
        ];

        for (let mock of mocks) {
            let source = new MessageTray.Source({
                title: mock.sourceTitle,
                iconName: mock.sourceIcon,
            });
            Main.messageTray.add(source);
            this._mockSources.push(source);

            for (let n of mock.notifications) {
                let params = {
                    source,
                    title: n.title,
                    body: n.body || '',
                };
                if (n.urgency !== undefined)
                    params.urgency = n.urgency;
                if (n.useTimestamp)
                    params.datetime = GLib.DateTime.new_now_local();

                let notification = new MessageTray.Notification(params);

                if (n.resident)
                    notification.resident = true;
                if (n.isTransient)
                    notification.isTransient = true;

                notification.acknowledged = true;

                if (n.actions) {
                    for (let [label] of n.actions)
                        notification.addAction(label, () => {});
                }

                source.addNotification(notification);
            }
        }
    }

    _removeMockNotifications() {
        if (!this._mockSources) return;
        for (let source of this._mockSources) {
            try { source.destroy(); } catch (_e) {}
        }
        this._mockSources = null;
    }

    _syncPanelHeight() {
        if (!this._panel) return;
        if (this._progressiveActive) return;
        let maxH = this._panelMaxH || 1100;
        let contentH = 0;
        for (let i = 0; i < this._panel.get_n_children(); i++) {
            let ch = this._panel.get_child_at_index(i);
            if (!ch.visible) continue;
            // Expanding children (notification area) report minimal allocated
            // height; use their preferred height so the panel sizes correctly.
            let h = ch.y_expand
                ? (ch.get_preferred_height(-1)?.[1] ?? ch.height)
                : ch.height;
            contentH += h;
        }
        this._panel.height = Math.max(200, Math.min(contentH + 16, maxH));
    }

    _destroyNotificationList() {
        this._removeMockNotifications();
        this._notifSignalDisposer.clearTimeoutRef(this, '_notifScaleRefreshId');
        this._notifSignalDisposer?.dispose?.();
        this._notifSignalDisposer = new RuntimeDisposer();
        this._destroyTrayNotification();
        if (this._notifContainer) { this._notifContainer.destroy(); this._notifContainer = null; }
        this._notifMessageView = null;
        this._notifScroll = null;
        this._notifPlaceholder = null;
        this._notifPlaceholderLabel = null;
        this._notifHeader = null;
        this._notifHeaderLabel = null;
        this._notifClearBtn = null;
        this._trayTitleLabel = null;
    }

    // -- Tray area notification (SNI watcher + AppIndicator fallback) --

    _buildTrayNotification() {
        if (!this._settings) return;
        let enabled = true;
        try { enabled = this._settings.get_boolean('tray-notification-enabled'); } catch (_) {}
        if (!enabled) return;

        this._trayCard = new St.BoxLayout({
            style_class: 'convergence-tray-notification',
            vertical: true, x_expand: true, reactive: true,
        });
        let titleRow = new St.BoxLayout({ x_expand: true });
        this._trayTitleLabel = new St.Label({
            text: 'Tray area',
            style_class: 'convergence-tray-notification-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(this._trayTitleLabel);
        this._trayCard.add_child(titleRow);
        this._trayIconsBox = new St.BoxLayout({
            style_class: 'convergence-tray-notification-icons',
            x_expand: true, x_align: Clutter.ActorAlign.START,
        });
        this._trayCard.add_child(this._trayIconsBox);
        this._notifContainer.insert_child_at_index(this._trayCard, 1);

        if (this._trayManager) {
            this._traySignalDisposer.connect(this._trayManager, 'items-changed',
                () => this._rebuildTrayIcons());
        }
        this._traySignalDisposer.connect(
            this._settings, 'changed::tray-notification-enabled', () => {
                let on = this._settings.get_boolean('tray-notification-enabled');
                if (this._trayCard) this._trayCard.visible = on && (this._trayManager?.items?.size > 0);
            });
    }

    _destroyTrayNotification() {
        this._traySignalDisposer?.dispose?.();
        this._traySignalDisposer = new RuntimeDisposer();
        this._trayMenuManager = null;
        this._trayIconsBox = null;
        if (this._trayCard) { this._trayCard.destroy(); this._trayCard = null; }
    }

    _rebuildTrayIcons() {
        if (!this._trayIconsBox) return;
        // Clean up existing menus
        for (let child of this._trayIconsBox.get_children()) {
            if (child._trayMenu) child._trayMenu.destroy();
        }
        this._trayIconsBox.destroy_all_children();

        let items = this._trayManager?.items;
        if (!items || items.size === 0) {
            if (this._trayCard) this._trayCard.visible = false;
            return;
        }

        let scale = this._qsScale ?? 1;
        let iconSize = Math.round(24 * scale);

        for (let [itemId, entry] of items) {
            // Fallback items (from AppIndicator)
            if (entry.fallbackIndicator) {
                let fallbackIconSize = Math.round(18 * scale);
                let iconParams = { icon_size: fallbackIconSize };
                if (entry.gicon)
                    iconParams.gicon = entry.gicon;
                else if (entry.iconName)
                    iconParams.icon_name = entry.iconName;
                else
                    continue;

                let btn = new St.Button({
                    style_class: 'convergence-tray-icon-btn',
                    child: new St.Icon(iconParams),
                    reactive: true, can_focus: true,
                    accessible_name: entry.title || itemId,
                });

                let indicator = entry.fallbackIndicator;
                let fallbackMenu = new PopupMenu.PopupMenu(btn, 0.0, St.Side.TOP);
                Main.uiGroup.add_child(fallbackMenu.actor);
                fallbackMenu.actor.hide();
                btn._trayMenu = fallbackMenu;
                if (!this._trayMenuManager)
                    this._trayMenuManager = new PopupMenu.PopupMenuManager(this._trayCard);
                this._trayMenuManager.addMenu(fallbackMenu);

                connectTrayInput(btn, entry, {
                    haptics: this._controller?.haptics,
                    onMenu: () => {
                        populateFallbackMenu(fallbackMenu, indicator);
                        if (fallbackMenu.isOpen) fallbackMenu.close();
                        else fallbackMenu.open();
                    },
                });

                this._trayIconsBox.add_child(btn);
                continue;
            }

            // SNI items — use TrayManager's cached icon data
            let title;
            try { title = entry.proxy?.Title || entry.proxy?.Id || itemId; } catch (_) { title = itemId; }

            let iconInfo = this._trayManager.getIconContent(itemId, iconSize);
            let iconWidget;
            if (iconInfo?.iconName) {
                iconWidget = new St.Icon({ icon_name: iconInfo.iconName, icon_size: iconSize });
            } else if (iconInfo?.gicon) {
                iconWidget = new St.Icon({ gicon: iconInfo.gicon, icon_size: iconSize });
            } else if (iconInfo?.content) {
                iconWidget = new St.Icon();
                iconWidget.set({
                    content: iconInfo.content,
                    width: iconSize, height: iconSize,
                    contentGravity: Clutter.ContentGravity.RESIZE_ASPECT,
                });
            } else {
                iconWidget = new St.Icon({
                    icon_name: 'application-x-executable-symbolic',
                    icon_size: iconSize,
                });
            }

            let btn = new St.Button({
                style_class: 'convergence-tray-icon-btn',
                child: iconWidget,
                reactive: true, can_focus: true,
                accessible_name: title,
            });

            let busName = entry.busName;
            let objPath = entry.objPath;
            let menuPath = '';
            try { menuPath = entry.proxy?.Menu || ''; } catch (_) {}

            let menu = new PopupMenu.PopupMenu(btn, 0.0, St.Side.TOP);
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            btn._trayMenu = menu;
            if (!this._trayMenuManager)
                this._trayMenuManager = new PopupMenu.PopupMenuManager(this._trayCard);
            this._trayMenuManager.addMenu(menu);

            connectTrayInput(btn, entry, {
                haptics: this._controller?.haptics,
                onMenu: () => {
                    if (menuPath) {
                        populateDbusMenu(menu, busName, menuPath, () => {
                            if (menu.numMenuItems > 0)
                                menu.open();
                        });
                    }
                },
            });

            this._trayIconsBox.add_child(btn);
        }

        if (this._trayCard) {
            let settingsOn = true;
            try { settingsOn = this._settings?.get_boolean('tray-notification-enabled') ?? true; } catch (_) {}
            this._trayCard.visible = settingsOn && items.size > 0;
        }
        this._refreshNotificationScale();
    }

    // -- Captured event --

    _onCapturedEvent(event) {
        if (!this._isOpen && !this._progressiveActive && !this._progressiveCloseActive)
            return Clutter.EVENT_PROPAGATE;
        // During progressive open, the status bar owns the gesture —
        // don't intercept or we'll steal the release event.
        if (this._progressiveActive)
            return Clutter.EVENT_PROPAGATE;
        if (this._inEditMode) return Clutter.EVENT_PROPAGATE;
        let type = event.type();
        let s = this._swipeState;

        if (type === Clutter.EventType.TOUCH_BEGIN || type === Clutter.EventType.BUTTON_PRESS) {
            let [x, y] = event.get_coords();
            if (this._isOpen && this._panel) {
                if (!this._isPointInsideActor(this._panel, x, y)) {
                    if (type === Clutter.EventType.BUTTON_PRESS &&
                        !this._isPointInQuickSettingsToggle(x, y) &&
                        !this._isPointInNotifIconsIndicator(x, y)) {
                        this.close();
                        return this._outsideClickPassThrough
                            ? Clutter.EVENT_PROPAGATE
                            : Clutter.EVENT_STOP;
                    }
                    s.outsidePanel = true; s.outsideStartY = y;
                    return Clutter.EVENT_STOP;
                }
            }
            s.outsidePanel = false;
            s.inNotifScroll = this._isTouchInNotifArea(x, y);
            if (s.inNotifScroll)
                this._stopNotifFling();
            s.active = true; s.claimed = false;
            s.startX = x; s.startY = y; s.lastX = x; s.lastY = y;
            s.direction = null; s.messageActor = null;
            s.overscrollAccum = 0; s.bottomBounceAccum = 0;
            s.swipeVelocity = 0; s.swipeLastTime = GLib.get_monotonic_time();
            s.hSwipeVelocity = 0; s.hSwipeLastTime = GLib.get_monotonic_time();
            // Start long-press timer for notifications
            if (s.inNotifScroll)
                this._startNotifLongPress(x, y);
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCH_UPDATE || type === Clutter.EventType.MOTION) {
            if (s.outsidePanel) {
                let [, y] = event.get_coords();
                let dy = y - (s.outsideStartY ?? y);
                if (dy > SWIPE_CLAIM_THRESHOLD && !this._isExpanded && this._overflowItems?.length) {
                    this._toggleExpand();
                    s.outsidePanel = false;
                    return Clutter.EVENT_STOP;
                }
                // Progressive close when swiping up on the backdrop
                let upDy = (s.outsideStartY ?? y) - y;
                if (upDy > SWIPE_CLAIM_THRESHOLD) {
                    if (!s.outsideClosing) {
                        s.outsideClosing = true;
                        this.progressiveCloseBegin();
                    }
                    let panelH = this._progressiveClosePanelH || this._panel?.height || 300;
                    let progress = Math.max(0, Math.min(1, upDy / panelH));
                    this.progressiveCloseUpdate(progress);
                }
                return Clutter.EVENT_STOP;
            }
            if (!s.active) return Clutter.EVENT_PROPAGATE;
            let [x, y] = event.get_coords();
            let dy = s.startY - y;
            let dx = x - s.startX;

            // Cancel long-press if moved too far
            if (Math.abs(dx) > LONG_PRESS_MOVE_TOLERANCE ||
                Math.abs(dy) > LONG_PRESS_MOVE_TOLERANCE)
                this._cancelNotifLongPress();

            // ── Direction detection ──
            if (!s.direction) {
                let adx = Math.abs(dx), ady = Math.abs(dy);
                if (adx < SWIPE_CLAIM_THRESHOLD && ady < SWIPE_CLAIM_THRESHOLD)
                    return Clutter.EVENT_PROPAGATE;
                this._cancelNotifLongPress();
                if (s.inNotifScroll) {
                    if (adx > ady) {
                        // Horizontal in notif area — swipe-to-dismiss
                        s.direction = 'notif-h-swipe';
                        s.messageActor = this._findMessageActorAt(s.startX, s.startY);
                        // Block swipe-dismiss on pinned notifications
                        if (s.messageActor?.notification === this._screencastNotification)
                            s.messageActor = null;
                        if (!s.messageActor)
                            s.direction = 'notif-scroll';
                    } else {
                        // Vertical in notif area — check for expand/collapse/snooze
                        let targetMsg = this._findMessageActorAt(s.startX, s.startY);
                        let canExpandCollapse = false;
                        if (targetMsg) {
                            let isExp = targetMsg.get_style_pseudo_class()?.includes('expanded');
                            let hasActions = targetMsg.notification?.actions?.length > 0;
                            if ((!isExp && dy < 0 && hasActions) || (isExp && dy > 0)) {
                                s.direction = 'notif-v-expand';
                                s.messageActor = targetMsg;
                                s.notifExpandTarget = !isExp;
                                let ab = this._findChildByStyleClass(targetMsg, 'message-action-bin');
                                if (ab && !isExp) {
                                    ab.visible = true;
                                    ab.clip_to_allocation = true;
                                    s.actionBinNatH = ab.get_preferred_height(-1)[1];
                                    ab.set_height(0);
                                    targetMsg.add_style_pseudo_class('expanded');
                                    let eb = this._findChildByStyleClass(targetMsg, 'message-expand-button');
                                    if (eb) eb.checked = true;
                                    // Progressive body text reveal
                                    let body = this._findChildByStyleClass(targetMsg, 'message-body');
                                    if (body) {
                                        s.bodyNatH = body.get_preferred_height(-1)[1];
                                        s.bodyClipH = body.height;
                                        body.clip_to_allocation = true;
                                    }
                                } else if (ab && isExp) {
                                    ab.clip_to_allocation = true;
                                    s.actionBinNatH = ab.height;
                                }
                                canExpandCollapse = true;
                            }
                        }
                        if (!canExpandCollapse) {
                            if (dy > 0 && this._isExpanded) {
                                this._toggleExpand();
                                s.direction = null;
                                s.active = false;
                                return Clutter.EVENT_STOP;
                            }
                            // If already at bottom and swiping up, dismiss panel
                            if (dy > 0) {
                                let adj = this._notifScroll?.vadjustment ??
                                    this._notifScroll?.get_vscroll_bar?.()?.get_adjustment?.();
                                if (adj) {
                                    let upper = adj.upper - adj.page_size;
                                    if (upper > adj.lower && adj.value >= upper - 1) {
                                        s.direction = 'qs-up';
                                        s.claimed = true;
                                        return Clutter.EVENT_STOP;
                                    }
                                }
                            }
                            s.direction = 'notif-scroll';
                        }
                    }
                    s.claimed = true;
                    s.scrollVelocity = 0;
                    s.scrollLastTime = GLib.get_monotonic_time();
                } else {
                    s.direction = dy > 0 ? 'qs-up' : 'qs-down';
                    s.claimed = true;
                }
            }

            // ── Notification: vertical scroll ──
            if (s.direction === 'notif-scroll') {
                let now = GLib.get_monotonic_time();
                let deltaY = s.lastY - y;
                let dt = (now - (s.scrollLastTime || now)) / 1000; // ms
                s.lastY = y;
                s.scrollLastTime = now;
                if (dt > 0 && dt < 200) {
                    let instantV = deltaY / dt;
                    s.scrollVelocity = s.scrollVelocity
                        ? s.scrollVelocity * 0.3 + instantV * 0.7
                        : instantV;
                }
                let adj = this._notifScroll?.vadjustment ??
                    this._notifScroll?.get_vscroll_bar?.()?.get_adjustment?.();
                if (adj) {
                    let upper = adj.upper - adj.page_size;
                    let hasScrollableContent = upper > adj.lower;
                    // At bottom and swiping up — rubber-band then overscroll
                    if (hasScrollableContent && deltaY > 0 && adj.value >= upper - 1) {
                        s.direction = 'notif-rubberband-bottom';
                        s.bottomBounceAccum = deltaY;
                        return Clutter.EVENT_STOP;
                    }
                    // At top and swiping down — rubber-band bounce
                    if (hasScrollableContent && deltaY < 0 && adj.value <= adj.lower + 1) {
                        if (!this._isExpanded && this._overflowItems?.length) {
                            this._toggleExpand();
                            s.direction = null;
                            s.active = false;
                            s.scrollVelocity = 0;
                        } else {
                            // Rubber-band at top
                            s.direction = 'notif-rubberband-top';
                            s.rubberbandAccum = Math.abs(deltaY);
                        }
                        return Clutter.EVENT_STOP;
                    }
                    if (hasScrollableContent) {
                        let newVal = Math.max(adj.lower, Math.min(upper, adj.value + deltaY));
                        adj.set_value(newVal);
                    }
                }
                return Clutter.EVENT_STOP;
            }

            // ── Notification: bottom rubber-band (bounce only, no dismiss) ──
            if (s.direction === 'notif-rubberband-bottom') {
                let deltaY = s.lastY - y;
                s.lastY = y;
                if (deltaY < 0) {
                    s.direction = 'notif-scroll';
                    this._notifScroll?.ease({
                        translation_y: 0, duration: 200,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                    return Clutter.EVENT_STOP;
                }
                s.bottomBounceAccum += deltaY;
                // Dampen stretch — capped, never transitions to dismiss
                let stretch = s.bottomBounceAccum * 0.35;
                let clamped = Math.min(stretch, BOTTOM_RUBBERBAND_MAX);
                if (this._notifScroll)
                    this._notifScroll.translation_y = -clamped;
                return Clutter.EVENT_STOP;
            }

            // ── Notification: rubber-band bounce at top ──
            if (s.direction === 'notif-rubberband-top') {
                let deltaY = s.lastY - y;
                s.lastY = y;
                if (deltaY > 0) {
                    s.direction = 'notif-scroll';
                    this._notifScroll?.ease({
                        translation_y: 0, duration: 200,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                    return Clutter.EVENT_STOP;
                }
                s.rubberbandAccum += Math.abs(deltaY);
                let stretch = s.rubberbandAccum * 0.4;
                let clamped = Math.min(stretch, 80);
                if (this._notifScroll)
                    this._notifScroll.translation_y = clamped;
                return Clutter.EVENT_STOP;
            }

            // ── Notification: horizontal swipe to dismiss ──
            if (s.direction === 'notif-h-swipe' && s.messageActor) {
                // Track horizontal velocity
                let now = GLib.get_monotonic_time();
                let dt = (now - (s.hSwipeLastTime || now)) / 1000;
                s.hSwipeLastTime = now;
                if (dt > 0 && dt < 200) {
                    let instantV = (x - s.lastX) / dt;
                    s.hSwipeVelocity = s.hSwipeVelocity
                        ? s.hSwipeVelocity * 0.3 + instantV * 0.7
                        : instantV;
                }
                s.lastX = x;

                s.messageActor.translation_x = dx;
                let w = s.messageActor.width || 1;
                let progress = Math.abs(dx) / w;
                s.messageActor.opacity = Math.round(
                    255 * Math.max(0, 1 - progress * 1.2));

                // Show/update background action indicator
                this._updateSwipeActionIndicator(s.messageActor, dx);
                return Clutter.EVENT_STOP;
            }

            // ── Notification: vertical expand/collapse ──
            if (s.direction === 'notif-v-expand' && s.messageActor) {
                let absDy = Math.abs(dy);
                let natH = s.actionBinNatH || 39;
                let progress = Math.max(0, Math.min(1, absDy / natH));
                let actionBin = this._findChildByStyleClass(s.messageActor, 'message-action-bin');
                if (actionBin) {
                    if (s.notifExpandTarget) {
                        actionBin.set_height(Math.round(natH * progress));
                    } else {
                        actionBin.set_height(Math.round(natH * (1 - progress)));
                    }
                }
                // Progressive body text reveal
                if (s.notifExpandTarget && s.bodyNatH > 0) {
                    let body = this._findChildByStyleClass(s.messageActor, 'message-body');
                    if (body) {
                        let bodyProgress = Math.min(1, absDy / (natH * 0.5));
                        let targetBodyH = s.bodyClipH + (s.bodyNatH - s.bodyClipH) * bodyProgress;
                        body.set_height(Math.round(targetBodyH));
                    }
                }
                return Clutter.EVENT_STOP;
            }

            // ── QS up: panel dismiss ──
            if (s.direction === 'qs-up') {
                let now = GLib.get_monotonic_time();
                let dt = (now - (s.swipeLastTime || now)) / 1000;
                s.swipeLastTime = now;
                if (dt > 0 && dt < 200) {
                    let instantV = (s.lastY - y) / dt;
                    s.swipeVelocity = s.swipeVelocity
                        ? s.swipeVelocity * 0.3 + instantV * 0.7
                        : instantV;
                }
                s.lastY = y;
                let clampedDy = Math.max(0, dy);
                this._panel.translation_y = -clampedDy;
                let panelH2 = this._panel.height || 300;
                let progress = 1 - Math.min(1, clampedDy / panelH2);
                this._backdrop.opacity = Math.round(progress * BACKDROP_OPACITY);
                return Clutter.EVENT_STOP;
            }

            // ── QS down: expand toggles with finger tracking ──
            if (s.direction === 'qs-down') {
                let downDy = Math.max(0, y - s.startY);
                if (downDy > SWIPE_THRESHOLD && !this._isExpanded && this._overflowItems?.length) {
                    this._toggleExpand();
                    s.direction = null;
                    s.active = false;
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.BUTTON_RELEASE) {
            if (s.outsidePanel) {
                if (s.outsideClosing) {
                    let [, y] = event.get_coords();
                    let upDy = (s.outsideStartY ?? y) - y;
                    s.outsideClosing = false;
                    s.outsidePanel = false;
                    this.progressiveCloseEnd(upDy > SWIPE_THRESHOLD);
                } else {
                    s.outsidePanel = false;
                    this.close();
                }
                return Clutter.EVENT_STOP;
            }
            if (!s.active) return Clutter.EVENT_PROPAGATE;
            s.active = false;
            this._cancelNotifLongPress();
            let direction = s.direction;
            let messageActor = s.messageActor;
            let notifExpandTarget = s.notifExpandTarget;

            // ── Notification horizontal swipe release ──
            if (direction === 'notif-h-swipe' && messageActor) {
                let [x2] = event.get_coords();
                let dx = x2 - s.startX;
                let w = messageActor.width || 1;
                let fraction = Math.abs(dx) / w;
                let hVelocity = Math.abs(s.hSwipeVelocity || 0);

                this._removeSwipeActionIndicator(messageActor);

                if (fraction >= NOTIF_SWIPE_DISMISS_THRESHOLD || hVelocity > NOTIF_SWIPE_VELOCITY_THRESHOLD) {
                    // Dismiss (via threshold or velocity)
                    this._dismissWithUndo(messageActor);
                } else if (fraction > 0.05 && fraction < 0.2 && hVelocity < 0.15) {
                    // Partial swipe — reveal action buttons inline
                    let revealX = dx > 0 ? NOTIF_ACTION_REVEAL_MAX : -NOTIF_ACTION_REVEAL_MAX;
                    messageActor.ease({
                        translation_x: revealX,
                        opacity: 255,
                        duration: NOTIF_SWIPE_ANIM_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                    this._showPartialSwipeActions(messageActor, dx > 0);
                } else {
                    // Snap back
                    messageActor.ease({
                        translation_x: 0,
                        opacity: 255,
                        duration: NOTIF_SWIPE_ANIM_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                }
                return Clutter.EVENT_STOP;
            }

            // ── Notification vertical expand/collapse release ──
            if (direction === 'notif-v-expand' && messageActor) {
                let [, y2] = event.get_coords();
                let dy2 = s.startY - y2;
                let absDy = Math.abs(dy2);
                let natH = s.actionBinNatH || 39;
                let commitThreshold = natH * 0.3;
                let actionBin = this._findChildByStyleClass(messageActor, 'message-action-bin');
                s.actionBinNatH = 0;

                let resetBody = () => {
                    let body = this._findChildByStyleClass(messageActor, 'message-body');
                    if (body) { body.clip_to_allocation = false; body.set_height(-1); }
                };

                if (absDy >= commitThreshold) {
                    if (actionBin) {
                        let targetH = notifExpandTarget ? natH : 0;
                        actionBin.ease({
                            height: targetH, duration: 150,
                            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                            onComplete: () => {
                                actionBin.clip_to_allocation = false;
                                resetBody();
                                if (notifExpandTarget) {
                                    actionBin.set_height(-1);
                                    this._autoExpandFirstNotifGroup(true);
                                } else {
                                    this._collapseMessage(messageActor, false);
                                    actionBin.set_height(-1);
                                }
                            },
                        });
                    }
                } else {
                    if (actionBin) {
                        let snapH = notifExpandTarget ? 0 : natH;
                        actionBin.ease({
                            height: snapH, duration: 150,
                            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                            onComplete: () => {
                                actionBin.clip_to_allocation = false;
                                resetBody();
                                if (notifExpandTarget)
                                    this._collapseMessage(messageActor, false);
                                actionBin.set_height(-1);
                            },
                        });
                    }
                }
                return Clutter.EVENT_STOP;
            }

            // ── Notification scroll release ──
            if (direction === 'notif-scroll') {
                let velocity = s.scrollVelocity || 0;
                this._startNotifFling(velocity);
                return Clutter.EVENT_STOP;
            }

            // ── Rubber-band top bounce release ──
            if (direction === 'notif-rubberband-top') {
                this._controller?.haptics?.vibrate(5);
                this._notifScroll?.ease({
                    translation_y: 0, duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                return Clutter.EVENT_STOP;
            }

            // ── Rubber-band bottom bounce release ──
            if (direction === 'notif-rubberband-bottom') {
                this._controller?.haptics?.vibrate(5);
                this._notifScroll?.ease({
                    translation_y: 0, duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                return Clutter.EVENT_STOP;
            }

            // ── QS up release (velocity-aware) ──
            if (direction === 'qs-up') {
                let [, y2] = event.get_coords();
                let dy2 = s.startY - y2;
                let velocity = s.swipeVelocity || 0;
                // Dismiss if past threshold OR if fast enough flick
                if (dy2 > SWIPE_THRESHOLD || velocity > 0.8)
                    this.close();
                else
                    this._snapOpen();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCH_CANCEL) {
            this._cancelNotifLongPress();
            if (s.outsideClosing) {
                s.outsideClosing = false;
                this.progressiveCloseEnd(false);
            }
            if (s.direction === 'notif-rubberband-top' || s.direction === 'notif-rubberband-bottom') {
                this._notifScroll?.ease({
                    translation_y: 0, duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
            if (s.direction === 'notif-h-swipe' && s.messageActor)
                this._removeSwipeActionIndicator(s.messageActor);
            s.outsidePanel = false; s.active = false;
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // -- Notification long-press --

    _startNotifLongPress(x, y) {
        this._cancelNotifLongPress();
        this._notifLongPressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            this._notifLongPressId = 0;
            let s = this._swipeState;
            if (s && !s.direction && !s.longPressFired) {
                s.longPressFired = true;
                s.active = false;
                let messageActor = this._findMessageActorAt(x, y);
                if (messageActor) {
                    this._controller?.haptics?.vibrate(20);
                    this._openNotificationSettings(messageActor);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelNotifLongPress() {
        if (this._notifLongPressId) {
            GLib.source_remove(this._notifLongPressId);
            this._notifLongPressId = 0;
        }
    }

    // -- Edit / Reorder mode --

    _enterEditMode() {
        if (this._inEditMode) return;
        this._inEditMode = true;
        this._syncEditBtnVisible();

        // Build active/hidden lists from ConvergenceQuickToggles
        this._editActiveList = [];
        this._editHiddenList = [];
        let hiddenIds = this._settings?.get_strv('qs-hidden-toggles') ?? [];
        let toggleInfoList = this._convergenceToggles?.getToggleInfoList() ?? [];
        for (let info of toggleInfoList) {
            if (hiddenIds.includes(info.toggleId))
                this._editHiddenList.push(info);
            else
                this._editActiveList.push(info);
        }

        // Hide normal QS content
        if (this._gridContainer) this._gridContainer.visible = false;
        this._syncExpandedSliderRowsVisibility();
        if (this._chevronRow) this._chevronRow.visible = false;
        if (this._notifContainer) this._notifContainer.visible = false;

        this._buildEditUI();
    }

    _exitEditMode() {
        if (!this._inEditMode) return;
        this._inEditMode = false;

        // Persist order
        let activeIds = this._editActiveList?.map(i => i.toggleId) ?? [];
        let hiddenIds = this._editHiddenList?.map(i => i.toggleId) ?? [];
        if (this._convergenceToggles)
            this._convergenceToggles.persistOrder(activeIds, hiddenIds);

        // Destroy edit UI
        this._editSignalDisposer?.dispose?.();
        this._editSignalDisposer = new RuntimeDisposer();
        if (this._editContainer) {
            this._editContainer.destroy();
            this._editContainer = null;
        }
        this._editActiveGrid = null;
        this._editHiddenGrid = null;
        this._editDivider = null;
        this._editActiveList = null;
        this._editHiddenList = null;

        // Restore normal QS content
        if (this._gridContainer) this._gridContainer.visible = true;
        this._syncExpandedSliderRowsVisibility();
        if (this._chevronRow) this._chevronRow.visible = true;
        if (this._notifContainer) this._notifContainer.visible = true;

        if (this._convergenceToggles)
            this._convergenceToggles.applySavedOrder();
        this._recalcOverflow();
        this._syncEditBtnVisible();
        this._syncPanelHeight();
    }

    _buildEditUI() {
        let scale = (this._panel?.width ?? 540) / 432;

        this._editContainer = new St.ScrollView({
            style_class: 'convergence-qs-edit-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true, y_expand: true,
            overlay_scrollbars: true,
        });
        let vscroll = this._editContainer.get_vscroll_bar?.();
        if (vscroll) vscroll.hide();

        let content = new St.BoxLayout({
            vertical: true, x_expand: true,
            style_class: 'convergence-qs-edit-content',
        });
        let editPadSide = Math.round(8 * scale);
        content.style = `padding-left: ${editPadSide}px; padding-right: ${editPadSide}px;`;

        // Header: "Reorder" + Done button
        let header = new St.BoxLayout({
            style_class: 'convergence-qs-edit-header',
            x_expand: true,
        });
        let headerLabel = new St.Label({
            text: 'Reorder',
            style_class: 'convergence-qs-edit-header-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let doneBtn = new St.Button({
            style_class: 'convergence-qs-notif-clear-btn',
            label: 'Done',
            y_align: Clutter.ActorAlign.CENTER,
        });
        doneBtn.connect('clicked', () => this._exitEditMode());
        header.add_child(headerLabel);
        header.add_child(doneBtn);
        content.add_child(header);

        // Active grid (GridLayout)
        this._editActiveGrid = new St.Widget({
            style_class: 'convergence-qs-edit-grid',
            x_expand: true,
            layout_manager: new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
            }),
        });
        this._editActiveGrid.layout_manager.column_homogeneous = true;
        content.add_child(this._editActiveGrid);

        // Divider
        this._editDivider = new St.BoxLayout({
            style_class: 'convergence-qs-edit-divider',
            x_expand: true,
        });
        this._editDivider.add_child(new St.Label({
            text: 'Available toggles',
            style_class: 'convergence-qs-edit-divider-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        content.add_child(this._editDivider);

        // Hidden grid (FlowLayout)
        let contentPad = editPadSide * 2;
        this._editCellWidth = Math.floor(((this._panel?.width ?? 540) - contentPad) / EDIT_COLUMNS);
        this._editHiddenGrid = new St.Widget({
            style_class: 'convergence-qs-edit-grid',
            x_expand: true,
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                homogeneous: false,
                snap_to_grid: true,
            }),
        });
        content.add_child(this._editHiddenGrid);

        this._syncEditHiddenVisibility();

        this._editContainer.child = content;
        this._panel.add_child(this._editContainer);

        this._renderEditGrid(this._editActiveGrid, this._editActiveList, false);
        this._renderEditGrid(this._editHiddenGrid, this._editHiddenList, true);
        this._syncEditHiddenVisibility();
        content.style = `padding: ${this._px(8)}px ${editPadSide}px ${this._px(24)}px ${editPadSide}px; spacing: ${this._px(8)}px;`;
        this._editDivider.style = `padding: ${this._px(12)}px ${this._px(12)}px ${this._px(4)}px ${this._px(12)}px;`;

        this._setupEditDnD();
    }

    _createEditCell(info, isHiddenSection) {
        let cell = new St.BoxLayout({
            style_class: 'convergence-qs-edit-cell',
            vertical: true, x_expand: true, y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            reactive: true,
        });
        cell._editInfo = info;
        cell._isHiddenSection = isHiddenSection;

        let scale = (this._panel?.width ?? 540) / 432;
        let iconSize = Math.round(48 * scale);
        let badgeSize = Math.round(18 * scale);
        let badgeInset = Math.round(badgeSize / 4);
        let containerSize = iconSize + badgeInset * 2;

        let iconContainer = new St.Widget({
            x_align: Clutter.ActorAlign.CENTER,
            width: containerSize,
            height: iconSize + badgeInset,
        });

        let iconCircle = new St.BoxLayout({
            style_class: 'convergence-qs-edit-icon',
            width: iconSize, height: iconSize,
            x: badgeInset, y: badgeInset,
        });
        iconCircle.style = `border-radius: ${iconSize / 2}px;`;
        let iconParams = { icon_size: Math.round(20 * scale) };
        if (info.gicon)
            iconParams.gicon = info.gicon;
        else if (info.iconName)
            iconParams.icon_name = info.iconName;
        else
            iconParams.icon_name = 'application-x-executable-symbolic';
        iconParams.x_expand = true;
        iconParams.y_expand = true;
        iconParams.x_align = Clutter.ActorAlign.CENTER;
        iconParams.y_align = Clutter.ActorAlign.CENTER;
        let icon = new St.Icon(iconParams);
        icon.add_style_class_name('convergence-qs-edit-icon-inner');
        iconCircle.add_child(icon);
        iconContainer.add_child(iconCircle);

        let badge = new St.Button({
            style_class: isHiddenSection
                ? 'convergence-qs-edit-badge-plus'
                : 'convergence-qs-edit-badge-minus',
            child: new St.Icon({
                icon_name: isHiddenSection ? 'list-add-symbolic' : 'list-remove-symbolic',
                icon_size: Math.round(10 * scale),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            width: badgeSize, height: badgeSize,
            x: badgeInset + iconSize - badgeSize * 3 / 4,
            y: 0,
        });
        badge.style = `border-radius: ${badgeSize / 2}px;`;
        badge.connect('clicked', () => {
            if (isHiddenSection)
                this._editRestoreToggle(info);
            else
                this._editHideToggle(info);
        });
        iconContainer.add_child(badge);
        cell.add_child(iconContainer);

        let label = new St.Label({
            text: info.label,
            style_class: 'convergence-qs-edit-cell-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = 0;
        label.clutter_text.ellipsize = 3;
        label.clutter_text.line_alignment = 1;
        cell.add_child(label);

        return cell;
    }

    _renderEditGrid(gridWidget, items, isHiddenSection) {
        gridWidget.destroy_all_children();
        let layout = gridWidget.layout_manager;
        let isFlowLayout = layout instanceof Clutter.FlowLayout;

        for (let i = 0; i < items.length; i++) {
            let info = items[i];
            let cell = this._createEditCell(info, isHiddenSection);
            if (isFlowLayout) {
                cell.width = this._editCellWidth;
                gridWidget.add_child(cell);
            } else {
                let row = Math.floor(i / EDIT_COLUMNS);
                let col = i % EDIT_COLUMNS;
                layout.attach(cell, col, row, 1, 1);
            }
        }
    }

    _editHideToggle(info) {
        if (this._editActiveList.length <= 1) return; // min 1 active
        let idx = this._editActiveList.findIndex(i => i.toggleId === info.toggleId);
        if (idx < 0) return;
        this._editActiveList.splice(idx, 1);
        this._editHiddenList.push(info);
        this._refreshEditGrids();
    }

    _editRestoreToggle(info) {
        let idx = this._editHiddenList.findIndex(i => i.toggleId === info.toggleId);
        if (idx < 0) return;
        this._editHiddenList.splice(idx, 1);
        this._editActiveList.push(info);
        this._refreshEditGrids();
    }

    _refreshEditGrids() {
        if (this._editActiveGrid)
            this._renderEditGrid(this._editActiveGrid, this._editActiveList, false);
        if (this._editHiddenGrid)
            this._renderEditGrid(this._editHiddenGrid, this._editHiddenList, true);
        this._syncEditHiddenVisibility();
    }

    _syncEditHiddenVisibility() {
        let hasHidden = this._editHiddenList?.length > 0;
        if (this._editDivider) this._editDivider.visible = hasHidden;
        if (this._editHiddenGrid) this._editHiddenGrid.visible = hasHidden;
    }

    // -- Edit DnD (drag and drop reorder) --

    _setupEditDnD() {
        if (!this._editContainer) return;
        this._editDnDState = null;
        this._editSignalDisposer.replaceConnection(
            this,
            '_editDnDEventId',
            this._editContainer,
            'captured-event',
            (_actor, event) => this._onEditCapturedEvent(event)
        );
    }

    _onEditCapturedEvent(event) {
        let type = event.type();

        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            let [x, y] = event.get_coords();
            let cell = this._findEditCellAt(x, y);
            if (!cell || cell._isHiddenSection) return Clutter.EVENT_PROPAGATE;
            this._editDnDState = {
                cell, startX: x, startY: y,
                dragging: false, longPressId: 0,
            };
            this._editDnDState.longPressId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, EDIT_LONG_PRESS_MS, () => {
                    let currentId = this._editDnDState?.longPressId ?? 0;
                    this._editSignalDisposer.untrackTimeout(currentId);
                    this._editDnDState.longPressId = 0;
                    if (this._editDnDState?.cell === cell)
                        this._startEditDrag(cell, x, y);
                    return GLib.SOURCE_REMOVE;
                });
            this._editSignalDisposer.trackTimeout(this._editDnDState.longPressId);
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.MOTION ||
            type === Clutter.EventType.TOUCH_UPDATE) {
            if (!this._editDnDState) return Clutter.EVENT_PROPAGATE;
            let [x, y] = event.get_coords();
            let s = this._editDnDState;
            if (s.dragging) {
                this._updateEditDrag(x, y);
                return Clutter.EVENT_STOP;
            }
            let dx = Math.abs(x - s.startX);
            let dy = Math.abs(y - s.startY);
            if (dx > EDIT_DRAG_THRESHOLD || dy > EDIT_DRAG_THRESHOLD) {
                // Cancel long press if moved too far
                this._clearEditLongPress(s);
                this._editDnDState = null;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.TOUCH_END) {
            if (!this._editDnDState) return Clutter.EVENT_PROPAGATE;
            let s = this._editDnDState;
            this._clearEditLongPress(s);
            if (s.dragging) {
                let [x, y] = event.get_coords();
                this._finishEditDrag(x, y);
                return Clutter.EVENT_STOP;
            }
            this._editDnDState = null;
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCH_CANCEL) {
            if (this._editDnDState) {
                this._clearEditLongPress(this._editDnDState);
                if (this._editDnDState.dragging)
                    this._finishEditDrag(this._editDnDState.startX, this._editDnDState.startY);
                this._editDnDState = null;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _clearEditLongPress(state) {
        let id = state?.longPressId ?? 0;
        if (!id)
            return;
        try { GLib.source_remove(id); } catch (_e) {}
        this._editSignalDisposer.untrackTimeout(id);
        state.longPressId = 0;
    }

    _findEditCellAt(x, y) {
        if (!this._editActiveGrid) return null;
        for (let child of this._editActiveGrid.get_children()) {
            if (!child._editInfo) continue;
            let [ok, lx, ly] = child.transform_stage_point(x, y);
            if (ok && lx >= 0 && ly >= 0 && lx <= child.width && ly <= child.height)
                return child;
        }
        return null;
    }

    _startEditDrag(cell, x, y) {
        if (!this._editDnDState || this._editDnDState.cell !== cell) return;
        this._editDnDState.dragging = true;

        let info = cell._editInfo;
        let ghost = this._createEditCell(info, false);
        ghost.remove_style_class_name('convergence-qs-edit-cell');
        ghost.add_style_class_name('convergence-qs-edit-cell');
        ghost.add_style_class_name('convergence-qs-edit-ghost');
        ghost.set_pivot_point(0.5, 0.5);
        ghost.set_scale(1.15, 1.15);
        ghost.set_position(x - cell.width / 2, y - cell.height / 2);
        Main.layoutManager.uiGroup.add_child(ghost);

        cell.opacity = 76;

        let grab = global.stage.grab(this._editContainer);
        this._editDnDState.ghost = ghost;
        this._editDnDState.grab = grab;
        this._editDnDState.sourceCell = cell;
        this._editDnDState.origIndex = this._editActiveList.findIndex(
            i => i.toggleId === info.toggleId);
        this._editDnDState.currentIndex = this._editDnDState.origIndex;
    }

    _updateEditDrag(x, y) {
        let s = this._editDnDState;
        if (!s?.ghost) return;
        s.ghost.set_position(x - s.ghost.width / 2, y - s.ghost.height / 2);

        // Find drop target index
        let dropIdx = this._findEditDropIndex(x, y);
        if (dropIdx < 0) return;
        let info = s.cell._editInfo;
        let curIdx = this._editActiveList.findIndex(i => i.toggleId === info.toggleId);
        if (curIdx < 0 || curIdx === dropIdx) return;

        // Reorder in the active list
        this._editActiveList.splice(curIdx, 1);
        this._editActiveList.splice(dropIdx, 0, info);
        this._renderEditGrid(this._editActiveGrid, this._editActiveList, false);

        // Re-find the cell and dim it
        s.currentIndex = dropIdx;
        for (let child of this._editActiveGrid.get_children()) {
            if (child._editInfo?.toggleId === info.toggleId) {
                child.opacity = 76;
                s.sourceCell = child;
                s.cell = child;
                break;
            }
        }
    }

    _findEditDropIndex(x, y) {
        if (!this._editActiveGrid) return -1;
        let children = this._editActiveGrid.get_children();
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            let [ok, lx, ly] = child.transform_stage_point(x, y);
            if (!ok) continue;
            let cx = child.width / 2;
            let cy = child.height / 2;
            let dist = Math.sqrt((lx - cx) ** 2 + (ly - cy) ** 2);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        return bestIdx;
    }

    _finishEditDrag(x, y) {
        let s = this._editDnDState;
        if (s?.grab) s.grab.dismiss();
        if (s?.ghost) {
            let parent = s.ghost.get_parent();
            if (parent) parent.remove_child(s.ghost);
            s.ghost.destroy();
        }
        if (s?.sourceCell) s.sourceCell.opacity = 255;
        else if (s?.cell) s.cell.opacity = 255;
        this._editDnDState = null;
        this._refreshEditGrids();
    }

    _findMessageActorAt(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor) {
            if (actor.has_style_class_name?.('message')) return actor;
            actor = actor.get_parent();
        }
        return null;
    }

    _findChildByStyleClass(actor, styleClass) {
        if (actor.style_class === styleClass) return actor;
        for (let i = 0, n = actor.get_n_children(); i < n; i++) {
            let found = this._findChildByStyleClass(actor.get_child_at_index(i), styleClass);
            if (found) return found;
        }
        return null;
    }

    _expandMessage(msg, animate = false) {
        msg.add_style_pseudo_class('expanded');
        let expandBtn = this._findChildByStyleClass(msg, 'message-expand-button');
        if (expandBtn) expandBtn.checked = true;
        let actionBin = this._findChildByStyleClass(msg, 'message-action-bin');
        if (actionBin && actionBin.get_n_children() > 0)
            actionBin.visible = true;

        if (animate && actionBin?.visible) {
            actionBin.opacity = 0;
            actionBin.ease({
                opacity: 255, duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _collapseMessage(msg, animate = false) {
        if (animate) {
            let actionBin = this._findChildByStyleClass(msg, 'message-action-bin');
            if (actionBin?.visible) {
                actionBin.ease({
                    opacity: 0, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        this._collapseMessage(msg, false);
                        if (actionBin) actionBin.opacity = 255;
                    },
                });
                return;
            }
        }
        msg.remove_style_pseudo_class('expanded');
        let expandBtn = this._findChildByStyleClass(msg, 'message-expand-button');
        if (expandBtn) expandBtn.checked = false;
        let actionBin = this._findChildByStyleClass(msg, 'message-action-bin');
        if (actionBin) actionBin.visible = false;
    }

    _autoExpandFirstNotifGroup(animate = false) {
        let mv = this._notifMessageView;
        if (!mv || mv.empty) return;

        if (this._autoExpandIdleId) {
            GLib.source_remove(this._autoExpandIdleId);
            this._autoExpandIdleId = 0;
        }
        this._autoExpandIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._autoExpandIdleId = 0;
            this._doAutoExpandFirstNotif(animate);
            return GLib.SOURCE_REMOVE;
        });
    }

    _doAutoExpandFirstNotif(animate = false) {
        let mv = this._notifMessageView;
        if (!mv || mv.empty) return;

        let allMsgs = [];
        let n = mv.get_n_children();
        for (let i = n - 1; i >= 0; i--) {
            let child = mv.get_child_at_index(i);
            let group = child.child ?? child;
            if (group.constructor.name !== 'NotificationMessageGroup')
                continue;
            let m = group.get_n_children();
            for (let j = 0; j < m; j++) {
                let msgBin = group.get_child_at_index(j);
                let msg = msgBin?.child ?? msgBin;
                if (!msg?.notification) continue;
                allMsgs.push(msg);
            }
        }

        let viewportH = this._notifScroll?.height ?? 0;
        if (viewportH <= 0) return;

        let collapsedMsg = allMsgs.find(m =>
            !m.get_style_pseudo_class()?.includes('expanded'));
        let expandedMsg = allMsgs.find(m =>
            m.get_style_pseudo_class()?.includes('expanded'));
        let collapsedH = collapsedMsg?.height ?? 96;
        let expandedH = expandedMsg?.height ?? (collapsedH + 39);
        let expandDelta = expandedH - collapsedH;
        if (expandDelta <= 0) expandDelta = 39;

        let expandedCount = 0;
        let totalH = 0;
        for (let msg of allMsgs) {
            let isExp = msg.get_style_pseudo_class()?.includes('expanded');
            totalH += isExp ? expandedH : collapsedH;
            if (isExp) expandedCount++;
        }

        for (let msg of allMsgs) {
            if (msg.get_style_pseudo_class()?.includes('expanded'))
                continue;
            let hasActions = msg.notification.actions?.length > 0;
            if (!hasActions && expandedCount > 0) continue;
            let projectedH = totalH + expandDelta;
            if (expandedCount > 0 && projectedH > viewportH)
                break;
            this._expandMessage(msg, animate);
            totalH += expandDelta;
            expandedCount++;
        }
    }

    _openNotificationSettings(messageActor) {
        try {
            let notification = messageActor?.notification;
            if (!notification) return;
            let appId = notification.source?.app?.get_id?.()
                     || notification.source?._appId
                     || null;
            if (appId) {
                let canonicalId = appId.replace(/\.desktop$/, '')
                    .toLowerCase().replace(/[^a-z0-9]/g, '-');
                try {
                    Gio.Subprocess.new(
                        ['gnome-control-center', 'notifications', canonicalId],
                        Gio.SubprocessFlags.NONE);
                } catch (_e) {
                    Gio.Subprocess.new(
                        ['gnome-control-center', 'notifications'],
                        Gio.SubprocessFlags.NONE);
                }
            } else {
                Gio.Subprocess.new(
                    ['gnome-control-center', 'notifications'],
                    Gio.SubprocessFlags.NONE);
            }
            this.close();
        } catch (_e) {}
    }

    // -- Swipe action indicator --

    _updateSwipeActionIndicator(messageActor, dx) {
        if (!messageActor._swipeIndicator) {
            let s = this._qsScale ?? 1;
            let indicator = new St.BoxLayout({
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                style: `border-radius: ${Math.round(12 * s)}px;`,
            });
            let icon = new St.Icon({
                icon_name: 'edit-delete-symbolic',
                icon_size: Math.round(20 * s),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                style: 'color: rgba(255,255,255,0.9);',
            });
            indicator.add_child(icon);
            indicator._icon = icon;

            let parent = messageActor.get_parent();
            if (parent) {
                parent.insert_child_below(indicator, messageActor);
                indicator.set_size(messageActor.width, messageActor.height);
                indicator.set_position(messageActor.x, messageActor.y);
            }
            messageActor._swipeIndicator = indicator;
        }

        let indicator = messageActor._swipeIndicator;
        let progress = Math.min(1, Math.abs(dx) / (messageActor.width || 1));
        let isRight = dx > 0;

        // Color shifts from grey to red as progress increases
        let r = Math.round(60 + progress * 140);
        let g = Math.round(60 - progress * 30);
        let b = Math.round(60 - progress * 30);
        indicator.style = `border-radius: ${Math.round(12 * (this._qsScale ?? 1))}px; background-color: rgb(${r},${g},${b});`;

        // Align icon to the reveal side
        if (indicator._icon) {
            indicator._icon.x_align = isRight
                ? Clutter.ActorAlign.START : Clutter.ActorAlign.END;
            indicator._icon.style = `color: rgba(255,255,255,${0.4 + progress * 0.6}); margin: 0 16px;`;
        }
    }

    _removeSwipeActionIndicator(messageActor) {
        if (messageActor._swipeIndicator) {
            messageActor._swipeIndicator.destroy();
            messageActor._swipeIndicator = null;
        }
    }

    // -- Partial-swipe action reveal --

    _showPartialSwipeActions(messageActor, isRight) {
        // Create a small action bar behind the notification
        if (messageActor._partialActions) return;

        let s = this._qsScale ?? 1;
        let actionBar = new St.BoxLayout({
            style: `background-color: rgb(50,53,62); border-radius: ${Math.round(12 * s)}px; padding: ${Math.round(8 * s)}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let snoozeBtn = new St.Button({
            child: new St.Icon({ icon_name: 'alarm-symbolic', icon_size: Math.round(18 * s) }),
            style: `color: rgba(255,255,255,0.9); padding: ${Math.round(8 * s)}px;`,
        });
        snoozeBtn.connect('clicked', () => {
            this._hidePartialSwipeActions(messageActor);
            this._snoozeNotification(messageActor);
        });

        let settingsBtn = new St.Button({
            child: new St.Icon({ icon_name: 'preferences-system-symbolic', icon_size: Math.round(18 * s) }),
            style: `color: rgba(255,255,255,0.9); padding: ${Math.round(8 * s)}px;`,
        });
        settingsBtn.connect('clicked', () => {
            this._hidePartialSwipeActions(messageActor);
            this._openNotificationSettings(messageActor);
        });

        actionBar.add_child(snoozeBtn);
        actionBar.add_child(settingsBtn);

        let parent = messageActor.get_parent();
        if (parent) {
            parent.insert_child_below(actionBar, messageActor);
            actionBar.set_position(
                isRight ? messageActor.x : messageActor.x + messageActor.width - NOTIF_ACTION_REVEAL_MAX,
                messageActor.y);
            actionBar.set_size(NOTIF_ACTION_REVEAL_MAX, messageActor.height);
        }

        messageActor._partialActions = actionBar;

        // Auto-dismiss after 5s if not interacted with
        messageActor._partialActionsTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            messageActor._partialActionsTimerId = 0;
            this._hidePartialSwipeActions(messageActor);
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidePartialSwipeActions(messageActor) {
        if (messageActor._partialActionsTimerId) {
            GLib.source_remove(messageActor._partialActionsTimerId);
            messageActor._partialActionsTimerId = 0;
        }
        if (messageActor._partialActions) {
            messageActor._partialActions.destroy();
            messageActor._partialActions = null;
        }
        messageActor.ease({
            translation_x: 0, duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // -- Clear all (preserving ongoing) --

    _clearDismissibleNotifications() {
        let mv = this._notifMessageView;
        if (!mv || mv.empty) return;

        let toDismiss = [];
        let n = mv.get_n_children();
        for (let i = n - 1; i >= 0; i--) {
            let child = mv.get_child_at_index(i);
            let group = child.child ?? child;
            if (group.constructor.name !== 'NotificationMessageGroup')
                continue;
            let m = group.get_n_children();
            for (let j = 0; j < m; j++) {
                let msgBin = group.get_child_at_index(j);
                let msg = msgBin?.child ?? msgBin;
                if (!msg?.notification) continue;
                let notif = msg.notification;
                // Skip ongoing/pinned notifications
                if (notif === this._screencastNotification) continue;
                if (notif.resident === true || notif.isTransient === false) continue;
                toDismiss.push(msg);
            }
        }

        // Staggered dismiss animation
        let lastIdx = toDismiss.length - 1;
        for (let i = 0; i < toDismiss.length; i++) {
            let msg = toDismiss[i];
            let isLast = i === lastIdx;
            let delay = i * 40;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                try {
                    msg.ease({
                        translation_x: msg.width * 1.5,
                        opacity: 0,
                        duration: NOTIF_SWIPE_ANIM_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                        onComplete: () => {
                            if (typeof msg.close === 'function')
                                msg.close();
                            if (isLast) {
                                this._syncStatusBarNotifIcons();
                                this._syncNotifEmpty();
                                this._styleNotificationSubtree(this._notifMessageView);
                            }
                        },
                    });
                } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // -- Undo after swipe-dismiss --

    _dismissWithUndo(messageActor) {
        let w = messageActor.width || 1;
        let dx = messageActor.translation_x;
        let targetX = dx > 0 ? w * 1.5 : -w * 1.5;
        this._controller?.haptics?.vibrate(10);

        // Store original state for undo
        let savedH = messageActor.height;
        let notification = messageActor.notification;

        // Track dismissed sources so the status bar can exclude their icons.
        if (!this._pendingDismissSources) this._pendingDismissSources = new Set();
        // Collect sources from the message actor and all its children
        let collectSources = (actor) => {
            if (actor.notification?.source)
                this._pendingDismissSources.add(actor.notification.source);
            if (actor.source)
                this._pendingDismissSources.add(actor.source);
            let child = actor.child ?? null;
            if (child) collectSources(child);
            let n = actor.get_n_children?.() ?? 0;
            for (let i = 0; i < n; i++)
                collectSources(actor.get_child_at_index(i));
        };
        collectSources(messageActor);

        messageActor.ease({
            translation_x: targetX,
            opacity: 0,
            duration: NOTIF_SWIPE_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                // Collapse height to zero to close the gap
                messageActor.set_height(0);
                messageActor.visible = false;
                // Destroy the notification in GNOME's system immediately
                // so the messageTray stays in sync. Undo will re-create it.
                try {
                    if (typeof messageActor.close === 'function')
                        messageActor.close();
                } catch (_e) {}
                this._showUndoToast(messageActor, savedH, notification);
                this._cleanupEmptyGroups();
                this._clearPendingDismiss(messageActor);
                this._syncStatusBarNotifIcons();
            },
        });
    }

    _showUndoToast(messageActor, savedH, notification) {
        this._clearUndoToast();

        let s = this._qsScale ?? 1;
        this._undoToast = new St.BoxLayout({
            style_class: 'convergence-qs-undo-toast',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
            style: `padding: ${Math.round(10 * s)}px ${Math.round(14 * s)}px; margin: ${Math.round(6 * s)}px;`,
        });
        let label = new St.Label({
            text: 'Notification dismissed',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `color: rgba(255,255,255,0.9); font-size: ${Math.round(13 * s)}px;`,
        });
        let undoBtn = new St.Button({
            label: 'Undo',
            style_class: 'convergence-qs-undo-btn',
            y_align: Clutter.ActorAlign.CENTER,
            style: `color: rgb(138,180,248); font-size: ${Math.round(13 * s)}px; font-weight: bold; padding: ${Math.round(4 * s)}px ${Math.round(12 * s)}px;`,
        });
        undoBtn.connect('clicked', () => {
            this._undoNotifDismiss(messageActor, savedH);
        });
        this._undoToast.add_child(label);
        this._undoToast.add_child(undoBtn);

        // Insert before the notification scroll
        if (this._notifContainer && this._notifScroll) {
            let idx = this._notifContainer.get_children().indexOf(this._notifScroll);
            if (idx >= 0)
                this._notifContainer.insert_child_at_index(this._undoToast, idx + 1);
            else
                this._notifContainer.add_child(this._undoToast);
        }

        this._undoToastTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UNDO_TOAST_MS, () => {
            this._undoToastTimerId = 0;
            // Notification was already closed when the swipe animation
            // completed — just clean up the toast.
            this._clearUndoToast();
            this._cleanupEmptyGroups();
            return GLib.SOURCE_REMOVE;
        });
    }

    _undoNotifDismiss(messageActor, savedH) {
        this._clearUndoToast();
        this._clearPendingDismiss(messageActor);
        this._syncStatusBarNotifIcons();
        try {
            messageActor.visible = true;
            messageActor.set_height(savedH);
            messageActor.ease({
                translation_x: 0,
                opacity: 255,
                duration: NOTIF_SWIPE_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } catch (_e) {}
    }

    _commitDismiss(messageActor) {
        try {
            this._clearPendingDismiss(messageActor);
            if (typeof messageActor.close === 'function')
                messageActor.close();
            this._autoExpandFirstNotifGroup(true);
            this._syncStatusBarNotifIcons();
            this._cleanupEmptyGroups();
        } catch (_e) {}
    }

    /** Hide empty or fully-dismissed group/section wrappers that linger
     *  after their messages have been swiped away. */
    _cleanupEmptyGroups() {
        let mv = this._notifMessageView;
        if (!mv) return;
        let dismissed = this._pendingDismissSources;
        let n = mv.get_n_children();
        for (let i = n - 1; i >= 0; i--) {
            let child = mv.get_child_at_index(i);
            let group = child.child ?? child;
            // Check if this group has any live NotificationMessage children
            let hasLiveMessage = false;
            let gc = group.get_n_children?.() ?? 0;
            for (let j = 0; j < gc; j++) {
                let msg = group.get_child_at_index(j);
                let inner = msg?.child ?? msg;
                // Only count actual notification messages, not decorative widgets
                if (!inner?.notification) continue;
                if (!inner.visible || inner.height <= 0) continue;
                let src = inner.notification?.source;
                if (src && dismissed?.has(src)) continue;
                hasLiveMessage = true;
                break;
            }
            if (!hasLiveMessage) {
                // Hide the group and all its children
                child.visible = false;
                child.height = 0;
                for (let j = 0; j < gc; j++) {
                    let c = group.get_child_at_index(j);
                    if (c) { c.visible = false; c.height = 0; }
                }
            }
        }
        this._syncNotifEmpty();
    }

    _clearPendingDismiss(messageActor) {
        if (!this._pendingDismissSources) return;
        let clearSources = (actor) => {
            if (actor.notification?.source)
                this._pendingDismissSources.delete(actor.notification.source);
            if (actor.source)
                this._pendingDismissSources.delete(actor.source);
            let child = actor.child ?? null;
            if (child) clearSources(child);
            let n = actor.get_n_children?.() ?? 0;
            for (let i = 0; i < n; i++)
                clearSources(actor.get_child_at_index(i));
        };
        clearSources(messageActor);
    }

    _syncStatusBarNotifIcons() {
        let statusBars = this._controller?.phoneStatusBars ?? [];
        for (let sb of statusBars)
            sb?._queueNotifIconSync?.();
    }

    _clearUndoToast() {
        if (this._undoToastTimerId) {
            GLib.source_remove(this._undoToastTimerId);
            this._undoToastTimerId = 0;
        }
        if (this._undoToast) {
            this._undoToast.destroy();
            this._undoToast = null;
        }
    }

    // -- Notification snooze --

    _snoozeNotification(messageActor) {
        try {
            let notification = messageActor?.notification;
            if (!notification) return;

            let source = notification.source;
            notification.acknowledged = true;
            this._controller?.haptics?.vibrate(15);

            // Animate out
            messageActor.ease({
                translation_x: 0,
                translation_y: -messageActor.height,
                opacity: 0,
                duration: NOTIF_SWIPE_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    messageActor.visible = false;
                    messageActor.set_height(0);
                },
            });

            // Re-surface after snooze period
            let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SNOOZE_DEFAULT_MS, () => {
                try {
                    notification.acknowledged = false;
                    if (source)
                        source.emit('notification-request-banner', notification);
                } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
            // Track for cleanup
            if (!this._snoozeTimerIds) this._snoozeTimerIds = [];
            this._snoozeTimerIds.push(timerId);
        } catch (_e) {}
    }

    // -- Ongoing notification styling --

    _applyOngoingNotifStyle() {
        let mv = this._notifMessageView;
        if (!mv || mv.empty) return;

        let n = mv.get_n_children();
        for (let i = 0; i < n; i++) {
            let child = mv.get_child_at_index(i);
            let group = child.child ?? child;
            if (group.constructor.name !== 'NotificationMessageGroup')
                continue;
            let m = group.get_n_children();
            for (let j = 0; j < m; j++) {
                let msgBin = group.get_child_at_index(j);
                let msg = msgBin?.child ?? msgBin;
                if (!msg?.notification) continue;
                let notif = msg.notification;
                if (notif.resident === true || notif.isTransient === false ||
                    notif === this._screencastNotification) {
                    if (!msg.has_style_class_name?.('convergence-notif-ongoing'))
                        msg.add_style_class_name('convergence-notif-ongoing');
                } else {
                    if (msg.has_style_class_name?.('convergence-notif-ongoing'))
                        msg.remove_style_class_name('convergence-notif-ongoing');
                }
            }
        }
    }

    // -- Notification priority sorting --

    _sortNotificationsByPriority() {
        let mv = this._notifMessageView;
        if (!mv || mv.empty) return;

        // Collect groups with their priority
        let groups = [];
        let n = mv.get_n_children();
        for (let i = 0; i < n; i++) {
            let child = mv.get_child_at_index(i);
            let group = child.child ?? child;
            if (group.constructor.name !== 'NotificationMessageGroup')
                continue;

            // Determine highest priority in this group
            let priority = 0; // 0=normal, 1=ongoing/resident, 2=urgent
            let m = group.get_n_children();
            for (let j = 0; j < m; j++) {
                let msgBin = group.get_child_at_index(j);
                let msg = msgBin?.child ?? msgBin;
                if (!msg?.notification) continue;
                let notif = msg.notification;
                if (notif.urgency >= 3) priority = Math.max(priority, 2); // CRITICAL
                else if (notif.resident || notif.isTransient === false)
                    priority = Math.max(priority, 1);
            }
            groups.push({ actor: child, priority });
        }

        // Sort: highest priority first (urgent > ongoing > normal)
        groups.sort((a, b) => b.priority - a.priority);

        // Re-order children
        for (let i = 0; i < groups.length; i++) {
            mv.set_child_at_index(groups[i].actor, i);
        }
    }

    // -- Group header tap to collapse/expand --

    _setupGroupHeaderTaps() {
        let mv = this._notifMessageView;
        if (!mv || mv.empty) return;

        let n = mv.get_n_children();
        for (let i = 0; i < n; i++) {
            let child = mv.get_child_at_index(i);
            let group = child.child ?? child;
            if (group.constructor.name !== 'NotificationMessageGroup')
                continue;
            if (group._convergenceGroupTapId) continue;

            // Find the header area (first child or source title)
            let header = this._findChildByStyleClass(group, 'message-group-header')
                      ?? this._findChildByStyleClass(group, 'message-source-title');
            if (!header) {
                // Use the group container itself for tap
                header = group;
            }

            group._convergenceGroupCollapsed = false;
            group._convergenceGroupTapId = header.connect('button-release-event', () => {
                this._toggleGroupCollapse(group);
                return Clutter.EVENT_STOP;
            });
        }
    }

    _toggleGroupCollapse(group) {
        let collapsed = !group._convergenceGroupCollapsed;
        group._convergenceGroupCollapsed = collapsed;

        let m = group.get_n_children();
        // Keep first child (newest) visible, hide/show the rest
        for (let j = 1; j < m; j++) {
            let child = group.get_child_at_index(j);
            if (!child) continue;
            if (collapsed) {
                child.ease({
                    opacity: 0, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => { child.visible = false; },
                });
            } else {
                child.visible = true;
                child.opacity = 0;
                child.ease({
                    opacity: 255, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        }
        this._controller?.haptics?.vibrate(5);
    }

    // -- Open / Close --

    /** Open the notification panel. */
    open() {
        if (this._isOpen) return;
        if (!this._hijacked) return;
        if (!this._overlay || !this._panel || !this._backdrop) return;

        this._resetSwipeState();
        this._rebuildTrayIcons();
        if (global.stage.get_key_focus()) global.stage.set_key_focus(null);
        this._isOpen = true;
        if (this._menu) { this._qsSuppressSignal = true; this._menu.isOpen = true; this._qsSuppressSignal = false; }

        this._recalcOverflow();
        this._overlay.visible = true;
        Main.layoutManager.uiGroup.set_child_below_sibling(
            this._overlay, Main.layoutManager.modalDialogGroup);
        this._raiseOverlayAboveCorners();

        // Measure after overlay is visible so children have valid sizes.
        // Use preferred height for expanding children (notification area)
        // since their allocated height may be stale or minimal.
        this._panel.remove_all_transitions();
        let contentH = 0;
        for (let i = 0; i < this._panel.get_n_children(); i++) {
            let ch = this._panel.get_child_at_index(i);
            if (!ch.visible) continue;
            let h = ch.y_expand
                ? (ch.get_preferred_height(-1)?.[1] ?? ch.height)
                : ch.height;
            contentH += h;
        }
        let targetH = Math.max(200, Math.min(contentH + 16, this._panelMaxH || 9999));
        this._panel.height = targetH;
        this._panel.translation_y = -targetH;
        this._refreshNotificationScale();
        this._panel.ease({
            translation_y: 0, duration: PANEL_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._backdrop.remove_all_transitions();
        this._backdrop.ease({
            opacity: BACKDROP_OPACITY, duration: PANEL_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._sortNotificationsByPriority();
        this._applyOngoingNotifStyle();
        this._setupGroupHeaderTaps();
        this._autoExpandFirstNotifGroup(true);
    }

    /** Close the notification panel. */
    close() {
        if (!this._isOpen) return;
        if (this._inEditMode) this._exitEditMode();
        this._convergenceToggles?.closeToggleMenu?.(false);
        this._stopNotifFling();
        this._cancelNotifLongPress();
        // Commit any pending undo dismiss on close
        if (this._undoToast) {
            if (this._undoToastTimerId) {
                GLib.source_remove(this._undoToastTimerId);
                this._undoToastTimerId = 0;
            }
            // Find the hidden message actor and commit the dismiss
            this._undoToast.destroy();
            this._undoToast = null;
        }
        if (this._autoExpandIdleId) {
            GLib.source_remove(this._autoExpandIdleId);
            this._autoExpandIdleId = 0;
        }
        this._resetSwipeState();
        this._isOpen = false;
        if (this._menu) { this._qsSuppressSignal = true; this._menu.isOpen = false; this._qsSuppressSignal = false; }

        if (this._isExpanded) {
            this._isExpanded = false;
            if (this._overflowItems?.length)
                for (let actor of this._overflowItems) actor.visible = false;
            this._gridContainer?.set_height(-1);
            if (this._volumeRow) {
                this._volumeRow.visible = false;
                this._volumeRow.opacity = 255;
            }
            if (this._brightnessRow) {
                this._brightnessRow.visible = false;
                this._brightnessRow.opacity = 255;
            }
            if (this._chevron?.child) this._chevron.child.icon_name = 'pan-down-symbolic';
        }
        if (!this._panel || !this._backdrop) return;
        let panelH = this._panel.height || 300;
        this._panel.remove_all_transitions();
        this._panel.ease({
            translation_y: -panelH, duration: PANEL_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { if (this._overlay) this._overlay.visible = false; this._syncPanelHeight(); },
        });
        this._backdrop.remove_all_transitions();
        this._backdrop.ease({
            opacity: 0, duration: PANEL_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _snapOpen() {
        this._panel.remove_all_transitions();
        this._panel.ease({ translation_y: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        this._backdrop.remove_all_transitions();
        this._backdrop.ease({ opacity: BACKDROP_OPACITY, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
    }

    // -- Progressive open (finger-tracking from status bar) --

    /**
     * Begin a progressive open of the panel.
     * @param {boolean} expanded - true to auto-expand toggles on commit
     */
    progressiveOpenBegin(expanded = false, touchCount = 1) {
        if (this._isOpen) return;
        if (!this._hijacked || !this._overlay || !this._panel || !this._backdrop) return;
        this._resetSwipeState();
        this._rebuildTrayIcons();
        if (global.stage.get_key_focus()) global.stage.set_key_focus(null);
        // Two-finger pull goes directly to expanded QS
        this._progressiveExpand = expanded || touchCount >= 2;
        this._progressiveActive = true;
        this._recalcOverflow();
        this._overlay.visible = true;
        Main.layoutManager.uiGroup.set_child_below_sibling(
            this._overlay, Main.layoutManager.modalDialogGroup);
        this._raiseOverlayAboveCorners();

        this._panel.remove_all_transitions();
        let contentH = 0;
        for (let i = 0; i < this._panel.get_n_children(); i++) {
            let ch = this._panel.get_child_at_index(i);
            if (!ch.visible) continue;
            let h = ch.y_expand
                ? (ch.get_preferred_height(-1)?.[1] ?? ch.height)
                : ch.height;
            contentH += h;
        }
        let maxH = this._panelMaxH || 9999;
        let targetH = Math.max(200, Math.min(contentH + 16, maxH));
        this._panel.height = targetH;
        this._progressivePanelH = targetH;
        this._panel.translation_y = -this._progressivePanelH;
        this._backdrop.remove_all_transitions();
        this._backdrop.opacity = 0;
    }

    /**
     * Update progressive open position.
     * @param {number} progress - 0 (closed) to 1 (fully open)
     */
    progressiveOpenUpdate(progress) {
        if (!this._progressiveActive) return;
        let p = Math.max(0, Math.min(1, progress));
        let panelH = this._progressivePanelH || this._panel.height || 300;
        this._panel.translation_y = -panelH * (1 - p);
        this._backdrop.opacity = Math.round(p * BACKDROP_OPACITY);
    }

    /**
     * End progressive open -- commit (open) or cancel (close).
     * @param {boolean} commit
     */
    progressiveOpenEnd(commit) {
        if (!this._progressiveActive) return;
        this._progressiveActive = false;
        this._resetSwipeState();
        if (commit) {
            this._isOpen = true;
            if (this._menu) { this._qsSuppressSignal = true; this._menu.isOpen = true; this._qsSuppressSignal = false; }
            this._syncPanelHeight();
            this._panel.remove_all_transitions();
            this._panel.ease({ translation_y: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
            this._backdrop.remove_all_transitions();
            this._backdrop.ease({ opacity: BACKDROP_OPACITY, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
            if (this._progressiveExpand && !this._isExpanded && this._overflowItems?.length) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._toggleExpand(); return GLib.SOURCE_REMOVE; });
            }
        } else {
            let pH = this._panel.height || 300;
            this._panel.remove_all_transitions();
            this._panel.ease({
                translation_y: -pH, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => { if (this._overlay) this._overlay.visible = false; },
            });
            this._backdrop.remove_all_transitions();
            this._backdrop.ease({ opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        }
        this._progressiveExpand = false;
    }

    // -- Progressive close (finger-tracking dismiss) --

    /**
     * Begin a progressive close of the panel.
     */
    progressiveCloseBegin() {
        if (!this._isOpen) return;
        this._progressiveCloseActive = true;
        let s = this._swipeState;
        let savedOutside = s.outsidePanel;
        let savedClosing = s.outsideClosing;
        let savedStartY = s.outsideStartY;
        this._resetSwipeState();
        s = this._swipeState;
        s.outsidePanel = savedOutside;
        s.outsideClosing = savedClosing;
        s.outsideStartY = savedStartY;
        this._progressiveClosePanelH = this._panel.height || 300;
        this._panel.remove_all_transitions();
        this._backdrop.remove_all_transitions();
    }

    /**
     * Update progressive close position.
     * @param {number} progress - 0 (still open) to 1 (fully closed)
     */
    progressiveCloseUpdate(progress) {
        if (!this._progressiveCloseActive) return;
        let p = Math.max(0, Math.min(1, progress));
        let panelH = this._progressiveClosePanelH || this._panel.height || 300;
        this._panel.translation_y = -panelH * p;
        this._backdrop.opacity = Math.round((1 - p) * BACKDROP_OPACITY);
    }

    /**
     * End progressive close -- commit (close) or cancel (snap back open).
     * @param {boolean} commit
     */
    progressiveCloseEnd(commit) {
        if (!this._progressiveCloseActive) return;
        this._progressiveCloseActive = false;
        this._resetSwipeState();
        if (commit) {
            this._isOpen = false;
            if (this._menu) { this._qsSuppressSignal = true; this._menu.isOpen = false; this._qsSuppressSignal = false; }
            if (this._isExpanded) {
                this._isExpanded = false;
                if (this._overflowItems?.length)
                    for (let actor of this._overflowItems) actor.visible = false;
                this._gridContainer?.set_height(-1);
                if (this._volumeRow) {
                    this._volumeRow.visible = false;
                    this._volumeRow.opacity = 255;
                }
                if (this._brightnessRow) {
                    this._brightnessRow.visible = false;
                    this._brightnessRow.opacity = 255;
                }
                if (this._chevron?.child) this._chevron.child.icon_name = 'pan-down-symbolic';
            }
            let pH = this._progressiveClosePanelH || this._panel.height || 300;
            this._panel.remove_all_transitions();
            this._panel.ease({
                translation_y: -pH, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => { if (this._overlay) this._overlay.visible = false; this._syncPanelHeight(); },
            });
            this._backdrop.remove_all_transitions();
            this._backdrop.ease({ opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        } else {
            this._snapOpen();
        }
    }

    // -- Screencast notification --

    _setupScreencastNotification() {
        let ui = Main.screenshotUI;
        if (!ui) return;
        this._onScreencastChanged(ui);
        this._signalDisposer.replaceConnection(
            this,
            '_screencastNotifId',
            ui,
            'notify::screencast-in-progress',
            () => this._onScreencastChanged(ui)
        );
    }

    _onScreencastChanged(ui) {
        if (ui.screencastInProgress) this._showScreencastNotification();
        else this._dismissScreencastNotification();
    }

    _showScreencastNotification() {
        if (this._screencastNotification) return;
        let source = new MessageTray.Source({ title: 'Screen Recorder', iconName: 'media-record-symbolic' });
        Main.messageTray.add(source);
        this._screencastSource = source;
        let notification = new MessageTray.Notification({ source, title: 'Screen recording in progress', body: '' });
        notification.isTransient = false;
        notification.resident = true;
        notification.acknowledged = true;
        notification.addAction('Stop Recording', () => Main.screenshotUI.stopScreencast());
        source.addNotification(notification);
        this._screencastNotification = notification;
    }

    _dismissScreencastNotification() {
        if (this._screencastNotification) {
            try { this._screencastNotification.destroy(); } catch (_e) {}
            this._screencastNotification = null;
        }
        if (this._screencastSource) {
            try { this._screencastSource.destroy(); } catch (_e) {}
            this._screencastSource = null;
        }
    }

    _teardownScreencastNotification() {
        this._signalDisposer.clearConnectionRef(this, '_screencastNotifId', Main.screenshotUI);
        this._dismissScreencastNotification();
    }

    // -- Screenshot open wrap --

    _wrapScreenshotOpen() {
        let ui = Main.screenshotUI;
        if (!ui || this._screenshotVisibleId) return;
        this._screenshotReopening = false;
        this._signalDisposer.replaceConnection(this, '_screenshotVisibleId', ui, 'notify::visible', () => {
            if (!ui.visible || !this._isOpen || this._screenshotReopening) return;
            ui.hide();
            this._closeImmediatelyForScreenshot();
            this._screenshotReopening = true;
            this._signalDisposer.restartTimeout(this, '_screenshotReopenId', GLib.PRIORITY_DEFAULT, 100, () => {
                this._screenshotReopening = false;
                ui.open();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _closeImmediatelyForScreenshot() {
        if (!this._isOpen) return;
        this._resetSwipeState();
        this._isOpen = false;
        if (this._menu) { this._qsSuppressSignal = true; this._menu.isOpen = false; this._qsSuppressSignal = false; }
        if (this._isExpanded) {
            this._isExpanded = false;
            if (this._overflowItems?.length) for (let a of this._overflowItems) a.visible = false;
            this._gridContainer?.set_height(-1);
            if (this._volumeRow) { this._volumeRow.visible = false; this._volumeRow.opacity = 255; }
            if (this._brightnessRow) { this._brightnessRow.visible = false; this._brightnessRow.opacity = 255; }
            if (this._chevron?.child) this._chevron.child.icon_name = 'pan-down-symbolic';
        }
        if (this._panel) { this._panel.remove_all_transitions(); this._panel.translation_y = -(this._panel.height || 300); }
        if (this._backdrop) { this._backdrop.remove_all_transitions(); this._backdrop.opacity = 0; }
        if (this._overlay) this._overlay.visible = false;
        this._syncPanelHeight();
    }

    _unwrapScreenshotOpen() {
        this._signalDisposer.clearConnectionRef(this, '_screenshotVisibleId', Main.screenshotUI);
    }

    /** Recalculate layout after monitor changes. */
    relayout() {
        if (!this._overlay) return;
        let monitor = this._getCurrentMonitor();
        if (!monitor) return;

        // If the overlay size doesn't match the monitor (stale from a
        // previous orientation), force a full rebuild via rehijack.
        let overlayW = this._overlay.width;
        if (overlayW > 0 && overlayW !== monitor.width) {
            this._unhijack();
            this._scheduleRehijackRetry(200);
            return;
        }

        let geo = this._computePanelGeometry(monitor);
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._backdrop.set_size(monitor.width, monitor.height);
        this._panelMaxH = geo.panelContentH;
        this._panelScale = geo.uiScale;
        this._qsScale = geo.uiScale;
        this._outsideClickPassThrough = geo.isInset;
        this._panel.set_position(geo.panelX, geo.panelY);
        this._panel.set_size(geo.panelW, geo.panelContentH);
        let panelStyle;
        if (geo.isInset) {
            panelStyle = `border-radius: ${geo.radius}px; background-color: rgba(24, 26, 32, 0.96);`;
        } else {
            let cornerRadius = 0;
            try { cornerRadius = this._settings?.get_int('window-corner-radius') ?? 0; } catch (_e) {}
            panelStyle = cornerRadius > 0
                ? `border-radius: ${this._px(cornerRadius, geo.uiScale)}px; background-color: rgba(24, 26, 32, 0.96);`
                : 'background-color: rgba(24, 26, 32, 0.96);';
        }
        this._panel.style = panelStyle;
        this._applyPanelScaleStyles();
        this._refreshNotificationScale();
        if (this._isOpen) this.close();
    }

    // -- Cleanup --

    destroy() {
        this._signalDisposer?.dispose?.();
        this._scaleSignalDisposer?.dispose?.();
        this._notifSignalDisposer?.dispose?.();
        this._traySignalDisposer?.dispose?.();
        this._editSignalDisposer?.dispose?.();
        this._stopNotifFling();
        this._cancelNotifLongPress();
        this._clearUndoToast();
        if (this._snoozeTimerIds) {
            for (let id of this._snoozeTimerIds)
                GLib.source_remove(id);
            this._snoozeTimerIds = null;
        }
        if (this._autoExpandIdleId) {
            GLib.source_remove(this._autoExpandIdleId);
            this._autoExpandIdleId = 0;
        }
        if (this._isOpen) { this._isOpen = false; if (this._menu) { this._qsSuppressSignal = true; this._menu.isOpen = false; this._qsSuppressSignal = false; } }
        this._unhijack();
        if (this._manageGlobalHooks) {
            this._teardownScreencastNotification();
            this._unwrapScreenshotOpen();
        }
        this._disconnectScaleSettings();
        // Cache is now instance-owned, destroyed by ConvergenceQuickToggles.destroy()
        if (this._overlay) {
            Main.layoutManager.removeChrome(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
        }
        this._panel = null;
        this._backdrop = null;
        this._gridContainer = null;
    }
}

export class NotificationPanelManager {
    constructor(controller, settings, trayManager) {
        this._controller = controller;
        this._settings = settings;
        this._trayManager = trayManager;
        this._activeTarget = 'phone';
        this._desktopPanel = null;
        this._phonePanel = null;
        this._desktopPanelUsesTray = false;

        if (this._desktopNotifEnabled() && this._hasDesktopLikeMonitor()) {
            this._createDesktopPanel(this._desktopTrayInPanel());
        }

        this._createPhonePanel();
        this._phonePanel.selectPhoneMonitor(this._getPhoneMonitorIndex());
    }

    _getMonitorSnapshots() {
        return this._controller?.displayConfig?.getMonitorSnapshots?.() ?? [];
    }

    _getPhoneMonitorIndex() {
        let controllerMonitorIndex = this._controller?.getPhoneMonitorIndex?.();
        if (Number.isInteger(controllerMonitorIndex))
            return controllerMonitorIndex;
        for (let snapshot of this._getMonitorSnapshots()) {
            if (snapshot.isBuiltin)
                return snapshot.index;
        }
        for (let snapshot of this._getMonitorSnapshots()) {
            if (snapshot.mode === DisplayMode.PHONE || snapshot.mode === DisplayMode.TABLET)
                return snapshot.index;
        }
        return Main.layoutManager.primaryIndex ?? 0;
    }

    _hasDesktopLikeMonitor() {
        return this._getMonitorSnapshots().some(snapshot =>
            snapshot.mode === DisplayMode.DESKTOP || snapshot.mode === DisplayMode.TV);
    }

    _desktopNotifEnabled() {
        try { return this._settings?.get_boolean('desktop-notification-panel-enabled') ?? true; }
        catch (_e) { return true; }
    }

    _desktopTrayInPanel() {
        try {
            let location = this._settings?.get_string('desktop-tray-location') ?? 'top-panel';
            return location === 'notification-panel' || location === 'both';
        } catch (_e) {
            return false;
        }
    }

    _destroyPanel(panel) {
        try { panel?.destroy?.(); } catch (_e) {}
    }

    _clearDesktopPanel() {
        this._destroyPanel(this._desktopPanel);
        this._desktopPanel = null;
        this._desktopPanelUsesTray = false;
        if (this._activeTarget === 'desktop')
            this._activeTarget = 'phone';
    }

    _createDesktopPanel(shouldUseTrayInPanel = this._desktopTrayInPanel()) {
        this._desktopPanelUsesTray = shouldUseTrayInPanel;
        this._desktopPanel = new NotificationPanel(
            this._controller,
            this._settings,
            shouldUseTrayInPanel ? this._trayManager : null,
            { hijackEnabled: true }
        );
    }

    _createPhonePanel() {
        this._phonePanel = new NotificationPanel(
            this._controller,
            this._settings,
            this._trayManager,
            {
                hijackEnabled: false,
                manageGlobalHooks: false,
                monitorIndex: this._getPhoneMonitorIndex(),
            }
        );
    }

    refreshTopology() {
        let shouldHaveDesktopPanel = this._desktopNotifEnabled() && this._hasDesktopLikeMonitor();

        if (shouldHaveDesktopPanel) {
            if (!this._desktopPanel) {
                this._createDesktopPanel(this._desktopTrayInPanel());
            } else {
                this._desktopPanel.relayout?.();
            }
        } else if (this._desktopPanel) {
            this._clearDesktopPanel();
        }

        if (!this._phonePanel) {
            this._createPhonePanel();
        }

        this._phonePanel.selectPhoneMonitor?.(this._getPhoneMonitorIndex());
        this._phonePanel.relayout?.();
    }

    refreshSettings() {
        let shouldHaveDesktopPanel = this._desktopNotifEnabled() && this._hasDesktopLikeMonitor();
        let shouldUseTrayInPanel = this._desktopTrayInPanel();

        if (!shouldHaveDesktopPanel) {
            if (this._desktopPanel) {
                this._clearDesktopPanel();
            }
        } else if (!this._desktopPanel || this._desktopPanelUsesTray !== shouldUseTrayInPanel) {
            this._clearDesktopPanel();
            this._createDesktopPanel(shouldUseTrayInPanel);
        } else {
            this._desktopPanel.relayout?.();
        }
    }

    relayout() {
        this._desktopPanel?.relayout?.();
        this._phonePanel?.relayout?.();
    }

    destroy() {
        this._clearDesktopPanel();
        this._destroyPanel(this._phonePanel);
        this._phonePanel = null;
    }

    _getTargetPanel() {
        if (this._activeTarget === 'desktop' && this._desktopPanel)
            return this._desktopPanel;
        return this._phonePanel ?? this._desktopPanel ?? null;
    }

    selectPhoneMonitor(monitorIndex = null) {
        this._activeTarget = 'phone';
        this._phonePanel?.selectPhoneMonitor?.(monitorIndex);
    }

    selectPointerMonitor() {
        this._activeTarget = 'desktop';
        this._desktopPanel?.selectPointerMonitor?.();
    }

    get isOpen() {
        return this._getTargetPanel()?.isOpen ?? false;
    }

    get pendingDismissSources() {
        let all = new Set();
        for (let p of [this._phonePanel, this._desktopPanel]) {
            if (p?._pendingDismissSources) {
                for (let s of p._pendingDismissSources)
                    all.add(s);
            }
        }
        return all;
    }

    get _isExpanded() {
        return this._getTargetPanel()?._isExpanded ?? false;
    }

    get _overflowItems() {
        return this._getTargetPanel()?._overflowItems ?? [];
    }

    open() {
        this._getTargetPanel()?.open?.();
    }

    close() {
        this._getTargetPanel()?.close?.();
    }

    progressiveOpenBegin(expanded = false, touchCount = 1) {
        this._getTargetPanel()?.progressiveOpenBegin?.(expanded, touchCount);
    }

    progressiveOpenUpdate(progress) {
        this._getTargetPanel()?.progressiveOpenUpdate?.(progress);
    }

    progressiveOpenEnd(commit) {
        this._getTargetPanel()?.progressiveOpenEnd?.(commit);
    }

    progressiveCloseBegin() {
        this._getTargetPanel()?.progressiveCloseBegin?.();
    }

    progressiveCloseUpdate(progress) {
        this._getTargetPanel()?.progressiveCloseUpdate?.(progress);
    }

    progressiveCloseEnd(commit) {
        this._getTargetPanel()?.progressiveCloseEnd?.(commit);
    }

    _toggleExpand() {
        this._getTargetPanel()?._toggleExpand?.();
    }
}
