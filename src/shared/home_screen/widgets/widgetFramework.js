// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';

const _SKIP_MODULES = new Set([
    'widgetFramework.js',
    'widgetCatalog.js',
    'widgetInstanceStore.js',
    'widgetSettingsWindow.js',
]);

function _isWidgetDefinition(value) {
    return !!value &&
        typeof value === 'object' &&
        typeof value.widgetType === 'string' &&
        value.widgetType.length > 0 &&
        typeof value.defaultColSpan === 'number' &&
        typeof value.defaultRowSpan === 'number';
}

function _collectModuleDefinitions(module, moduleName) {
    let defs = [];
    for (let [exportName, value] of Object.entries(module)) {
        if (!_isWidgetDefinition(value))
            continue;
        defs.push({
            def: Object.freeze(value),
            exportName,
            moduleName,
        });
    }
    defs.sort((a, b) => a.exportName.localeCompare(b.exportName));
    return defs;
}

async function _loadDefinitions() {
    let here = Gio.File.new_for_uri(import.meta.url);
    let dir = here.get_parent();
    let enumerator = dir.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE,
        null
    );

    let moduleNames = [];
    try {
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            let name = info.get_name();
            if (!name.endsWith('Widget.js') || _SKIP_MODULES.has(name))
                continue;
            moduleNames.push(name);
        }
    } finally {
        enumerator.close(null);
    }

    moduleNames.sort((a, b) => a.localeCompare(b));

    let definitions = [];
    let defsByType = new Map();

    for (let moduleName of moduleNames) {
        let child = dir.get_child(moduleName);
        let module;
        try {
            module = await import(child.get_uri());
        } catch (error) {
            console.error(`Failed to load widget module ${moduleName}: ${error}`);
            continue;
        }

        for (let { def, exportName } of _collectModuleDefinitions(module, moduleName)) {
            if (defsByType.has(def.widgetType)) {
                console.error(`Skipping duplicate widget type ${def.widgetType} from ${moduleName}:${exportName}`);
                continue;
            }
            defsByType.set(def.widgetType, def);
            definitions.push(def);
        }
    }

    return {
        definitions,
        defsByType,
    };
}

const { definitions: _DEFINITIONS, defsByType: _DEFS_BY_TYPE } = await _loadDefinitions();

class MissingWidgetInstance {
    constructor(widgetType, runtimeEnv) {
        this._widgetType = widgetType;
        this._runtimeEnv = runtimeEnv ?? null;
    }

    buildContent(w, h) {
        let St = this._runtimeEnv?.St ?? null;
        let Clutter = this._runtimeEnv?.Clutter ?? null;
        if (!St || !Clutter)
            throw new Error(`Missing widget placeholder requires shell env for ${this._widgetType}`);

        let wrapper = new St.Widget({
            x_expand: true,
            y_expand: true,
            width: w,
            height: h,
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            style: 'border-radius: 16px;',
        });
        wrapper.add_child(new St.Widget({
            x_expand: true,
            y_expand: true,
            style: 'background-color: rgba(70, 20, 20, 0.72); border: 1px solid rgba(255, 150, 150, 0.24); border-radius: 16px;',
        }));
        let content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 12px;',
        });
        content.add_child(new St.Label({
            text: 'Missing Widget',
            style: 'color: rgba(255,255,255,0.92); font-size: 14px; font-weight: 600;',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        content.add_child(new St.Label({
            text: this._widgetType,
            style: 'color: rgba(255,210,210,0.78); font-size: 11px; margin-top: 4px;',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        wrapper.add_child(content);
        return wrapper;
    }

    destroy() {}
}

class StaticPreviewWidgetInstance {
    constructor(definition, settings, runtimeEnv) {
        this._definition = definition;
        this._settings = settings ?? null;
        this._runtimeEnv = runtimeEnv ?? null;
    }

    buildContent(w, h, colSpan, rowSpan, monitor, gridMetrics, runtimeEnv) {
        let St = (runtimeEnv ?? this._runtimeEnv)?.St ?? null;
        let Clutter = (runtimeEnv ?? this._runtimeEnv)?.Clutter ?? null;
        if (!St || !Clutter)
            throw new Error(`Static preview widget requires shell env for ${this._definition.widgetType}`);

        let wrapper = new St.Widget({
            x_expand: true,
            y_expand: true,
            width: w,
            height: h,
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            style: 'border-radius: 16px;',
        });
        let preview = this._definition.buildPreview?.({
            settings: this._settings,
            runtimeEnv: runtimeEnv ?? this._runtimeEnv,
            definition: this._definition,
            gridMetrics: gridMetrics ?? null,
        });
        if (preview) {
            preview.x_expand = true;
            preview.y_expand = true;
            wrapper.add_child(preview);
        }
        return wrapper;
    }

    destroy() {
        this._definition = null;
        this._settings = null;
        this._runtimeEnv = null;
    }
}

function _createMissingDefinition(widgetType) {
    return {
        widgetType,
        label: widgetType,
        description: 'Missing widget module',
        defaultColSpan: 2,
        defaultRowSpan: 1,
        minColSpan: 1,
        minRowSpan: 1,
        missing: true,
        supportsResize: true,
        createInstance({ runtimeEnv }) {
            return new MissingWidgetInstance(widgetType, runtimeEnv);
        },
    };
}

export function getWidgetDefinitions() {
    return [..._DEFINITIONS];
}

export function getWidgetCatalog() {
    return getWidgetDefinitions().map(def => ({
        widgetType: def.widgetType,
        label: def.label,
        defaultColSpan: def.defaultColSpan,
        defaultRowSpan: def.defaultRowSpan,
        minColSpan: def.minColSpan ?? 1,
        minRowSpan: def.minRowSpan ?? 1,
        maxColSpan: def.maxColSpan,
        maxRowSpan: def.maxRowSpan,
        description: def.description ?? '',
        unique: !!def.unique,
    }));
}

export function getWidgetDefinition(widgetType, options = {}) {
    let def = _DEFS_BY_TYPE.get(widgetType) ?? null;
    if (def || !options.allowMissing)
        return def;
    return _createMissingDefinition(widgetType);
}

export function createWidgetInstance(widgetType, settings, widgetItem, runtimeEnv = null) {
    let def = getWidgetDefinition(widgetType, { allowMissing: true });
    if (def?.createInstance)
        return def.createInstance({ settings, widgetItem, runtimeEnv, definition: def });
    if (def?.buildPreview)
        return new StaticPreviewWidgetInstance(def, settings, runtimeEnv);
    return null;
}

export function buildWidgetPreview(widgetType, settings, runtimeEnv = null) {
    let def = getWidgetDefinition(widgetType, { allowMissing: true });
    if (def?.buildPreview)
        return def.buildPreview({ settings, runtimeEnv, definition: def });
    return createWidgetInstance(widgetType, settings, null, runtimeEnv)?.buildContent?.(180, 100) ?? null;
}

export function getWidgetSizeLimits(widgetType, maxCols) {
    let def = getWidgetDefinition(widgetType, { allowMissing: true });
    return {
        minColSpan: def?.minColSpan || 1,
        minRowSpan: def?.minRowSpan || 1,
        maxColSpan: def?.maxColSpan ?? (maxCols || 5),
        maxRowSpan: def?.maxRowSpan ?? 4,
    };
}

export function buildWidgetPreferenceSections(context) {
    for (let def of getWidgetDefinitions())
        def.buildPreferences?.(context);
}
