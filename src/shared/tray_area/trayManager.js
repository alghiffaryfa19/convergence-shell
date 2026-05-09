// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ── D-Bus interface definitions ──────────────────────────────────────

const DBUSMENU_IFACE = 'com.canonical.dbusmenu';

const SNI_WATCHER_IFACE = `<node>
<interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
        <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
        <arg name="service" type="s" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
        <arg type="s"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
        <arg type="s"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
</interface>
</node>`;

const SNI_ITEM_IFACE = `<node>
<interface name="org.kde.StatusNotifierItem">
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <method name="ContextMenu">
        <arg name="x" type="i" direction="in"/>
        <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Activate">
        <arg name="x" type="i" direction="in"/>
        <arg name="y" type="i" direction="in"/>
    </method>
</interface>
</node>`;

const SNI_ITEM_PROXY_WRAPPER = Gio.DBusProxy.makeProxyWrapper(SNI_ITEM_IFACE);

// ── Exported helpers ─────────────────────────────────────────────────

/**
 * Fetch menu items from a com.canonical.dbusmenu service.
 * @param {string} busName - D-Bus bus name
 * @param {string} menuPath - D-Bus object path for the menu
 * @param {function} callback - receives an array of menu item objects
 */
export function fetchDbusMenuItems(busName, menuPath, callback) {
    Gio.DBus.session.call(
        busName, menuPath, DBUSMENU_IFACE, 'GetLayout',
        new GLib.Variant('(iias)', [0, -1, [
            'type', 'label', 'enabled', 'visible', 'icon-name',
            'toggle-type', 'toggle-state', 'children-display',
        ]]),
        GLib.VariantType.new('(u(ia{sv}av))'),
        Gio.DBusCallFlags.NONE, 2000, null,
        (conn, res) => {
            try {
                let result = conn.call_finish(res);
                let layout = result.get_child_value(1);
                let items = parseDbusMenuLayout(layout);
                callback(items);
            } catch (_e) {
                callback([]);
            }
        },
    );
}

/**
 * Parse a dbusmenu layout variant into a flat list of items.
 * @param {GLib.Variant} layoutVariant - (ia{sv}av) layout
 * @returns {Array} parsed items
 */
function parseDbusMenuLayout(layoutVariant) {
    let items = [];
    let childrenVariant = layoutVariant.get_child_value(2);
    for (let i = 0; i < childrenVariant.n_children(); i++) {
        let childWrapper = childrenVariant.get_child_value(i).get_variant();
        let id = childWrapper.get_child_value(0).get_int32();
        let propsVariant = childWrapper.get_child_value(1);
        let props = {};
        let nProps = propsVariant.n_children();
        for (let j = 0; j < nProps; j++) {
            let entry = propsVariant.get_child_value(j);
            let key = entry.get_child_value(0).get_string()[0];
            let val = entry.get_child_value(1).get_variant();
            try {
                if (key === 'label')
                    props.label = val.get_string()[0];
                else if (key === 'enabled')
                    props.enabled = val.get_boolean();
                else if (key === 'visible')
                    props.visible = val.get_boolean();
                else if (key === 'type')
                    props.type = val.get_string()[0];
                else if (key === 'children-display')
                    props.childrenDisplay = val.get_string()[0];
                else if (key === 'toggle-type')
                    props.toggleType = val.get_string()[0];
                else if (key === 'toggle-state')
                    props.toggleState = val.get_int32();
                else if (key === 'icon-name')
                    props.iconName = val.get_string()[0];
            } catch (_e) {}
        }
        if (props.visible === false) continue;
        let subChildren = parseDbusMenuLayout(childWrapper);
        items.push({ id, props, children: subChildren });
    }
    return items;
}

/**
 * Create St.ImageContent from an SNI IconPixmap variant.
 * @param {GLib.Variant} pixmapVariant - a(iiay) pixmap array
 * @param {number} targetSize - desired icon size in pixels
 * @returns {Object|null} { content, width, height } or null
 */
export function createIconContentFromPixmap(pixmapVariant, targetSize) {
    if (!pixmapVariant) return null;
    let nChildren = pixmapVariant.n_children();
    if (nChildren === 0) return null;

    let bestIdx = 0, bestW = 0;
    for (let i = 0; i < nChildren; i++) {
        let entry = pixmapVariant.get_child_value(i);
        let w = entry.get_child_value(0).get_int32();
        if (w >= targetSize && (bestW === 0 || w < bestW || bestW < targetSize)) {
            bestW = w; bestIdx = i;
        } else if (bestW < targetSize && w > bestW) {
            bestW = w; bestIdx = i;
        }
    }

    let entry = pixmapVariant.get_child_value(bestIdx);
    let w = entry.get_child_value(0).get_int32();
    let h = entry.get_child_value(1).get_int32();
    let pixmapData = entry.get_child_value(2);
    let rowStride = w * 4;

    try {
        const Cogl = imports.gi.Cogl;
        let imageContent = new St.ImageContent({
            preferredWidth: w, preferredHeight: h,
        });
        let coglContext = [];
        let mutterBackend = global.stage?.context?.get_backend?.();
        if (imageContent.set_bytes.length === 6 && mutterBackend?.get_cogl_context)
            coglContext.push(mutterBackend.get_cogl_context());
        imageContent.set_bytes(...coglContext, pixmapData.get_data_as_bytes(),
            Cogl.PixelFormat.ARGB_8888, w, h, rowStride);
        return { content: imageContent, width: w, height: h };
    } catch (_e) {
        return null;
    }
}

// ── TrayManager ──────────────────────────────────────────────────────

/**
 * Shared tray manager — owns the SNI watcher bus name and tracks items.
 * Emits 'items-changed' whenever the set of tray items changes.
 * No UI — consumers (phone NotificationPanel, desktop DesktopTray) read
 * the items Map and build their own widgets.
 */
export class TrayManager {
    constructor() {
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._sniItems = null;
        this._sniNameWatches = [];
        this._sniWatcherOwnId = 0;
        this._sniWatcherExported = false;
        this._sniConnection = null;
        this._sniFallbackPolling = false;
        this._trayPollId = 0;
        this._trayLastKeys = null;
    }

    // ── Simple event emitter ─────────────────────────────────────────

    /**
     * Connect to a signal.
     * @param {string} signal - signal name (e.g. 'items-changed')
     * @param {function} cb - callback
     * @returns {number} connection id
     */
    connect(signal, cb) {
        let id = this._nextListenerId++;
        this._listeners.set(id, { signal, cb });
        return id;
    }

    /**
     * Disconnect a signal by id.
     * @param {number} id - connection id from connect()
     */
    disconnect(id) {
        this._listeners.delete(id);
    }

    /**
     * Emit a signal to all connected listeners.
     * @param {string} signal - signal name
     * @param {...*} args - arguments passed to callbacks
     */
    emit(signal, ...args) {
        for (let [, entry] of this._listeners) {
            if (entry.signal === signal) {
                try { entry.cb(...args); } catch (e) {
                    log(`[Convergence TrayManager] Signal '${signal}' handler error: ${e.message}`);
                }
            }
        }
    }

    // ── Public API ───────────────────────────────────────────────────

    /** The current Map of tray items (read-only for consumers). */
    get items() {
        return this._sniItems;
    }

    /** Whether fallback polling is active (AppIndicator extension owns the bus name). */
    get isFallbackMode() {
        return this._sniFallbackPolling;
    }

    /**
     * Enable the tray manager — start owning the SNI watcher bus name
     * and tracking items.
     */
    enable() {
        this._sniItems = new Map();
        this._sniNameWatches = [];

        this._sniWatcherDBusInfo = Gio.DBusNodeInfo.new_for_xml(SNI_WATCHER_IFACE);
        this._sniWatcherIfaceInfo = this._sniWatcherDBusInfo.interfaces[0];

        this._sniWatcherOwnId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.kde.StatusNotifierWatcher',
            Gio.BusNameOwnerFlags.NONE,
            // bus acquired
            (connection, _name) => {
                this._sniConnection = connection;
                try {
                    this._sniExportId = connection.register_object(
                        '/StatusNotifierWatcher',
                        this._sniWatcherIfaceInfo,
                        (conn, sender, path, iface, method, params, invocation) =>
                            this._onSniWatcherMethodCall(conn, sender, path, iface, method, params, invocation),
                        (conn, sender, path, iface, propName) =>
                            this._onSniWatcherGetProperty(conn, sender, path, iface, propName),
                        null,
                    );
                    this._sniWatcherExported = true;
                } catch (e) {
                    log(`[Convergence TrayManager] Failed to export SNI watcher: ${e.message}`);
                }
                // Emit HostRegistered so items know we're listening
                try {
                    connection.emit_signal(
                        null,
                        '/StatusNotifierWatcher',
                        'org.kde.StatusNotifierWatcher',
                        'StatusNotifierHostRegistered',
                        null,
                    );
                } catch (_) {}
            },
            // name acquired
            (_connection, _name) => {},
            // name lost — another watcher owns it; fall back to polling
            (_connection, _name) => {
                this._startFallbackPolling();
            },
        );
    }

    /**
     * Disable the tray manager — unown bus name, unexport, stop polling,
     * clear all items.
     */
    disable() {
        // Stop fallback polling
        if (this._trayPollId) {
            GLib.source_remove(this._trayPollId);
            this._trayPollId = 0;
        }
        this._sniFallbackPolling = false;

        // Unexport D-Bus object and unown bus name
        if (this._sniWatcherExported && this._sniConnection && this._sniExportId) {
            try {
                this._sniConnection.unregister_object(this._sniExportId);
            } catch (_) {}
            this._sniExportId = 0;
            this._sniWatcherExported = false;
        }

        if (this._sniWatcherOwnId) {
            Gio.bus_unown_name(this._sniWatcherOwnId);
            this._sniWatcherOwnId = 0;
        }

        // Unwatch all bus names
        if (this._sniNameWatches) {
            for (let wid of this._sniNameWatches) {
                try { Gio.DBus.session.unwatch_name(wid); } catch (_) {}
            }
            this._sniNameWatches = [];
        }

        // Clear item map
        if (this._sniItems) {
            this._sniItems.clear();
            this._sniItems = null;
        }

        this._sniConnection = null;
        this._trayLastKeys = null;
        this._listeners.clear();
    }

    // ── Internal D-Bus methods ───────────────────────────────────────

    _onSniWatcherMethodCall(_conn, sender, _path, _iface, method, params, invocation) {
        if (method === 'RegisterStatusNotifierItem') {
            let [service] = params.deep_unpack();
            let busName, objPath;

            if (service.startsWith('/')) {
                busName = sender;
                objPath = service;
            } else if (service.includes('/')) {
                let idx = service.indexOf('/');
                busName = service.substring(0, idx);
                objPath = service.substring(idx);
            } else {
                busName = service;
                objPath = '/StatusNotifierItem';
            }

            let itemId = `${busName}${objPath}`;

            if (!this._sniItems.has(itemId)) {
                this._registerSniItem(busName, objPath, itemId);
            }

            invocation.return_value(null);

            // Emit the registration signal
            try {
                this._sniConnection?.emit_signal(
                    null,
                    '/StatusNotifierWatcher',
                    'org.kde.StatusNotifierWatcher',
                    'StatusNotifierItemRegistered',
                    new GLib.Variant('(s)', [itemId]),
                );
            } catch (_) {}
        } else if (method === 'RegisterStatusNotifierHost') {
            invocation.return_value(null);
        } else {
            invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', `Unknown method ${method}`);
        }
    }

    _onSniWatcherGetProperty(_conn, _sender, _path, _iface, propName) {
        if (propName === 'RegisteredStatusNotifierItems') {
            return new GLib.Variant('as', [...this._sniItems.keys()]);
        } else if (propName === 'IsStatusNotifierHostRegistered') {
            return new GLib.Variant('b', true);
        } else if (propName === 'ProtocolVersion') {
            return new GLib.Variant('i', 0);
        }
        return null;
    }

    _registerSniItem(busName, objPath, itemId) {
        try {
            new SNI_ITEM_PROXY_WRAPPER(
                Gio.DBus.session,
                busName,
                objPath,
                (proxy, error) => {
                    if (error) {
                        log(`[Convergence TrayManager] Failed to create SNI proxy for ${itemId}: ${error.message}`);
                        return;
                    }

                    let nameWatchId = Gio.DBus.session.watch_name(
                        busName,
                        Gio.BusNameWatcherFlags.NONE,
                        null,
                        () => {
                            this._unregisterSniItem(itemId);
                        },
                    );

                    this._sniItems.set(itemId, {
                        busName, objPath, proxy, nameWatchId,
                        cachedPixmap: null,
                    });
                    this._sniNameWatches.push(nameWatchId);
                    // Delay to let proxy cache properties, then fetch pixmap
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        this._cachePixmap(itemId);
                        this.emit('items-changed');
                        return GLib.SOURCE_REMOVE;
                    });
                },
            );
        } catch (e) {
            log(`[Convergence TrayManager] Error registering SNI item ${itemId}: ${e.message}`);
        }
    }

    _unregisterSniItem(itemId) {
        let entry = this._sniItems.get(itemId);
        if (!entry) return;

        if (entry.nameWatchId) {
            Gio.DBus.session.unwatch_name(entry.nameWatchId);
            let idx = this._sniNameWatches.indexOf(entry.nameWatchId);
            if (idx >= 0) this._sniNameWatches.splice(idx, 1);
        }

        this._sniItems.delete(itemId);

        // Emit the unregistration signal
        try {
            this._sniConnection?.emit_signal(
                null,
                '/StatusNotifierWatcher',
                'org.kde.StatusNotifierWatcher',
                'StatusNotifierItemUnregistered',
                new GLib.Variant('(s)', [itemId]),
            );
        } catch (_) {}

        this.emit('items-changed');
    }

    /**
     * Fetch and cache the IconPixmap variant for an SNI item.
     * @param {string} itemId
     */
    _cachePixmap(itemId) {
        let entry = this._sniItems.get(itemId);
        if (!entry?.busName || !entry?.objPath) return;
        try {
            let result = Gio.DBus.session.call_sync(
                entry.busName, entry.objPath,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'IconPixmap']),
                GLib.VariantType.new('(v)'),
                Gio.DBusCallFlags.NONE, 1000, null);
            entry.cachedPixmap = result.get_child_value(0).get_variant();
        } catch (_) {
            entry.cachedPixmap = null;
        }
    }

    /**
     * Get an St.ImageContent for an item's icon at the given size.
     * Uses the cached pixmap variant, avoiding repeated D-Bus calls.
     * @param {string} itemId
     * @param {number} targetSize
     * @returns {{ content: St.ImageContent, width: number, height: number }|null}
     */
    getIconContent(itemId, targetSize) {
        let entry = this._sniItems.get(itemId);
        if (!entry) return null;

        // Check named icon first
        let iconName = '';
        try { iconName = entry.proxy?.IconName || ''; } catch (_) {}
        if (iconName) return { iconName };

        // Use cached pixmap
        if (entry.cachedPixmap)
            return createIconContentFromPixmap(entry.cachedPixmap, targetSize);

        // Fallback items from AppIndicator polling
        if (entry.fallbackIndicator) {
            let gicon = entry.gicon || null;
            let name = entry.iconName || '';
            if (gicon) return { gicon };
            if (name) return { iconName: name };
        }

        return null;
    }

    _startFallbackPolling() {
        if (this._sniFallbackPolling) return;
        this._sniFallbackPolling = true;
        this._trayPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._populateFallback();
            return GLib.SOURCE_CONTINUE;
        });
        this._populateFallback();
    }

    _populateFallback() {
        if (!this._sniItems) return;

        let trayItems = [];
        for (let [key, indicator] of Object.entries(Main.panel.statusArea)) {
            if (!key.startsWith('appindicator-')) continue;
            if (!indicator?.visible) continue;
            if (!indicator._icon) continue;
            let iconName = indicator._icon?.icon_name || indicator.iconName || '';
            let gicon = indicator._icon?.gicon || indicator.gicon || null;
            let title = indicator.accessible_name || indicator._indicator?.title || key.replace('appindicator-', '');
            if (!iconName && !gicon) continue;
            trayItems.push({ key, indicator, iconName, gicon, title });
        }

        let newKeys = trayItems.map(i => i.key).join(',');
        if (newKeys === this._trayLastKeys) return;
        this._trayLastKeys = newKeys;

        // Rebuild the fallback items in the map
        // First remove old fallback entries
        for (let [key, entry] of this._sniItems) {
            if (entry.fallbackIndicator) this._sniItems.delete(key);
        }

        // Add new fallback entries
        for (let item of trayItems) {
            this._sniItems.set(item.key, {
                busName: null,
                objPath: null,
                proxy: null,
                nameWatchId: 0,
                fallbackIndicator: item.indicator,
                iconName: item.iconName,
                gicon: item.gicon,
                title: item.title,
            });
        }

        this.emit('items-changed');
    }
}
