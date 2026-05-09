// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { populateDbusMenu, populateFallbackMenu } from '../../shared/tray_area/trayInputHandler.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';

/**
 * DesktopTray — creates PanelMenu.Button icons in the GNOME top panel
 * for each tray item tracked by the shared TrayManager.
 */
export class DesktopTray {
    /**
     * @param {Gio.Settings|null} settings - extension settings
     * @param {TrayManager} trayManager - shared tray manager instance
     */
    constructor(settings, trayManager) {
        this._settings = settings;
        this._trayManager = trayManager;
        this._panelIds = [];
        this._runtimeDisposer = new RuntimeDisposer();

        if (this._trayManager) {
            this._runtimeDisposer.connect(this._trayManager, 'items-changed',
                () => this._rebuild());
        }

        if (this._settings) {
            try {
                this._runtimeDisposer.connect(
                    this._settings,
                    'changed::desktop-tray-enabled', () => this._rebuild());
            } catch (_) {}
        }

        // Initial build
        this._rebuild();
    }

    _isEnabled() {
        try {
            return this._settings?.get_boolean('desktop-tray-enabled') ?? true;
        } catch (_) {
            return true;
        }
    }

    _rebuild() {
        // Remove all existing panel icons
        this._removeAllPanelIcons();

        if (!this._isEnabled()) return;
        if (!this._trayManager?.items) return;

        for (let [itemId, entry] of this._trayManager.items) {
            // Skip appindicator fallback items — AppIndicator already shows them
            if (this._trayManager.isFallbackMode && itemId.startsWith('appindicator-'))
                continue;

            let sanitizedId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
            let panelId = `convergence-tray-${sanitizedId}`;

            let button = new PanelMenu.Button(0.0, panelId, false);

            let iconInfo = this._trayManager.getIconContent(itemId, 16);
            let iconWidget;
            if (iconInfo?.iconName) {
                iconWidget = new St.Icon({ icon_name: iconInfo.iconName, icon_size: 16 });
            } else if (iconInfo?.gicon) {
                iconWidget = new St.Icon({ gicon: iconInfo.gicon, icon_size: 16 });
            } else if (iconInfo?.content) {
                iconWidget = new St.Icon();
                iconWidget.set({
                    content: iconInfo.content,
                    width: 16, height: 16,
                    contentGravity: Clutter.ContentGravity.RESIZE_ASPECT,
                });
            } else {
                iconWidget = new St.Icon({
                    icon_name: 'application-x-executable-symbolic',
                    icon_size: 16,
                });
            }

            button.add_child(iconWidget);

            // Let PanelMenu.Button handle click/hover natively so GNOME's
            // panel menu manager can auto-switch between open menus.
            // We just populate the menu content when it opens.
            // Add a placeholder so the menu isn't empty on first click
            // (PanelMenu won't open an empty menu).
            button.menu.addMenuItem(new PopupMenu.PopupMenuItem('Loading…'));

            if (entry.fallbackIndicator) {
                let indicator = entry.fallbackIndicator;
                button.menu.connect('open-state-changed', (_menu, isOpen) => {
                    if (!isOpen) return;
                    populateFallbackMenu(button.menu, indicator);
                });
            } else {
                let busName = entry.busName;
                let menuPath = '';
                try { menuPath = entry.proxy?.Menu || ''; } catch (_) {}

                if (menuPath) {
                    button.menu.connect('open-state-changed', (_menu, isOpen) => {
                        if (!isOpen) return;
                        populateDbusMenu(button.menu, busName, menuPath);
                    });
                }
            }

            try {
                Main.panel.addToStatusArea(panelId, button, 1, 'right');
                this._panelIds.push(panelId);
            } catch (e) {
                log(`[Convergence DesktopTray] Failed to add ${panelId}: ${e.message}`);
                try { button.destroy(); } catch (_) {}
            }
        }
    }

    _removeAllPanelIcons() {
        for (let panelId of this._panelIds) {
            let existing = Main.panel.statusArea[panelId];
            if (existing) {
                try { existing.destroy(); } catch (_) {}
            }
        }
        this._panelIds = [];
    }

    destroy() {
        this._runtimeDisposer?.dispose?.();
        this._removeAllPanelIcons();
        this._runtimeDisposer = null;
        this._trayManager = null;
        this._settings = null;
    }
}
