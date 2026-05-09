// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';

const PANEL_ID = 'convergence-desktop-notif-icons';
const NOTIF_ICON_SIZE = 16;
const NOTIF_FALLBACK_ICON = 'notification-symbolic';
const DEFAULT_MAX_ICONS = 5;
const SYNC_DEBOUNCE_MS = 100;

/**
 * DesktopNotifIcons — adds notification source icons to the GNOME top panel
 * in desktop mode, mirroring the phone status bar's notification icon feature.
 */
export class DesktopNotifIcons {
    /**
     * @param {Gio.Settings|null} settings - extension settings
     * @param {function|null} onActivate - callback when the icon area is clicked
     */
    constructor(settings, onActivate = null) {
        this._settings = settings;
        this._onActivate = onActivate;
        this._runtimeDisposer = new RuntimeDisposer();
        this._notifIconMap = new Map();
        this._notifIconSourceTracked = null;
        this._notifIconSyncQueued = false;
        this._panelButton = null;
        this._iconBox = null;

        this._buildPanelButton();
        this._setupNotifIconTracking();
        this._setupSettingsTracking();
    }

    _buildPanelButton() {
        this._panelButton = new PanelMenu.Button(0.0, PANEL_ID, true);
        // Disable the built-in menu — clicks are handled by the activate callback.
        this._panelButton.menu?.close?.();
        this._panelButton.menu?.actor?.hide?.();

        this._panelButton.connect('event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.BUTTON_RELEASE ||
                type === Clutter.EventType.TOUCH_END) {
                this._onActivate?.();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._iconBox = new St.BoxLayout({
            style_class: 'convergence-desktop-notif-icons',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelButton.add_child(this._iconBox);

        // Place in the right box, to the left of tray area items.
        // Position 0 = leftmost in the right box (before tray icons and QS).
        try {
            Main.panel.addToStatusArea(PANEL_ID, this._panelButton, 0, 'right');
        } catch (e) {
            log(`[Convergence DesktopNotifIcons] Failed to add panel button: ${e.message}`);
        }
    }

    // ── Notification tracking (mirrors phone statusBar logic) ────────

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
            SYNC_DEBOUNCE_MS,
            () => {
                this._notifIconSyncTimeoutId = 0;
                this._notifIconSyncQueued = false;
                this._syncNotifIcons();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _syncNotifIcons() {
        let container = this._iconBox;
        if (!container) return;

        let tray = Main.messageTray;
        if (!tray) return;

        let activeEntries = [];
        let sources = tray.getSources?.() ?? [];
        for (let source of sources) {
            let notifications = source.notifications ?? [];
            if (notifications.length === 0) continue;

            let iconName = null;
            try { iconName = source.icon?.to_string?.() ?? null; } catch (_e) {}
            if (!iconName) {
                let latest = notifications[notifications.length - 1];
                try { iconName = latest?.gicon?.to_string?.() ?? null; } catch (_e) {}
            }
            if (!iconName) {
                try {
                    iconName = source.app?.get_icon?.()?.to_string?.() ?? null;
                } catch (_e) {}
            }
            if (!iconName) iconName = NOTIF_FALLBACK_ICON;
            activeEntries.push({source, iconName});
        }

        let maxIcons = DEFAULT_MAX_ICONS;
        try {
            let settingsMax = this._settings?.get_int('desktop-max-notification-icons');
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
                    style_class: 'convergence-desktop-notif-icon',
                    icon_name: entry.iconName,
                    icon_size: NOTIF_ICON_SIZE,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                newMap.set(entry.source, icon);
                container.add_child(icon);
            }
        }

        if (overflow) {
            let more = new St.Label({
                style_class: 'convergence-desktop-notif-overflow',
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

        // Hide the panel button entirely when there are no notifications.
        if (this._panelButton) {
            if (activeEntries.length === 0)
                this._panelButton.hide();
            else
                this._panelButton.show();
        }
    }

    // ── Settings ─────────────────────────────────────────────────────

    _setupSettingsTracking() {
        if (!this._settings) return;
        try {
            if (this._settings.settings_schema?.has_key?.('desktop-max-notification-icons')) {
                this._runtimeDisposer.connect(this._settings,
                    'changed::desktop-max-notification-icons', () => this._syncNotifIcons());
            }
        } catch (_e) {}
    }

    // ── Teardown ─────────────────────────────────────────────────────

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

    destroy() {
        this._teardownNotifIconTracking();
        this._runtimeDisposer?.dispose?.();

        for (let [, icon] of this._notifIconMap) {
            if (icon.get_parent()) icon.get_parent().remove_child(icon);
            icon.destroy();
        }
        this._notifIconMap.clear();

        let existing = Main.panel.statusArea[PANEL_ID];
        if (existing) {
            try { existing.destroy(); } catch (_) {}
        }
        this._panelButton = null;
        this._iconBox = null;
        this._onActivate = null;
        this._runtimeDisposer = null;
        this._settings = null;
    }
}
