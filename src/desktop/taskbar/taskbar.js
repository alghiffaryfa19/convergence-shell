// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { Logger } from '../../shared/utilities/logger.js';

const MIN_THICKNESS = 40;
const DEFAULT_THICKNESS = 64;
const AUTOHIDE_DELAY_MS = 300;
const AUTOHIDE_ANIM_MS = 200;
const TRIGGER_ZONE_PX = 4;
const DYNAMIC_OPACITY_ANIM_MS = 200;


/**
 * Left-side desktop taskbar — a vertical bar on the left edge of the
 * primary monitor, below the GNOME panel.  Holds favourite and running
 * app icons provided by TaskbarIcons.
 */
export class Taskbar {
    constructor(controller, settings) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._logger = new Logger('Taskbar', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();

        this._actor = null;
        this._taskbarSection = null;
        this._scrollView = null;
        this._showAppsContainer = null;
        this._favoritesRow = null;
        this._taskbarStrut = null;
        this._taskbarContentScale = 1;
        this._dynamicOpacityAlpha = null;

        // Panel background sync state
        this._panelBgStyleApplied = false;
        this._panelBgDesiredStyle = null;

        // Multi-monitor state
        this._mirrorTaskbars = [];
        this._mirrorStruts = [];
        this._monitorsChangedId = 0;
        this._pointerMonitorCheckId = 0;
        this._lastPointerMonitor = -1;

        // Auto-hide / intellihide state
        this._autohideActive = false;
        this._autohideRevealed = false;
        this._autohideHideTimerId = 0;
        this._triggerZone = null;
        this._intellihideActive = false;
        this._intellihideWindowSignals = [];
        this._fullscreenHidden = false;
        this._fullscreenSignalIds = [];

        // Dynamic opacity state
        this._dynamicOpacityActive = false;
        this._dynamicOpacityWindowSignals = [];

        this._build();

        // Populate icons on the next idle tick so that companion modules
        // (TaskbarIcons etc.) created after us are available via the
        // controller.
        this._populateIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._populateIdleId = 0;
            this._populateIcons();
            this._bindKeyboardShortcuts();
            this._connectAutohideSettings();
            this._setupAutohide();
            this._setupFullscreenMonitor();
            this._setupDynamicOpacity();
            this._setupMultiMonitor();
            this._syncCorners();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Actor construction ───────────────────────────────────────────

    _build() {
        this._favoritesRow = new St.BoxLayout({
            style_class: 'convergence-taskbar-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._favoritesRow.set_style('spacing: 3px; padding: 3px 0px 3px 0px;');

        this._scrollView = new St.ScrollView({
            style_class: 'convergence-taskbar-scrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            overlay_scrollbars: true,
            enable_mouse_scrolling: false,
        });
        this._scrollView.add_child(this._favoritesRow);

        // Container for the Show Apps button, pinned below the scroll view
        this._showAppsContainer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._taskbarSection = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._taskbarSection.add_child(this._scrollView);
        this._taskbarSection.add_child(this._showAppsContainer);

        this._actor = new St.Widget({
            name: 'convergence-taskbar',
            style_class: 'convergence-taskbar-background',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            clip_to_allocation: true,
        });
        this._actor.add_child(this._taskbarSection);

        // Click on empty area below/left of the Show Apps button opens the app grid.
        // This makes the bottom-left corner a reliable "start menu" click target.
        this._actor.connect('button-press-event', (_actor, event) => {
            let btn = event.get_button?.() ?? 1;
            if (btn !== 1) return Clutter.EVENT_PROPAGATE;

            let [clickX, clickY] = event.get_coords();

            // Resolve the Show Apps button from whichever container currently owns it.
            let showAppsBtn = this._findShowAppsButton();
            if (!showAppsBtn) return Clutter.EVENT_PROPAGATE;

            // Get the Show Apps button's screen position
            let [btnX, btnY] = showAppsBtn.get_transformed_position();
            let btnW = showAppsBtn.width;
            let btnH = showAppsBtn.height;

            // Click must be below or to the left of the button's top-right corner
            // (i.e. not above the button AND not to the right of the button)
            let isBelowOrOnButton = clickY >= btnY;
            let isLeftOfOrOnButton = clickX <= btnX + btnW;

            if (isBelowOrOnButton && isLeftOfOrOnButton) {
                let appMenu = this._controller?.appMenu;
                if (appMenu)
                    appMenu.toggle(this._getAnchorMonitorIndex());
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Scroll on taskbar switches workspaces
        this._actor.connect('scroll-event', (_actor, event) => {
            let dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.SMOOTH)
                return Clutter.EVENT_PROPAGATE;
            let ws = global.workspace_manager;
            let active = ws.get_active_workspace_index();
            let nWs = ws.get_n_workspaces();
            let target = active;
            if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
                target = Math.min(nWs - 1, active + 1);
            else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
                target = Math.max(0, active - 1);
            if (target !== active)
                ws.get_workspace_by_index(target).activate(global.get_current_time());
            return Clutter.EVENT_STOP;
        });

        // Insert into uiGroup below the modal dialog group (same z-order
        // as the old extension) so the bar renders above the desktop but
        // below modal dialogs and the panel.
        Main.layoutManager.uiGroup.insert_child_below(
            this._actor, Main.layoutManager.modalDialogGroup);

        // Invisible strut reserves work-area space so maximised windows
        // do not overlap the taskbar.
        let thickness = this._readTaskbarThicknessPx();
        this._taskbarStrut = new St.Widget({
            name: 'convergence-taskbar-strut',
            width: thickness,
            height: 0,
            opacity: 0,
            reactive: false,
        });
        Main.layoutManager.addTopChrome(this._taskbarStrut, {
            affectsStruts: true,
            trackFullscreen: true,
        });
    }

    _findShowAppsButton() {
        let search = actor => {
            if (actor == null)
                return null;
            if (actor._convergenceIsShowApps)
                return actor;

            let children = actor.get_children?.() ?? [];
            for (let child of children) {
                let found = search(child);
                if (found)
                    return found;
            }
            return null;
        };

        return search(this._showAppsContainer) ?? search(this._favoritesRow);
    }

    // ── Icon population ──────────────────────────────────────────────

    _computeMetrics() {
        let thickness = this._readTaskbarThicknessPx();
        let gap = Math.max(8, Math.round(thickness * 0.14));
        let iconPad = Math.max(2, Math.round(gap * 0.5));
        let cellW = Math.max(24, thickness - gap);

        // Use taskbar-icon-size setting if set, otherwise auto-compute
        let customIconSize = 0;
        try { customIconSize = this._settings?.get_int('taskbar-icon-size') ?? 0; }
        catch (_e) {}
        let iconSize = customIconSize > 0
            ? Math.min(customIconSize, cellW - iconPad * 2)
            : Math.max(16, cellW - iconPad * 2 - 4);

        return {
            taskbarIconSize: iconSize,
            taskbarCellW: cellW,
            sideTaskbarGapPx: gap,
            sideTaskbarExtraPadPx: 2,
        };
    }

    getMetrics() {
        return this._computeMetrics();
    }

    _populateIcons() {
        let icons = this._controller?.taskbarIcons;
        if (!icons || !this._favoritesRow) return;

        let metrics = this.getMetrics();
        icons.populateFavorites(this._favoritesRow, {
            isLargeDisplay: true,
            sideTaskbar: true,
            taskbar: true,
            metrics,
        });

        // Connect running-app / focus-change signals so the taskbar
        // reflects open applications in real time.
        icons.connectAppStateSignals(this._favoritesRow);

        // Wire hover animation events on the row
        let anims = this._controller?.taskbarAnimations;
        if (anims)
            anims.connectRow(this._favoritesRow);

    }

    refreshIcons() {
        let icons = this._controller?.taskbarIcons;
        if (!icons || !this._favoritesRow) return;

        let metrics = this.getMetrics();
        icons.populateFavorites(this._favoritesRow, {
            isLargeDisplay: true,
            sideTaskbar: true,
            taskbar: true,
            metrics,
        });
    }

    // ── Settings readers ─────────────────────────────────────────────

    _readTaskbarThicknessPx() {
        try {
            let px = this._settings?.get_int('taskbar-thickness') ?? DEFAULT_THICKNESS;
            return Math.max(MIN_THICKNESS, px);
        } catch (_e) {
            return DEFAULT_THICKNESS;
        }
    }

    _readTaskbarBackgroundOpacity() {
        try {
            let v = this._settings?.get_int('taskbar-panel-background-opacity') ?? 20;
            return Math.max(0, Math.min(1, v / 100));
        } catch (_e) {
            return 0.2;
        }
    }

    // ── Constant queries (left-side only) ────────────────────────────

    isSideTaskbarLayout()  { return true; }
    isTaskbarMode()        { return true; }
    isSideTaskbarMode()    { return true; }
    _readTaskbarPosition() { return 'left'; }

    _getDesktopMonitorIndices() {
        let desktopMonitorIndices = this._controller?.getDesktopMonitorIndices?.();
        if (Array.isArray(desktopMonitorIndices) && desktopMonitorIndices.length > 0)
            return desktopMonitorIndices;
        return [Main.layoutManager.primaryIndex];
    }

    _getAnchorMonitorIndex() {
        let primaryDesktopMonitorIndex = this._controller?.getPrimaryDesktopMonitorIndex?.();
        if (Number.isInteger(primaryDesktopMonitorIndex))
            return primaryDesktopMonitorIndex;
        return Main.layoutManager.primaryIndex;
    }

    getTaskbarAnchorMonitor() {
        let monitors = Main.layoutManager.monitors ?? [];
        return monitors[this._getAnchorMonitorIndex()] ?? Main.layoutManager.primaryMonitor;
    }

    getTaskbarThickness() {
        return this._readTaskbarThicknessPx();
    }

    getTaskbarRect() {
        if (this._actor) {
            let width = this._actor.width ?? 0;
            let height = this._actor.height ?? 0;
            if (width > 0 && height > 0) {
                return {
                    x: this._actor.x,
                    y: this._actor.y,
                    width,
                    height,
                };
            }
        }

        let monitor = this.getTaskbarAnchorMonitor();
        if (!monitor) return null;
        let thickness = this._readTaskbarThicknessPx();
        let panelH = Main.panel?.height || 0;
        return {
            x: monitor.x,
            y: monitor.y + panelH,
            width: thickness,
            height: monitor.height - panelH,
        };
    }

    getTaskbarRectForMonitor(monitorIndex) {
        let monitors = Main.layoutManager.monitors ?? [];
        if (!Number.isInteger(monitorIndex) || monitorIndex < 0 || monitorIndex >= monitors.length)
            return null;

        let mirror = this._mirrorTaskbars.find(entry => entry.monitorIndex === monitorIndex);
        let mirrorActor = mirror?.actor ?? null;
        if (mirrorActor) {
            let width = mirrorActor.width ?? 0;
            let height = mirrorActor.height ?? 0;
            if (width > 0 && height > 0) {
                return {
                    x: mirrorActor.x,
                    y: mirrorActor.y,
                    width,
                    height,
                };
            }
        }

        let rect = this.getTaskbarRect();
        if (!rect)
            return null;

        let monitor = monitors[monitorIndex];
        let overlapW = Math.max(0,
            Math.min(rect.x + rect.width, monitor.x + monitor.width) -
            Math.max(rect.x, monitor.x));
        let overlapH = Math.max(0,
            Math.min(rect.y + rect.height, monitor.y + monitor.height) -
            Math.max(rect.y, monitor.y));

        return overlapW > 0 && overlapH > 0 ? rect : null;
    }

    // ── Layout ───────────────────────────────────────────────────────

    _applyInlineStyle() {
        // The user setting (0-100) controls the background alpha directly,
        // matching the old extension's approach: background-color: rgba(0,0,0, alpha).
        let bgAlpha = this._dynamicOpacityAlpha ?? this._readTaskbarBackgroundOpacity();
        let overlayAlpha = Math.max(0.08, bgAlpha * 0.25);

        this._actor.set_style(
            `background-color: rgba(0, 0, 0, ${bgAlpha}); ` +
            `box-shadow: inset 0 0 0 9999px rgba(0, 0, 0, ${overlayAlpha}); ` +
            `border-top-width: 0;`);

        this._taskbarSection.set_style(
            `padding: 1px 0px 2px 0px;`);

        // Sync the GNOME top panel background to match taskbar opacity
        this._syncPanelBackground();
    }

    /**
     * Match the GNOME top panel's background to the taskbar's transparency.
     * Installs a guard to prevent GNOME overview/session-mode from resetting
     * the panel style.
     * @private
     */
    _syncPanelBackground() {
        let panel = Main.panel;
        if (!panel) return;

        let bgAlpha = this._dynamicOpacityAlpha ?? this._readTaskbarBackgroundOpacity();
        let overlayAlpha = Math.max(0.08, bgAlpha * 0.25);
        let combinedAlpha = bgAlpha + overlayAlpha * (1 - bgAlpha);

        let style =
            `background-color: rgba(0, 0, 0, ${combinedAlpha}); ` +
            `box-shadow: none; ` +
            `border-radius: 0;`;

        this._panelBgDesiredStyle = style;
        panel.set_style(style);
        this._panelBgStyleApplied = true;

        this._installPanelStyleGuard();
    }

    /**
     * Install a property interceptor on Main.panel.style so that external
     * code (e.g. GNOME overview) cannot clear the custom background.
     * @private
     */
    _installPanelStyleGuard() {
        let panel = Main.panel;
        if (!panel || panel._convergencePanelStyleGuarded)
            return;

        let self = this;
        Object.defineProperty(panel, 'style', {
            configurable: true,
            get() {
                return panel.get_style();
            },
            set(v) {
                if ((v === null || v === '' || v === undefined) && self._panelBgDesiredStyle) {
                    panel.set_style(self._panelBgDesiredStyle);
                } else {
                    panel.set_style(v);
                }
            },
        });
        panel._convergencePanelStyleGuarded = true;
    }

    /**
     * Remove the panel style guard and restore the default panel background.
     * @private
     */
    _restorePanelBackground() {
        if (this._panelBgStyleApplied) {
            this._panelBgDesiredStyle = null;
            let panel = Main.panel;
            if (panel?._convergencePanelStyleGuarded) {
                delete panel.style;
                delete panel._convergencePanelStyleGuarded;
            }
            panel?.set_style(null);
            this._panelBgStyleApplied = false;
        }
    }

    relayout() {
        let monitor = this.getTaskbarAnchorMonitor();
        if (!monitor) return;

        let thickness = this._readTaskbarThicknessPx();
        let panelH = Main.panel?.height || 0;
        let x = monitor.x;
        let y = monitor.y + panelH;
        let h = monitor.height - panelH;

        this._actor.set_position(x, y);
        this._actor.set_size(thickness, h);

        this._taskbarStrut.set_position(x, y);
        this._taskbarStrut.set_size(thickness, h);

        this._applyInlineStyle();
        this._fitIconsToMonitor(monitor);
    }

    refreshTopology() {
        this._setupMultiMonitor();
    }

    _fitIconsToMonitor(_monitor) {
        // Icons are now in a ScrollView — no scaling needed.
        // The scroll view handles overflow natively.
        this._taskbarContentScale = 1;
    }

    // Keep for companion module compatibility.
    fitTaskbarRowToMonitor(_row, _monitor) {
        return 1;
    }

    show() { this._actor?.show(); }
    hide() { this._actor?.hide(); }

    /**
     * Bind Super+1-9 shortcuts via TaskbarIcons.
     * @private
     */
    _bindKeyboardShortcuts() {
        let icons = this._controller?.taskbarIcons;
        if (icons)
            icons.bindKeyboardShortcuts();
    }

    // ── Auto-hide / Intellihide ────────────────────────────────────

    /**
     * Connect settings signals for auto-hide, intellihide and dynamic opacity.
     * @private
     */
    _connectAutohideSettings() {
        if (!this._settings) return;
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-secondary-mode', () => this._setupAutohide());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-autohide-hover', () => this._setupAutohide());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-intellihide', () => this._setupAutohide());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-dynamic-opacity', () => this._setupDynamicOpacity());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-dynamic-opacity-min', () => this._syncDynamicOpacity());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-panel-background-opacity', () => this._syncDynamicOpacity());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-monitor-mode', () => this._setupMultiMonitor());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-single-monitor-target', () => this._setupMultiMonitor());
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-thickness', () => {
                this.relayout();
                this.refreshIcons();
                this._setupMultiMonitor();
            });
        this._runtimeDisposer.connect(this._settings,
            'changed::taskbar-icon-size', () => {
                this.refreshIcons();
                this._setupMultiMonitor();
            });
    }

    /**
     * Set up or tear down auto-hide and intellihide based on current settings.
     * Called when relevant settings change.
     * @private
     */
    _setupAutohide() {
        let mode = 'visible';
        try { mode = this._settings?.get_string('taskbar-secondary-mode') ?? 'visible'; }
        catch (_e) {}

        let intellihide = false;
        try { intellihide = this._settings?.get_boolean('taskbar-intellihide') ?? false; }
        catch (_e) {}

        let wantAutohide = mode === 'hidden';
        let wantIntellihide = intellihide && !wantAutohide;

        // Tear down previous state
        this._teardownAutohide();

        if (wantAutohide) {
            this._autohideActive = true;
            this._autohideRevealed = false;
            this._hideTaskbar(false);
            this._createTriggerZone();
        } else if (wantIntellihide) {
            this._intellihideActive = true;
            this._autohideRevealed = false;
            this._createTriggerZone();
            this._connectIntellihideWindowSignals();
            this._syncIntellihide();
        } else {
            // Visible mode — ensure taskbar is shown
            this._revealTaskbar(false);
        }

        // Update strut: no strut reservation when hidden/intellihide
        this._syncStrutVisibility();
    }

    /**
     * Tear down auto-hide and intellihide state and restore the taskbar.
     * @private
     */
    _teardownAutohide() {
        this._cancelAutohideTimer();
        this._destroyTriggerZone();
        this._disconnectIntellihideWindowSignals();
        this._autohideActive = false;
        this._intellihideActive = false;
        this._autohideRevealed = false;
    }

    /**
     * Slide the taskbar into view.
     * @param {boolean} [animate=true] - Whether to animate the transition
     */
    _revealTaskbar(animate = true) {
        if (!this._actor) return;
        // Don't reveal while a fullscreen window is active
        if (this._fullscreenHidden) return;
        this._autohideRevealed = true;
        this._actor.remove_all_transitions();

        if (animate) {
            this._actor.ease({
                translation_x: 0,
                duration: AUTOHIDE_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._actor.translation_x = 0;
        }
    }

    /**
     * Slide the taskbar off-screen (to the left for a left-side taskbar).
     * @param {boolean} [animate=true] - Whether to animate the transition
     */
    _hideTaskbar(animate = true) {
        if (!this._actor) return;
        this._autohideRevealed = false;
        let thickness = this._readTaskbarThicknessPx();
        let hideX = -thickness;
        this._actor.remove_all_transitions();

        if (animate) {
            this._actor.ease({
                translation_x: hideX,
                duration: AUTOHIDE_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
        } else {
            this._actor.translation_x = hideX;
        }
    }

    /**
     * Create a thin reactive trigger zone at the left monitor edge that
     * reveals the taskbar on pointer entry.
     * @private
     */
    _createTriggerZone() {
        if (this._triggerZone) return;

        let monitor = this.getTaskbarAnchorMonitor();
        if (!monitor) return;
        let panelH = Main.panel?.height || 0;

        this._triggerZone = new St.Widget({
            name: 'convergence-taskbar-trigger',
            reactive: true,
            width: TRIGGER_ZONE_PX,
            height: monitor.height - panelH,
            x: monitor.x,
            y: monitor.y + panelH,
            opacity: 0,
        });

        Main.layoutManager.uiGroup.add_child(this._triggerZone);

        this._runtimeDisposer.connect(this._triggerZone, 'enter-event', () => {
            let hoverEnabled = true;
            try { hoverEnabled = this._settings?.get_boolean('taskbar-autohide-hover') ?? true; }
            catch (_e) {}
            if (!hoverEnabled) return Clutter.EVENT_PROPAGATE;

            this._cancelAutohideTimer();
            this._revealTaskbar(true);
            return Clutter.EVENT_PROPAGATE;
        });

        // When the pointer leaves the taskbar area, start the hide delay
        if (this._actor) {
            this._runtimeDisposer.connect(this._actor, 'leave-event', () => {
                if (!this._autohideActive && !this._intellihideActive)
                    return Clutter.EVENT_PROPAGATE;
                if (!this._autohideRevealed)
                    return Clutter.EVENT_PROPAGATE;

                this._scheduleAutohideTimer();
                return Clutter.EVENT_PROPAGATE;
            });

            this._runtimeDisposer.connect(this._actor, 'enter-event', () => {
                this._cancelAutohideTimer();
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    /**
     * Destroy the trigger zone actor.
     * @private
     */
    _destroyTriggerZone() {
        if (this._triggerZone) {
            let parent = this._triggerZone.get_parent();
            if (parent) parent.remove_child(this._triggerZone);
            this._triggerZone.destroy();
            this._triggerZone = null;
        }
    }

    /**
     * Schedule the taskbar to hide after the delay.
     * @private
     */
    _scheduleAutohideTimer() {
        this._cancelAutohideTimer();
        this._runtimeDisposer.restartTimeout(
            this,
            '_autohideHideTimerId',
            GLib.PRIORITY_DEFAULT,
            AUTOHIDE_DELAY_MS,
            () => {
                // For intellihide, re-check occlusion before hiding
                if (this._intellihideActive && !this._isTaskbarOccluded()) {
                    this._revealTaskbar(true);
                    return GLib.SOURCE_REMOVE;
                }
                this._hideTaskbar(true);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Cancel any pending auto-hide timer.
     * @private
     */
    _cancelAutohideTimer() {
        this._runtimeDisposer.clearTimeoutRef(this, '_autohideHideTimerId');
    }

    /**
     * Update the strut visibility based on auto-hide/intellihide state.
     * When hidden, struts should not reserve work-area space.
     * @private
     */
    _syncStrutVisibility() {
        if (!this._taskbarStrut) return;
        let shouldStrut = !this._autohideActive && !this._intellihideActive;
        if (shouldStrut) {
            let thickness = this._readTaskbarThicknessPx();
            let monitor = this.getTaskbarAnchorMonitor();
            let panelH = Main.panel?.height || 0;
            if (monitor) {
                this._taskbarStrut.set_position(monitor.x, monitor.y + panelH);
                this._taskbarStrut.set_size(thickness, monitor.height - panelH);
            }
        } else {
            this._taskbarStrut.set_size(0, 0);
        }
    }

    // ── Intellihide ─────────────────────────────────────────────────

    /**
     * Connect to window position/size signals for intellihide tracking.
     * @private
     */
    _connectIntellihideWindowSignals() {
        this._disconnectIntellihideWindowSignals();

        let display = global.display;
        if (!display) return;

        let windowCreatedId = this._runtimeDisposer.connect(display,
            'window-created', (_d, metaWindow) => {
                this._trackIntellihideWindow(metaWindow);
                this._syncIntellihide();
            });
        this._intellihideWindowSignals.push({ obj: display, id: windowCreatedId });

        let wsManager = global.workspace_manager;
        if (wsManager) {
            let wsChangedId = this._runtimeDisposer.connect(wsManager,
                'active-workspace-changed', () => {
                    this._refreshIntellihideTracking();
                    this._syncIntellihide();
                });
            this._intellihideWindowSignals.push({ obj: wsManager, id: wsChangedId });
        }

        // Track existing windows
        let activeWs = wsManager?.get_active_workspace();
        if (activeWs) {
            for (let win of activeWs.list_windows()) {
                this._trackIntellihideWindow(win);
            }
        }
    }

    /**
     * Track a single window for intellihide position/size changes.
     * @param {Object} metaWindow
     * @private
     */
    _trackIntellihideWindow(metaWindow) {
        if (!metaWindow) return;
        let type = metaWindow.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
            return;

        try {
            let posId = metaWindow.connect('position-changed', () => this._syncIntellihide());
            let sizeId = metaWindow.connect('size-changed', () => this._syncIntellihide());
            this._intellihideWindowSignals.push(
                { obj: metaWindow, id: posId },
                { obj: metaWindow, id: sizeId });
        } catch (_e) {}
    }

    /**
     * Refresh intellihide tracking for all windows on the active workspace.
     * @private
     */
    _refreshIntellihideTracking() {
        // Disconnect old window-level signals (keep display/ws signals)
        let kept = [];
        for (let entry of this._intellihideWindowSignals) {
            if (entry.obj === global.display || entry.obj === global.workspace_manager) {
                kept.push(entry);
                continue;
            }
            try { entry.obj.disconnect(entry.id); } catch (_e) {}
        }
        this._intellihideWindowSignals = kept;

        let ws = global.workspace_manager?.get_active_workspace();
        if (ws) {
            for (let win of ws.list_windows())
                this._trackIntellihideWindow(win);
        }
    }

    /**
     * Disconnect all intellihide window signals.
     * @private
     */
    _disconnectIntellihideWindowSignals() {
        for (let entry of this._intellihideWindowSignals) {
            try { entry.obj.disconnect(entry.id); } catch (_e) {}
        }
        this._intellihideWindowSignals = [];
    }

    /**
     * Check whether any normal window on the active workspace overlaps
     * the taskbar area on the taskbar's monitor.
     * @returns {boolean}
     */
    _isTaskbarOccluded() {
        let tbRect = this.getTaskbarRect();
        if (!tbRect) return false;

        let monitor = this.getTaskbarAnchorMonitor();
        let monIndex = monitor ? Main.layoutManager.monitors.indexOf(monitor) : -1;
        let ws = global.workspace_manager?.get_active_workspace();
        if (!ws) return false;

        for (let win of ws.list_windows()) {
            if (win.minimized) continue;
            let type = win.get_window_type();
            if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
                continue;
            if (monIndex >= 0 && win.get_monitor() !== monIndex) continue;

            let frame = win.get_frame_rect();
            if (!frame) continue;

            // Rectangle overlap test
            if (frame.x < tbRect.x + tbRect.width &&
                frame.x + frame.width > tbRect.x &&
                frame.y < tbRect.y + tbRect.height &&
                frame.y + frame.height > tbRect.y) {
                return true;
            }
        }
        return false;
    }

    /**
     * Sync intellihide visibility: hide if occluded, show if not.
     * @private
     */
    // ── Fullscreen monitor ─────────────────────────────────────────

    _setupFullscreenMonitor() {
        this._teardownFullscreenMonitor();
        let display = global.display;
        if (!display) return;

        let id = display.connect('in-fullscreen-changed', () => this._syncFullscreenHide());
        this._fullscreenSignalIds.push({ obj: display, id });

        // Also track workspace changes since fullscreen state is per-workspace
        let wsManager = global.workspace_manager;
        if (wsManager) {
            let wsId = wsManager.connect('active-workspace-changed',
                () => this._syncFullscreenHide());
            this._fullscreenSignalIds.push({ obj: wsManager, id: wsId });
        }

        this._syncFullscreenHide();
    }

    _teardownFullscreenMonitor() {
        for (let entry of this._fullscreenSignalIds) {
            try { entry.obj.disconnect(entry.id); } catch (_) {}
        }
        this._fullscreenSignalIds = [];
        if (this._fullscreenHidden) {
            this._fullscreenHidden = false;
            this._revealTaskbar(false);
            this._syncCorners();
        }
    }

    _syncFullscreenHide() {
        let hasFullscreen = this._hasFullscreenWindow();
        if (hasFullscreen && !this._fullscreenHidden) {
            this._fullscreenHidden = true;
            this._hideTaskbar(true);
            this._syncCorners();
        } else if (!hasFullscreen && this._fullscreenHidden) {
            this._fullscreenHidden = false;
            // Restore based on current mode
            if (this._autohideActive) {
                this._hideTaskbar(false);
            } else if (this._intellihideActive) {
                this._syncIntellihide();
            } else {
                this._revealTaskbar(true);
            }
            this._syncCorners();
        }
    }

    _hasFullscreenWindow() {
        let monitor = this.getTaskbarAnchorMonitor();
        let monIndex = monitor ? Main.layoutManager.monitors.indexOf(monitor) : -1;
        let ws = global.workspace_manager?.get_active_workspace();
        if (!ws) return false;

        for (let win of ws.list_windows()) {
            if (win.minimized) continue;
            if (!win.is_fullscreen()) continue;
            if (monIndex >= 0 && win.get_monitor() !== monIndex) continue;
            return true;
        }
        return false;
    }

    // ── Intellihide sync ─────────────────────────────────────────

    _syncIntellihide() {
        if (!this._intellihideActive) return;
        if (this._fullscreenHidden) return; // fullscreen takes priority

        if (this._isTaskbarOccluded()) {
            if (this._autohideRevealed)
                this._hideTaskbar(true);
        } else {
            if (!this._autohideRevealed)
                this._revealTaskbar(true);
        }
        this._syncStrutVisibility();
    }

    // ── Dynamic opacity ─────────────────────────────────────────────

    /**
     * Set up or tear down dynamic opacity based on the setting.
     * @private
     */
    _setupDynamicOpacity() {
        let enabled = false;
        try { enabled = this._settings?.get_boolean('taskbar-dynamic-opacity') ?? false; }
        catch (_e) {}

        if (enabled && !this._dynamicOpacityActive) {
            this._dynamicOpacityActive = true;
            this._connectDynamicOpacitySignals();
            this._syncDynamicOpacity();
        } else if (!enabled && this._dynamicOpacityActive) {
            this._teardownDynamicOpacity();
            this._dynamicOpacityAlpha = null;
            this._applyInlineStyle();
        }
    }

    /**
     * Tear down dynamic opacity tracking.
     * @private
     */
    _teardownDynamicOpacity() {
        for (let entry of this._dynamicOpacityWindowSignals) {
            try { entry.obj.disconnect(entry.id); } catch (_e) {}
        }
        this._dynamicOpacityWindowSignals = [];
        this._dynamicOpacityActive = false;
    }

    /**
     * Connect window and workspace signals needed for dynamic opacity.
     * @private
     */
    _connectDynamicOpacitySignals() {
        this._teardownDynamicOpacity();
        this._dynamicOpacityActive = true;

        let display = global.display;
        if (display) {
            let id = display.connect('window-created', (_d, metaWindow) => {
                this._trackDynamicOpacityWindow(metaWindow);
                this._syncDynamicOpacity();
            });
            this._dynamicOpacityWindowSignals.push({ obj: display, id });
        }

        let wsManager = global.workspace_manager;
        if (wsManager) {
            let id = wsManager.connect('active-workspace-changed',
                () => {
                    this._refreshDynamicOpacityTracking();
                    this._syncDynamicOpacity();
                });
            this._dynamicOpacityWindowSignals.push({ obj: wsManager, id });
        }

        // Track existing windows
        let ws = wsManager?.get_active_workspace();
        if (ws) {
            for (let win of ws.list_windows())
                this._trackDynamicOpacityWindow(win);
        }
    }

    /**
     * Track a window's maximize state for dynamic opacity.
     * @param {Object} metaWindow
     * @private
     */
    _trackDynamicOpacityWindow(metaWindow) {
        if (!metaWindow) return;
        let type = metaWindow.get_window_type();
        if (type !== Meta.WindowType.NORMAL) return;

        try {
            let id1 = metaWindow.connect('notify::maximized-horizontally',
                () => this._syncDynamicOpacity());
            let id2 = metaWindow.connect('notify::maximized-vertically',
                () => this._syncDynamicOpacity());
            this._dynamicOpacityWindowSignals.push(
                { obj: metaWindow, id: id1 },
                { obj: metaWindow, id: id2 });
        } catch (_e) {}
    }

    /**
     * Refresh dynamic opacity window tracking after workspace change.
     * @private
     */
    _refreshDynamicOpacityTracking() {
        let kept = [];
        for (let entry of this._dynamicOpacityWindowSignals) {
            if (entry.obj === global.display || entry.obj === global.workspace_manager) {
                kept.push(entry);
                continue;
            }
            try { entry.obj.disconnect(entry.id); } catch (_e) {}
        }
        this._dynamicOpacityWindowSignals = kept;

        let ws = global.workspace_manager?.get_active_workspace();
        if (ws) {
            for (let win of ws.list_windows())
                this._trackDynamicOpacityWindow(win);
        }
    }

    /**
     * Recalculate and apply the dynamic opacity based on whether any
     * maximized window is present on the taskbar's monitor.
     * @private
     */
    _syncDynamicOpacity() {
        if (!this._dynamicOpacityActive || !this._actor) return;

        let hasMaximized = this._hasMaximizedWindowOnMonitor();
        let fullAlpha = this._readTaskbarBackgroundOpacity();
        let minAlpha = 0;
        try { minAlpha = Math.max(0, Math.min(1,
            (this._settings?.get_int('taskbar-dynamic-opacity-min') ?? 0) / 100)); }
        catch (_e) {}

        let targetAlpha = hasMaximized ? fullAlpha : minAlpha;

        if (this._dynamicOpacityAlpha === targetAlpha) return;
        this._dynamicOpacityAlpha = targetAlpha;

        // Smoothly transition the style
        this._actor.ease({
            duration: DYNAMIC_OPACITY_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._applyInlineStyle(),
        });
        // Apply immediately so the transition target is correct
        this._applyInlineStyle();
    }

    /**
     * Check whether any maximized window exists on the taskbar's monitor.
     * @returns {boolean}
     * @private
     */
    _hasMaximizedWindowOnMonitor() {
        let monitor = this.getTaskbarAnchorMonitor();
        let monIndex = monitor ? Main.layoutManager.monitors.indexOf(monitor) : -1;
        let ws = global.workspace_manager?.get_active_workspace();
        if (!ws) return false;

        for (let win of ws.list_windows()) {
            if (win.minimized) continue;
            let type = win.get_window_type();
            if (type !== Meta.WindowType.NORMAL) continue;
            if (monIndex >= 0 && win.get_monitor() !== monIndex) continue;
            if (win.maximized_horizontally && win.maximized_vertically)
                return true;
        }
        return false;
    }

    // ── Multi-monitor ────────────────────────────────────────────────

    /**
     * Read the taskbar monitor mode setting.
     * @returns {'single'|'all'}
     * @private
     */
    _readMonitorMode() {
        try {
            let mode = this._settings?.get_string('taskbar-monitor-mode') ?? 'single';
            return mode === 'all' ? 'all' : 'single';
        } catch (_e) {
            return 'single';
        }
    }

    /**
     * Read the single-monitor target setting.
     * @returns {'primary'|'focused'}
     * @private
     */
    _readSingleMonitorTarget() {
        try {
            let t = this._settings?.get_string('taskbar-single-monitor-target') ?? 'primary';
            return t === 'focused' ? 'focused' : 'primary';
        } catch (_e) {
            return 'primary';
        }
    }

    /**
     * Set up multi-monitor taskbar support based on current settings.
     * In 'all' mode, creates a mirror taskbar on every non-primary monitor.
     * In 'single'+'focused' mode, moves the taskbar to the pointer's monitor.
     * @private
     */
    _syncCorners() {
        try {
            this._controller?.taskbarAnimations?.syncTaskbarCorners();
        } catch (_e) {}
    }

    /**
     * Set up multi-monitor taskbar support.
     * @private
     */
    _setupMultiMonitor() {
        this._teardownMultiMonitor();

        let mode = this._readMonitorMode();

        // Connect to monitors-changed to rebuild on hotplug
        this._runtimeDisposer.replaceConnection(
            this,
            '_monitorsChangedId',
            Main.layoutManager,
            'monitors-changed',
            () => this._setupMultiMonitor()
        );

        if (mode === 'all') {
            let desktopMonitorIndices = this._getDesktopMonitorIndices();
            let anchorMonitorIndex = this._getAnchorMonitorIndex();
            for (let i of desktopMonitorIndices) {
                if (i === anchorMonitorIndex)
                    continue;
                this._createMirrorTaskbar(i);
            }
        } else {
            // single mode
            let target = this._readSingleMonitorTarget();
            if (target === 'focused')
                this._startPointerMonitorTracking();
        }
    }

    /**
     * Tear down all multi-monitor state: destroy mirrors, stop tracking.
     * @private
     */
    _teardownMultiMonitor() {
        this._stopPointerMonitorTracking();
        this._destroyMirrorTaskbars();
        this._runtimeDisposer.clearConnectionRef(this, '_monitorsChangedId', Main.layoutManager);
    }

    /**
     * Create a mirror taskbar on the given monitor.
     * The mirror shares the same favorites/running icons as the primary.
     * @param {number} monitorIndex
     * @private
     */
    _createMirrorTaskbar(monitorIndex) {
        let monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor) return;

        let thickness = this._readTaskbarThicknessPx();
        let panelH = Main.panel?.height || 0;
        let x = monitor.x;
        let y = monitor.y + panelH;
        let h = monitor.height - panelH;

        // Mirror container
        let actor = new St.Widget({
            name: `convergence-taskbar-mirror-${monitorIndex}`,
            style_class: 'convergence-taskbar-background',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            clip_to_allocation: true,
        });
        actor.set_position(x, y);
        actor.set_size(thickness, h);

        // Apply same inline style as primary
        let bgAlpha = this._dynamicOpacityAlpha ?? this._readTaskbarBackgroundOpacity();
        let overlayAlpha = Math.max(0.08, bgAlpha * 0.25);
        actor.set_style(
            `background-color: rgba(0, 0, 0, ${bgAlpha}); ` +
            `box-shadow: inset 0 0 0 9999px rgba(0, 0, 0, ${overlayAlpha}); ` +
            `border-top-width: 0;`);

        // Build icon row
        let mirrorRow = new St.BoxLayout({
            style_class: 'convergence-taskbar-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        mirrorRow.set_style('spacing: 3px; padding: 3px 0px 3px 0px;');

        let mirrorScroll = new St.ScrollView({
            style_class: 'convergence-taskbar-scrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            overlay_scrollbars: true,
            enable_mouse_scrolling: false,
        });
        mirrorScroll.add_child(mirrorRow);

        let section = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        section.set_style('padding: 1px 0px 2px 0px;');
        section.add_child(mirrorScroll);
        actor.add_child(section);

        Main.layoutManager.uiGroup.insert_child_below(
            actor, Main.layoutManager.modalDialogGroup);

        // Populate icons
        let icons = this._controller?.taskbarIcons;
        if (icons) {
            let metrics = this.getMetrics();
            icons.populateFavorites(mirrorRow, {
                isLargeDisplay: true,
                sideTaskbar: true,
                taskbar: true,
                metrics,
            });
        }

        // Strut for this mirror
        let strut = new St.Widget({
            name: `convergence-taskbar-mirror-strut-${monitorIndex}`,
            width: thickness,
            height: h,
            opacity: 0,
            reactive: false,
        });
        strut.set_position(x, y);
        Main.layoutManager.addTopChrome(strut, {
            affectsStruts: true,
            trackFullscreen: true,
        });

        this._mirrorTaskbars.push({
            monitorIndex,
            actor,
            row: mirrorRow,
            section,
        });
        this._mirrorStruts.push(strut);
    }

    /**
     * Destroy all mirror taskbars and their struts.
     * @private
     */
    _destroyMirrorTaskbars() {
        for (let mirror of this._mirrorTaskbars) {
            if (mirror.actor?.get_parent())
                mirror.actor.get_parent().remove_child(mirror.actor);
            mirror.actor?.destroy?.();
        }
        this._mirrorTaskbars = [];

        for (let strut of this._mirrorStruts) {
            try { Main.layoutManager.removeChrome(strut); } catch (_e) {}
            strut.destroy();
        }
        this._mirrorStruts = [];
    }

    /**
     * Start polling the pointer position to move the taskbar to the
     * focused monitor (single + focused mode).
     * @private
     */
    _startPointerMonitorTracking() {
        if (this._pointerMonitorCheckId) return;
        this._lastPointerMonitor = this._getAnchorMonitorIndex();

        this._pointerMonitorCheckId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 500, () => {
                let [mx, my] = global.get_pointer();
                let monitors = Main.layoutManager.monitors;
                let desktopMonitorIndices = new Set(this._getDesktopMonitorIndices());
                let found = this._getAnchorMonitorIndex();
                for (let i = 0; i < monitors.length; i++) {
                    if (!desktopMonitorIndices.has(i))
                        continue;
                    let m = monitors[i];
                    if (mx >= m.x && mx < m.x + m.width &&
                        my >= m.y && my < m.y + m.height) {
                        found = i;
                        break;
                    }
                }
                if (found !== this._lastPointerMonitor) {
                    this._lastPointerMonitor = found;
                    this._moveTaskbarToMonitor(found);
                }
                return GLib.SOURCE_CONTINUE;
            });
        this._runtimeDisposer.trackTimeout(this._pointerMonitorCheckId);
    }

    /**
     * Stop the pointer monitor tracking interval.
     * @private
     */
    _stopPointerMonitorTracking() {
        this._runtimeDisposer.clearTimeoutRef(this, '_pointerMonitorCheckId');
        // Restore to primary
        let anchorMonitorIndex = this._getAnchorMonitorIndex();
        if (this._lastPointerMonitor !== anchorMonitorIndex)
            this._moveTaskbarToMonitor(anchorMonitorIndex);
        this._lastPointerMonitor = -1;
    }

    /**
     * Reposition the primary taskbar actor and strut to the given monitor.
     * @param {number} monitorIndex
     * @private
     */
    _moveTaskbarToMonitor(monitorIndex) {
        let monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor || !this._actor) return;

        let thickness = this._readTaskbarThicknessPx();
        let panelH = (monitorIndex === Main.layoutManager.primaryIndex)
            ? (Main.panel?.height || 0) : 0;
        let x = monitor.x;
        let y = monitor.y + panelH;
        let h = monitor.height - panelH;

        this._actor.set_position(x, y);
        this._actor.set_size(thickness, h);

        if (this._taskbarStrut) {
            this._taskbarStrut.set_position(x, y);
            this._taskbarStrut.set_size(thickness, h);
        }

        this._applyInlineStyle();
    }

    /**
     * Get all taskbar rows including mirrors — used by TaskbarIcons for
     * bulk highlight updates.
     * @returns {St.BoxLayout[]}
     */
    getAllTaskbarRows() {
        let rows = [];
        if (this._favoritesRow) rows.push(this._favoritesRow);
        for (let mirror of this._mirrorTaskbars) {
            if (mirror.row) rows.push(mirror.row);
        }
        return rows;
    }

    // ── Cleanup ──────────────────────────────────────────────────────

    destroy() {
        if (this._populateIdleId) {
            GLib.source_remove(this._populateIdleId);
            this._populateIdleId = 0;
        }

        this._teardownMultiMonitor();
        this._teardownFullscreenMonitor();
        this._teardownAutohide();
        this._teardownDynamicOpacity();
        this._restorePanelBackground();

        if (this._taskbarStrut) {
            Main.layoutManager.removeChrome(this._taskbarStrut);
            this._taskbarStrut.destroy();
            this._taskbarStrut = null;
        }

        if (this._actor) {
            let parent = this._actor.get_parent();
            if (parent) parent.remove_child(this._actor);
            this._actor.destroy();
            this._actor = null;
        }

        this._taskbarSection = null;
        this._scrollView = null;
        this._showAppsContainer = null;
        this._favoritesRow = null;
        this._runtimeDisposer?.dispose();
        this._logger?.destroy?.();
    }
}
