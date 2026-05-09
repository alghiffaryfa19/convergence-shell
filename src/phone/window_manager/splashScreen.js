// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SPLASH_ICON_SIZE = 96;
const SPLASH_FADE_IN_MS = 80;
const SPLASH_FADE_OUT_MS = 200;
const SPLASH_TIMEOUT_MS = 5000;

/**
 * SplashScreen -- full-screen splash overlay shown during app launch.
 *
 * Displays the app icon centered on a dark background while the
 * application loads. Automatically dismissed when the app's window
 * appears or after a safety timeout.
 */
export class SplashScreen {
    constructor(controller = null) {
        this._controller = controller;
        this._overlay = null;
        this._pendingAppId = null;
        this._timeoutId = 0;
        this._windowCreatedId = 0;
        this._focusAppId = 0;
        this._retryIds = null;
    }

    /**
     * Show a splash screen for the given app.
     * @param {Shell.App} app - the app being launched
     * @param {number} monitorIndex - which monitor to cover (-1 for primary)
     */
    show(app, monitorIndex = -1) {
        if (app.get_n_windows() > 0)
            return;

        this.dismiss();

        let appId = app.get_id();
        this._pendingAppId = appId;

        let resolvedMonitorIndex = monitorIndex;
        if (!Number.isInteger(resolvedMonitorIndex) || resolvedMonitorIndex < 0)
            resolvedMonitorIndex = this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[resolvedMonitorIndex]
            ?? Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        this._overlay = new St.Widget({
            style_class: 'convergence-splash',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        let box = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 16px;',
        });

        let icon = app.create_icon_texture(SPLASH_ICON_SIZE);
        if (icon) {
            icon.x_align = Clutter.ActorAlign.CENTER;
            box.add_child(icon);
        }

        let name = app.get_name();
        if (name) {
            let label = new St.Label({
                text: name,
                style_class: 'convergence-splash-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(label);
        }

        this._overlay.add_child(box);

        this._overlay.opacity = 0;
        Main.layoutManager.addTopChrome(this._overlay);
        this._overlay.ease({
            opacity: 255,
            duration: SPLASH_FADE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._windowCreatedId = global.display.connect('window-created',
            (_display, metaWindow) => {
                if (!this._pendingAppId) return;
                let tracker = Shell.WindowTracker.get_default();
                let windowApp = tracker.get_window_app(metaWindow);
                if (windowApp?.get_id() === this._pendingAppId) {
                    this.dismiss();
                    return;
                }
                let retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._retryIds?.delete(retryId);
                    if (!this._pendingAppId) return GLib.SOURCE_REMOVE;
                    let app2 = tracker.get_window_app(metaWindow);
                    if (app2?.get_id() === this._pendingAppId)
                        this.dismiss();
                    return GLib.SOURCE_REMOVE;
                });
                if (!this._retryIds) this._retryIds = new Set();
                this._retryIds.add(retryId);
            });

        this._focusAppId = Shell.WindowTracker.get_default().connect(
            'notify::focus-app', (tracker) => {
                if (!this._pendingAppId) return;
                let focusedApp = tracker.focus_app;
                if (focusedApp?.get_id() === this._pendingAppId)
                    this.dismiss();
            });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPLASH_TIMEOUT_MS, () => {
            this._timeoutId = 0;
            this.dismiss();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Fade out and destroy the splash overlay. */
    dismiss() {
        this._pendingAppId = null;

        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._focusAppId) {
            Shell.WindowTracker.get_default().disconnect(this._focusAppId);
            this._focusAppId = 0;
        }
        if (this._retryIds) {
            for (let id of this._retryIds)
                GLib.source_remove(id);
            this._retryIds.clear();
        }
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        let overlay = this._overlay;
        if (!overlay) return;
        this._overlay = null;

        overlay.ease({
            opacity: 0,
            duration: SPLASH_FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                Main.layoutManager.removeChrome(overlay);
                overlay.destroy();
            },
        });
    }

    destroy() {
        this.dismiss();
    }
}
