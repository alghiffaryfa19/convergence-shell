// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu as NativeAppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

import { Logger } from '../../shared/utilities/logger.js';
import { addClickCursor, createLongPressController } from '../../shared/utilities/uiUtils.js';
import {
    TOUCH_LONG_PRESS_CANCEL_DIST,
} from '../../shared/utilities/gestureConstants.js';

import {
    DND_ENABLED,
    DOCK_LAUNCH_BOUNCE_MS,
} from './appDrawer.js';

/**
 * Phone drawer icon factory.
 *
 * Creates app icons with labels for the full grid, folder preview icons,
 * and favorites dock row icons.  All desktop-specific features (taskbar
 * indicators, accent colours, hover highlights, window previews) are
 * intentionally excluded.
 */
export class DrawerIcons {
    /**
     * @param {import('./appDrawer.js').AppDrawer} drawer - Parent drawer.
     * @param {import('gi://Gio').Settings|null} settings - Extension GSettings.
     */
    constructor(drawer, settings) {
        this._drawer = drawer;
        this._settings = settings ?? null;
        this._logger = new Logger('DrawerIcons', this._settings);
    }

    // ── Dock icons ────────────────────────────────────────────────────

    /**
     * Create a single dock (favorites row) icon button.
     * @param {Shell.App} app
     * @param {boolean} [isPinned=true]
     * @returns {St.Button}
     */
    createDockIcon(app, isPinned = true) {
        let d = this._drawer;
        let dockIconSize = d._dockIconSize || 48;
        let dockCellW = d._dockCellW || dockIconSize;
        let iconPad = 0;  // Phone dock icons fill their cell without padding

        let icon = app.create_icon_texture(dockIconSize);
        icon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let content = new St.BoxLayout({
            style_class: 'convergence-app-icon-button',
            vertical: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            style: `padding: ${Math.max(0, iconPad)}px;`,
        });
        content.add_child(icon);

        let indicators = new St.BoxLayout({
            style_class: 'convergence-dock-indicators',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        content.add_child(indicators);

        let overlay = new St.Widget({
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        overlay.add_child(content);

        let button = new St.Button({
            child: overlay,
            style_class: 'convergence-drawer-icon',
            width: dockCellW,
            height: dockCellW,
            style: 'padding: 0; margin: 0;',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
        });
        button._convergenceApp = app;
        button._convergenceIcon = icon;
        button._convergenceContent = content;
        button._convergenceIndicators = indicators;
        addClickCursor(button, d._runtimeDisposer);

        // ── Long-press two-phase flow ──
        // Phase 1 (500ms): haptic + icon lift animation
        // Phase 2a (finger moves after phase 1): start DnD
        // Phase 2b (finger lifts after phase 1 without moving): context menu
        let lpFired = false;
        let lpDragStarted = false;
        let lpController = createLongPressController(500, () => {
            d._activeLpCancel = null;
            if (!d._pressed) return;
            lpFired = true;
            lpDragStarted = false;
            // Haptic buzz + icon lift
            d._controller?.haptics?.vibrate(15);
            this._animateIconLift(icon, true);
            // Start DnD immediately (Pixel-style)
            let virtualItem = { type: 'app', id: app.get_id() };
            d._dndFromDock = true;
            d._dndDockSourceIndex = d._getPrimaryDockIndexForAppId(app.get_id());
            d._startDnd?.(button, app, virtualItem);
        });

        let startLp = () => {
            if (!DND_ENABLED || !isPinned) return;
            lpFired = false;
            lpDragStarted = false;
            d._activeLpCancel = cancelLp;
            lpController.start();
        };
        let cancelLp = () => {
            if (!DND_ENABLED || !isPinned) return;
            lpController.cancel();
            if (d._activeLpCancel === cancelLp)
                d._activeLpCancel = null;
        };

        let touchStartX = 0;
        let touchStartY = 0;
        let touchTracking = false;
        let touchCancelDist = Math.max(10,
            Math.round(TOUCH_LONG_PRESS_CANCEL_DIST * (d._scale ?? 1)));
        let touchCancelDistSq = touchCancelDist * touchCancelDist;

        // Press animation: scale down to 93%
        let setActive = active => {
            if (active) {
                content.add_style_pseudo_class('active');
                this._animateIconPress(icon, true);
            } else {
                content.remove_style_pseudo_class('active');
                if (!lpFired) this._animateIconPress(icon, false);
            }
        };

        button.connect('notify::hover', () => {
            if (button.hover)
                content.add_style_pseudo_class('hover');
            else
                content.remove_style_pseudo_class('hover');
        });

        button.connect('button-press-event', (_actor, event) => {
            let btn = event.get_button?.() ?? 1;
            if (btn === 3) {
                // Right-click: show context menu directly
                this._showAppContextMenu(button, app);
                return Clutter.EVENT_STOP;
            }
            if (btn !== 1) return Clutter.EVENT_PROPAGATE;
            setActive(true);
            startLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            this._animateIconLift(icon, false);
            setActive(false);
            cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('touch-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                setActive(true);
                [touchStartX, touchStartY] = event.get_coords();
                touchTracking = true;
                startLp();
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (touchTracking && !d._dndActive) {
                    let [x, y] = event.get_coords();
                    let dx = x - touchStartX;
                    let dy = y - touchStartY;
                    let distSq = dx * dx + dy * dy;
                    if (lpFired && !lpDragStarted && distSq >= touchCancelDistSq) {
                        // Phase 2a: long-press + drag → start DnD
                        lpDragStarted = true;
                        let virtualItem = { type: 'app', id: app.get_id() };
                        d._dndFromDock = true;
                        d._dndDockSourceIndex = d._getPrimaryDockIndexForAppId(app.get_id());
                        d._startDnd?.(button, app, virtualItem);
                    } else if (!lpFired && distSq >= touchCancelDistSq) {
                        // Moved before long-press: cancel
                        setActive(false);
                        cancelLp();
                        touchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                this._animateIconLift(icon, false);
                setActive(false);
                button.fake_release();
                touchTracking = false;
                cancelLp();
                if (type === Clutter.EventType.TOUCH_CANCEL)
                    lpFired = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('leave-event', () => {
            if (d._pressed) return Clutter.EVENT_PROPAGATE;
            content.remove_style_pseudo_class('active');
            content.remove_style_pseudo_class('hover');
            if (!d._dndActive) cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', () => {
            let dndCooldown =
                (GLib.get_monotonic_time() / 1000) - d._dndEndedMs < 300;
            if (!lpFired && !d._dndActive && !dndCooldown) {
                this._animateLaunchAffordance(button);
                this._activateDockApp(app);
                d.collapse();
            }
            lpFired = false;
            lpDragStarted = false;
        });
        button.connect('key-press-event', (_actor, event) =>
            this._onDockButtonKeyPress(button, app, isPinned, event));

        return button;
    }

    // ── Grid icons ────────────────────────────────────────────────────

    /**
     * Create a grid app icon with label.
     * @param {Shell.App} app
     * @param {object} item - Grid item descriptor.
     * @returns {St.Button}
     */
    createGridIcon(app, item) {
        let d = this._drawer;
        let iconSize = d._iconSize || 48;
        let cellW = d._iconCellW || 72;
        let cellH = d._iconCellH || 96;
        let pad = d._labelPadH || 2;

        let icon = app.create_icon_texture(iconSize);
        icon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let content = new St.BoxLayout({
            style_class: 'convergence-app-icon-button',
            vertical: true,
            x_expand: true,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            style: `padding: 0 ${pad}px;`,
        });
        content.add_child(icon);

        let notifDotLabel = new St.Label({ text: '' });
        let notifDot = new St.Button({
            child: notifDotLabel,
            style_class: 'convergence-grid-notif-dot',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
            reactive: true,
            can_focus: false,
        });
        notifDot._convergenceLabel = notifDotLabel;
        content.add_child(notifDot);

        let label = new St.Label({
            text: app.get_display_name?.() || app.get_name?.() || '',
            style_class: 'convergence-app-label convergence-grid-icon-label',
            x_expand: true,
            style: `min-height: ${d._labelH || 38}px; height: ${d._labelH || 38}px; ` +
                `font-size: ${d._labelFontSize || 14}px; margin-top: ${d._labelMarginTop || 4}px;`,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: imports.gi.Pango.WrapMode.WORD_CHAR,
            ellipsize: imports.gi.Pango.EllipsizeMode.END,
            max_length: 0,
        });
        label.clutter_text.set_line_alignment(1);
        content.add_child(label);

        let overlay = new St.Widget({
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        overlay.add_child(content);

        let button = new St.Button({
            child: overlay,
            style: 'padding: 0; margin: 0;',
            width: cellW,
            height: cellH,
            can_focus: true,
        });
        button._convergenceApp = app;
        button._convergenceGridItem = item;
        button._convergenceContent = content;
        button._convergenceNotifDot = notifDot;
        addClickCursor(button, d._runtimeDisposer);

        // ── Grid icon long-press: same two-phase flow as dock ──
        let lpFired = false;
        let lpDragStarted = false;
        let gridTouchStartX = 0, gridTouchStartY = 0;
        let gridTouchTracking = false;
        let gridTouchCancelDist = Math.max(10,
            Math.round(TOUCH_LONG_PRESS_CANCEL_DIST * (d._scale ?? 1)));
        let gridTouchCancelDistSq = gridTouchCancelDist * gridTouchCancelDist;

        let lpController = createLongPressController(500, () => {
            d._activeLpCancel = null;
            if (!d._pressed) return;
            lpFired = true;
            lpDragStarted = false;
            // Haptic buzz + icon lift
            d._controller?.haptics?.vibrate(15);
            this._animateIconLift(icon, true);
            // Start DnD immediately (Pixel-style)
            d._startDnd?.(button, app, item);
        });

        let startLp = () => {
            if (!DND_ENABLED) return;
            lpFired = false;
            lpDragStarted = false;
            d._activeLpCancel = cancelLp;
            lpController.start();
        };
        let cancelLp = () => {
            if (!DND_ENABLED) return;
            lpController.cancel();
            if (d._activeLpCancel === cancelLp)
                d._activeLpCancel = null;
        };

        let lastInputWasTouch = false;

        button.connect('notify::hover', () => {
            if (lastInputWasTouch) return;
            if (button.hover)
                content.add_style_pseudo_class('hover');
            else
                content.remove_style_pseudo_class('hover');
        });

        button.connect('button-press-event', (_actor, event) => {
            lastInputWasTouch = false;
            let btn = event.get_button?.() ?? 1;
            if (btn === 3) {
                this._showAppContextMenu(button, app);
                return Clutter.EVENT_STOP;
            }
            content.add_style_pseudo_class('active');
            this._animateIconPress(icon, true);
            startLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            this._animateIconLift(icon, false);
            content.remove_style_pseudo_class('active');
            if (!lpFired) this._animateIconPress(icon, false);
            cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('touch-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                lastInputWasTouch = true;
                content.add_style_pseudo_class('active');
                this._animateIconPress(icon, true);
                [gridTouchStartX, gridTouchStartY] = event.get_coords();
                gridTouchTracking = true;
                startLp();
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (gridTouchTracking && !d._dndActive) {
                    let [x, y] = event.get_coords();
                    let dx = x - gridTouchStartX;
                    let dy = y - gridTouchStartY;
                    let distSq = dx * dx + dy * dy;
                    if (lpFired && !lpDragStarted && distSq >= gridTouchCancelDistSq) {
                        lpDragStarted = true;
                        d._startDnd?.(button, app, item);
                    } else if (!lpFired && distSq >= gridTouchCancelDistSq) {
                        content.remove_style_pseudo_class('active');
                        this._animateIconPress(icon, false);
                        cancelLp();
                        gridTouchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                this._animateIconLift(icon, false);
                content.remove_style_pseudo_class('active');
                if (!lpFired) this._animateIconPress(icon, false);
                content.remove_style_pseudo_class('hover');
                gridTouchTracking = false;
                cancelLp();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('leave-event', () => {
            content.remove_style_pseudo_class('active');
            content.remove_style_pseudo_class('hover');
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', () => {
            let dndCooldown =
                (GLib.get_monotonic_time() / 1000) - d._dndEndedMs < 300;
            if (!lpFired && !d._dndActive && !dndCooldown) {
                this._animateLaunchAffordance(button);
                if (d._controller?.activateApp)
                    d._controller.activateApp(app, d._getLayoutMonitorIndex?.());
                else
                    app.activate();
                d.collapse();
            }
            lpFired = false;
            lpDragStarted = false;
        });

        return button;
    }

    // ── Folder icons ──────────────────────────────────────────────────

    /**
     * Create a folder icon showing a 2x2 mini-icon preview.
     * @param {object} folderItem - { type:'folder', name, apps:[] }
     * @param {Shell.AppSystem} appSystem
     * @returns {St.Button}
     */
    createFolderIcon(folderItem, appSystem) {
        let d = this._drawer;
        let cellW = d._iconCellW || 72;
        let cellH = d._iconCellH || 96;
        let miniSize = d._folderMiniSize || 20;
        let gridSize = d._folderGridSize || 52;

        let miniGrid = new St.Widget({
            style_class: 'convergence-folder-icon-grid',
            width: gridSize,
            height: gridSize,
            layout_manager: new Clutter.GridLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        let gridLayout = miniGrid.layout_manager;

        // Samsung-style 3x3 preview grid
        let previewApps = (folderItem.apps || []).slice(0, 9);
        let previewCols = 3;
        let miniIconSize = Math.round(miniSize * 0.75); // smaller for 3x3
        let col = 0;
        let row = 0;
        for (let appId of previewApps) {
            let app = appSystem.lookup_app(appId);
            if (!app)
                continue;
            let miniIcon = app.create_icon_texture(miniIconSize);
            miniIcon.set({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            gridLayout.attach(miniIcon, col, row, 1, 1);
            col++;
            if (col >= previewCols) {
                col = 0;
                row++;
            }
        }

        let label = new St.Label({
            text: folderItem.name || 'Folder',
            style_class: 'convergence-app-label convergence-grid-icon-label',
            x_expand: true,
            style: `min-height: ${d._labelH || 38}px; height: ${d._labelH || 38}px; ` +
                `font-size: ${d._labelFontSize || 14}px; margin-top: ${d._labelMarginTop || 4}px;`,
        });
        label.clutter_text.set({
            ellipsize: imports.gi.Pango.EllipsizeMode.END,
            line_wrap: true,
            line_wrap_mode: imports.gi.Pango.WrapMode.WORD_CHAR,
            max_length: 0,
        });
        label.clutter_text.set_line_alignment(1);

        let box = new St.BoxLayout({
            style_class: 'convergence-app-icon-button',
            vertical: true,
            x_expand: true,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            style: `padding: 0 ${d._labelPadH || 2}px;`,
        });
        box.add_child(miniGrid);
        box.add_child(label);

        let overlay = new St.Widget({
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        overlay.add_child(box);

        let button = new St.Button({
            child: overlay,
            style: 'padding: 0; margin: 0;',
            width: cellW,
            height: cellH,
            can_focus: true,
        });
        button._convergenceFolderItem = folderItem;
        addClickCursor(button, d._runtimeDisposer);

        button.connect('notify::hover', () => {
            if (button.hover)
                box.add_style_pseudo_class('hover');
            else
                box.remove_style_pseudo_class('hover');
        });
        button.connect('button-press-event', () => {
            box.add_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            box.remove_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('leave-event', () => {
            box.remove_style_pseudo_class('active');
            box.remove_style_pseudo_class('hover');
            return Clutter.EVENT_PROPAGATE;
        });

        // Open folder on TOUCH_BEGIN for zero-latency response.
        // Use a short delay to distinguish tap from drag gesture.
        let folderTapTimer = 0;
        let folderTouchMoved = false;
        let folderTouchStartX = 0, folderTouchStartY = 0;

        button.connect('touch-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                box.add_style_pseudo_class('active');
                this._animateIconPress(miniGrid, true);
                folderTouchMoved = false;
                [folderTouchStartX, folderTouchStartY] = event.get_coords();
                // Open after 80ms if finger doesn't move (avoids opening on scroll)
                if (folderTapTimer) GLib.source_remove(folderTapTimer);
                folderTapTimer = GLib.timeout_add(GLib.PRIORITY_HIGH, 80, () => {
                    folderTapTimer = 0;
                    if (!folderTouchMoved) {
                        this._animateIconPress(miniGrid, false);
                        d._openFolderPopup?.(folderItem, button);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                let [x, y] = event.get_coords();
                let dx = x - folderTouchStartX;
                let dy = y - folderTouchStartY;
                if (dx * dx + dy * dy > 100) { // 10px movement
                    folderTouchMoved = true;
                    if (folderTapTimer) {
                        GLib.source_remove(folderTapTimer);
                        folderTapTimer = 0;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                box.remove_style_pseudo_class('active');
                this._animateIconPress(miniGrid, false);
                if (folderTapTimer) {
                    GLib.source_remove(folderTapTimer);
                    folderTapTimer = 0;
                    if (!folderTouchMoved)
                        d._openFolderPopup?.(folderItem, button);
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', () => {
            d._openFolderPopup?.(folderItem, button);
        });

        return button;
    }

    // ── Helpers ────────────────────────────────────────────────────────

    /**
     * Play a scale-bounce animation on an icon to acknowledge a tap.
     * @param {Clutter.Actor} actor
     */
    // ── Android-style press/lift animations ─────────────────────────

    /**
     * Scale icon down on press (Android touch-down feedback).
     * @param {Clutter.Actor} icon
     * @param {boolean} pressed
     */
    _animateIconPress(icon, pressed) {
        if (!icon) return;
        icon.remove_all_transitions();
        icon.set_pivot_point(0.5, 0.5);
        if (pressed) {
            icon.ease({
                scale_x: 0.93, scale_y: 0.93,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            icon.ease({
                scale_x: 1.0, scale_y: 1.0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    }

    /**
     * Scale icon up on long-press recognition (Android "lift" feedback).
     * @param {Clutter.Actor} icon
     * @param {boolean} lifted
     */
    _animateIconLift(icon, lifted) {
        if (!icon) return;
        icon.remove_all_transitions();
        icon.set_pivot_point(0.5, 0.5);
        if (lifted) {
            icon.ease({
                scale_x: 1.12, scale_y: 1.12,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            icon.ease({
                scale_x: 1.0, scale_y: 1.0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    // ── GNOME native context menu ────────────────────────────────────

    /**
     * Show GNOME's native AppMenu for an app, anchored to the icon.
     * Includes app shortcuts, App Info, pin/unpin, etc.
     * @param {St.Button} anchor
     * @param {Shell.App} app
     */
    _showAppContextMenu(anchor, app) {
        let d = this._drawer;

        // Dismiss any existing context menu
        if (d._contextMenu) {
            try { d._contextMenu.close(); } catch (_e) {}
            try {
                if (d._contextMenu.actor?.get_parent())
                    d._contextMenu.actor.get_parent().remove_child(
                        d._contextMenu.actor);
                d._contextMenu.destroy();
            } catch (_e) {}
            d._contextMenu = null;
        }

        if (!d._contextMenuManager)
            d._contextMenuManager = new PopupMenu.PopupMenuManager(
                d._actor ?? Main.layoutManager.uiGroup);

        let menu = new NativeAppMenu(anchor, St.Side.TOP, {
            favoritesSection: true,
            showSingleWindows: false,
        });
        menu.setApp(app);
        Main.layoutManager.uiGroup.add_child(menu.actor);

        d._contextMenu = menu;
        menu.connect('menu-closed', () => {
            if (d._contextMenu === menu) {
                try {
                    if (menu.actor?.get_parent())
                        menu.actor.get_parent().remove_child(menu.actor);
                    menu.destroy();
                } catch (_e) {}
                d._contextMenu = null;
            }
        });
        d._contextMenuManager.addMenu(menu);
        menu.open();
    }

    // ── Launch animation ─────────────────────────────────────────────

    _animateLaunchAffordance(actor) {
        if (!actor)
            return;
        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 1.0);
        actor.ease({
            scale_x: 1.12,
            scale_y: 1.12,
            duration: DOCK_LAUNCH_BOUNCE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                actor.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: DOCK_LAUNCH_BOUNCE_MS,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                });
            },
        });
    }

    /**
     * Activate a dock app (focus or launch).
     * @param {Shell.App} app
     * @param {object} [opts]
     */
    _activateDockApp(app, opts = {}) {
        let d = this._drawer;
        if (opts.forceNewWindow) {
            app.open_new_window(-1);
        } else if (d._controller?.activateApp) {
            d._controller.activateApp(app, d._getLayoutMonitorIndex?.());
        } else {
            app.activate();
        }
    }

    /**
     * Handle keyboard navigation within the dock row.
     * @param {St.Button} button
     * @param {Shell.App} app
     * @param {boolean} isPinned
     * @param {Clutter.Event} event
     * @returns {number}
     */
    _onDockButtonKeyPress(button, app, isPinned, event) {
        let key = event.get_key_symbol();
        let row = button.get_parent?.();
        let buttons = row?.get_children?.()?.filter(
            c => c instanceof St.Button) ?? [];
        let idx = buttons.indexOf(button);

        if (key === Clutter.KEY_Return || key === Clutter.KEY_space) {
            this._activateDockApp(app);
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
    }

    destroy() {
        this._logger?.destroy?.();
        this._drawer = null;
        this._settings = null;
    }
}
