// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SETTINGS_SCHEMA_ID = 'org.gnome.shell.extensions.convergence';
const HOME_LAYOUT_KEY = 'home-screen-layout';

function _clone(value) {
    if (value == null)
        return value;
    return JSON.parse(JSON.stringify(value));
}

function _createEmptyLayoutRoot() {
    return {
        __version: 2,
        monitors: {},
    };
}

function _normalizeLayoutRoot(root) {
    if (!root || typeof root !== 'object')
        return _createEmptyLayoutRoot();

    if (root.__version === 2) {
        if (!root.monitors || typeof root.monitors !== 'object')
            root.monitors = {};
        return root;
    }

    if (Array.isArray(root.items)) {
        return {
            __version: 2,
            monitors: {
                legacy: {
                    cols: root.cols ?? 5,
                    activePage: root.activePage ?? 0,
                    items: root.items,
                },
            },
        };
    }

    return _createEmptyLayoutRoot();
}

function _parseLayoutString(json) {
    try {
        return _normalizeLayoutRoot(json ? JSON.parse(json) : null);
    } catch (_error) {
        return _createEmptyLayoutRoot();
    }
}

function _randomSuffix() {
    return Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
}

export function ensureWidgetInstanceId(widgetItem) {
    if (!widgetItem || widgetItem.type !== 'widget')
        return null;
    if (typeof widgetItem.instanceId === 'string' && widgetItem.instanceId.length > 0)
        return widgetItem.instanceId;
    widgetItem.instanceId = GLib.uuid_string_random?.() ??
        `widget-${GLib.get_real_time()}-${_randomSuffix()}`;
    return widgetItem.instanceId;
}

export function getWidgetPreferences(widgetItem) {
    return widgetItem?.widgetData?.preferences ?? null;
}

export function getWidgetPreference(widgetItem, key, fallbackValue = null) {
    let prefs = getWidgetPreferences(widgetItem);
    if (!prefs || !(key in prefs))
        return fallbackValue;
    return prefs[key];
}

export function setWidgetPreference(widgetItem, key, value) {
    if (!widgetItem)
        return;
    if (!widgetItem.widgetData || typeof widgetItem.widgetData !== 'object')
        widgetItem.widgetData = {};
    if (!widgetItem.widgetData.preferences || typeof widgetItem.widgetData.preferences !== 'object')
        widgetItem.widgetData.preferences = {};
    widgetItem.widgetData.preferences[key] = value;
}

export function createExtensionSettings(extensionDir) {
    let schemaSource = Gio.SettingsSchemaSource.get_default();
    if (extensionDir) {
        let schemaDir = GLib.build_filenamev([extensionDir, 'schemas']);
        let schemaFile = Gio.File.new_for_path(schemaDir);
        if (schemaFile.query_exists(null))
            schemaSource = Gio.SettingsSchemaSource.new_from_directory(schemaDir, schemaSource, false);
    }

    let schema = schemaSource.lookup(SETTINGS_SCHEMA_ID, true);
    if (!schema)
        throw new Error(`Missing settings schema ${SETTINGS_SCHEMA_ID}`);

    return new Gio.Settings({ settings_schema: schema });
}

export function parseHomeLayout(settings) {
    return _parseLayoutString(settings?.get_string?.(HOME_LAYOUT_KEY) ?? '');
}

export function serializeHomeLayout(root) {
    return JSON.stringify(_normalizeLayoutRoot(_clone(root)));
}

export function visitWidgetInstances(root, visitor) {
    let normalized = _normalizeLayoutRoot(root);
    for (let [monitorKey, monitorData] of Object.entries(normalized.monitors ?? {})) {
        if (!Array.isArray(monitorData?.items))
            continue;
        for (let item of monitorData.items) {
            if (item?.type !== 'widget')
                continue;
            visitor(item, monitorKey, monitorData, normalized);
        }
    }
}

export function findWidgetInstance(root, instanceId) {
    if (!instanceId)
        return null;

    let found = null;
    visitWidgetInstances(root, (item, monitorKey, monitorData, normalized) => {
        if (found || item.instanceId !== instanceId)
            return;
        found = {
            item,
            monitorKey,
            monitorData,
            root: normalized,
        };
    });
    return found;
}

export function getWidgetInstanceRecord(settings, instanceId) {
    let root = parseHomeLayout(settings);
    let record = findWidgetInstance(root, instanceId);
    if (!record)
        return null;
    return {
        item: _clone(record.item),
        monitorKey: record.monitorKey,
        monitorData: _clone(record.monitorData),
        root,
    };
}

export function updateWidgetInstance(settings, instanceId, updater) {
    let root = parseHomeLayout(settings);
    let record = findWidgetInstance(root, instanceId);
    if (!record)
        return false;

    updater(record.item, record.monitorKey, record.monitorData, root);
    settings.set_string(HOME_LAYOUT_KEY, serializeHomeLayout(root));
    return true;
}

export class WidgetInstanceSettingsStore {
    constructor(settings, instanceId) {
        this._settings = settings;
        this._instanceId = instanceId;
        this.reload();
    }

    reload() {
        this._record = getWidgetInstanceRecord(this._settings, this._instanceId);
        return this._record;
    }

    get instanceId() {
        return this._instanceId;
    }

    get widgetItem() {
        return this._record?.item ?? null;
    }

    get widgetType() {
        return this.widgetItem?.widgetType ?? null;
    }

    getPreference(key, fallbackValue = null) {
        return getWidgetPreference(this.widgetItem, key, fallbackValue);
    }

    setPreference(key, value) {
        let changed = updateWidgetInstance(this._settings, this._instanceId, item => {
            setWidgetPreference(item, key, value);
        });
        if (changed)
            this.reload();
        return changed;
    }

    updatePreferences(mutator) {
        let changed = updateWidgetInstance(this._settings, this._instanceId, item => {
            if (!item.widgetData || typeof item.widgetData !== 'object')
                item.widgetData = {};
            if (!item.widgetData.preferences || typeof item.widgetData.preferences !== 'object')
                item.widgetData.preferences = {};
            mutator(item.widgetData.preferences, item);
        });
        if (changed)
            this.reload();
        return changed;
    }
}
