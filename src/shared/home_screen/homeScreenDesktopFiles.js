// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { addClickCursor, createLongPressController } from '../utilities/uiUtils.js';
import { TOUCH_LONG_PRESS_CANCEL_DIST } from '../utilities/gestureConstants.js';

const HOME_LONG_PRESS_MS = 500;

function getDesktopDir() {
    let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
    if (!path) path = GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']);
    return Gio.File.new_for_path(path);
}

function getFileIconName(gFile) {
    try {
        let info = gFile.query_info(
            'standard::icon,standard::content-type,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let gIcon = info.get_icon();
        if (gIcon) {
            if (gIcon instanceof Gio.ThemedIcon) {
                let names = gIcon.get_names();
                if (names && names.length > 0)
                    return names[0];
            }
            return gIcon.to_string();
        }
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            return 'folder';
    } catch (_e) {}
    return 'text-x-generic';
}

function getFileDisplayName(gFile) {
    try {
        let info = gFile.query_info('standard::display-name',
            Gio.FileQueryInfoFlags.NONE, null);
        return info.get_display_name();
    } catch (_e) {}
    return gFile.get_basename();
}

function isFileDirectory(gFile) {
    try {
        let info = gFile.query_info('standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        return info.get_file_type() === Gio.FileType.DIRECTORY;
    } catch (_e) {}
    return false;
}

function getAlternativeApps(gFile) {
    let apps = [];
    try {
        let info = gFile.query_info('standard::content-type',
            Gio.FileQueryInfoFlags.NONE, null);
        let contentType = info.get_content_type();
        if (contentType) {
            let defaultApp = Gio.AppInfo.get_default_for_type(contentType, false);
            let allApps = Gio.AppInfo.get_all_for_type(contentType);
            let defaultId = defaultApp?.get_id?.();
            for (let app of allApps) {
                if (app.get_id() !== defaultId)
                    apps.push(app);
                if (apps.length >= 3) break;
            }
        }
    } catch (_e) {}
    return apps;
}

function deleteRecursive(gFile) {
    try {
        let enumerator = gFile.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            let child = gFile.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                deleteRecursive(child);
            else
                child.delete(null);
        }
        enumerator.close(null);
        gFile.delete(null);
    } catch (_e) {}
}

/**
 * Desktop file monitoring, file icon creation, and file actions
 * for the home screen.
 */
export class HomeScreenDesktopFiles {
    /**
     * @param {object} homeScreen - The HomeScreen instance.
     */
    constructor(homeScreen) {
        this._home = homeScreen;
        this._desktopFileMonitor = null;
        this._desktopFileMonitorId = 0;
        this._selectedFileItem = null;
        this._selectedFileBox = null;
        this._renameDialog = null;
    }

    /** Start monitoring ~/Desktop for file changes. */
    startDesktopFileMonitor() {
        if (this._desktopFileMonitor) return;
        let dir = getDesktopDir();
        try {
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
        } catch (_e) {}

        try {
            this._desktopFileMonitor = dir.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._desktopFileMonitorId = this._desktopFileMonitor.connect('changed',
                (_mon, _file, _other, eventType) => {
                    if (eventType === Gio.FileMonitorEvent.CREATED ||
                        eventType === Gio.FileMonitorEvent.DELETED ||
                        eventType === Gio.FileMonitorEvent.MOVED_IN ||
                        eventType === Gio.FileMonitorEvent.MOVED_OUT ||
                        eventType === Gio.FileMonitorEvent.RENAMED ||
                        eventType === Gio.FileMonitorEvent.CHANGED)
                        this.syncDesktopFiles();
                });
        } catch (_e) {}
    }

    /** Stop the desktop file monitor. */
    stopDesktopFileMonitor() {
        if (this._desktopFileMonitor) {
            if (this._desktopFileMonitorId) {
                this._desktopFileMonitor.disconnect(this._desktopFileMonitorId);
                this._desktopFileMonitorId = 0;
            }
            this._desktopFileMonitor.cancel();
            this._desktopFileMonitor = null;
        }
    }

    /**
     * Scan ~/Desktop for non-hidden files/folders.
     * Keeps grid positions stable; only adds new files and prunes deleted ones.
     */
    syncDesktopFiles() {
        let h = this._home;
        let dir = getDesktopDir();
        let diskFiles = new Map();

        try {
            let enumerator = dir.enumerate_children(
                'standard::name,standard::is-hidden,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_is_hidden()) continue;
                let child = dir.get_child(info.get_name());
                diskFiles.set(child.get_uri(), info.get_name());
            }
            enumerator.close(null);
        } catch (_e) {
            return;
        }

        let changed = false;
        let before = h._homeGridItems.length;
        h._homeGridItems = h._homeGridItems.filter(i => {
            if (i.type !== 'file') return true;
            return diskFiles.has(i.uri);
        });
        if (h._homeGridItems.length !== before) changed = true;

        let placedUris = new Set(
            h._homeGridItems.filter(i => i.type === 'file').map(i => i.uri));

        for (let [uri] of diskFiles) {
            if (placedUris.has(uri)) continue;
            let cell = h._findNextAvailableCell(h._homeCurrentPage);
            if (!cell) cell = { col: 0, row: 0, page: (h._homeCurrentPage ?? 0) + 1 };
            h._homeGridItems.push({
                type: 'file',
                uri,
                col: cell.col,
                row: cell.row,
                page: cell.page ?? h._homeCurrentPage ?? 0,
            });
            changed = true;
        }

        if (changed) {
            h._saveHomeLayout();
            h._renderHomeGrid();
        }
    }

    /**
     * Create a file icon button for the home grid.
     * @param {object} item - The file grid item.
     * @returns {St.Button}
     */
    createFileIcon(item) {
        let h = this._home;
        let gFile = Gio.File.new_for_uri(item.uri);
        let iconName;
        let displayName;

        let basename = gFile.get_basename() ?? '';
        if (basename.endsWith('.desktop')) {
            try {
                let appInfo = GioUnix.DesktopAppInfo.new_from_filename(gFile.get_path());
                if (appInfo) {
                    displayName = appInfo.get_display_name() || appInfo.get_name();
                    let gIcon = appInfo.get_icon();
                    if (gIcon instanceof Gio.ThemedIcon) {
                        let names = gIcon.get_names();
                        if (names && names.length > 0)
                            iconName = names[0];
                    }
                    if (!iconName && gIcon)
                        iconName = gIcon.to_string();
                }
            } catch (_e) {}
        }

        if (!iconName) iconName = getFileIconName(gFile);
        if (!displayName) displayName = getFileDisplayName(gFile);

        let pad = h._labelPadH;
        let box = new St.BoxLayout({
            style_class: 'convergence-home-icon-button',
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
            style: `padding: ${pad}px;`,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            icon_size: h._iconSize,
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);

        let label = new St.Label({
            text: displayName,
            style_class: 'convergence-home-icon-label',
            x_expand: true,
            style: `height: ${h._labelMaxHeight}px; font-size: ${h._labelFontSize}px; margin-top: ${h._labelMarginTop}px;`,
        });
        label.clutter_text.set({
            ellipsize: 3, line_wrap: true, line_wrap_mode: 2, max_length: 0,
        });
        label.clutter_text.set_line_alignment(1);
        box.add_child(label);

        let button = new St.Button({
            child: box,
            width: h._cellW, height: h._cellH,
            style: 'padding: 0; margin: 0;',
        });
        addClickCursor(button, h._runtimeDisposer);

        let lastInputWasTouch = false;
        button.connect('notify::hover', () => {
            if (lastInputWasTouch) return;
            if (button.hover) box.add_style_pseudo_class('hover');
            else box.remove_style_pseudo_class('hover');
        });

        let lpFired = false;
        let lpController = createLongPressController(HOME_LONG_PRESS_MS, (x, y) => {
            lpFired = true;
            h._beginHomeDndReady(button, item, null, x, y);
        });

        let startLp = (x, y) => {
            lpFired = false;
            h._cancelHomeDndMenuTimer();
            lpController.start(x, y);
        };
        let cancelLp = () => {
            lpController.cancel();
            h._setHomeDndReadyVisual(button, false);
        };
        let touchStartX = 0, touchStartY = 0, touchTracking = false;
        let touchCancelDist = Math.max(10, Math.round(TOUCH_LONG_PRESS_CANCEL_DIST * (h._scale ?? 1)));
        let touchCancelDistSq = touchCancelDist * touchCancelDist;

        button.connect('button-press-event', (_actor, event) => {
            lastInputWasTouch = false;
            let btn = event.get_button ? event.get_button() : 0;
            if (btn === Clutter.BUTTON_SECONDARY) {
                h._cancelHomeDndMenuTimer();
                cancelLp();
                lpFired = true;
                let [ex, ey] = event.get_coords();
                this.showFileMenu(ex, ey, item);
                return Clutter.EVENT_STOP;
            }
            box.add_style_pseudo_class('active');
            let [x, y] = event.get_coords();
            startLp(x, y);
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            box.remove_style_pseudo_class('active');
            cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('touch-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                lastInputWasTouch = true;
                box.add_style_pseudo_class('active');
                let [x, y] = event.get_coords();
                touchStartX = x; touchStartY = y;
                touchTracking = true;
                startLp(x, y);
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (touchTracking && !lpFired && !h._homeDndActive && !h._homeDndReady) {
                    let [x, y] = event.get_coords();
                    let dx = x - touchStartX, dy = y - touchStartY;
                    if (dx * dx + dy * dy >= touchCancelDistSq) {
                        box.remove_style_pseudo_class('active');
                        cancelLp();
                        touchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END) {
                box.remove_style_pseudo_class('active');
                box.remove_style_pseudo_class('hover');
                touchTracking = false;
                cancelLp();
            } else if (type === Clutter.EventType.TOUCH_CANCEL) {
                box.remove_style_pseudo_class('active');
                box.remove_style_pseudo_class('hover');
                touchTracking = false;
                cancelLp();
                lpFired = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('leave-event', (_actor, event) => {
            let source = event.get_source_device();
            if (source && source.get_device_type() !== Clutter.InputDeviceType.TOUCHSCREEN_DEVICE) {
                box.remove_style_pseudo_class('active');
                cancelLp();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        let lastClickTime = 0;
        button.connect('clicked', () => {
            if (lpFired) return;
            if (lastInputWasTouch) {
                this.deselectFileIcon();
                this.openFile(item);
                lpFired = true;
                return;
            }
            let now = GLib.get_monotonic_time() / 1000;
            if (now - lastClickTime < 400) {
                lastClickTime = 0;
                this.deselectFileIcon();
                this.openFile(item);
                lpFired = true;
            } else {
                lastClickTime = now;
                this.selectFileIcon(item, box);
            }
        });

        return button;
    }

    /** Select a file icon for single-click highlight. */
    selectFileIcon(item, box) {
        if (this._selectedFileBox && this._selectedFileBox !== box)
            this._selectedFileBox.remove_style_class_name('convergence-home-icon-selected');
        this._selectedFileItem = item;
        this._selectedFileBox = box;
        box.add_style_class_name('convergence-home-icon-selected');
    }

    /** Deselect any file icon. */
    deselectFileIcon() {
        if (this._selectedFileBox)
            this._selectedFileBox.remove_style_class_name('convergence-home-icon-selected');
        this._selectedFileItem = null;
        this._selectedFileBox = null;
    }

    /** Open a file item with its default handler. */
    openFile(item) {
        let gFile = Gio.File.new_for_uri(item.uri);
        let basename = gFile.get_basename() ?? '';
        if (basename.endsWith('.desktop')) {
            try {
                let appInfo = GioUnix.DesktopAppInfo.new_from_filename(gFile.get_path());
                if (appInfo) { appInfo.launch([], null); return; }
            } catch (_e) {}
        }
        try {
            Gio.AppInfo.launch_default_for_uri(item.uri, null);
        } catch (_e) {
            try {
                let fileManager = Gio.AppInfo.get_default_for_type('inode/directory', true);
                if (fileManager) fileManager.launch_uris([item.uri], null);
            } catch (_e2) {}
        }
    }

    /** Move a file to trash. */
    moveFileToTrash(item) {
        try {
            let gFile = Gio.File.new_for_uri(item.uri);
            gFile.trash(null);
        } catch (_e) {}
    }

    /** Permanently delete a file. */
    deleteFilePermanently(item) {
        try {
            let gFile = Gio.File.new_for_uri(item.uri);
            if (isFileDirectory(gFile)) deleteRecursive(gFile);
            else gFile.delete(null);
        } catch (_e) {}
    }

    /** Show the rename dialog for a desktop file. */
    renameDesktopFile(item) {
        let h = this._home;
        let gFile = Gio.File.new_for_uri(item.uri);
        let basename = gFile.get_basename() ?? getFileDisplayName(gFile);
        h._dismissHomeMenu();
        this._showRenameDialog(basename, newName => {
            if (!newName || newName === basename) return;
            try {
                let parent = gFile.get_parent();
                let dest = parent.get_child(newName);
                gFile.move(dest, Gio.FileCopyFlags.NONE, null, null);
                item.uri = dest.get_uri();
                h._saveHomeLayout();
            } catch (_e) {}
        });
    }

    _showRenameDialog(currentName, onCommit) {
        this._dismissRenameDialog();
        let h = this._home;
        let monitor = h._getHomeMonitor();
        let monW = monitor?.width ?? global.stage.width;
        let monH = monitor?.height ?? global.stage.height;
        let monX = monitor?.x ?? 0;
        let monY = monitor?.y ?? 0;

        let backdrop = new St.Widget({
            reactive: true, x: monX, y: monY,
            width: monW, height: monH,
            style: 'background-color: rgba(0,0,0,0.35);',
        });

        let card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'convergence-rename-dialog',
            style: 'background-color: rgba(40,40,40,0.95); border-radius: 16px; padding: 20px; min-width: 280px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        card.add_child(new St.Label({
            text: 'Rename',
            style: 'color: white; font-size: 16px; font-weight: 600; margin-bottom: 12px;',
            x_align: Clutter.ActorAlign.START,
        }));

        let entry = new St.Entry({
            text: currentName, can_focus: true,
            style: 'color: white; background-color: rgba(255,255,255,0.12); border-radius: 8px; padding: 8px 12px; font-size: 14px; min-width: 240px; caret-color: white;',
        });
        card.add_child(entry);

        let dotIdx = currentName.lastIndexOf('.');
        let selectEnd = dotIdx > 0 ? dotIdx : currentName.length;

        let buttonRow = new St.BoxLayout({
            style: 'margin-top: 16px; spacing: 12px;',
            x_align: Clutter.ActorAlign.END,
        });
        card.add_child(buttonRow);

        let cancelBtn = new St.Button({
            label: 'Cancel',
            style: 'color: rgba(255,255,255,0.8); background-color: rgba(255,255,255,0.1); border-radius: 8px; padding: 6px 16px; font-size: 13px;',
        });
        let renameBtn = new St.Button({
            label: 'Rename',
            style: 'color: white; background-color: rgba(80,130,255,0.8); border-radius: 8px; padding: 6px 16px; font-size: 13px; font-weight: 600;',
        });
        buttonRow.add_child(cancelBtn);
        buttonRow.add_child(renameBtn);

        let cardWrapper = new St.BoxLayout({
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        cardWrapper.add_child(card);
        backdrop.add_child(cardWrapper);
        cardWrapper.set_position(0, 0);
        cardWrapper.set_size(monW, monH);

        Main.layoutManager.uiGroup.add_child(backdrop);
        this._renameDialog = backdrop;

        let dismiss = () => this._dismissRenameDialog();
        let commit = () => {
            let newName = entry.get_text().trim();
            dismiss();
            onCommit(newName);
        };

        cancelBtn.connect('clicked', dismiss);
        renameBtn.connect('clicked', commit);
        entry.clutter_text.connect('activate', commit);

        backdrop.connect('button-press-event', (_a, event) => {
            let [ex, ey] = event.get_coords();
            let [cx, cy] = card.get_transformed_position();
            let cw = card.width, ch = card.height;
            if (ex < cx || ex > cx + cw || ey < cy || ey > cy + ch)
                dismiss();
            return Clutter.EVENT_STOP;
        });

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            entry.grab_key_focus();
            try { entry.clutter_text.set_selection(0, selectEnd); }
            catch (_e) { entry.clutter_text.set_cursor_position(-1); }
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissRenameDialog() {
        if (this._renameDialog) {
            let d = this._renameDialog;
            this._renameDialog = null;
            d.get_parent()?.remove_child(d);
            d.destroy();
        }
    }

    /** Show the file context menu. */
    showFileMenu(x, y, fileItem) {
        let h = this._home;
        let gFile = Gio.File.new_for_uri(fileItem.uri);
        let isDir = isFileDirectory(gFile);
        let isDesktopFile = (gFile.get_basename() ?? '').endsWith('.desktop');

        h._showHomeNativeMenuAtPoint(x, y, menu => {
            h._addHomeNativeMenuItem(menu, 'Open', () => this.openFile(fileItem));

            if (!isDir && !isDesktopFile) {
                let apps = getAlternativeApps(gFile);
                for (let appInfo of apps) {
                    h._addHomeNativeMenuItem(menu, `Open with ${appInfo.get_display_name()}`, () => {
                        try { appInfo.launch_uris([fileItem.uri], null); } catch (_e) {}
                    });
                }
            }

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            h._addHomeNativeMenuItem(menu, 'Rename', () => this.renameDesktopFile(fileItem));
            h._addHomeNativeMenuItem(menu, 'Move to Trash', () => this.moveFileToTrash(fileItem));
            h._addHomeNativeMenuItem(menu, 'Delete Permanently', () => this.deleteFilePermanently(fileItem));
        });
    }

    /** Clean up on destroy. */
    destroy() {
        this.stopDesktopFileMonitor();
        this._dismissRenameDialog();
    }
}
