// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { fetchDbusMenuItems } from './trayManager.js';

const DBUSMENU_IFACE = 'com.canonical.dbusmenu';

/**
 * Shared tray icon input handling.
 *
 * Provides common click/tap behaviour for tray icons regardless of
 * where they are rendered (top panel, notification panel, or any
 * future location).
 *
 * - Left click / tap:  Activate the item (opens the app)
 * - Right click / long-press:  Open the context menu (dbusmenu)
 *
 * For fallback AppIndicator items the context menu is read from the
 * indicator's own PopupMenu.  For SNI items it is fetched via the
 * com.canonical.dbusmenu D-Bus interface.
 */

/**
 * Call the SNI Activate method on a tray item.
 * @param {string} busName
 * @param {string} objPath
 * @param {number} x - stage x coordinate
 * @param {number} y - stage y coordinate
 */
export function activateSniItem(busName, objPath, x, y) {
    Gio.DBus.session.call(busName, objPath,
        'org.kde.StatusNotifierItem', 'Activate',
        new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

/**
 * Fetch and populate a PopupMenu from a dbusmenu service.
 * @param {PopupMenu.PopupMenu} menu - target menu to populate
 * @param {string} busName
 * @param {string} menuPath
 * @param {function|null} onComplete - called after items are populated
 */
export function populateDbusMenu(menu, busName, menuPath, onComplete = null) {
    menu.removeAll();
    fetchDbusMenuItems(busName, menuPath, (items) => {
        _addDbusMenuItems(menu, items, busName, menuPath);
        if (onComplete) onComplete();
    });
}

function _addDbusMenuItems(menu, items, busName, menuPath) {
    for (let item of items) {
        let p = item.props;
        if (p.type === 'separator') {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            continue;
        }
        let label = (p.label || '').replace(/_([A-Za-z])/, '$1');
        if (!label && !p.iconName) continue;

        if (item.children?.length > 0 || p.childrenDisplay === 'submenu') {
            let sub = new PopupMenu.PopupSubMenuMenuItem(label || '');
            if (p.enabled === false) sub.setSensitive(false);
            _addDbusMenuItems(sub.menu, item.children ?? [], busName, menuPath);
            menu.addMenuItem(sub);
        } else {
            let menuItem = new PopupMenu.PopupMenuItem(label || '');

            // Icon
            if (p.iconName) {
                try {
                    menuItem._icon = new St.Icon({
                        icon_name: p.iconName, icon_size: 16,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    menuItem.insert_child_at_index(menuItem._icon, 1);
                } catch (_e) {}
            }

            // Toggle ornament
            if (p.toggleType === 'checkmark')
                menuItem.setOrnament(p.toggleState
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            else if (p.toggleType === 'radio')
                menuItem.setOrnament(p.toggleState
                    ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

            // Disabled items shown greyed out instead of hidden
            if (p.enabled === false) menuItem.setSensitive(false);

            let itemId = item.id;
            menuItem.connect('activate', () => {
                Gio.DBus.session.call(
                    busName, menuPath, DBUSMENU_IFACE, 'Event',
                    new GLib.Variant('(isvu)', [itemId, 'clicked',
                        new GLib.Variant('s', ''), 0]),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
            });
            menu.addMenuItem(menuItem);
        }
    }
}

/**
 * Copy menu items from a fallback AppIndicator's PopupMenu into a
 * target PopupMenu (e.g. a PanelMenu.Button's menu).
 * @param {PopupMenu.PopupMenu} targetMenu
 * @param {object} indicator - the fallback AppIndicator instance
 */
export function populateFallbackMenu(targetMenu, indicator) {
    targetMenu.removeAll();
    if (!indicator?.menu) return;
    let srcItems = indicator.menu._getMenuItems?.() ?? [];
    for (let srcItem of srcItems) {
        if (srcItem instanceof PopupMenu.PopupSeparatorMenuItem) {
            targetMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            continue;
        }
        let label = srcItem.label?.text || '';
        if (!label) continue;
        let menuItem = new PopupMenu.PopupMenuItem(label);
        menuItem.connect('activate', () => {
            try { srcItem.emit('activate', null); } catch (_e) {
                try { srcItem.activate(null); } catch (_e2) {}
            }
        });
        targetMenu.addMenuItem(menuItem);
    }
}

/**
 * Wire up input handlers on a button for a tray entry.
 *
 * Works with any St.Button or PanelMenu.Button. The caller provides
 * callbacks for activating the item and opening/populating the menu.
 *
 * @param {St.Button} button - the clickable button widget
 * @param {object} entry - tray manager entry
 * @param {object} opts
 * @param {function} opts.onMenu - called on any click/tap (opens context menu)
 */
export function connectTrayInput(button, entry, { onMenu, haptics = null }) {
    // All clicks and taps open the context menu.
    button.connect('button-press-event', (_a, event) => {
        let btn = event.get_button();
        if (btn === 1 || btn === 3) {
            haptics?.vibrate(10);
            onMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    button.connect('touch-event', (_a, event) => {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
            haptics?.vibrate(10);
            onMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
}
