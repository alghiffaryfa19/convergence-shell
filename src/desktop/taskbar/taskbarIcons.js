// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu as NativeAppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import { addClickCursor, createLongPressController } from '../../shared/utilities/uiUtils.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { Logger } from '../../shared/utilities/logger.js';

const HOVER_HL_FADE_MS = 150;
const TASKBAR_LAUNCH_BOUNCE_MS = 130;
const DND_LONG_PRESS_MS = 500;
const DND_REORDER_ANIM_MS = 150;
const URGENT_PULSE_MS = 800;

/**
 * St.Widget with BinLayout that reports a fixed preferred size so children's
 * minimum dimensions cannot inflate the parent button's allocation.
 */
const _FixedBinWidget = GObject.registerClass(
class _FixedBinWidget extends St.Widget {
    vfunc_get_preferred_width(_forHeight) {
        let s = this._fixedSize ?? 0;
        return [s, s];
    }
    vfunc_get_preferred_height(_forWidth) {
        let s = this._fixedSize ?? 0;
        return [s, s];
    }
});

const TASKBAR_ACCENT_CLASSES = [
    'convergence-taskbar-accent-blue',
    'convergence-taskbar-accent-teal',
    'convergence-taskbar-accent-green',
    'convergence-taskbar-accent-yellow',
    'convergence-taskbar-accent-orange',
    'convergence-taskbar-accent-red',
    'convergence-taskbar-accent-pink',
    'convergence-taskbar-accent-purple',
    'convergence-taskbar-accent-slate',
];

/**
 * Manages app icons in the desktop taskbar: creating icon buttons from
 * favorites, showing running/focused indicators, notification badges,
 * handling click-to-activate/minimize, and the Show Apps button.
 */
export class TaskbarIcons {
    /**
     * @param {Object} taskbar - Parent Taskbar instance
     * @param {Object} controller - Extension controller
     * @param {Object} settings - GSettings instance
     */
    constructor(taskbar, controller, settings) {
        this._taskbar = taskbar;
        this._controller = controller;
        this._settings = settings ?? null;
        this._logger = new Logger('TaskbarIcons', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();

        this._urgentApps = new Set();
        this._lastRunningNonPinnedIds = '';
        this._runningAppsUpdateId = 0;
        this._accentClass = 'convergence-taskbar-accent-blue';
        this._interfaceSettings = null;

        // Context menu state
        this._contextMenuManager = null;
        this._contextMenu = null;

        // Notification badge state
        this._notifSyncId = 0;
        this._notifSignalConnected = false;

        // Keyboard shortcut binding names
        this._keybindingNames = [];

        // The current favorites row (set during populateFavorites)
        this._currentRow = null;

        // App state signal IDs (for running app tracking)
        this._appStateSignalIds = [];

        // Drag-and-drop reorder state
        this._dndActive = false;
        this._dndButton = null;
        this._dndClone = null;
        this._dndOrigIndex = -1;
        this._dndPreviewIndex = -1;
        this._dndGrabSequence = null;
        this._dndStartX = 0;
        this._dndStartY = 0;

        // Urgent window state
        this._urgentDisplaySignals = [];
        this._urgentPulseTimers = new Map();

        try {
            this._interfaceSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.interface',
            });
        } catch (_e) {
            this._interfaceSettings = null;
        }

        this._connectSettingsSignals();
        this._connectNotificationSignals();
        this._connectUrgentSignals();
    }

    /**
     * Connect to Shell signals that track running app changes and
     * focus changes, so the taskbar updates live.
     * @param {St.BoxLayout} row - The favorites row to update
     */
    connectAppStateSignals(row) {
        this._disconnectAppStateSignals();

        let appSys = Shell.AppSystem.get_default();
        let tracker = Shell.WindowTracker.get_default();

        let id1 = appSys.connect('app-state-changed', () => {
            this.scheduleRunningAppsUpdate(row);
        });
        this._appStateSignalIds.push({ obj: appSys, id: id1 });

        let id2 = tracker.connect('notify::focus-app', () => {
            this.updateRunningHighlights(row);
        });
        this._appStateSignalIds.push({ obj: tracker, id: id2 });

        let favs = AppFavorites.getAppFavorites();
        let id3 = favs.connect('changed', () => {
            this.populateFavorites(row, {
                isLargeDisplay: true,
                sideTaskbar: this._taskbar.isSideTaskbarLayout(),
                taskbar: this._taskbar.isTaskbarMode(),
                metrics: this._getCurrentMetrics(),
            });
        });
        this._appStateSignalIds.push({ obj: favs, id: id3 });
    }

    /**
     * Disconnect app state tracking signals.
     * @private
     */
    _disconnectAppStateSignals() {
        for (let entry of this._appStateSignalIds) {
            try { entry.obj.disconnect(entry.id); } catch (_e) {}
        }
        this._appStateSignalIds = [];
    }

    /**
     * Create a taskbar icon button for an app.
     * @param {Object} app - Shell.App instance
     * @param {boolean} isPinned - Whether this is a pinned favorite
     * @param {Object|null} metrics - Optional sizing metrics
     * @returns {St.Button}
     */
    createTaskbarIcon(app, isPinned = true, metrics = null) {
        let sideTaskbar = this._taskbar.isSideTaskbarMode();
        let taskbarIconSize = metrics?.taskbarIconSize ?? 32;
        let taskbarCellW = metrics?.taskbarCellW ?? 48;
        let iconPad = sideTaskbar
            ? Math.max(1, Math.round((metrics?.sideTaskbarGapPx ?? 6) * 0.5)) +
                (metrics?.sideTaskbarExtraPadPx ?? 2)
            : 0;
        let itemExtent = taskbarCellW;

        let icon = app.create_icon_texture(taskbarIconSize);
        icon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let content;
        let indicators = new St.BoxLayout({
            style_class: 'convergence-taskbar-indicators',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        if (sideTaskbar) {
            let taskbarPos = this._taskbar._readTaskbarPosition?.() ?? 'left';
            let edgeSide = taskbarPos === 'right'
                ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
            let contentSize = itemExtent - iconPad * 2;
            content = new _FixedBinWidget({
                layout_manager: new Clutter.BinLayout(),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                width: contentSize,
                height: contentSize,
                clip_to_allocation: true,
            });
            content._fixedSize = contentSize;
            content.add_child(icon);
            indicators.vertical = true;
            indicators.add_style_class_name(
                'convergence-taskbar-indicators-vertical');
            indicators.x_align = edgeSide;
            indicators.y_align = Clutter.ActorAlign.CENTER;
            indicators.x_expand = true;
            indicators.y_expand = true;
            // Position indicators between icon edge and panel edge
            let contentWidth = contentSize;
            let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            let halfGap = (contentWidth - taskbarIconSize) / 4;
            let offset = Math.round(halfGap + 4 * scale);
            indicators.translation_x = taskbarPos === 'right' ? offset : -offset;
            indicators.style = 'margin: 0; margin-top: 0; min-height: 0; spacing: 2px;';
            content.add_child(indicators);
        } else {
            content = new St.BoxLayout({
                style_class: 'convergence-app-icon-button',
                vertical: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            content.add_child(icon);
            indicators.x_expand = true;
            content.add_child(indicators);
        }

        let notifDot = this._createNotificationBadge();
        content.add_child(notifDot);

        let button = new St.Button({
            child: content,
            style_class: 'convergence-taskbar-icon',
            width: itemExtent,
            height: itemExtent,
            style: `padding: ${iconPad}px; margin: 0;`,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
        });
        button._convergenceApp = app;
        button._convergenceIcon = icon;
        button._convergenceIndicatorRow = indicators;
        button._convergenceTaskbarNotifDot = notifDot;
        button._convergenceBaseStyle = `padding: ${iconPad}px; margin: 0;`;

        this._applyHoverHighlight(button);
        button.connect('notify::hover', () => this.syncButtonHoverHighlight(button));
        addClickCursor(button, this._runtimeDisposer);

        this._wireIconClickHandlers(button, app, isPinned);
        this._wireIconKeyboardHandlers(button, app, isPinned);
        this._wireIconPreviewHandlers(button, app);
        this._initDragHandlers(button);

        // Wire per-button hover animation (SIMPLE mode)
        let anims = this._controller?.taskbarAnimations;
        if (anims)
            anims.connectButton(button);

        return button;
    }

    /**
     * Create the "Show Apps" button for the taskbar.
     * @param {number} monitorIndex
     * @param {Object|null} metrics
     * @returns {St.Button}
     */
    createShowAppsButton(monitorIndex = -1, metrics = null) {
        let sideTaskbar = this._taskbar.isSideTaskbarMode();
        let taskbarIconSize = metrics?.taskbarIconSize ?? 32;
        let taskbarCellW = metrics?.taskbarCellW ?? 48;
        let iconPad = sideTaskbar
            ? Math.max(1, metrics?.sideTaskbarGapPx ?? 6) +
                (metrics?.sideTaskbarExtraPadPx ?? 2)
            : 0;
        let itemExtent = taskbarCellW;

        let icon = new St.Icon({
            icon_size: taskbarIconSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'convergence-taskbar-show-apps-icon',
        });

        // Apply custom icon from settings, and update dynamically on change.
        // The icon chooser stores either a themed icon name ('firefox') or
        // an absolute file path ('/usr/share/icons/...').
        let applyIcon = () => {
            let customIcon = '';
            try {
                customIcon = this._settings?.get_string('taskbar-app-grid-icon') ?? '';
            } catch (_e) {}
            if (customIcon) {
                if (customIcon.startsWith('/')) {
                    // Absolute file path — use GFileIcon
                    try {
                        icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(customIcon));
                    } catch (_e) {
                        icon.gicon = null;
                        icon.icon_name = 'view-app-grid-symbolic';
                    }
                } else {
                    // Themed icon name — set directly on icon_name
                    icon.gicon = null;
                    icon.icon_name = customIcon;
                }
            } else {
                icon.gicon = null;
                icon.icon_name = 'view-app-grid-symbolic';
            }
        };
        applyIcon();
        if (this._settings?.settings_schema?.has_key?.('taskbar-app-grid-icon')) {
            let iconSettingsState = { id: 0 };
            this._runtimeDisposer.replaceConnection(
                iconSettingsState,
                'id',
                this._settings,
                'changed::taskbar-app-grid-icon',
                applyIcon
            );
            this._runtimeDisposer.connect(icon, 'destroy', () => {
                this._runtimeDisposer.clearConnectionRef(iconSettingsState, 'id', this._settings);
            });
        }

        let button = new St.Button({
            child: icon,
            style_class: 'convergence-taskbar-show-apps',
            width: itemExtent,
            height: itemExtent,
            style: `padding: ${iconPad}px; margin: 0;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button._convergenceIsShowApps = true;
        button._convergenceBaseStyle = `padding: ${iconPad}px; margin: 0;`;

        this._applyHoverHighlight(button);
        button.connect('notify::hover', () => this.syncButtonHoverHighlight(button));
        addClickCursor(button, this._runtimeDisposer);

        // Left-click: toggle the floating AppMenu
        button.connect('clicked', () => {
            let appMenu = this._controller?.appMenu;
            if (appMenu) {
                appMenu.toggle(monitorIndex >= 0
                    ? monitorIndex
                    : Main.layoutManager.primaryIndex);
            } else {
                if (Main.overview?.visible)
                    Main.overview.hide();
                else
                    Main.overview?.show?.();
            }
        });

        // Right-click: context menu with Extension Settings
        this._wireShowAppsContextMenu(button);

        return button;
    }

    /**
     * Populate favorites and running-app icons in the given taskbar row.
     * @param {St.BoxLayout} row
     * @param {Object} options
     */
    populateFavorites(row, options = {}) {
        let {
            isLargeDisplay = true,
            sideTaskbar = false,
            taskbar = false,
            maxTaskbarIcons = 20,
            metrics = null,
        } = options;

        this._currentRow = row;
        this._dismissContextMenu();
        row.destroy_all_children();

        let isSideTaskbar = taskbar && sideTaskbar;
        let bottomTaskbar = taskbar && !sideTaskbar;
        row.set_vertical(sideTaskbar);

        let hasLeadingShowApps = isLargeDisplay && this._hasLeadingShowAppsControl();
        let showAppsBtn = hasLeadingShowApps
            ? this.createShowAppsButton(-1, metrics)
            : null;

        let placeShowAppsAtEnd = sideTaskbar;
        if (showAppsBtn && !placeShowAppsAtEnd)
            row.add_child(showAppsBtn);

        let favorites = AppFavorites.getAppFavorites().getFavorites();
        let pinnedLimit = isLargeDisplay ? favorites.length : maxTaskbarIcons;
        let pinnedCount = Math.min(favorites.length, pinnedLimit);

        for (let i = 0; i < pinnedCount; i++) {
            let app = favorites[i];
            let btn = this.createTaskbarIcon(app, true, metrics);
            row.add_child(btn);
        }

        if (isLargeDisplay) {
            let pinnedIds = new Set(
                favorites.slice(0, pinnedCount).map(a => a.get_id()));
            let runningApps = this._getRunningNonPinnedApps(pinnedIds);
            this._lastRunningNonPinnedIds =
                runningApps.map(a => a.get_id()).join(',');

            if (runningApps.length > 0) {
                row.add_child(this._createTaskbarSeparator(sideTaskbar));
                let added = pinnedCount;
                let totalCap = pinnedCount + 3;
                for (let app of runningApps) {
                    if (added >= totalCap) break;
                    let btn = this.createTaskbarIcon(app, false, metrics);
                    row.add_child(btn);
                    added++;
                }
            }

            this.updateRunningHighlights(row);
        }

        if (showAppsBtn && placeShowAppsAtEnd) {
            // Place the Show Apps button in the separate bottom container
            // so it stays pinned below the scroll view.
            let showAppsContainer = this._taskbar?._showAppsContainer;
            if (showAppsContainer) {
                showAppsContainer.destroy_all_children();
                showAppsContainer.add_child(showAppsBtn);
            } else {
                // Fallback (mirror taskbars without a container)
                row.add_child(showAppsBtn);
            }
        }

        this._syncNotificationBadges(row);

        // --- TEMPORARY DIAGNOSTIC — remove after debugging ---
        if (sideTaskbar) {
            if (this._diagTimerId) GLib.source_remove(this._diagTimerId);
            this._diagTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._diagTimerId = 0;
                this._dumpButtonDiag(row);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _dumpButtonDiag(row) {
        let lines = ['', '=== TASKBAR BUTTON DIAGNOSTICS ==='];
        lines.push(`row spacing style: ${row.get_style()}`);
        lines.push(`row alloc: ${Math.round(row.width)}x${Math.round(row.height)}`);
        lines.push('');

        let prevBottom = null;
        for (let btn of row.get_children()) {
            let app = btn._convergenceApp;
            let name = app?.get_name?.() ?? (btn.style_class || 'separator');
            if (!app) {
                let [bx, by] = btn.get_transformed_position();
                lines.push(`${name}: pos=${Math.round(bx)},${Math.round(by)} size=${Math.round(btn.width)}x${Math.round(btn.height)}`);
                prevBottom = by + btn.height;
                lines.push('');
                continue;
            }

            let [bx, by] = btn.get_transformed_position();
            let gap = prevBottom != null ? Math.round((by - prevBottom) * 10) / 10 : '-';
            prevBottom = by + btn.height;

            // Check style classes and inline style
            let classes = [];
            for (let cls of ['convergence-taskbar-icon-focused', 'convergence-taskbar-icon-running',
                'convergence-taskbar-icon-running-strip', 'convergence-taskbar-icon-urgent']) {
                if (btn.has_style_class_name(cls)) classes.push(cls.replace('convergence-taskbar-icon-', ''));
            }
            let stateStr = classes.length ? classes.join('+') : 'idle';

            // Check transforms
            let tx = btn.translation_x, ty = btn.translation_y;
            let sx = btn.scale_x, sy = btn.scale_y;
            let transformStr = '';
            if (Math.abs(tx) > 0.1 || Math.abs(ty) > 0.1)
                transformStr += ` translate=(${tx.toFixed(1)},${ty.toFixed(1)})`;
            if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01)
                transformStr += ` scale=(${sx.toFixed(2)},${sy.toFixed(2)})`;

            // Check for hover clone
            let hasClone = btn._convergenceRaisedClone ? 'YES' : 'no';

            let flag = (Math.round(btn.height) !== Math.round(btn.width)) ? ' <<<< SIZE' : '';
            if (gap !== '-' && gap !== 3) flag += ` <<<< GAP=${gap}`;

            lines.push(`${name} [${stateStr}]${flag}`);
            lines.push(`  screen pos: ${Math.round(bx)},${Math.round(by)}  gap_from_prev: ${gap}px`);
            lines.push(`  alloc: ${Math.round(btn.width)}x${Math.round(btn.height)}  style: "${btn.get_style()}"`);
            lines.push(`  transform:${transformStr || ' none'}  clone: ${hasClone}`);
            lines.push(`  clip_to_alloc: ${btn.clip_to_allocation}  content_clip: ${btn.get_first_child()?.clip_to_allocation}`);
            lines.push('');
        }
        lines.push('=== END DIAGNOSTICS ===');
        let msg = lines.join('\n');
        log(msg);
        try {
            let path = GLib.get_home_dir() + '/taskbar_diag.txt';
            GLib.file_set_contents(path, msg);
        } catch (_e) {}
    }

    _getCurrentMetrics() {
        return this._taskbar?.getMetrics?.() ?? null;
    }

    /**
     * Update running/focused indicator styles on all taskbar icon children.
     * @param {St.BoxLayout} row
     */
    updateRunningHighlights(row) {
        if (!row) return;

        let tracker = Shell.WindowTracker.get_default();
        let focusApp = tracker.focus_app;
        let showIndicators = this._readShowOpenIndicators();
        let accentClass = this._readTaskbarAccentClass();
        let prevAccent = this._accentClass;
        let accentChanged = accentClass !== prevAccent;
        this._accentClass = accentClass;

        let highlightFillEnabled = this._readHighlightFillEnabled();
        let highlightEdgeEnabled = this._readHighlightEdgeEnabled();
        let highlightStripEnabled = this._readHighlightStripEnabled();

        for (let child of row.get_children()) {
            let app = child._convergenceApp;
            if (!app) continue;

            // Accent color
            if (accentChanged) {
                if (prevAccent) child.remove_style_class_name(prevAccent);
                child.add_style_class_name(accentClass);
            } else if (!child._convergenceAccentApplied) {
                child.add_style_class_name(accentClass);
            }
            child._convergenceAccentApplied = true;

            // Highlight fill/edge/strip CSS classes
            if (!highlightFillEnabled)
                child.add_style_class_name('convergence-taskbar-no-highlight-fill');
            else
                child.remove_style_class_name('convergence-taskbar-no-highlight-fill');

            if (!highlightEdgeEnabled)
                child.add_style_class_name('convergence-taskbar-no-highlight-edge');
            else
                child.remove_style_class_name('convergence-taskbar-no-highlight-edge');

            if (!showIndicators) {
                this._clearRunState(child);
                this.syncInstanceIndicators(child, 0, false);
                continue;
            }

            let isFocused = app === focusApp;
            let isRunning = app.get_state() === Shell.AppState.RUNNING;
            let instanceCount = this._countAppInstances(app);
            let isUrgent = this._urgentApps.has(app.get_id?.());

            let nextState = 0;
            if (isFocused) nextState |= 1;
            else if (isRunning) nextState |= 2;
            if (isRunning && highlightStripEnabled)
                nextState |= 4;
            if (isUrgent) nextState |= 16;

            let prev = child._convergenceRunState ?? 0;
            if (prev !== nextState) {
                this._applyRunState(child, prev, nextState);
                child._convergenceRunState = nextState;
                this.syncButtonHoverHighlight(child);
            }

            let dotCount = 0;
            if (isFocused || isRunning)
                dotCount = Math.min(4, Math.max(1, instanceCount));
            this.syncInstanceIndicators(child, dotCount, isFocused);
        }
    }

    /**
     * Sync the running-instance dot indicators on a taskbar icon button.
     * @param {St.Button} button
     * @param {number} count
     * @param {boolean} focused
     */
    syncInstanceIndicators(button, count, focused) {
        let row = button?._convergenceIndicatorRow;
        if (!row) return;

        let wasFocused = row.has_style_class_name(
            'convergence-taskbar-indicators-focused');
        row.remove_style_class_name('convergence-taskbar-indicators-focused');
        if (focused)
            row.add_style_class_name('convergence-taskbar-indicators-focused');

        let currentCount = row.get_n_children();
        let focusChanged = wasFocused !== focused && currentCount > 0;

        if (count <= 0) {
            if (currentCount === 0) {
                row.hide();
                return;
            }
            row.ease({
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    row.destroy_all_children();
                    row.hide();
                    row.opacity = 255;
                },
            });
            return;
        }

        if (currentCount < count) {
            for (let i = currentCount; i < count; i++) {
                let dot = new St.Widget({
                    style_class: 'convergence-taskbar-instance-dot',
                    scale_x: 0,
                    scale_y: 0,
                    opacity: 0,
                });
                dot.set_pivot_point(0.5, 0.5);
                row.add_child(dot);
                dot.ease({
                    scale_x: 1, scale_y: 1, opacity: 255,
                    duration: 200,
                    delay: (i - currentCount) * 40,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
        }

        if (currentCount > count) {
            let children = row.get_children();
            for (let i = currentCount - 1; i >= count; i--) {
                let dot = children[i];
                dot.ease({
                    scale_x: 0, scale_y: 0, opacity: 0,
                    duration: 150,
                    delay: (currentCount - 1 - i) * 30,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (!dot.is_destroyed?.()) dot.destroy();
                    },
                });
            }
        }

        if (!row.visible || currentCount === 0) {
            row.opacity = 0;
            row.show();
            row.ease({
                opacity: 255, duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (focusChanged && count > 0) {
            let targetScale = focused ? 1.2 : 1.0;
            let targetOpacity = focused ? 200 : 255;
            for (let dot of row.get_children()) {
                if (dot.is_destroyed?.()) continue;
                dot.set_pivot_point(0.5, 0.5);
                dot.ease({
                    scale_x: targetScale, scale_y: targetScale,
                    opacity: targetOpacity,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    onComplete: () => {
                        if (dot.is_destroyed?.()) return;
                        dot.ease({
                            scale_x: 1.0, scale_y: 1.0,
                            duration: 120,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    },
                });
            }
        }
    }

    /**
     * Sync hover highlight styling on a taskbar icon button.
     * @param {St.Button} button
     */
    syncButtonHoverHighlight(button) {
        if (!button._convergenceHlEnabled || !button._convergenceHlStyles)
            return;
        let s = button._convergenceHlStyles;
        let base = button._convergenceBaseStyle ?? '';
        let isActive = button.has_style_pseudo_class('active');
        let isHover = (button.hover && !button._convergenceTouchActive) ||
            button._convergenceExternalHover;
        let isFocused = button.has_style_class_name(
            'convergence-taskbar-icon-focused');
        let isRunning = button.has_style_class_name(
            'convergence-taskbar-icon-running');
        let isShowAppsActive = button._convergenceShowAppsActive ?? false;

        let hlStyle;
        if (isActive)
            hlStyle = s.pressed;
        else if (isHover)
            hlStyle = s.hover;
        else if (isFocused)
            hlStyle = s.focused;
        else if (isShowAppsActive)
            hlStyle = s.focused;
        else if (isRunning)
            hlStyle = s.running;
        else
            hlStyle = s.none;

        button.set_style(base + hlStyle);
    }

    /**
     * Find the center coordinates of a taskbar icon for a given app.
     * @param {St.BoxLayout} row
     * @param {string} appId
     * @returns {{x:number,y:number}|null}
     */
    getTaskbarIconTarget(row, appId) {
        if (!row || !appId) return null;
        for (let child of row.get_children()) {
            let app = child._convergenceApp;
            if (!app || app.get_id() !== appId) continue;
            let [x, y] = child.get_transformed_position();
            return { x: x + child.width / 2, y: y + child.height / 2 };
        }
        return null;
    }

    /**
     * Get the screen-space rectangle of a taskbar icon for a given app ID.
     * Used for minimize-to-icon geometry (set_icon_geometry).
     * @param {string} appId - The application ID (e.g. 'org.gnome.Terminal.desktop')
     * @param {number} [monitorIndex=-1] - Monitor index (unused, for API compat)
     * @returns {{x:number, y:number, width:number, height:number}|null}
     */
    getTaskbarIconRect(appId, monitorIndex = -1) {
        let row = this._currentRow;
        if (!row || !appId) return null;
        for (let child of row.get_children()) {
            let app = child._convergenceApp;
            if (!app || app.get_id() !== appId) continue;
            try {
                let [x, y] = child.get_transformed_position();
                return {
                    x: Math.round(x),
                    y: Math.round(y),
                    width: Math.round(child.width),
                    height: Math.round(child.height),
                };
            } catch (_e) {
                return null;
            }
        }
        return null;
    }

    /**
     * Schedule a debounced running-apps update.
     * @param {St.BoxLayout} row
     */
    scheduleRunningAppsUpdate(row) {
        if (this._runningAppsUpdateId) return;
        this._runningAppsUpdateId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 100, () => {
                this._runningAppsUpdateId = 0;
                let favorites = AppFavorites.getAppFavorites().getFavorites();
                let pinnedIds = new Set(favorites.map(a => a.get_id()));
                let runningApps = this._getRunningNonPinnedApps(pinnedIds);
                let runningIds = runningApps.map(a => a.get_id()).join(',');

                if (runningIds === this._lastRunningNonPinnedIds) {
                    this.updateRunningHighlights(row);
                } else {
                    this._lastRunningNonPinnedIds = runningIds;
                    this.populateFavorites(row, {
                        isLargeDisplay: true,
                        sideTaskbar: this._taskbar.isSideTaskbarLayout(),
                        taskbar: this._taskbar.isTaskbarMode(),
                        metrics: this._getCurrentMetrics(),
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Activate a taskbar app (focus, new window, or cycle).
     * @param {Object} app
     * @param {Object} opts
     */
    activateTaskbarApp(app, opts = {}) {
        if (!app) return;
        let { forceNewWindow = false } = opts;

        if (forceNewWindow) {
            this._controller?.setPendingDesktopLaunch?.();
            try {
                app.open_new_window(-1);
                return;
            } catch (_e) {
                try { app.activate(); } catch (_e2) {}
            }
        }

        this._clearAppUrgent(app);

        let target = this._chooseTaskbarTargetWindow(app);
        if (target) {
            try {
                target.activate(global.get_current_time());
                return;
            } catch (_e) {}
        }
        this._controller?.setPendingDesktopLaunch?.();
        try {
            app.activate();
        } catch (_e) {}
    }

    /**
     * Mark an app as no longer urgent and update highlights.
     * @param {Object} app
     * @private
     */
    _clearAppUrgent(app) {
        let appId = app?.get_id?.();
        if (!appId) return;
        this._urgentApps.delete(appId);
    }

    /**
     * Choose the best window to activate when clicking a taskbar icon.
     * @param {Object} app
     * @returns {Object|null} MetaWindow
     * @private
     */
    _chooseTaskbarTargetWindow(app) {
        let windows = this._getAppFocusableWindows(app);
        if (!windows.length) return null;

        let activeWs = global.workspace_manager.get_active_workspace_index();
        let wsWins = windows.filter(
            w => (w.get_workspace()?.index?.() ?? -1) === activeWs);
        let focusWin = global.display.get_focus_window();

        if (wsWins.length > 0) {
            if (focusWin && wsWins.includes(focusWin)) {
                let idx = wsWins.indexOf(focusWin);
                return wsWins[(idx + 1) % wsWins.length];
            }
            return wsWins[0];
        }
        return windows[0];
    }

    /**
     * Get focusable (non-minimized, normal/dialog) windows for an app.
     * @param {Object} app
     * @returns {Object[]}
     * @private
     */
    _getAppFocusableWindows(app) {
        try {
            return (app.get_windows() || []).filter(w => {
                if (!w || w.is_skip_taskbar() || w.minimized) return false;
                let t = w.get_window_type();
                return t === Meta.WindowType.NORMAL || t === Meta.WindowType.DIALOG;
            });
        } catch (_e) {
            return [];
        }
    }

    /**
     * Get running apps that are not in the pinned favorites set.
     * @param {Set} pinnedIds
     * @returns {Object[]}
     * @private
     */
    _getRunningNonPinnedApps(pinnedIds) {
        let tracker = Shell.WindowTracker.get_default();
        let wsManager = global.workspace_manager;
        let seen = new Set();
        let result = [];

        for (let i = 0; i < wsManager.get_n_workspaces(); i++) {
            let ws = wsManager.get_workspace_by_index(i);
            if (!ws) continue;
            for (let win of ws.list_windows()) {
                if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
                if (win.is_skip_taskbar()) continue;
                let app = tracker.get_window_app(win);
                if (!app) continue;
                let id = app.get_id();
                if (pinnedIds.has(id) || seen.has(id)) continue;
                seen.add(id);
                result.push(app);
            }
        }
        return result;
    }

    /**
     * Count the number of window instances for an app.
     * @param {Object} app
     * @returns {number}
     * @private
     */
    _countAppInstances(app) {
        try {
            let wins = app.get_windows() || [];
            let count = 0;
            for (let w of wins) {
                if (!w || w.is_skip_taskbar()) continue;
                let type = w.get_window_type();
                if (type === Meta.WindowType.NORMAL ||
                    type === Meta.WindowType.DIALOG)
                    count++;
            }
            return count;
        } catch (_e) {
            return 0;
        }
    }

    /**
     * Read whether to show open-app indicators from settings.
     * @returns {boolean}
     * @private
     */
    _readShowOpenIndicators() {
        try {
            return this._settings?.get_boolean('taskbar-show-open-indicators') ?? true;
        } catch (_e) {
            return true;
        }
    }

    /**
     * Read the current GNOME accent color as a taskbar style class.
     * @returns {string}
     * @private
     */
    _readTaskbarAccentClass() {
        if (!this._interfaceSettings)
            return 'convergence-taskbar-accent-blue';
        try {
            let val = this._interfaceSettings.get_string('accent-color') || 'blue';
            let map = {
                blue: 'convergence-taskbar-accent-blue',
                teal: 'convergence-taskbar-accent-teal',
                green: 'convergence-taskbar-accent-green',
                yellow: 'convergence-taskbar-accent-yellow',
                orange: 'convergence-taskbar-accent-orange',
                red: 'convergence-taskbar-accent-red',
                pink: 'convergence-taskbar-accent-pink',
                purple: 'convergence-taskbar-accent-purple',
                slate: 'convergence-taskbar-accent-slate',
            };
            return map[val] ?? 'convergence-taskbar-accent-blue';
        } catch (_e) {
            return 'convergence-taskbar-accent-blue';
        }
    }

    /**
     * Whether a leading "Show Apps" control should appear.
     * @returns {boolean}
     * @private
     */
    _hasLeadingShowAppsControl() {
        // The desktop taskbar always shows the Show Apps button.
        // The setting 'taskbar-app-grid-icon' is a string (custom icon),
        // not a boolean toggle — the button is always present.
        return true;
    }

    /**
     * Create a visual separator for the taskbar row (between pinned and running).
     * @param {boolean} vertical
     * @returns {St.Widget}
     * @private
     */
    _createTaskbarSeparator(vertical) {
        let iconSize = this._taskbar?.getTaskbarThickness?.() ?? 48;
        let barLen = Math.round(iconSize * 0.6);
        return new St.Widget({
            style_class: vertical
                ? 'convergence-taskbar-separator-vertical'
                : 'convergence-taskbar-separator',
            width: vertical ? barLen : 1,
            height: vertical ? 1 : barLen,
        });
    }

    /**
     * Create a notification badge overlay widget.
     * @returns {St.Widget}
     * @private
     */
    _createNotificationBadge() {
        let notifDot = new St.Widget({
            style_class: 'convergence-taskbar-notif-dot',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        let notifLabel = new St.Label({
            text: '0',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        notifDot.add_child(notifLabel);
        notifDot._convergenceLabel = notifLabel;
        return notifDot;
    }

    /**
     * Apply hover highlight configuration to a button.
     * @param {St.Button} button
     * @private
     */
    _applyHoverHighlight(button) {
        let hl = this._getHoverHighlightStyles();
        button.add_style_class_name('no-highlight');
        if (!hl) {
            button._convergenceHlEnabled = false;
            button._convergenceHlStyles = null;
            return;
        }
        button._convergenceHlEnabled = true;
        let brStyle = hl.br > 0 ? `border-radius: ${hl.br}px;` : '';
        let trans = `transition-duration: ${HOVER_HL_FADE_MS}ms;`;
        button._convergenceHlStyles = {
            hover: `background-color: ${hl.bg}; ${brStyle} ${trans}`,
            pressed: `background-color: ${hl.pressed}; ${brStyle} ${trans}`,
            running: `background-color: ${hl.running}; ${brStyle} ${trans}`,
            focused: `background-color: ${hl.focused}; ${brStyle} ${trans}`,
            none: `background-color: transparent; ${brStyle} ${trans}`,
        };
        this.syncButtonHoverHighlight(button);
    }

    /**
     * Read hover highlight style configuration from settings.
     * @returns {Object|null}
     * @private
     */
    _getHoverHighlightStyles() {
        let s = this._settings;
        if (!s?.get_boolean('taskbar-hover-highlight-enabled'))
            return null;
        return {
            bg: s.get_string('taskbar-hover-highlight-color'),
            pressed: s.get_string('taskbar-hover-highlight-pressed-color'),
            running: s.get_string('taskbar-hover-highlight-running-color'),
            focused: s.get_string('taskbar-hover-highlight-focused-color'),
            br: s.get_int('taskbar-hover-highlight-border-radius'),
        };
    }

    /**
     * Wire click/touch/press handlers onto a taskbar icon button.
     * @param {St.Button} button
     * @param {Object} app
     * @param {boolean} isPinned
     * @private
     */
    _wireIconClickHandlers(button, app, isPinned) {
        let lpFired = false;
        let touchStartX = 0;
        let touchStartY = 0;
        let touchTracking = false;
        let touchCancelDistSq = 100;

        let setActive = (active) => {
            if (active) button.add_style_pseudo_class('active');
            else button.remove_style_pseudo_class('active');
            this.syncButtonHoverHighlight(button);
        };

        button.connect('button-press-event', (_actor, event) => {
            let btn = event.get_button?.() ?? 1;
            if (btn === 2) {
                this.activateTaskbarApp(app, { forceNewWindow: true });
                return Clutter.EVENT_STOP;
            }
            if (btn === 3) {
                this._showAppContextMenu(button, app, isPinned);
                return Clutter.EVENT_STOP;
            }
            if (btn !== 1) return Clutter.EVENT_PROPAGATE;
            button._convergenceTouchActive = false;
            setActive(true);
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('button-release-event', () => {
            setActive(false);
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('touch-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                button._convergenceTouchActive = true;
                setActive(true);
                [touchStartX, touchStartY] = event.get_coords();
                touchTracking = true;
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (touchTracking && !lpFired) {
                    let [x, y] = event.get_coords();
                    let dx = x - touchStartX, dy = y - touchStartY;
                    if (dx * dx + dy * dy >= touchCancelDistSq) {
                        setActive(false);
                        touchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                setActive(false);
                button.fake_release();
                touchTracking = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('leave-event', () => {
            setActive(false);
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('clicked', () => {
            if (!lpFired) {
                this._animateLaunchAffordance(button);
                this.activateTaskbarApp(app);
            }
            lpFired = false;
        });
    }

    /**
     * Wire window preview / tooltip handlers onto a taskbar icon button.
     * Shows window previews on hover if the app has windows, otherwise
     * shows a text tooltip with the app name.
     * @param {St.Button} button
     * @param {Object} app
     * @private
     */
    _wireIconPreviewHandlers(button, app) {
        let previews = this._controller?.taskbarPreviews;
        if (!previews) return;

        button.connect('enter-event', () => {
            if (this._dndActive) return Clutter.EVENT_PROPAGATE;
            let wins = app.get_windows().filter(w =>
                w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar());
            if (wins.length > 0)
                previews.showWindowPreview(button, app);
            else
                previews.showTaskbarTooltip(button, app.get_name?.() ?? app.get_id?.() ?? '');
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('leave-event', () => {
            if (this._dndActive) return Clutter.EVENT_PROPAGATE;
            // Use grace period — gives user time to move pointer to the preview popup
            previews._dismissPreviewGracefully();
            previews.hideTaskbarTooltip();
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('button-press-event', () => {
            previews.hideWindowPreview();
            previews.hideTaskbarTooltip();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * Wire keyboard navigation handlers onto a taskbar icon button.
     * @param {St.Button} button
     * @param {Object} app
     * @param {boolean} isPinned
     * @private
     */
    _wireIconKeyboardHandlers(button, app, isPinned) {
        button.connect('key-press-event', (_actor, event) => {
            let key = event.get_key_symbol();
            let ctrl = event.has_control_modifier?.() || false;
            let row = button.get_parent?.();
            let buttons = row?.get_children?.()
                ?.filter(c => c instanceof St.Button) ?? [];
            let idx = buttons.indexOf(button);

            if (ctrl && (key === Clutter.KEY_Return || key === Clutter.KEY_n)) {
                this.activateTaskbarApp(app, { forceNewWindow: true });
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Return || key === Clutter.KEY_space) {
                this.activateTaskbarApp(app);
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Menu) {
                this._showAppContextMenu(button, app, isPinned);
                return Clutter.EVENT_STOP;
            }
            if (idx >= 0 && (key === Clutter.KEY_Right || key === Clutter.KEY_Down)) {
                let next = buttons[Math.min(buttons.length - 1, idx + 1)];
                next?.grab_key_focus?.();
                return Clutter.EVENT_STOP;
            }
            if (idx >= 0 && (key === Clutter.KEY_Left || key === Clutter.KEY_Up)) {
                let prev = buttons[Math.max(0, idx - 1)];
                prev?.grab_key_focus?.();
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Home && buttons.length) {
                buttons[0].grab_key_focus?.();
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_End && buttons.length) {
                buttons[buttons.length - 1].grab_key_focus?.();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * Animate a brief scale bounce on an icon button (launch affordance).
     * @param {Clutter.Actor} actor
     * @private
     */
    _animateLaunchAffordance(actor) {
        if (!actor) return;
        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 1.0);
        actor.ease({
            scale_x: 1.12, scale_y: 1.12,
            duration: TASKBAR_LAUNCH_BOUNCE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                actor.ease({
                    scale_x: 1, scale_y: 1,
                    duration: TASKBAR_LAUNCH_BOUNCE_MS,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                });
            },
        });
    }

    /**
     * Clear running-state style classes from a button.
     * @param {St.Button} child
     * @private
     */
    _clearRunState(child) {
        let prev = child._convergenceRunState ?? 0;
        if (prev !== 0) {
            if (prev & 1)
                child.remove_style_class_name('convergence-taskbar-icon-focused');
            if (prev & 2)
                child.remove_style_class_name('convergence-taskbar-icon-running');
            if (prev & 4)
                child.remove_style_class_name('convergence-taskbar-icon-running-strip');
            if (prev & 16)
                child.remove_style_class_name('convergence-taskbar-icon-urgent');
            child._convergenceRunState = 0;
            this.syncButtonHoverHighlight(child);
        }
    }

    /**
     * Apply run-state style transitions on a button.
     * @param {St.Button} child
     * @param {number} prev
     * @param {number} next
     * @private
     */
    _applyRunState(child, prev, next) {
        let removed = prev & ~next;
        let added = next & ~prev;
        if (removed & 1)
            child.remove_style_class_name('convergence-taskbar-icon-focused');
        if (removed & 2)
            child.remove_style_class_name('convergence-taskbar-icon-running');
        if (removed & 4)
            child.remove_style_class_name('convergence-taskbar-icon-running-strip');
        if (removed & 16)
            child.remove_style_class_name('convergence-taskbar-icon-urgent');
        if (added & 1)
            child.add_style_class_name('convergence-taskbar-icon-focused');
        if (added & 2)
            child.add_style_class_name('convergence-taskbar-icon-running');
        if (added & 4)
            child.add_style_class_name('convergence-taskbar-icon-running-strip');
        if (added & 16)
            child.add_style_class_name('convergence-taskbar-icon-urgent');
    }

    // ── Task 1: Show Apps context menu ─────────────────────────────

    /**
     * Wire right-click context menu onto the Show Apps button.
     * @param {St.Button} button
     * @private
     */
    _wireShowAppsContextMenu(button) {
        if (!button) return;

        button.connect('button-press-event', (_actor, event) => {
            let btn = event.get_button?.() ?? 1;
            if (btn === 3) {
                this._showShowAppsMenu(button);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * Show the Show Apps button context menu.
     * @param {St.Button} anchor
     * @private
     */
    _showShowAppsMenu(anchor) {
        this._dismissContextMenu();
        this._ensureContextMenuManager();

        let menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.LEFT);
        menu.actor.add_style_class_name('popup-menu');
        Main.layoutManager.uiGroup.add_child(menu.actor);
        menu.actor.hide();

        let settingsItem = new PopupMenu.PopupMenuItem('Extension Settings');
        settingsItem.connect('activate', () => {
            this._openExtensionPreferences();
            this._dismissContextMenu();
        });
        menu.addMenuItem(settingsItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._contextMenu = menu;
        menu.connect('menu-closed', () => {
            if (this._contextMenu === menu)
                this._dismissContextMenu();
        });
        this._contextMenuManager.addMenu(menu);
        menu.open();
    }

    // ── Task 2: App icon context menus ──────────────────────────────

    /**
     * Show a right-click context menu for a taskbar app icon.
     * @param {St.Button} anchor
     * @param {Object} app
     * @param {boolean} isPinned
     * @private
     */
    _showAppContextMenu(anchor, app, _isPinned) {
        if (!anchor || !app) return;

        // Dismiss window preview and tooltip before showing the menu
        let previews = this._controller?.taskbarPreviews;
        if (previews) {
            previews.hideWindowPreview();
            previews.hideTaskbarTooltip();
        }

        this._dismissContextMenu();
        this._ensureContextMenuManager();

        // Use GNOME's native AppMenu which includes all .desktop file
        // actions, window list, pin/unpin, "Show Details", etc.
        let menu = new NativeAppMenu(anchor, St.Side.LEFT, {
            favoritesSection: true,
            showSingleWindows: true,
        });
        menu.setApp(app);

        Main.layoutManager.uiGroup.add_child(menu.actor);

        this._contextMenu = menu;
        menu.connect('menu-closed', () => {
            if (this._contextMenu === menu)
                this._dismissContextMenu();
        });
        this._contextMenuManager.addMenu(menu);
        menu.open();
    }

    /**
     * Get all normal/dialog windows for an app (including minimized).
     * @param {Object} app
     * @returns {Object[]}
     * @private
     */
    _getAppAllWindows(app) {
        try {
            return (app.get_windows() || []).filter(w => {
                if (!w || w.is_skip_taskbar()) return false;
                let t = w.get_window_type();
                return t === Meta.WindowType.NORMAL || t === Meta.WindowType.DIALOG;
            });
        } catch (_e) {
            return [];
        }
    }

    /**
     * Ensure the PopupMenuManager is created.
     * @private
     */
    _ensureContextMenuManager() {
        if (!this._contextMenuManager) {
            this._contextMenuManager = new PopupMenu.PopupMenuManager(
                this._taskbar?._actor ?? Main.layoutManager.uiGroup);
        }
    }

    /**
     * Dismiss the current context menu.
     * @private
     */
    _dismissContextMenu() {
        if (this._contextMenu) {
            try { this._contextMenu.close(); } catch (_e) {}
            try {
                if (this._contextMenu.actor?.get_parent())
                    this._contextMenu.actor.get_parent().remove_child(
                        this._contextMenu.actor);
                this._contextMenu.destroy();
            } catch (_e) {}
            this._contextMenu = null;
        }
    }

    /**
     * Open the extension preferences window.
     * @private
     */
    _openExtensionPreferences() {
        try {
            Main.extensionManager?.openExtensionPrefs?.(
                'convergence@daniel-blandford.github.io', '', {});
            return;
        } catch (_e) {}
        try {
            GLib.spawn_command_line_async(
                'gnome-extensions prefs convergence@daniel-blandford.github.io');
        } catch (_e) {}
    }

    // ── Task 3: Keyboard shortcuts (Super+1-9) ─────────────────────

    /**
     * Bind Super+1-9 keyboard shortcuts to activate taskbar apps.
     * Should be called once after the first populateFavorites.
     */
    bindKeyboardShortcuts() {
        this.unbindKeyboardShortcuts();

        for (let i = 1; i <= 9; i++) {
            let name = `activate-taskbar-${i}`;
            let index = i; // capture for closure
            try {
                Main.wm.addKeybinding(
                    name,
                    this._settings,
                    Meta.KeyBindingFlags.NONE,
                    Shell.ActionMode.NORMAL |
                    Shell.ActionMode.OVERVIEW,
                    () => this._activateNthTaskbarApp(index));
                this._keybindingNames.push(name);
            } catch (_e) {
                // Key might not exist in schema; skip silently
            }
        }
    }

    /**
     * Unbind all keyboard shortcuts.
     */
    unbindKeyboardShortcuts() {
        for (let name of this._keybindingNames) {
            try { Main.wm.removeKeybinding(name); } catch (_e) {}
        }
        this._keybindingNames = [];
    }

    /**
     * Activate or minimize the Nth app in the taskbar.
     * @param {number} n - 1-based index
     * @private
     */
    _activateNthTaskbarApp(n) {
        let row = this._currentRow;
        if (!row) return;

        // Collect app buttons in order (skip Show Apps, separators, spacers)
        let appButtons = [];
        for (let child of row.get_children()) {
            if (child._convergenceApp)
                appButtons.push(child);
        }

        let idx = n - 1;
        if (idx < 0 || idx >= appButtons.length) return;

        let app = appButtons[idx]._convergenceApp;
        if (!app) return;

        // Toggle behavior: if focused, minimize; otherwise activate
        let tracker = Shell.WindowTracker.get_default();
        if (app === tracker.focus_app) {
            let focusWin = global.display.get_focus_window();
            if (focusWin) {
                try { focusWin.minimize(); } catch (_e) {}
            }
        } else {
            this.activateTaskbarApp(app);
        }
    }

    // ── Task 4: Running indicator settings readers ──────────────────

    /**
     * Read whether highlight fill is enabled.
     * @returns {boolean}
     * @private
     */
    _readHighlightFillEnabled() {
        try {
            return this._settings?.get_boolean(
                'taskbar-highlight-fill-enabled') ?? true;
        } catch (_e) {
            return true;
        }
    }

    /**
     * Read whether highlight edge is enabled.
     * @returns {boolean}
     * @private
     */
    _readHighlightEdgeEnabled() {
        try {
            return this._settings?.get_boolean(
                'taskbar-highlight-edge-enabled') ?? false;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Read whether highlight strip is enabled.
     * @returns {boolean}
     * @private
     */
    _readHighlightStripEnabled() {
        try {
            return this._settings?.get_boolean(
                'taskbar-highlight-strip-enabled') ?? false;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Connect to highlight and notification settings change signals.
     * @private
     */
    _connectSettingsSignals() {
        if (!this._settings) return;

        let keys = [
            'taskbar-highlight-fill-enabled',
            'taskbar-highlight-edge-enabled',
            'taskbar-highlight-strip-enabled',
            'taskbar-notification-badges',
        ];
        for (let key of keys) {
            try {
                this._runtimeDisposer.connect(this._settings, `changed::${key}`, () => {
                    if (this._currentRow)
                        this.updateRunningHighlights(this._currentRow);
                    if (key === 'taskbar-notification-badges' && this._currentRow)
                        this._syncNotificationBadges(this._currentRow);
                });
            } catch (_e) {}
        }
    }

    // ── Task 5: Notification badges ─────────────────────────────────

    /**
     * Connect to message tray signals for notification badge updates.
     * @private
     */
    _connectNotificationSignals() {
        let tray = Main.messageTray;
        if (!tray || this._notifSignalConnected) return;

        let signals = [
            'source-added', 'source-removed',
            'queue-changed', 'notify::sources',
        ];
        for (let signal of signals) {
            try {
                this._runtimeDisposer.connect(tray, signal, () => {
                    this._queueNotificationBadgeSync();
                });
                this._notifSignalConnected = true;
            } catch (_e) {}
        }
    }

    /**
     * Queue a debounced notification badge sync.
     * @private
     */
    _queueNotificationBadgeSync() {
        if (this._notifSyncId) return;
        this._notifSyncId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 200, () => {
                this._notifSyncId = 0;
                if (this._currentRow)
                    this._syncNotificationBadges(this._currentRow);
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Sync notification badge counts on all taskbar icon buttons.
     * @param {St.BoxLayout} row
     * @private
     */
    _syncNotificationBadges(row) {
        if (!row) return;

        let enabled = true;
        try {
            enabled = this._settings?.get_boolean(
                'taskbar-notification-badges') ?? true;
        } catch (_e) {}

        if (!enabled) {
            for (let child of row.get_children()) {
                let dot = child._convergenceTaskbarNotifDot;
                if (dot) dot.hide();
            }
            return;
        }

        let notifMap = this._collectNotificationsByApp();

        for (let child of row.get_children()) {
            let dot = child._convergenceTaskbarNotifDot;
            if (!dot) continue;
            let app = child._convergenceApp;
            let appId = app?.get_id?.();
            let count = notifMap.get(appId) ?? 0;
            if (count > 0) {
                dot.show();
                dot._convergenceLabel?.set_text?.(`${Math.min(99, count)}`);
            } else {
                dot.hide();
            }
        }
    }

    /**
     * Collect notification counts per app from the message tray.
     * @returns {Map<string, number>}
     * @private
     */
    _collectNotificationsByApp() {
        let map = new Map();
        let tray = Main.messageTray;
        if (!tray) return map;

        let sources = [];
        try {
            if (typeof tray.getSources === 'function')
                sources = tray.getSources() ?? [];
        } catch (_e) {}
        if (!sources.length)
            sources = tray._sources ?? [];

        for (let source of sources) {
            let app = source?.app ?? source?._app ?? source?.get_app?.();
            let appId = app?.get_id?.();
            if (!appId) continue;

            let notifications = source?.notifications ??
                source?._notifications ??
                source?.getNotifications?.() ?? [];
            let count = 0;
            for (let n of notifications) {
                if (!n) continue;
                let acknowledged = !!(n.acknowledged ?? n._acknowledged);
                if (!acknowledged) count++;
            }
            if (count > 0)
                map.set(appId, (map.get(appId) ?? 0) + count);
        }
        return map;
    }

    // ── Task 9: Drag-and-Drop icon reordering ─────────────────────

    /**
     * Attach long-press drag handlers to a taskbar icon button.
     * After a 500ms hold the icon enters drag mode for reordering.
     * @param {St.Button} button
     * @private
     */
    _initDragHandlers(button) {
        let lpId = 0;
        let pressed = false;
        let pressX = 0;
        let pressY = 0;
        const CANCEL_DIST = 10;

        let cancelLp = () => {
            pressed = false;
            if (lpId) { GLib.source_remove(lpId); lpId = 0; }
        };

        button.connect('button-press-event', (_actor, event) => {
            let btn = event.get_button?.() ?? 1;
            if (btn !== 1) return Clutter.EVENT_PROPAGATE;
            pressed = true;
            [pressX, pressY] = event.get_coords();
            [this._dndStartX, this._dndStartY] = [pressX, pressY];
            lpId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DND_LONG_PRESS_MS, () => {
                lpId = 0;
                // Only start DnD if still pressed AND still hovering the button
                if (pressed && !this._dndActive && button.hover)
                    this._onDragBegin(button);
                else
                    pressed = false;
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('button-release-event', () => {
            cancelLp();
            if (this._dndActive && this._dndButton === button)
                this._onDragEnd();
            return Clutter.EVENT_PROPAGATE;
        });

        // A successful click means press+release completed — cancel any DnD
        button.connect('clicked', () => { cancelLp(); });

        button.connect('motion-event', (_actor, event) => {
            let [x, y] = event.get_coords();

            // Cancel long-press if pointer moved too far before timer fires
            if (lpId && pressed && !this._dndActive) {
                let dx = x - pressX;
                let dy = y - pressY;
                if (Math.sqrt(dx * dx + dy * dy) > CANCEL_DIST) {
                    pressed = false;
                    GLib.source_remove(lpId);
                    lpId = 0;
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            if (!this._dndActive || this._dndButton !== button)
                return Clutter.EVENT_PROPAGATE;
            this._onDragMotion(x, y);
            return Clutter.EVENT_STOP;
        });

        button.connect('leave-event', () => {
            if (!this._dndActive) {
                pressed = false;
                if (lpId) { GLib.source_remove(lpId); lpId = 0; }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Cancel long-press on hover loss (catches trackpad tap-slide)
        button.connect('notify::hover', () => {
            if (!button.hover && !this._dndActive) {
                pressed = false;
                if (lpId) { GLib.source_remove(lpId); lpId = 0; }
            }
        });

        // Cancel long-press on scroll (trackpad two-finger or scroll wheel)
        button.connect('scroll-event', () => {
            if (!this._dndActive) {
                pressed = false;
                if (lpId) { GLib.source_remove(lpId); lpId = 0; }
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /**
     * Begin a drag operation on a taskbar icon button.
     * Creates a floating clone that follows the pointer and dims the original.
     * @param {St.Button} button
     * @private
     */
    _onDragBegin(button) {
        let row = this._currentRow;
        if (!row) return;

        this._dndActive = true;
        this._dndButton = button;
        this._dndPreviewIndex = -1;

        // Find the original index among app-icon children
        let children = row.get_children().filter(c => !!c._convergenceApp);
        this._dndOrigIndex = children.indexOf(button);

        // Dim the original
        button.opacity = 120;

        // Create a clone that floats on top of everything
        let [bx, by] = button.get_transformed_position();
        this._dndClone = new Clutter.Clone({
            source: button,
            width: button.width,
            height: button.height,
            opacity: 220,
        });
        this._dndClone.set_position(bx, by);
        Main.layoutManager.uiGroup.add_child(this._dndClone);

        // Grab events globally via a stage capture
        this._dndGrabSequence = global.stage.connect('captured-event',
            (_stage, event) => {
                let type = event.type();
                if (type === Clutter.EventType.MOTION) {
                    let [x, y] = event.get_coords();
                    this._onDragMotion(x, y);
                    return Clutter.EVENT_STOP;
                }
                if (type === Clutter.EventType.BUTTON_RELEASE ||
                    type === Clutter.EventType.TOUCH_END ||
                    type === Clutter.EventType.TOUCH_CANCEL) {
                    this._onDragEnd();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
    }

    /**
     * Handle pointer movement during a drag — reposition the clone and
     * animate neighbouring icons to show the insertion gap.
     * @param {number} x - Stage x coordinate
     * @param {number} y - Stage y coordinate
     * @private
     */
    _onDragMotion(x, y) {
        if (!this._dndClone || !this._dndActive) return;

        // Move clone to follow cursor (centred on the icon)
        this._dndClone.set_position(
            x - this._dndClone.width / 2,
            y - this._dndClone.height / 2);

        // Determine drop index among app-icon children
        let row = this._currentRow;
        if (!row) return;

        let children = row.get_children().filter(c => !!c._convergenceApp);
        let vertical = row.vertical;
        let insertIdx = children.length;

        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            if (child === this._dndButton) continue;
            let [cx, cy] = child.get_transformed_position();
            let mid = vertical
                ? cy + child.height / 2
                : cx + child.width / 2;
            let pos = vertical ? y : x;
            if (pos < mid) {
                insertIdx = i;
                break;
            }
        }

        // Adjust insert index relative to original position
        if (insertIdx === this._dndPreviewIndex) return;
        this._dndPreviewIndex = insertIdx;

        // Animate icons to create a gap at the insertion point
        let origIdx = this._dndOrigIndex;
        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            if (child === this._dndButton) continue;

            // Calculate the shift this child needs
            let shift = 0;
            if (origIdx < insertIdx) {
                // Dragged forward: items between origIdx+1..insertIdx-1 shift back
                if (i > origIdx && i < insertIdx)
                    shift = -1;
            } else if (origIdx > insertIdx) {
                // Dragged backward: items between insertIdx..origIdx-1 shift forward
                if (i >= insertIdx && i < origIdx)
                    shift = 1;
            }

            let extent = vertical ? child.height + 3 : child.width + 3;
            let tx = vertical ? 0 : shift * extent;
            let ty = vertical ? shift * extent : 0;

            child.ease({
                translation_x: tx,
                translation_y: ty,
                duration: DND_REORDER_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    /**
     * Finish or cancel the drag operation.
     * If dropped over the taskbar, commit the reorder; otherwise cancel.
     * @private
     */
    _onDragEnd() {
        if (!this._dndActive) return;

        // Disconnect the stage grab
        if (this._dndGrabSequence) {
            global.stage.disconnect(this._dndGrabSequence);
            this._dndGrabSequence = null;
        }

        let row = this._currentRow;
        let validDrop = this._dndPreviewIndex >= 0 &&
            this._dndPreviewIndex !== this._dndOrigIndex &&
            row;

        // Check if the clone is still within the taskbar area
        if (validDrop && this._dndClone) {
            let taskbarRect = this._taskbar.getTaskbarRect?.();
            if (taskbarRect) {
                let cx = this._dndClone.x + this._dndClone.width / 2;
                let cy = this._dndClone.y + this._dndClone.height / 2;
                let inBounds = cx >= taskbarRect.x &&
                    cx <= taskbarRect.x + taskbarRect.width + 40 &&
                    cy >= taskbarRect.y &&
                    cy <= taskbarRect.y + taskbarRect.height;
                if (!inBounds)
                    validDrop = false;
            }
        }

        if (validDrop)
            this._commitReorder();

        // Clean up clone
        if (this._dndClone) {
            this._dndClone.get_parent()?.remove_child(this._dndClone);
            this._dndClone.destroy();
            this._dndClone = null;
        }

        // Restore original opacity
        if (this._dndButton)
            this._dndButton.opacity = 255;

        // Reset translation on all children
        if (row) {
            let children = row.get_children().filter(c => !!c._convergenceApp);
            for (let child of children) {
                child.remove_all_transitions();
                child.translation_x = 0;
                child.translation_y = 0;
            }
        }

        this._dndActive = false;
        this._dndButton = null;
        this._dndOrigIndex = -1;
        this._dndPreviewIndex = -1;
    }

    /**
     * Commit the reorder by writing the new favorites order to GSettings.
     * @private
     */
    _commitReorder() {
        let row = this._currentRow;
        if (!row) return;

        let favorites = AppFavorites.getAppFavorites();
        let favIds = favorites.getFavorites().map(a => a.get_id());
        let origIdx = this._dndOrigIndex;
        let insertIdx = this._dndPreviewIndex;

        if (origIdx < 0 || origIdx >= favIds.length) return;
        if (insertIdx < 0) return;

        // Remove the dragged app from its old position
        let [movedId] = favIds.splice(origIdx, 1);
        // Insert at the new position (adjusted for removal)
        let newIdx = insertIdx > origIdx ? insertIdx - 1 : insertIdx;
        newIdx = Math.max(0, Math.min(newIdx, favIds.length));
        favIds.splice(newIdx, 0, movedId);

        // Write the new order to GSettings
        try {
            let schema = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            schema.set_strv('favorite-apps', favIds);
        } catch (e) {
            this._logger?.log?.(`DnD: failed to write favorites: ${e}`);
        }

        // Repopulate to reflect the new order
        if (this._currentRow) {
            this.populateFavorites(this._currentRow, {
                isLargeDisplay: true,
                sideTaskbar: this._taskbar.isSideTaskbarLayout(),
                taskbar: this._taskbar.isTaskbarMode(),
                metrics: this._getCurrentMetrics(),
            });
        }
    }

    // ── External DnD hover (app menu → taskbar) ────────────────────

    /**
     * Show a drop-position indicator when an external app is dragged
     * over the taskbar.  Animates existing icons to open a gap (via
     * translation) and positions a translucent placeholder icon in the
     * gap as a floating overlay — never inserted into the row, so it
     * does not affect row natural-height or trigger scale recalculation.
     * @param {Shell.App} app - The app being dragged
     * @param {number} x - Stage x coordinate
     * @param {number} y - Stage y coordinate
     */
    showExternalDndHover(app, x, y) {
        let row = this._currentRow;
        if (!row || !app) return;

        let children = row.get_children().filter(c => !!c._convergenceApp);
        let vertical = row.vertical;

        // Determine insertion index
        let insertIdx = children.length;
        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            let [cx, cy] = child.get_transformed_position();
            let mid = vertical
                ? cy + child.height / 2
                : cx + child.width / 2;
            let pos = vertical ? y : x;
            if (pos < mid) {
                insertIdx = i;
                break;
            }
        }

        if (insertIdx === this._extDndInsertIndex && this._extDndPlaceholder)
            return;
        this._extDndInsertIndex = insertIdx;

        // Create the floating placeholder on first call
        if (!this._extDndPlaceholder) {
            let metrics = this._taskbar._computeMetrics();
            let cellW = metrics.taskbarCellW;
            let iconSize = metrics.taskbarIconSize;
            let iconPad = Math.max(1, metrics.sideTaskbarGapPx ?? 6) +
                (metrics.sideTaskbarExtraPadPx ?? 2);

            let icon = app.create_icon_texture(iconSize);
            let placeholder = new St.Widget({
                style_class: 'convergence-taskbar-icon',
                width: cellW,
                height: cellW,
                opacity: 120,
                layout_manager: new Clutter.BinLayout(),
                style: `padding: ${iconPad}px; margin: 0;`,
            });
            placeholder.add_child(icon);

            Main.layoutManager.uiGroup.add_child(placeholder);
            this._extDndPlaceholder = placeholder;
        }

        // Animate existing icons to create a gap at the insertion point
        let spacing = 3;
        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            let extent = (vertical ? child.height : child.width) + spacing;
            let shift = i >= insertIdx ? extent : 0;
            let tx = vertical ? 0 : shift;
            let ty = vertical ? shift : 0;
            child.ease({
                translation_x: tx, translation_y: ty,
                duration: DND_REORDER_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        // Position the placeholder in the gap
        if (children.length > 0) {
            let ref = children[Math.min(insertIdx, children.length - 1)];
            let [rx, ry] = ref.get_transformed_position();
            let cellW = this._extDndPlaceholder.width;
            let cellH = this._extDndPlaceholder.height;

            if (insertIdx < children.length) {
                // Place at the ref icon's current (pre-shift) position
                this._extDndPlaceholder.set_position(rx, ry);
            } else {
                // Place after the last icon
                if (vertical)
                    this._extDndPlaceholder.set_position(rx, ry + cellH + spacing);
                else
                    this._extDndPlaceholder.set_position(rx + cellW + spacing, ry);
            }
        }
    }

    /**
     * Remove the external DnD placeholder and reset icon translations.
     */
    cancelExternalDndHover() {
        if (this._extDndPlaceholder) {
            let parent = this._extDndPlaceholder.get_parent();
            if (parent) parent.remove_child(this._extDndPlaceholder);
            this._extDndPlaceholder.destroy();
            this._extDndPlaceholder = null;
        }
        this._extDndInsertIndex = -1;

        // Reset translations on all icon children
        let row = this._currentRow;
        if (row) {
            let children = row.get_children().filter(c => !!c._convergenceApp);
            for (let child of children) {
                child.ease({
                    translation_x: 0, translation_y: 0,
                    duration: DND_REORDER_ANIM_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        }
    }

    /**
     * Accept an external app drop at the current insertion index.
     * @param {string} appId - The dropped app's ID
     */
    acceptExternalDrop(appId) {
        let insertIdx = this._extDndInsertIndex;
        this.cancelExternalDndHover();

        if (!appId || insertIdx < 0) return;

        let favorites = AppFavorites.getAppFavorites();
        let favIds = favorites.getFavorites().map(a => a.get_id());

        // Already a favorite — reorder it
        let existingIdx = favIds.indexOf(appId);
        if (existingIdx >= 0)
            favIds.splice(existingIdx, 1);

        let newIdx = Math.max(0, Math.min(insertIdx, favIds.length));
        favIds.splice(newIdx, 0, appId);

        try {
            let schema = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            schema.set_strv('favorite-apps', favIds);
        } catch (e) {
            this._logger?.log?.(`External DnD: failed to write favorites: ${e}`);
        }

        if (this._currentRow) {
            this.populateFavorites(this._currentRow, {
                isLargeDisplay: true,
                sideTaskbar: this._taskbar.isSideTaskbarLayout(),
                taskbar: this._taskbar.isTaskbarMode(),
                metrics: this._getCurrentMetrics(),
            });
        }
    }

    // ── Task 10: Urgent window notification state ───────────────────

    /**
     * Connect to display signals for urgent/demands-attention windows,
     * and to the window tracker to clear urgent state on focus.
     * @private
     */
    _connectUrgentSignals() {
        let display = global.display;
        if (!display) return;

        let onUrgent = (_display, metaWindow) => {
            if (!metaWindow) return;
            let tracker = Shell.WindowTracker.get_default();
            let app = tracker.get_window_app(metaWindow);
            if (!app) return;
            let appId = app.get_id?.();
            if (!appId) return;

            this._urgentApps.add(appId);
            this._applyUrgentPulse(appId);

            if (this._currentRow)
                this.updateRunningHighlights(this._currentRow);
        };

        try {
            let id1 = display.connect('window-demands-attention', onUrgent);
            this._urgentDisplaySignals.push({ obj: display, id: id1 });
        } catch (_e) {}

        try {
            let id2 = display.connect('window-marked-urgent', onUrgent);
            this._urgentDisplaySignals.push({ obj: display, id: id2 });
        } catch (_e) {}

        // Clear urgent state when the user focuses an app
        let tracker = Shell.WindowTracker.get_default();
        if (tracker) {
            try {
                let id3 = tracker.connect('notify::focus-app', () => {
                    let focusApp = tracker.focus_app;
                    if (!focusApp) return;
                    this._clearAppUrgent(focusApp);
                    this._stopUrgentPulse(focusApp.get_id?.());
                    if (this._currentRow)
                        this.updateRunningHighlights(this._currentRow);
                });
                this._urgentDisplaySignals.push({ obj: tracker, id: id3 });
            } catch (_e) {}
        }
    }

    /**
     * Start a pulsing opacity animation on the taskbar icon for an urgent app.
     * @param {string} appId
     * @private
     */
    _applyUrgentPulse(appId) {
        if (!appId || !this._currentRow) return;
        if (this._urgentPulseTimers.has(appId)) return;

        let pulseUp = true;
        let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, URGENT_PULSE_MS / 2, () => {
            let button = this._findButtonForApp(appId);
            if (!button || !this._urgentApps.has(appId)) {
                this._urgentPulseTimers.delete(appId);
                return GLib.SOURCE_REMOVE;
            }
            let targetOpacity = pulseUp ? 255 : 153; // 1.0 and ~0.6
            button.ease({
                opacity: targetOpacity,
                duration: URGENT_PULSE_MS / 2,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
            pulseUp = !pulseUp;
            return GLib.SOURCE_CONTINUE;
        });
        this._urgentPulseTimers.set(appId, timerId);
    }

    /**
     * Stop the pulsing animation for an urgent app and restore full opacity.
     * @param {string} appId
     * @private
     */
    _stopUrgentPulse(appId) {
        if (!appId) return;
        let timerId = this._urgentPulseTimers.get(appId);
        if (timerId) {
            GLib.source_remove(timerId);
            this._urgentPulseTimers.delete(appId);
        }
        let button = this._findButtonForApp(appId);
        if (button) {
            button.remove_all_transitions();
            button.opacity = 255;
        }
    }

    /**
     * Find the taskbar button for an app ID in the current row.
     * @param {string} appId
     * @returns {St.Button|null}
     * @private
     */
    _findButtonForApp(appId) {
        if (!appId || !this._currentRow) return null;
        for (let child of this._currentRow.get_children()) {
            if (child._convergenceApp?.get_id?.() === appId)
                return child;
        }
        return null;
    }

    /**
     * Disconnect all urgent-window signal connections.
     * @private
     */
    _disconnectUrgentSignals() {
        for (let entry of this._urgentDisplaySignals) {
            try { entry.obj.disconnect(entry.id); } catch (_e) {}
        }
        this._urgentDisplaySignals = [];

        for (let [, timerId] of this._urgentPulseTimers) {
            try { GLib.source_remove(timerId); } catch (_e) {}
        }
        this._urgentPulseTimers.clear();
    }

    // ── Cleanup ─────────────────────────────────────────────────────

    /**
     * Clean up all resources.
     */
    destroy() {
        this.unbindKeyboardShortcuts();
        this._dismissContextMenu();
        this._disconnectAppStateSignals();
        this._disconnectUrgentSignals();

        // Cancel any active drag
        if (this._dndActive)
            this._onDragEnd();

        if (this._runningAppsUpdateId) {
            GLib.source_remove(this._runningAppsUpdateId);
            this._runningAppsUpdateId = 0;
        }
        if (this._notifSyncId) {
            GLib.source_remove(this._notifSyncId);
            this._notifSyncId = 0;
        }

        this._currentRow = null;
        this._contextMenuManager = null;
        this._runtimeDisposer.dispose();
        this._logger?.destroy?.();
    }
}
