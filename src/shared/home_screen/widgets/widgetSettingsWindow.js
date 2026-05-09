// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { getWidgetDefinition } from './widgetFramework.js';
import { WidgetInstanceSettingsStore } from './widgetInstanceStore.js';

function _buildHelpers(store) {
    return {
        gtk: { Adw, Gtk, Gio, GLib },

        addSwitchPreference(group, options) {
            let row = new Adw.SwitchRow({
                title: options.title,
                subtitle: options.subtitle ?? '',
                active: !!options.getValue(),
            });
            row.connect('notify::active', () => {
                options.setValue(!!row.get_active());
            });
            group.add(row);
            return row;
        },

        addEntryPreference(group, options) {
            let row = new Adw.EntryRow({
                title: options.title,
                text: `${options.getValue() ?? ''}`,
                show_apply_button: true,
            });
            row.connect('apply', () => {
                options.setValue(row.get_text());
                store.reload();
            });
            group.add(row);
            return row;
        },

        addComboPreference(group, options) {
            let labels = options.options.map(option => option.label);
            let values = options.options.map(option => option.value);
            let row = new Adw.ComboRow({
                title: options.title,
                subtitle: options.subtitle ?? '',
                model: new Gtk.StringList({ strings: labels }),
            });
            let currentValue = options.getValue();
            let index = Math.max(0, values.indexOf(currentValue));
            row.set_selected(index >= 0 ? index : 0);
            row.connect('notify::selected', () => {
                let selectedValue = values[row.get_selected()] ?? values[0];
                options.setValue(selectedValue);
                store.reload();
            });
            group.add(row);
            return row;
        },
    };
}

export function createWidgetSettingsWindow({ settings, instanceId, transientFor = null }) {
    let store = instanceId ? new WidgetInstanceSettingsStore(settings, instanceId) : null;

    let window = new Adw.PreferencesWindow({
        transient_for: transientFor,
        modal: false,
        default_width: 560,
        default_height: 680,
        search_enabled: false,
    });

    let page = new Adw.PreferencesPage({
        title: 'Widget',
        icon_name: 'preferences-system-symbolic',
    });
    window.add(page);

    let infoGroup = new Adw.PreferencesGroup({ title: 'Widget Settings' });
    page.add(infoGroup);

    if (!instanceId) {
        infoGroup.description = 'No widget instance id was provided.';
        return window;
    }

    let widgetItem = store?.widgetItem ?? null;
    if (!widgetItem) {
        infoGroup.description = 'This widget instance could not be found. It may have been removed from the home screen.';
        return window;
    }

    let def = getWidgetDefinition(widgetItem.widgetType, { allowMissing: true });
    window.title = `${def?.label ?? widgetItem.widgetType} Settings`;
    infoGroup.title = def?.label ?? 'Widget';
    infoGroup.description = def?.description ?? widgetItem.widgetType;
    infoGroup.add(new Adw.ActionRow({
        title: 'Widget Type',
        subtitle: widgetItem.widgetType,
    }));
    infoGroup.add(new Adw.ActionRow({
        title: 'Instance ID',
        subtitle: widgetItem.instanceId,
    }));

    let helpers = _buildHelpers(store);

    if (def?.buildInstanceSettings) {
        def.buildInstanceSettings({
            window,
            page,
            settings,
            store,
            widgetItem,
            helpers,
        });
    } else {
        let group = new Adw.PreferencesGroup({
            title: 'No Custom Settings',
            description: 'This widget does not currently expose custom instance settings.',
        });
        page.add(group);
    }

    return window;
}

export function openWidgetSettingsWindow(options) {
    let window = createWidgetSettingsWindow(options);
    window.present();
    return window;
}
