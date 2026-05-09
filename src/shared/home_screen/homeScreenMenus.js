// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HOME_DND_MENU_AUTO_MS = 250;

/**
 * Long-press/right-click context menus, app menus, and background menus
 * for the home screen.
 */
export class HomeScreenMenus {
    /**
     * @param {object} homeScreen - The HomeScreen instance.
     */
    constructor(homeScreen) {
        this._home = homeScreen;
    }

    /** Dismiss any open home menu. */
    dismissHomeMenu(fromNativeClose = false) {
        let h = this._home;
        if (h._homeMenuFocusId) {
            h._runtimeDisposer.untrackConnection(global.display, h._homeMenuFocusId);
            global.display.disconnect(h._homeMenuFocusId);
            h._homeMenuFocusId = 0;
        }
        if (h._homeMenuCaptureId) {
            h._runtimeDisposer.untrackConnection(global.stage, h._homeMenuCaptureId);
            global.stage.disconnect(h._homeMenuCaptureId);
            h._homeMenuCaptureId = 0;
        }

        if (h._homeMenuIsPopup && h._homeMenu) {
            let menu = h._homeMenu;
            h._homeMenu = null;
            h._homeMenuIsPopup = false;
            if (!fromNativeClose) {
                try { menu.close(); } catch (_e) {}
            }
            try { h._homeMenuManager?.removeMenu?.(menu); } catch (_e) {}
            try {
                if (menu.actor?.get_parent())
                    menu.actor.get_parent().remove_child(menu.actor);
                menu.destroy?.();
            } catch (_e) {}
        } else if (h._homeMenu) {
            if (h._homeMenu.get_parent())
                h._homeMenu.get_parent().remove_child(h._homeMenu);
            h._homeMenu.destroy();
            h._homeMenu = null;
        }
        if (h._homeMenuAnchor) {
            if (h._homeMenuAnchor.get_parent())
                h._homeMenuAnchor.get_parent().remove_child(h._homeMenuAnchor);
            h._homeMenuAnchor.destroy();
            h._homeMenuAnchor = null;
        }
        h._homeMenuIsPopup = false;
    }

    /** Remove an item from the home grid. */
    removeHomeIcon(item) {
        let h = this._home;
        let idx = h._homeGridItems.indexOf(item);
        if (idx !== -1)
            h._homeGridItems.splice(idx, 1);
        h._pruneEmptyTrailingPages();
        h._saveHomeLayout();
        h._renderHomeGrid();
    }

    /** Cancel the background long-press timer. */
    cancelBgLongPress() {
        this._home._runtimeDisposer.clearTimeoutRef(this._home, '_bgLongPressTimerId');
    }

    /** Open the system control center (Settings). */
    openSystemControlCenter(panel = '') {
        let h = this._home;
        let command = panel ? `gnome-control-center ${panel}` : 'gnome-control-center';
        try {
            GLib.spawn_command_line_async(command);
            return true;
        } catch (e) {
            h._logger?.warn(`Failed to spawn control center command "${command}"`, e);
        }

        try {
            let app = Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop');
            if (app) {
                app.activate();
                return true;
            }
        } catch (e) {
            h._logger?.warn('Failed to activate org.gnome.Settings.desktop', e);
        }
        return false;
    }

    /** Begin the two-phase DnD ready state for an icon. */
    beginHomeDndReady(button, item, app, x, y) {
        let h = this._home;
        if (!h._visible)
            return;
        this.cancelBgLongPress();
        this.dismissHomeMenu();
        h._homeDndReady = true;
        h._homeDndSourceBtn = button;
        h._homeDndItem = item;
        h._homeDndApp = app ?? null;
        h._homeDndStartX = x;
        h._homeDndStartY = y;
        h._setHomeDndReadyVisual(button, true);
        h._emitHomeFeedback('drag-start');
    }

    /** Reset the DnD ready state without promoting to full DnD. */
    resetHomeDndReadyState() {
        let h = this._home;
        h._cancelHomeDndMenuTimer();
        h._setHomeDndReadyVisual(h._homeDndSourceBtn, false);
        h._homeDndReady = false;
        h._homeDndSourceBtn = null;
        h._homeDndItem = null;
        h._homeDndApp = null;
    }

    /** Schedule auto-opening the menu after DnD ready timeout. */
    scheduleHomeDndAutoMenu(button, item, app) {
        let h = this._home;
        h._cancelHomeDndMenuTimer();
        let tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOME_DND_MENU_AUTO_MS, () => {
            h._homeDndMenuTimerId = 0;
            h._runtimeDisposer.untrackTimeout(tid);
            if (!h._homeDndReady || h._homeDndSourceBtn !== button || h._homeDndItem !== item)
                return GLib.SOURCE_REMOVE;
            this.openReadyItemMenu(button, item, app, h._homeDndStartX, h._homeDndStartY);
            return GLib.SOURCE_REMOVE;
        });
        h._homeDndMenuTimerId = tid;
        h._runtimeDisposer.trackTimeout(tid);
    }

    /** Open the appropriate menu for a DnD-ready item. */
    openReadyItemMenu(button, item, app, x, y) {
        let h = this._home;
        if (!button || !item)
            return;

        if (h._isWidget(item)) {
            this.resetHomeDndReadyState();
            h._enterWidgetResizeMode(button, item);
            return;
        }
        if (h._isFolder(item)) {
            this.showHomeFolderMenu(x, y, item);
            return;
        }
        if (h._isFile(item)) {
            h._showFileMenu(x, y, item);
            return;
        }
        if (app)
            this.showHomeAppMenu(x, y, app, item);
    }

    /** Show the folder context menu. */
    showHomeFolderMenu(x, y, folderItem) {
        this.showHomeNativeMenuAtPoint(x, y, menu => {
            this.addHomeNativeMenuItem(menu, 'Remove from Home Screen', () => {
                this.removeHomeIcon(folderItem);
            });
        });
    }

    /** Add a menu item to a native popup menu. */
    addHomeNativeMenuItem(menu, label, action) {
        let item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            this.dismissHomeMenu();
            action?.();
        });
        menu.addMenuItem(item);
    }

    /** Show a native popup menu anchored to an actor. */
    showHomeNativeMenu(sourceActor, populate, side = St.Side.TOP, alignment = 0.5, deferredOpen = false) {
        let h = this._home;
        if (!sourceActor)
            return null;
        h._controller?.haptics?.vibrate(20);
        this.dismissHomeMenu();
        if (!h._homeMenuManager)
            h._homeMenuManager = new PopupMenu.PopupMenuManager(Main.layoutManager.uiGroup);

        let menu = new PopupMenu.PopupMenu(sourceActor, alignment, side);
        menu.blockSourceEvents = true;
        menu.actor.add_style_class_name('popup-menu');
        Main.layoutManager.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        populate?.(menu);

        h._homeMenu = menu;
        h._homeMenuIsPopup = true;
        menu.connect('menu-closed', () => {
            if (h._homeMenu === menu)
                this.dismissHomeMenu(true);
        });
        h._homeMenuManager.addMenu(menu);

        h._homeMenuFocusId = h._runtimeDisposer.connect(global.display, 'notify::focus-window', () => {
            if (h._homeMenu === menu && global.display.get_focus_window())
                this.dismissHomeMenu();
        });
        h._homeMenuCaptureId = h._runtimeDisposer.connect(global.stage, 'captured-event', (_a, event) => {
            if (h._homeMenu !== menu || !menu.actor)
                return Clutter.EVENT_PROPAGATE;

            let type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            let [ex, ey] = event.get_coords();
            let insideMenu = false;
            try {
                let target = global.stage.get_actor_at_pos(
                    Clutter.PickMode.ALL, Math.round(ex), Math.round(ey));
                insideMenu = !!target && (target === menu.actor || menu.actor.contains(target));
            } catch (_e) {}

            if (!insideMenu) {
                let [mx, my] = menu.actor.get_transformed_position();
                let [mw, mh] = menu.actor.get_transformed_size
                    ? menu.actor.get_transformed_size()
                    : [menu.actor.get_width(), menu.actor.get_height()];
                insideMenu = ex >= mx && ex <= mx + mw && ey >= my && ey <= my + mh;
            }

            if (!insideMenu)
                this.dismissHomeMenu();
            return Clutter.EVENT_PROPAGATE;
        });

        if (deferredOpen) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (h._homeMenu === menu)
                    menu.open();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            menu.open();
        }
        return menu;
    }

    /** Check if a point is over any home grid button. */
    isPointOverHomeGridButton(x, y) {
        for (let entry of this._home._homeGridButtons) {
            let btn = entry?.btn;
            if (!btn || !btn.visible)
                continue;
            let [bx, by] = btn.get_transformed_position();
            let bw = btn.get_width();
            let bh = btn.get_height();
            if (x >= bx && x <= bx + bw && y >= by && y <= by + bh)
                return true;
        }
        return false;
    }

    /** Show a native menu at a screen coordinate. */
    showHomeNativeMenuAtPoint(x, y, populate) {
        let h = this._home;
        let anchor = new St.Widget({
            reactive: false,
            width: 1, height: 1, opacity: 0,
        });
        Main.layoutManager.uiGroup.add_child(anchor);
        anchor.set_position(Math.round(x), Math.round(y));
        anchor.show();
        h._homeMenuAnchor = anchor;
        let menu = this.showHomeNativeMenu(anchor, populate, St.Side.TOP, 0.5, true);
        this._queueHomeMenuPositionAtPoint(menu, x, y);
        return menu;
    }

    _positionHomeMenuAtPoint(menu, x, y) {
        if (!menu?.actor)
            return;
        let h = this._home;
        let actor = menu.actor;
        let [minW, natW] = actor.get_preferred_width(-1);
        let [minH, natH] = actor.get_preferred_height(-1);
        let menuW = Math.max(1, actor.width || natW || minW || 1);
        let menuH = Math.max(1, actor.height || natH || minH || 1);
        let monitor = h._getHomeMonitor();
        let minX = monitor ? monitor.x + 8 : 8;
        let maxX = monitor ? monitor.x + monitor.width - menuW - 8 : global.stage.width - menuW - 8;
        let minY = monitor ? monitor.y + 8 : 8;
        let maxY = monitor ? monitor.y + monitor.height - menuH - 8 : global.stage.height - menuH - 8;
        let targetX = Math.max(minX, Math.min(maxX, Math.round(x)));
        let targetY = Math.max(minY, Math.min(maxY, Math.round(y - 8)));
        actor.set_position(targetX, targetY);
        actor.raise_top?.();
    }

    _queueHomeMenuPositionAtPoint(menu, x, y) {
        if (!menu)
            return;
        let h = this._home;
        h._runtimeDisposer.restartTimeout(
            h, '_homeMenuPosOnceId',
            GLib.PRIORITY_DEFAULT_IDLE, 0,
            () => {
                this._positionHomeMenuAtPoint(menu, x, y);
                return GLib.SOURCE_REMOVE;
            });
        h._runtimeDisposer.restartTimeout(
            h, '_homeMenuPosSettleId',
            GLib.PRIORITY_DEFAULT, 34,
            () => {
                this._positionHomeMenuAtPoint(menu, x, y);
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Show the app context menu. */
    showHomeAppMenu(x, y, app, item) {
        this.showHomeNativeMenuAtPoint(x, y, menu => {
            this.addHomeNativeMenuItem(menu, 'Remove from Home Screen', () => {
                this.removeHomeIcon(item);
            });
            this.addHomeNativeMenuItem(menu, 'App Info', () => {
                this._openAppInfo(app);
            });
        });
    }

    _openAppInfo(app) {
        if (!app)
            return;
        let appId = app.get_id();
        if (appId) {
            try {
                GLib.spawn_command_line_async(`gnome-software --details ${GLib.shell_quote(appId)}`);
                return;
            } catch (_e) {}
        }
        this.openSystemControlCenter('applications');
    }

    /** Show the background context menu (widgets, folders, settings). */
    showHomeBackgroundMenu(x, y) {
        let h = this._home;
        if (h._homeDndReady || h._homeDndActive)
            return;
        this.showHomeNativeMenuAtPoint(x, y, menu => {
            this.addHomeNativeMenuItem(menu, 'Widgets', () => h._openWidgetPicker());
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.addHomeNativeMenuItem(menu, 'New Folder', () => this._createDesktopFolder());
            this.addHomeNativeMenuItem(menu, 'Open Desktop Folder', () => this._openDesktopFolder());
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.addHomeNativeMenuItem(menu, 'Change Background...', () => {
                this.openSystemControlCenter('background');
            });
            this.addHomeNativeMenuItem(menu, 'Display Settings', () => {
                this.openSystemControlCenter('display');
            });
            this.addHomeNativeMenuItem(menu, 'Convergence Settings', () => {
                let isPhone = h._controller?.displayConfig?.getDisplayMode?.() === 'phone'
                    || h._controller?.displayConfig?.isSmallDisplay;
                let page = isPhone ? 'phone' : 'desktop';
                try {
                    if (h._settings?.settings_schema?.has_key?.('prefs-open-page'))
                        h._settings.set_string('prefs-open-page', page);
                } catch (_e) {}
                try {
                    Main.extensionManager?.openExtensionPrefs?.('convergence@daniel-blandford.github.io', '', {});
                } catch (_e) {
                    try { GLib.spawn_command_line_async('gnome-extensions prefs convergence@daniel-blandford.github.io'); }
                    catch (_e2) {}
                }
            });
            this.addHomeNativeMenuItem(menu, 'Settings', () => {
                this.openSystemControlCenter();
            });
        });
    }

    _openDesktopFolder() {
        let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        if (!path) path = GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']);
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(path).get_uri(), null);
        } catch (_e) {}
    }

    _createDesktopFolder() {
        let basePath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        if (!basePath) basePath = GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']);
        let dir = Gio.File.new_for_path(basePath);
        let name = 'New Folder';
        let target = dir.get_child(name);
        let counter = 1;
        while (target.query_exists(null)) {
            name = `New Folder (${counter})`;
            target = dir.get_child(name);
            counter++;
        }
        try {
            target.make_directory(null);
        } catch (_e) {}
    }
}
