// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Logger } from '../../shared/utilities/logger.js';

/**
 * Drag-to-uninstall zone and confirmation dialog for the phone drawer.
 *
 * During DnD reorder, a "Uninstall" drop target appears.  Dropping an app
 * on it triggers a confirmation dialog.  Supports Flatpak, Snap, AppImage,
 * and native package detection across multiple distro package managers.
 */
export class DrawerUninstall {
    /**
     * @param {import('./appDrawer.js').AppDrawer} drawer - Parent drawer.
     * @param {import('gi://Gio').Settings|null} settings - Extension GSettings.
     */
    constructor(drawer, settings) {
        this._drawer = drawer;
        this._settings = settings ?? null;
        this._logger = new Logger('DrawerUninstall', this._settings);
        this._uninstallCapabilityCache = new Map();
        this._preferredStoreCache = null;
        this._deleteConfirmDialog = null;
        this._deleteConfirmGrab = null;
        this._deleteConfirmCaptureId = 0;
    }

    // ── Package detection ─────────────────────────────────────────────

    /**
     * Strip `.desktop` suffix from a desktop file ID.
     * @param {string} desktopId
     * @returns {string}
     */
    _desktopIdToAppId(desktopId) {
        if (!desktopId)
            return '';
        return `${desktopId}`.replace(/\.desktop$/i, '');
    }

    /**
     * Run a command synchronously and capture output.
     * @param {string[]} argv
     * @returns {{ ok: boolean, stdout: string, stderr: string, status: number }}
     */
    _spawnCapture(argv) {
        try {
            let [_ok, out, err, status] = GLib.spawn_sync(
                null, argv, null,
                GLib.SpawnFlags.SEARCH_PATH, null);
            let stdout = out ? `${out}`.trim() : '';
            let stderr = err ? `${err}`.trim() : '';
            return { ok: status === 0, stdout, stderr, status };
        } catch (_e) {
            return { ok: false, stdout: '', stderr: '', status: -1 };
        }
    }

    /**
     * Check whether a command is available on PATH.
     * @param {string} cmd
     * @returns {boolean}
     */
    _commandExists(cmd) {
        return !!GLib.find_program_in_path(cmd);
    }

    /**
     * Get the filesystem path of an app's .desktop file.
     * @param {Shell.App} app
     * @returns {string}
     */
    _getDesktopFilePath(app) {
        try {
            return app?.get_app_info?.()?.get_filename?.() ?? '';
        } catch (_e) {
            return '';
        }
    }

    /**
     * Read a key from a .desktop file.
     * @param {string} path
     * @param {string} key
     * @returns {string}
     */
    _readDesktopKey(path, key) {
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            return '';
        try {
            let keyFile = new GLib.KeyFile();
            keyFile.load_from_file(path, GLib.KeyFileFlags.NONE);
            return keyFile.get_string('Desktop Entry', key) ?? '';
        } catch (_e) {
            return '';
        }
    }

    /**
     * Determine how an app was installed.
     * @param {Shell.App} app
     * @returns {'flatpak'|'snap'|'appimage'|'native'}
     */
    _getAppInstallKind(app) {
        let file = this._getDesktopFilePath(app);
        let desktopId = `${app?.get_id?.() ?? ''}`.toLowerCase();
        if (file.includes('/flatpak/exports/share/applications/') ||
            file.includes('/.local/share/flatpak/'))
            return 'flatpak';
        if (file.includes('/snapd/desktop/applications/') ||
            desktopId.includes('.snap'))
            return 'snap';
        let appImagePath = this._readDesktopKey(file, 'X-AppImage-Path');
        if (appImagePath || file.toLowerCase().includes('appimage'))
            return 'appimage';
        return 'native';
    }

    /**
     * Resolve the native package name owning a desktop file.
     * @param {string} desktopFile
     * @returns {string}
     */
    _resolveNativePackageName(desktopFile) {
        if (!desktopFile)
            return '';
        if (this._commandExists('dpkg-query')) {
            let res = this._spawnCapture(['dpkg-query', '-S', desktopFile]);
            if (res.ok && res.stdout.includes(':'))
                return res.stdout.split(':')[0].trim();
        }
        if (this._commandExists('rpm')) {
            let res = this._spawnCapture(
                ['rpm', '-qf', '--qf', '%{NAME}', desktopFile]);
            if (res.ok && res.stdout)
                return res.stdout.trim();
        }
        if (this._commandExists('pacman')) {
            let res = this._spawnCapture(['pacman', '-Qo', desktopFile]);
            if (res.ok) {
                let m = res.stdout.match(/owned by\s+([^\s]+)/i);
                if (m?.[1])
                    return m[1].trim();
            }
        }
        if (this._commandExists('xbps-query')) {
            let res = this._spawnCapture(['xbps-query', '-o', desktopFile]);
            if (res.ok && res.stdout.includes(':')) {
                let atom = res.stdout.split(':')[0].trim();
                if (atom)
                    return atom.replace(/-[0-9].*$/, '');
            }
        }
        if (this._commandExists('apk')) {
            let res = this._spawnCapture(
                ['apk', 'info', '--who-owns', desktopFile]);
            if (res.ok) {
                let m = res.stdout.match(/owned by\s+([^\s]+)/i);
                if (m?.[1])
                    return m[1].trim().replace(/-[0-9].*$/, '');
            }
        }
        return '';
    }

    /**
     * Build a package-manager remove command for a native package.
     * @param {string} pkgName
     * @returns {{ argv: string[], auth: boolean }|null}
     */
    _buildNativeUninstallCommand(pkgName) {
        if (!pkgName)
            return null;
        if (this._commandExists('apt-get'))
            return { argv: ['apt-get', 'remove', '-y', pkgName], auth: true };
        if (this._commandExists('dnf'))
            return { argv: ['dnf', 'remove', '-y', pkgName], auth: true };
        if (this._commandExists('yum'))
            return { argv: ['yum', 'remove', '-y', pkgName], auth: true };
        if (this._commandExists('pacman'))
            return { argv: ['pacman', '-Rns', '--noconfirm', pkgName], auth: true };
        if (this._commandExists('zypper'))
            return { argv: ['zypper', '--non-interactive', 'rm', pkgName], auth: true };
        if (this._commandExists('xbps-remove'))
            return { argv: ['xbps-remove', '-Ry', pkgName], auth: true };
        if (this._commandExists('eopkg'))
            return { argv: ['eopkg', 'remove', '-y', pkgName], auth: true };
        if (this._commandExists('apk'))
            return { argv: ['apk', 'del', pkgName], auth: true };
        if (this._commandExists('rpm-ostree'))
            return { argv: ['rpm-ostree', 'uninstall', pkgName], auth: true };
        if (this._commandExists('nix-env'))
            return { argv: ['nix-env', '-e', pkgName], auth: false };
        return null;
    }

    /** @private */
    _uninstallAppImageFiles(app) {
        let desktopPath = this._getDesktopFilePath(app);
        let appImagePath = this._readDesktopKey(desktopPath, 'X-AppImage-Path');
        if (!appImagePath) {
            let execCmd = this._readDesktopKey(desktopPath, 'Exec');
            let token = execCmd?.split(/\s+/)?.[0] ?? '';
            if (token.toLowerCase().includes('.appimage'))
                appImagePath = token;
        }

        let deletedAny = false;
        let tryDelete = path => {
            if (!path)
                return;
            let home = GLib.get_home_dir();
            if (!path.startsWith(home))
                return;
            try {
                let file = Gio.File.new_for_path(path);
                file.delete(null);
                deletedAny = true;
            } catch (_e) {}
        };

        tryDelete(appImagePath);
        tryDelete(desktopPath);
        return deletedAny;
    }

    /**
     * Build a complete uninstall plan for an app.
     * @param {Shell.App} app
     * @returns {{ kind: string, commands: Array }}
     */
    _buildUninstallPlan(app) {
        let kind = this._getAppInstallKind(app);
        let commands = [];
        let desktopPath = this._getDesktopFilePath(app);
        let appId = this._desktopIdToAppId(app.get_id?.());

        if (kind === 'flatpak' && this._commandExists('flatpak')) {
            let flatpakId = this._readDesktopKey(desktopPath, 'X-Flatpak');
            let ids = [flatpakId, appId].filter(Boolean);
            let seen = new Set();
            for (let id of ids) {
                if (seen.has(id))
                    continue;
                seen.add(id);
                commands.push({
                    argv: ['flatpak', 'uninstall', '-y', '--noninteractive', id],
                    auth: false,
                });
            }
        } else if (kind === 'snap' && this._commandExists('snap')) {
            let snapName = this._readDesktopKey(desktopPath, 'X-SnapInstanceName');
            if (!snapName) {
                let base = `${app.get_id?.() ?? ''}`.replace(/\.desktop$/i, '');
                snapName = base.split(/[_./]/)[0] ?? '';
            }
            if (snapName)
                commands.push({ argv: ['snap', 'remove', snapName], auth: true });
        } else if (kind === 'native') {
            let pkg = this._resolveNativePackageName(desktopPath);
            let cmd = this._buildNativeUninstallCommand(pkg);
            if (cmd)
                commands.push(cmd);
        }

        return { kind, commands };
    }

    /**
     * Check whether an app can be uninstalled.
     * @param {Shell.App} app
     * @returns {boolean}
     */
    isAppUninstallable(app) {
        let id = `${app?.get_id?.() ?? ''}`;
        if (this._uninstallCapabilityCache.has(id))
            return this._uninstallCapabilityCache.get(id);
        try {
            let file = this._getDesktopFilePath(app);
            let kind = this._getAppInstallKind(app);
            let uninstallable = false;
            if (kind === 'flatpak')
                uninstallable = this._commandExists('flatpak');
            else if (kind === 'snap')
                uninstallable = this._commandExists('snap');
            else if (kind === 'appimage')
                uninstallable = true;
            else if (kind === 'native' && file &&
                (file.startsWith('/usr/share/applications/') ||
                 file.startsWith('/usr/local/share/applications/'))) {
                uninstallable =
                    this._commandExists('apt-get') ||
                    this._commandExists('dnf') ||
                    this._commandExists('yum') ||
                    this._commandExists('pacman') ||
                    this._commandExists('zypper') ||
                    this._commandExists('xbps-remove') ||
                    this._commandExists('eopkg') ||
                    this._commandExists('apk') ||
                    this._commandExists('rpm-ostree') ||
                    this._commandExists('nix-env');
            }
            this._uninstallCapabilityCache.set(id, uninstallable);
            return uninstallable;
        } catch (_e) {
            this._uninstallCapabilityCache.set(id, false);
            return false;
        }
    }

    // ── Store integration ─────────────────────────────────────────────

    /** @private */
    _resolvePreferredStoreApp() {
        if (this._preferredStoreCache)
            return this._preferredStoreCache;
        let appSystem = Shell.AppSystem.get_default();
        let lookup = ids => {
            for (let id of ids) {
                let app = appSystem.lookup_app(id);
                if (app)
                    return app;
            }
            return null;
        };
        let bazaar = lookup([
            'io.github.kolunmi.Bazaar.desktop',
            'io.github.kolunmi.bazaar.desktop',
            'io.github.Bazaar.desktop',
            'bazaar.desktop',
        ]);
        let gnomeSoftware = lookup(['org.gnome.Software.desktop']);
        this._preferredStoreCache = bazaar || gnomeSoftware || null;
        return this._preferredStoreCache;
    }

    /** @private */
    _openAppInfoInStore(app) {
        if (!app)
            return;
        let appId = this._desktopIdToAppId(app.get_id?.());
        let uri = appId ? `appstream://${appId}` : '';
        try {
            if (uri) {
                Gio.AppInfo.launch_default_for_uri(uri, null);
                return;
            }
        } catch (_e) {}
        let store = this._resolvePreferredStoreApp();
        try {
            store?.activate?.();
        } catch (_e) {}
    }

    // ── Subprocess helpers ────────────────────────────────────────────

    /** @private */
    _runSubprocessChecked(argv, onDone = null) {
        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            proc.wait_check_async(null, (_p, res) => {
                let ok = false;
                try {
                    ok = proc.wait_check_finish(res);
                } catch (_e) {
                    ok = false;
                }
                onDone?.(ok);
            });
        } catch (_e) {
            onDone?.(false);
        }
    }

    /** @private */
    _runUninstallCommandChain(commands, onDone = null, index = 0) {
        if (!commands || index >= commands.length) {
            onDone?.(false);
            return;
        }
        let spec = commands[index];
        if (!spec?.argv?.length) {
            this._runUninstallCommandChain(commands, onDone, index + 1);
            return;
        }
        let argv = spec.argv;
        if (spec.auth && this._commandExists('pkexec'))
            argv = ['pkexec', ...argv];
        this._runSubprocessChecked(argv, ok => {
            if (ok)
                onDone?.(true);
            else
                this._runUninstallCommandChain(commands, onDone, index + 1);
        });
    }

    /**
     * Request uninstallation of an app (with store fallback).
     * @param {Shell.App} app
     */
    requestAppUninstall(app) {
        if (!app)
            return;
        if (!this.isAppUninstallable(app))
            return this._openAppInfoInStore(app);

        let refresh = () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._uninstallCapabilityCache.clear();
                this._drawer._populateApps();
                return GLib.SOURCE_REMOVE;
            });
        };

        this._openAppInfoInStore(app);

        let plan = this._buildUninstallPlan(app);
        if (plan.kind === 'appimage') {
            this._uninstallAppImageFiles(app);
            refresh();
            return;
        }
        if (!plan.commands.length) {
            refresh();
            return;
        }
        this._runUninstallCommandChain(plan.commands, () => refresh());
    }

    /**
     * Return a human-readable description of the uninstall method.
     * @param {Shell.App} app
     * @returns {string}
     */
    _describeUninstallTarget(app) {
        let plan = this._buildUninstallPlan(app);
        if (plan.kind === 'flatpak')
            return 'Method: Flatpak package';
        if (plan.kind === 'snap')
            return 'Method: Snap package';
        if (plan.kind === 'appimage')
            return 'Method: AppImage file';
        if (plan.kind === 'native') {
            let first = plan.commands?.[0]?.argv?.[0] ?? '';
            if (first)
                return `Method: ${first} package`;
            return 'Method: Native package';
        }
        return 'Method: Store-managed app';
    }

    // ── Confirmation dialog ───────────────────────────────────────────

    /**
     * Show a centered delete-confirmation dialog for an app.
     * @param {Shell.App} app
     */
    showDeleteConfirmDialog(app) {
        if (!app)
            return;
        this.dismissDeleteConfirmDialog();

        let appName = app.get_name?.() || app.get_id?.() || 'this app';
        let panel = new St.BoxLayout({
            style_class: 'convergence-delete-confirm',
            vertical: true,
            reactive: true,
        });
        try {
            panel.add_effect_with_name(
                'convergence-delete-confirm-blur',
                new Shell.BlurEffect({
                    sigma: 24,
                    brightness: 0.50,
                    mode: Shell.BlurMode.BACKGROUND,
                }));
        } catch (_e) {}

        let title = new St.Label({
            text: `Delete ${appName}?`,
            style_class: 'convergence-delete-confirm-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        let subtitle = new St.Label({
            text: 'This will uninstall the app from your system.',
            style_class: 'convergence-delete-confirm-subtitle',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        let detail = new St.Label({
            text: this._describeUninstallTarget(app),
            style_class: 'convergence-delete-confirm-detail',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        let actions = new St.BoxLayout({
            style_class: 'convergence-delete-confirm-actions',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        let cancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'convergence-delete-confirm-cancel',
            can_focus: true,
        });
        let deleteBtn = new St.Button({
            label: 'Delete',
            style_class: 'convergence-delete-confirm-delete',
            can_focus: true,
        });
        cancelBtn.connect('clicked', () => this.dismissDeleteConfirmDialog());
        deleteBtn.connect('clicked', () => {
            this.dismissDeleteConfirmDialog();
            this.requestAppUninstall(app);
        });
        actions.add_child(cancelBtn);
        actions.add_child(deleteBtn);
        panel.add_child(title);
        panel.add_child(subtitle);
        panel.add_child(detail);
        panel.add_child(actions);

        this._deleteConfirmDialog = panel;
        Main.layoutManager.uiGroup.add_child(panel);

        panel.set_position(0, 0);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._deleteConfirmDialog)
                return GLib.SOURCE_REMOVE;
            let w = panel.get_width();
            let h = panel.get_height();
            let x = Math.round((global.stage.width - w) / 2);
            let y = Math.round((global.stage.height - h) / 2);
            panel.set_position(Math.max(8, x), Math.max(8, y));
            global.stage.set_key_focus(cancelBtn);
            return GLib.SOURCE_REMOVE;
        });

        this._deleteConfirmGrab = global.stage.grab(panel);
        this._deleteConfirmCaptureId = global.stage.connect(
            'captured-event', (_a, event) => {
                let type = event.type();
                if (type === Clutter.EventType.KEY_PRESS) {
                    if (event.get_key_symbol() === Clutter.KEY_Escape) {
                        this.dismissDeleteConfirmDialog();
                        return Clutter.EVENT_STOP;
                    }
                }
                if (type === Clutter.EventType.BUTTON_PRESS ||
                    type === Clutter.EventType.TOUCH_BEGIN) {
                    let [ex, ey] = event.get_coords();
                    let [px, py] = panel.get_transformed_position();
                    let pw = panel.get_width();
                    let ph = panel.get_height();
                    if (ex < px || ex > px + pw || ey < py || ey > py + ph) {
                        this.dismissDeleteConfirmDialog();
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
    }

    /** Dismiss and destroy the delete-confirmation dialog. */
    dismissDeleteConfirmDialog() {
        if (this._deleteConfirmCaptureId) {
            global.stage.disconnect(this._deleteConfirmCaptureId);
            this._deleteConfirmCaptureId = 0;
        }
        if (this._deleteConfirmGrab) {
            this._deleteConfirmGrab.dismiss();
            this._deleteConfirmGrab = null;
        }
        if (this._deleteConfirmDialog) {
            if (this._deleteConfirmDialog.get_parent())
                this._deleteConfirmDialog.get_parent().remove_child(
                    this._deleteConfirmDialog);
            this._deleteConfirmDialog.destroy();
            this._deleteConfirmDialog = null;
        }
    }

    /** Release cached data. */
    destroy() {
        this.dismissDeleteConfirmDialog();
        this._uninstallCapabilityCache.clear();
        this._preferredStoreCache = null;
        this._logger?.destroy?.();
    }
}
