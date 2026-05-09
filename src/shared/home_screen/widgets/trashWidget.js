// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

function _requireShellEnv(runtimeEnv) {
    let St = runtimeEnv?.St ?? null;
    let Clutter = runtimeEnv?.Clutter ?? null;
    if (!St || !Clutter)
        throw new Error('Trash widget requires shell runtime env');
    return { St, Clutter };
}

function _openTrash(runtimeEnv) {
    try {
        runtimeEnv?.Gio?.AppInfo?.launch_default_for_uri?.('trash:///', null);
        return true;
    } catch (_e) {
        let appSystem = runtimeEnv?.Shell?.AppSystem?.get_default?.() ?? null;
        let files = appSystem?.lookup_app?.('org.gnome.Nautilus.desktop') ||
            appSystem?.lookup_app?.('nautilus.desktop');
        if (files) {
            files.activate();
            return true;
        }
    }
    return false;
}

export const TRASH_WIDGET_DEFINITION = {
    widgetType: 'trash',
    label: 'Recycle Bin',
    description: 'Open or empty the trash',
    defaultColSpan: 1,
    defaultRowSpan: 1,
    minColSpan: 1,
    minRowSpan: 1,
    maxColSpan: 1,
    maxRowSpan: 1,
    unique: true,
    interactionStyle: 'icon',
    supportsResize: false,

    buildPreview({ settings, runtimeEnv, gridMetrics }) {
        let { St, Clutter } = _requireShellEnv(runtimeEnv);
        let Gio = runtimeEnv?.Gio;

        // Use grid metrics to match app icon dimensions
        let iconSize = gridMetrics?.iconSize ?? 48;
        let labelFontSize = gridMetrics?.labelFontSize ?? 11;
        let labelMarginTop = gridMetrics?.labelMarginTop ?? 4;
        let labelMaxHeight = gridMetrics?.labelMaxHeight ?? 30;
        let labelPadH = gridMetrics?.labelPadH ?? 4;

        // Determine if trash is empty or full
        let isEmpty = true;
        try {
            let trashDir = Gio?.File?.new_for_uri?.('trash:///');
            let enumerator = trashDir?.enumerate_children?.('standard::*', 0, null);
            if (enumerator?.next_file?.(null)) isEmpty = false;
            enumerator?.close?.(null);
        } catch (_e) {}

        // Use custom icon from settings, or themed default
        let iconName;
        try {
            if (isEmpty)
                iconName = settings?.get_string?.('widget-trash-icon-empty') || '';
            else
                iconName = settings?.get_string?.('widget-trash-icon-full') || '';
        } catch (_e) {}
        if (!iconName)
            iconName = isEmpty ? 'user-trash' : 'user-trash-full';

        let box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: iconSize,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: 'Recycle Bin',
            style: `font-size: ${labelFontSize}px; margin-top: ${labelMarginTop}px; min-height: ${labelMaxHeight}px; padding: 0 ${labelPadH}px; color: rgba(255,255,255,0.78);`,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    },

    onActivate({ runtimeEnv }) {
        return _openTrash(runtimeEnv);
    },

    populateWidgetMenu({ menu, addMenuItem, runtimeEnv }) {
        addMenuItem(menu, 'Open Recycle Bin', () => {
            _openTrash(runtimeEnv);
        });
    },

    buildPreferences({ settings, hasKey, page, helpers, window }) {
        let { Adw } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'Recycle Bin Widget',
            description: 'Customize the recycle bin widget icons',
        });

        let added = false;
        if (hasKey('widget-trash-icon-empty')) {
            group.add(helpers.createIconChooserRow(settings, 'widget-trash-icon-empty', window, {
                title: 'Empty icon',
                defaultIcon: 'user-trash',
            }));
            added = true;
        }

        if (hasKey('widget-trash-icon-full')) {
            group.add(helpers.createIconChooserRow(settings, 'widget-trash-icon-full', window, {
                title: 'Full icon',
                defaultIcon: 'user-trash-full',
            }));
            added = true;
        }

        if (added)
            page.add(group);
    },
};
