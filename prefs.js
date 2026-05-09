// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { buildWidgetPreferenceSections } from './src/shared/home_screen/widgets/widgetFramework.js';
import { openWidgetSettingsWindow } from './src/shared/home_screen/widgets/widgetSettingsWindow.js';

// --- Icon chooser infrastructure ---

const IconDataItem = GObject.registerClass({
    Properties: {
        'display-name': GObject.ParamSpec.string(
            'display-name', '', '', GObject.ParamFlags.READWRITE, ''),
        'icon-string': GObject.ParamSpec.string(
            'icon-string', '', '', GObject.ParamFlags.READWRITE, ''),
    },
}, class IconDataItem extends GObject.Object {});

let _iconCachePromise = null;
function _getSystemIcons() {
    if (_iconCachePromise)
        return _iconCachePromise;
    _iconCachePromise = new Promise(resolve => {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const display = Gdk.Display.get_default();
            const theme = Gtk.IconTheme.get_for_display(display);
            const names = [...new Set(theme.get_icon_names())].sort();
            resolve(names);
            return GLib.SOURCE_REMOVE;
        });
    });
    return _iconCachePromise;
}
function _clearIconCache() {
    _iconCachePromise = null;
}

const IconChooserDialog = GObject.registerClass({
    Signals: { 'response': { param_types: [GObject.TYPE_INT] } },
}, class IconChooserDialog extends Adw.Window {
    _init(parent) {
        super._init({
            modal: true,
            transient_for: parent,
            default_width: 520,
            default_height: 580,
            title: 'Choose Icon',
        });
        this._iconString = '';
        this._filterMode = 'all';
        this._searchDelay = 0;

        const toolbarView = new Adw.ToolbarView();
        this.set_content(toolbarView);

        const headerBar = new Adw.HeaderBar();
        const cancelBtn = new Gtk.Button({ label: 'Cancel' });
        cancelBtn.connect('clicked', () => this.close());
        headerBar.pack_start(cancelBtn);
        const selectBtn = new Gtk.Button({
            label: 'Select',
            css_classes: ['suggested-action'],
            sensitive: false,
        });
        selectBtn.connect('clicked', () => {
            this.emit('response', Gtk.ResponseType.APPLY);
            this.close();
        });
        headerBar.pack_end(selectBtn);
        toolbarView.add_top_bar(headerBar);

        const contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_start: 12, margin_end: 12,
            margin_top: 8, margin_bottom: 8,
        });
        toolbarView.set_content(contentBox);

        const searchRow = new Gtk.Box({ spacing: 8 });
        const searchEntry = new Gtk.SearchEntry({
            hexpand: true,
            placeholder_text: 'Search icons\u2026',
        });
        searchRow.append(searchEntry);

        const filterMenu = new Gio.Menu();
        filterMenu.append('All', 'icon-filter.set::all');
        filterMenu.append('Symbolic', 'icon-filter.set::symbolic');
        filterMenu.append('Full Color', 'icon-filter.set::color');
        const filterBtn = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            menu_model: filterMenu,
            tooltip_text: 'Filter icon type',
        });
        const filterAction = new Gio.SimpleAction({
            name: 'set',
            parameter_type: GLib.VariantType.new('s'),
        });
        filterAction.connect('activate', (_a, param) => {
            this._filterMode = param.unpack();
            this._applyFilter(searchEntry.get_text());
        });
        const actionGroup = new Gio.SimpleActionGroup();
        actionGroup.add_action(filterAction);
        this.insert_action_group('icon-filter', actionGroup);
        searchRow.append(filterBtn);
        contentBox.append(searchRow);

        this._store = new Gio.ListStore({ item_type: IconDataItem });
        this._filterModel = new Gtk.FilterListModel({
            model: this._store,
            filter: Gtk.CustomFilter.new(null),
        });
        this._selection = new Gtk.SingleSelection({
            model: this._filterModel,
            autoselect: false,
        });
        this._selection.connect('notify::selected-item', () => {
            const item = this._selection.get_selected_item();
            if (item) {
                this._iconString = item.icon_string;
                selectBtn.sensitive = true;
            } else {
                selectBtn.sensitive = false;
            }
        });

        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, listItem) => {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 4, halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            const img = new Gtk.Image({ pixel_size: 32 });
            box.append(img);
            listItem.set_child(box);
        });
        factory.connect('bind', (_f, listItem) => {
            const item = listItem.get_item();
            const box = listItem.get_child();
            const img = box.get_first_child();
            img.icon_name = item.icon_string;
            box.tooltip_text = item.display_name;
        });

        const gridView = new Gtk.GridView({
            model: this._selection,
            factory,
            min_columns: 4,
            max_columns: 9,
            css_classes: ['convergence-icon-grid'],
            vexpand: true,
        });
        gridView.connect('activate', (_gv, pos) => {
            this._selection.set_selected(pos);
            this._iconString = this._selection.get_selected_item()?.icon_string ?? '';
            if (this._iconString) {
                this.emit('response', Gtk.ResponseType.APPLY);
                this.close();
            }
        });
        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
            css_classes: ['card'],
        });
        scroll.set_child(gridView);
        contentBox.append(scroll);

        const browseBtn = new Gtk.Button({
            label: 'Browse Files\u2026',
            halign: Gtk.Align.CENTER,
            margin_top: 4,
        });
        browseBtn.connect('clicked', () => {
            const fd = new Gtk.FileDialog({
                title: 'Choose Icon',
                default_filter: (() => {
                    const f = new Gtk.FileFilter();
                    f.set_name('Images');
                    f.add_mime_type('image/svg+xml');
                    f.add_mime_type('image/png');
                    f.add_mime_type('image/jpeg');
                    f.add_pixbuf_formats();
                    return f;
                })(),
            });
            fd.open(this, null, (_d, res) => {
                try {
                    const file = fd.open_finish(res);
                    if (file) {
                        this._iconString = file.get_path();
                        this.emit('response', Gtk.ResponseType.APPLY);
                        this.close();
                    }
                } catch (_e) { /* cancelled */ }
            });
        });
        contentBox.append(browseBtn);

        searchEntry.connect('search-changed', () => {
            if (this._searchDelay)
                GLib.source_remove(this._searchDelay);
            this._searchDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._searchDelay = 0;
                this._applyFilter(searchEntry.get_text());
                return GLib.SOURCE_REMOVE;
            });
        });

        _getSystemIcons().then(names => {
            for (const name of names)
                this._store.append(new IconDataItem({ display_name: name, icon_string: name }));
        });
    }

    get iconString() {
        return this._iconString;
    }

    _applyFilter(text) {
        const query = (text ?? '').toLowerCase();
        const mode = this._filterMode;
        this._filterModel.set_filter(Gtk.CustomFilter.new(item => {
            const name = item.display_name;
            if (query && !name.includes(query))
                return false;
            if (mode === 'symbolic')
                return name.endsWith('-symbolic');
            if (mode === 'color')
                return !name.endsWith('-symbolic');
            return true;
        }));
    }
});

function _createIconChooserRow(settings, key, parentWindow, {title, defaultIcon} = {}) {
    defaultIcon = defaultIcon || 'view-app-grid-symbolic';
    title = title || 'App grid button icon';
    const row = new Adw.ActionRow({
        title,
        subtitle: settings.get_string(key) || `(default: ${defaultIcon})`,
    });

    const preview = new Gtk.Image({
        pixel_size: 24,
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(preview);

    const _setPreviewIcon = (iconStr) => {
        if (iconStr && iconStr.startsWith('/')) {
            try {
                preview.set_from_gicon(Gio.FileIcon.new(Gio.File.new_for_path(iconStr)));
                return;
            } catch (_e) {}
        }
        preview.icon_name = iconStr || 'image-missing';
    };

    const chooseBtn = new Gtk.Button({
        icon_name: 'document-edit-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Choose icon',
    });
    chooseBtn.connect('clicked', () => {
        const dlg = new IconChooserDialog(parentWindow);
        dlg.connect('response', (_d, type) => {
            if (type === Gtk.ResponseType.APPLY && dlg.iconString) {
                settings.set_string(key, dlg.iconString);
            }
        });
        dlg.present();
    });
    row.add_suffix(chooseBtn);

    const resetBtn = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Reset to default',
    });
    resetBtn.connect('clicked', () => {
        settings.set_string(key, '');
    });
    row.add_suffix(resetBtn);

    const defaultLabel = defaultIcon.startsWith('/')
        ? GLib.path_get_basename(defaultIcon) : defaultIcon;
    const _update = () => {
        const val = settings.get_string(key);
        row.subtitle = val || `(default: ${defaultLabel})`;
        _setPreviewIcon(val || defaultIcon);
    };
    settings.connect(`changed::${key}`, _update);
    _update();

    return row;
}

export default class ConvergencePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const settingsSchema = settings.settings_schema;
        const pageByName = new Map();
        const hasKey = key => {
            try {
                return !!settingsSchema?.has_key(key);
            } catch (_e) {
                return false;
            }
        };

        // --- Desktop tab ---
        const desktopPage = new Adw.PreferencesPage({
            title: 'Desktop',
            icon_name: 'video-display-symbolic',
        });
        desktopPage.set_name('desktop');
        pageByName.set('desktop', desktopPage);
        pageByName.set('windows', desktopPage);
        window.add(desktopPage);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
        });
        desktopPage.add(generalGroup);

        // --- App Windows popup ---
        const appWindowsRow = new Adw.ActionRow({
            title: 'App windows',
            subtitle: 'Rounded corners and window appearance',
            activatable: true,
        });
        appWindowsRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        appWindowsRow.connect('activated', () => {
            const dlg = new Adw.Dialog({
                title: 'App Windows',
                content_width: 500,
                content_height: 300,
            });
            const tv = new Adw.ToolbarView();
            tv.add_top_bar(new Adw.HeaderBar());
            const pg = new Adw.PreferencesPage();
            tv.set_content(pg);
            dlg.set_child(tv);

            const grp = new Adw.PreferencesGroup({
                title: 'App Windows',
                description: 'Configure window appearance',
            });
            pg.add(grp);

            const cornersEnabledRow = new Adw.SwitchRow({
                title: 'Rounded corners',
                subtitle: 'Apply rounded corners to windows (resets to off on each startup)',
            });
            settings.bind('rounded-corners-enabled', cornersEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            grp.add(cornersEnabledRow);

            const cornerRadiusRow = new Adw.SpinRow({
                title: 'Corner radius',
                subtitle: 'Corner radius in pixels for maximized windows (0 to disable)',
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 50, step_increment: 1, page_increment: 5,
                }),
            });
            settings.bind('window-corner-radius', cornerRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            grp.add(cornerRadiusRow);

            const cornerSmoothingRow = new Adw.SpinRow({
                title: 'Corner smoothing',
                subtitle: 'Squircle smoothing (0 = circular, 1 = max smoothness)',
                digits: 2,
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 1, step_increment: 0.05, page_increment: 0.1,
                }),
            });
            settings.bind('window-corner-smoothing', cornerSmoothingRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            grp.add(cornerSmoothingRow);

            dlg.present(window);
        });
        generalGroup.add(appWindowsRow);

        // --- Multi-Monitor popup ---
        const multiMonRow = new Adw.ActionRow({
            title: 'Multi-monitor',
            subtitle: 'Independent workspaces and workspace shortcut behavior',
            activatable: true,
        });
        multiMonRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        multiMonRow.connect('activated', () => {
            const dlg = new Adw.Dialog({
                title: 'Multi-Monitor',
                content_width: 500,
                content_height: 500,
            });
            const tv = new Adw.ToolbarView();
            tv.add_top_bar(new Adw.HeaderBar());
            const pg = new Adw.PreferencesPage();
            tv.set_content(pg);
            dlg.set_child(tv);

            const grp = new Adw.PreferencesGroup({
                title: 'Multi-Monitor',
                description: 'Control workspace behavior across multiple displays',
            });
            pg.add(grp);

            const independentWsRow = new Adw.SwitchRow({
                title: 'Independent workspaces',
                subtitle: 'Each monitor navigates its own workspace stack independently',
            });
            if (hasKey('independent-workspaces')) {
                try {
                    settings.bind('independent-workspaces', independentWsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                } catch (_e) {
                    independentWsRow.set_sensitive(false);
                    independentWsRow.set_subtitle('Unavailable: schema key independent-workspaces is missing');
                }
            } else {
                independentWsRow.set_sensitive(false);
                independentWsRow.set_subtitle('Unavailable: schema key independent-workspaces is missing');
            }
            grp.add(independentWsRow);

            const vanillaPrimaryWsRow = new Adw.SwitchRow({
                title: 'Vanilla primary workspaces',
                subtitle: 'Keep GNOME-native workspace behavior on primary display while secondary displays stay independent',
            });
            if (hasKey('independent-workspaces-vanilla-primary')) {
                try {
                    settings.bind('independent-workspaces-vanilla-primary', vanillaPrimaryWsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                } catch (_e) {
                    vanillaPrimaryWsRow.set_sensitive(false);
                    vanillaPrimaryWsRow.set_subtitle('Unavailable: schema key independent-workspaces-vanilla-primary is missing');
                }
            } else {
                vanillaPrimaryWsRow.set_sensitive(false);
                vanillaPrimaryWsRow.set_subtitle('Unavailable: schema key independent-workspaces-vanilla-primary is missing');
            }
            if (hasKey('independent-workspaces') && hasKey('independent-workspaces-vanilla-primary')) {
                independentWsRow.bind_property(
                    'active', vanillaPrimaryWsRow, 'sensitive',
                    GObject.BindingFlags.SYNC_CREATE
                );
            }
            grp.add(vanillaPrimaryWsRow);

            const workspaceShortcutTargetRow = new Adw.ComboRow({
                title: 'Workspace shortcut target',
                subtitle: 'When independent workspaces is enabled, keyboard shortcuts target pointer or focused monitor',
                model: new Gtk.StringList({ strings: ['Pointer monitor', 'Focused monitor'] }),
            });
            if (hasKey('workspace-shortcut-target-monitor')) {
                const shortcutTargetMap = { pointer: 0, focused: 1 };
                const shortcutTargetValues = ['pointer', 'focused'];
                workspaceShortcutTargetRow.set_selected(
                    shortcutTargetMap[settings.get_string('workspace-shortcut-target-monitor')] ?? 0
                );
                workspaceShortcutTargetRow.connect('notify::selected', () => {
                    settings.set_string(
                        'workspace-shortcut-target-monitor',
                        shortcutTargetValues[workspaceShortcutTargetRow.get_selected()] ?? 'pointer'
                    );
                });
                settings.connect('changed::workspace-shortcut-target-monitor', () => {
                    workspaceShortcutTargetRow.set_selected(
                        shortcutTargetMap[settings.get_string('workspace-shortcut-target-monitor')] ?? 0
                    );
                });
            } else {
                workspaceShortcutTargetRow.set_sensitive(false);
                workspaceShortcutTargetRow.set_subtitle('Unavailable: schema key workspace-shortcut-target-monitor is missing');
            }
            if (hasKey('independent-workspaces')) {
                independentWsRow.bind_property(
                    'active', workspaceShortcutTargetRow, 'sensitive',
                    GObject.BindingFlags.SYNC_CREATE
                );
            }
            grp.add(workspaceShortcutTargetRow);

            const homeInOverviewRow = new Adw.SwitchRow({
                title: 'Show homescreen in overview',
                subtitle: 'Only affects GNOME overview; normal workspace visibility is unchanged',
            });
            if (hasKey('show-home-in-overview')) {
                try {
                    settings.bind('show-home-in-overview', homeInOverviewRow, 'active', Gio.SettingsBindFlags.DEFAULT);
                } catch (_e) {
                    homeInOverviewRow.set_sensitive(false);
                    homeInOverviewRow.set_subtitle('Unavailable: schema key show-home-in-overview is missing');
                }
            } else {
                homeInOverviewRow.set_sensitive(false);
                homeInOverviewRow.set_subtitle('Unavailable: schema key show-home-in-overview is missing');
            }
            grp.add(homeInOverviewRow);

            dlg.present(window);
        });
        generalGroup.add(multiMonRow);

        // --- Taskbar ---
        pageByName.set('dock', desktopPage);

        const dockTaskbarModeRow = new Adw.SwitchRow({
            title: 'Panel mode',
            subtitle: 'Span the full height of the monitor edge',
        });
        settings.bind(
            'taskbar-panel-mode',
            dockTaskbarModeRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        const dockLayoutGroup = new Adw.PreferencesGroup({
            title: 'Taskbar',
            description: 'Placement, appearance, mode, and effects for the taskbar',
        });
        desktopPage.add(dockLayoutGroup);

        const visibilitySettingsRow = new Adw.ActionRow({
            title: 'Visibility',
            subtitle: 'When the taskbar shows and when it retracts',
            activatable: true,
        });
        visibilitySettingsRow.add_suffix(new Gtk.Image({
            icon_name: 'go-next-symbolic',
        }));
        visibilitySettingsRow.connect('activated', () => {
            const visDialog = new Adw.Dialog({
                title: 'Taskbar Visibility',
                content_width: 500,
                content_height: 500,
            });
            const visToolbarView = new Adw.ToolbarView();
            const visHeaderBar = new Adw.HeaderBar();
            visToolbarView.add_top_bar(visHeaderBar);
            const visDialogPage = new Adw.PreferencesPage();
            visToolbarView.set_content(visDialogPage);
            visDialog.set_child(visToolbarView);

            const dockVisibilityGroup = new Adw.PreferencesGroup({
                title: 'Visibility',
                description: 'When the taskbar shows and when it retracts',
            });
            visDialogPage.add(dockVisibilityGroup);

            const dockModeRow = new Adw.ComboRow({
                title: 'Taskbar visibility',
                subtitle: 'How the taskbar appears on the desktop',
                model: new Gtk.StringList({ strings: ['Always visible', 'Auto-hide'] }),
            });
            const dockModeValue = settings.get_string('taskbar-secondary-mode');
            dockModeRow.set_selected(dockModeValue === 'hidden' ? 1 : 0);
            dockModeRow.connect('notify::selected', () => {
                settings.set_string('taskbar-secondary-mode',
                    dockModeRow.get_selected() === 1 ? 'hidden' : 'visible');
            });
            settings.connect('changed::taskbar-secondary-mode', () => {
                let val = settings.get_string('taskbar-secondary-mode');
                dockModeRow.set_selected(val === 'hidden' ? 1 : 0);
            });
            dockVisibilityGroup.add(dockModeRow);

            const dockHoverRow = new Adw.SwitchRow({
                title: 'Show on hover',
                subtitle: 'Reveal the taskbar when hovering the screen edge',
            });
            settings.bind(
                'taskbar-autohide-hover',
                dockHoverRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            dockModeRow.bind_property(
                'selected', dockHoverRow, 'sensitive',
                GObject.BindingFlags.SYNC_CREATE
            );
            dockVisibilityGroup.add(dockHoverRow);

            const dockOverlapHideRow = new Adw.SwitchRow({
                title: 'Hide when window overlaps',
                subtitle: 'Hide taskbar when windows move behind its area',
            });
            settings.bind(
                'taskbar-hide-when-overlapped',
                dockOverlapHideRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            dockVisibilityGroup.add(dockOverlapHideRow);

            const dockMaximizedAvoidRow = new Adw.SwitchRow({
                title: 'Keep maximized windows clear',
                subtitle: 'Hide taskbar when a maximized window is present to avoid overlap',
            });
            settings.bind(
                'taskbar-maximized-avoid-taskbar',
                dockMaximizedAvoidRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            dockVisibilityGroup.add(dockMaximizedAvoidRow);

            let dockIntellihideRow = null;
            if (hasKey('taskbar-intellihide')) {
                dockIntellihideRow = new Adw.SwitchRow({
                    title: 'Intellihide',
                    subtitle: 'Auto-hide taskbar when windows overlap; reveal on pointer-at-edge',
                });
                settings.bind(
                    'taskbar-intellihide',
                    dockIntellihideRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                dockVisibilityGroup.add(dockIntellihideRow);
            }

            const syncDockVisibilityDependents = () => {
                const alwaysVisible = dockModeRow.get_selected() === 0;
                dockOverlapHideRow.set_sensitive(alwaysVisible);
                dockMaximizedAvoidRow.set_sensitive(alwaysVisible);
                if (dockIntellihideRow)
                    dockIntellihideRow.set_sensitive(alwaysVisible);
            };
            dockModeRow.connect('notify::selected', syncDockVisibilityDependents);
            syncDockVisibilityDependents();

            visDialog.present(window);
        });
        dockLayoutGroup.add(visibilitySettingsRow);

        const dockMonitorModeRow = new Adw.ComboRow({
            title: 'Taskbar displays',
            subtitle: 'Show taskbar on all displays or only one display',
            model: new Gtk.StringList({ strings: ['All multi-window displays', 'Single display only'] }),
        });
        const dockMonitorModeValue = settings.get_string('taskbar-monitor-mode');
        dockMonitorModeRow.set_selected(dockMonitorModeValue === 'single' ? 1 : 0);
        dockMonitorModeRow.connect('notify::selected', () => {
            settings.set_string('taskbar-monitor-mode',
                dockMonitorModeRow.get_selected() === 1 ? 'single' : 'all');
        });
        settings.connect('changed::taskbar-monitor-mode', () => {
            let val = settings.get_string('taskbar-monitor-mode');
            dockMonitorModeRow.set_selected(val === 'single' ? 1 : 0);
        });
        dockLayoutGroup.add(dockMonitorModeRow);

        const dockSingleTargetRow = new Adw.ComboRow({
            title: 'Single-display target',
            subtitle: 'Primary, or the focused display (pointer display when using a mouse)',
            model: new Gtk.StringList({ strings: ['Primary display', 'Focused/pointer display'] }),
        });
        const dockSingleTargetValue = settings.get_string('taskbar-single-monitor-target');
        dockSingleTargetRow.set_selected(dockSingleTargetValue === 'focused' ? 1 : 0);
        dockSingleTargetRow.connect('notify::selected', () => {
            settings.set_string('taskbar-single-monitor-target',
                dockSingleTargetRow.get_selected() === 1 ? 'focused' : 'primary');
        });
        settings.connect('changed::taskbar-single-monitor-target', () => {
            let val = settings.get_string('taskbar-single-monitor-target');
            dockSingleTargetRow.set_selected(val === 'focused' ? 1 : 0);
        });
        dockMonitorModeRow.bind_property(
            'selected', dockSingleTargetRow, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );
        dockLayoutGroup.add(dockSingleTargetRow);

        if (hasKey('taskbar-app-grid-icon')) {
            const dockIconRow = _createIconChooserRow(settings, 'taskbar-app-grid-icon', window);
            dockLayoutGroup.add(dockIconRow);
        }

        const effectsSettingsRow = new Adw.ActionRow({
            title: 'Effects &amp; indicators',
            subtitle: 'Animations, hover effects, running indicators, and badges',
            activatable: true,
        });
        effectsSettingsRow.add_suffix(new Gtk.Image({
            icon_name: 'go-next-symbolic',
        }));
        effectsSettingsRow.connect('activated', () => {
            const effDialog = new Adw.Dialog({
                title: 'Effects &amp; Indicators',
                content_width: 500,
                content_height: 650,
            });
            const effToolbarView = new Adw.ToolbarView();
            const effHeaderBar = new Adw.HeaderBar();
            effToolbarView.add_top_bar(effHeaderBar);
            const effDialogPage = new Adw.PreferencesPage();
            effToolbarView.set_content(effDialogPage);
            effDialog.set_child(effToolbarView);

            const dockEffectsGroup = new Adw.PreferencesGroup({
                title: 'Animations',
                description: 'Launch effects and hover animations',
            });
            effDialogPage.add(dockEffectsGroup);

            const dockAnimateOpenRow = new Adw.SwitchRow({
                title: 'Animate opening applications',
                subtitle: 'Play a launch animation on app activation',
            });
            settings.bind(
                'taskbar-animate-opening-apps',
                dockAnimateOpenRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            dockEffectsGroup.add(dockAnimateOpenRow);

            const hoverAnimRow = new Adw.SwitchRow({
                title: 'Animate hovering app icons',
                subtitle: 'Animate taskbar icons when the pointer hovers over them',
            });
            settings.bind(
                'taskbar-animate-hover',
                hoverAnimRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            dockEffectsGroup.add(hoverAnimRow);

            const hoverAnimExpanderRow = new Adw.ExpanderRow({
                title: 'Hover animation options',
                subtitle: 'Type, duration, zoom, travel, rotation, and extent',
                show_enable_switch: false,
            });
            hoverAnimRow.bind_property(
                'active', hoverAnimExpanderRow, 'sensitive',
                GObject.BindingFlags.SYNC_CREATE
            );
            dockEffectsGroup.add(hoverAnimExpanderRow);

            const hoverTypeRow = new Adw.ComboRow({
                title: 'Animation type',
                subtitle: 'SIMPLE raises only the hovered icon; RIPPLE and PLANK animate neighbours',
                model: new Gtk.StringList({ strings: ['Simple', 'Ripple', 'Plank'] }),
            });
            const hoverTypeMap = { SIMPLE: 0, RIPPLE: 1, PLANK: 2 };
            const hoverTypeValues = ['SIMPLE', 'RIPPLE', 'PLANK'];
            hoverTypeRow.set_selected(hoverTypeMap[settings.get_string('taskbar-hover-animation-type')] ?? 0);
            hoverTypeRow.connect('notify::selected', () => {
                let val = hoverTypeValues[hoverTypeRow.get_selected()] ?? 'SIMPLE';
                settings.set_string('taskbar-hover-animation-type', val);
                const defaults = {
                    SIMPLE: { duration: 160, rotation: 0, travel: 0.30, zoom: 1.0, convexity: 1.0, extent: 4 },
                    RIPPLE: { duration: 130, rotation: 10, travel: 0.40, zoom: 1.25, convexity: 1.0, extent: 4 },
                    PLANK:  { duration: 100, rotation: 0, travel: 0.0, zoom: 2.0, convexity: 1.0, extent: 4 },
                };
                let d = defaults[val];
                if (d) {
                    settings.set_int('taskbar-hover-animation-duration', d.duration);
                    settings.set_int('taskbar-hover-animation-rotation', d.rotation);
                    settings.set_double('taskbar-hover-animation-travel', d.travel);
                    settings.set_double('taskbar-hover-animation-zoom', d.zoom);
                    settings.set_double('taskbar-hover-animation-convexity', d.convexity);
                    settings.set_int('taskbar-hover-animation-extent', d.extent);
                }
            });
            settings.connect('changed::taskbar-hover-animation-type', () => {
                hoverTypeRow.set_selected(hoverTypeMap[settings.get_string('taskbar-hover-animation-type')] ?? 0);
            });
            hoverAnimExpanderRow.add_row(hoverTypeRow);

            const hoverDurationAdj = new Gtk.Adjustment({ lower: 0, upper: 300, step_increment: 10, page_increment: 50 });
            const hoverDurationRow = new Adw.SpinRow({ title: 'Duration (ms)', adjustment: hoverDurationAdj });
            settings.bind('taskbar-hover-animation-duration', hoverDurationAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverAnimExpanderRow.add_row(hoverDurationRow);

            const hoverZoomAdj = new Gtk.Adjustment({ lower: 0.5, upper: 2.5, step_increment: 0.05, page_increment: 0.25 });
            const hoverZoomRow = new Adw.SpinRow({ title: 'Zoom', digits: 2, adjustment: hoverZoomAdj });
            settings.bind('taskbar-hover-animation-zoom', hoverZoomAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverAnimExpanderRow.add_row(hoverZoomRow);

            const hoverTravelAdj = new Gtk.Adjustment({ lower: -1.0, upper: 1.0, step_increment: 0.05, page_increment: 0.1 });
            const hoverTravelRow = new Adw.SpinRow({ title: 'Travel', digits: 2, adjustment: hoverTravelAdj });
            settings.bind('taskbar-hover-animation-travel', hoverTravelAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverAnimExpanderRow.add_row(hoverTravelRow);

            const hoverRotationAdj = new Gtk.Adjustment({ lower: -30, upper: 30, step_increment: 1, page_increment: 5 });
            const hoverRotationRow = new Adw.SpinRow({ title: 'Rotation (\u00B0)', adjustment: hoverRotationAdj });
            settings.bind('taskbar-hover-animation-rotation', hoverRotationAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverAnimExpanderRow.add_row(hoverRotationRow);

            const hoverConvexAdj = new Gtk.Adjustment({ lower: 0.0, upper: 3.0, step_increment: 0.1, page_increment: 0.5 });
            const hoverConvexRow = new Adw.SpinRow({ title: 'Convexity', digits: 1, adjustment: hoverConvexAdj });
            settings.bind('taskbar-hover-animation-convexity', hoverConvexAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverAnimExpanderRow.add_row(hoverConvexRow);

            const hoverExtentAdj = new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1, page_increment: 2 });
            const hoverExtentRow = new Adw.SpinRow({ title: 'Extent (icons)', adjustment: hoverExtentAdj });
            settings.bind('taskbar-hover-animation-extent', hoverExtentAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverAnimExpanderRow.add_row(hoverExtentRow);

            const hoverHlRow = new Adw.SwitchRow({
                title: 'Highlight hovering app icons',
                subtitle: 'Show a coloured background behind taskbar icons on hover',
            });
            settings.bind(
                'taskbar-hover-highlight-enabled',
                hoverHlRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            dockEffectsGroup.add(hoverHlRow);

            const hoverHlExpanderRow = new Adw.ExpanderRow({
                title: 'Hover highlight options',
                subtitle: 'Colour, pressed colour, and border radius',
                show_enable_switch: false,
            });
            hoverHlRow.bind_property(
                'active', hoverHlExpanderRow, 'sensitive',
                GObject.BindingFlags.SYNC_CREATE
            );
            dockEffectsGroup.add(hoverHlExpanderRow);

            const hoverHlColorRow = new Adw.ActionRow({ title: 'Highlight colour' });
            const hoverHlColorBtn = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: true,
            });
            {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-color'));
                hoverHlColorBtn.set_rgba(rgba);
            }
            hoverHlColorBtn.connect('color-set', () => {
                settings.set_string('taskbar-hover-highlight-color',
                    hoverHlColorBtn.get_rgba().to_string());
            });
            settings.connect('changed::taskbar-hover-highlight-color', () => {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-color'));
                hoverHlColorBtn.set_rgba(rgba);
            });
            hoverHlColorRow.add_suffix(hoverHlColorBtn);
            hoverHlExpanderRow.add_row(hoverHlColorRow);

            const hoverHlPressedRow = new Adw.ActionRow({ title: 'Pressed colour' });
            const hoverHlPressedBtn = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: true,
            });
            {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-pressed-color'));
                hoverHlPressedBtn.set_rgba(rgba);
            }
            hoverHlPressedBtn.connect('color-set', () => {
                settings.set_string('taskbar-hover-highlight-pressed-color',
                    hoverHlPressedBtn.get_rgba().to_string());
            });
            settings.connect('changed::taskbar-hover-highlight-pressed-color', () => {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-pressed-color'));
                hoverHlPressedBtn.set_rgba(rgba);
            });
            hoverHlPressedRow.add_suffix(hoverHlPressedBtn);
            hoverHlExpanderRow.add_row(hoverHlPressedRow);

            const hoverHlBrAdj = new Gtk.Adjustment({ lower: 0, upper: 24, step_increment: 1, page_increment: 4 });
            const hoverHlBrRow = new Adw.SpinRow({ title: 'Border radius (px)', adjustment: hoverHlBrAdj });
            settings.bind('taskbar-hover-highlight-border-radius', hoverHlBrAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
            hoverHlExpanderRow.add_row(hoverHlBrRow);

            const hoverHlRunningRow = new Adw.ActionRow({ title: 'Running app colour' });
            const hoverHlRunningBtn = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: true,
            });
            {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-running-color'));
                hoverHlRunningBtn.set_rgba(rgba);
            }
            hoverHlRunningBtn.connect('color-set', () => {
                settings.set_string('taskbar-hover-highlight-running-color',
                    hoverHlRunningBtn.get_rgba().to_string());
            });
            settings.connect('changed::taskbar-hover-highlight-running-color', () => {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-running-color'));
                hoverHlRunningBtn.set_rgba(rgba);
            });
            hoverHlRunningRow.add_suffix(hoverHlRunningBtn);
            hoverHlExpanderRow.add_row(hoverHlRunningRow);

            const hoverHlFocusedRow = new Adw.ActionRow({ title: 'Focused app colour' });
            const hoverHlFocusedBtn = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: true,
            });
            {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-focused-color'));
                hoverHlFocusedBtn.set_rgba(rgba);
            }
            hoverHlFocusedBtn.connect('color-set', () => {
                settings.set_string('taskbar-hover-highlight-focused-color',
                    hoverHlFocusedBtn.get_rgba().to_string());
            });
            settings.connect('changed::taskbar-hover-highlight-focused-color', () => {
                let rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string('taskbar-hover-highlight-focused-color'));
                hoverHlFocusedBtn.set_rgba(rgba);
            });
            hoverHlFocusedRow.add_suffix(hoverHlFocusedBtn);
            hoverHlExpanderRow.add_row(hoverHlFocusedRow);

            const indicatorsGroup = new Adw.PreferencesGroup({
                title: 'Indicators',
                description: 'Running app markers, highlights, and badges',
            });
            effDialogPage.add(indicatorsGroup);

            const dockIndicatorsRow = new Adw.SwitchRow({
                title: 'Show open-app indicators',
                subtitle: 'Show running/focused state markers on taskbar icons',
            });
            settings.bind(
                'taskbar-show-open-indicators',
                dockIndicatorsRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            indicatorsGroup.add(dockIndicatorsRow);

            const dockHighlightFillRow = new Adw.SwitchRow({
                title: 'Highlight fill layer',
                subtitle: 'Show background fill for running/focused app highlights',
            });
            settings.bind(
                'taskbar-highlight-fill-enabled',
                dockHighlightFillRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            indicatorsGroup.add(dockHighlightFillRow);

            const dockHighlightEdgeRow = new Adw.SwitchRow({
                title: 'Highlight bottom edge layer',
                subtitle: 'Show bottom edge line for running/focused app highlights',
            });
            settings.bind(
                'taskbar-highlight-edge-enabled',
                dockHighlightEdgeRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            indicatorsGroup.add(dockHighlightEdgeRow);

            const dockHighlightStripRow = new Adw.SwitchRow({
                title: 'Running-state strip layer',
                subtitle: 'Show additional running-state strip on taskbar highlights',
            });
            settings.bind(
                'taskbar-highlight-strip-enabled',
                dockHighlightStripRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            indicatorsGroup.add(dockHighlightStripRow);

            if (hasKey('taskbar-notification-badges')) {
                const dockNotifBadgesRow = new Adw.SwitchRow({
                    title: 'Notification badges',
                    subtitle: 'Show notification count badges on taskbar icons',
                });
                settings.bind(
                    'taskbar-notification-badges',
                    dockNotifBadgesRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                indicatorsGroup.add(dockNotifBadgesRow);
            }

            const minimizeGroup = new Adw.PreferencesGroup({
                title: 'Minimize',
                description: 'Window minimize animation behavior',
            });
            effDialogPage.add(minimizeGroup);

            const dockMinAnimRow = new Adw.ComboRow({
                title: 'Minimize animation',
                subtitle: 'Animation style for minimizing windows',
                model: new Gtk.StringList({ strings: ['Scale', 'Genie'] }),
            });
            const dockMinAnimMap = { scale: 0, genie: 1 };
            const dockMinAnimValues = ['scale', 'genie'];
            dockMinAnimRow.set_selected(dockMinAnimMap[settings.get_string('taskbar-minimize-animation-style')] ?? 0);
            dockMinAnimRow.connect('notify::selected', () => {
                settings.set_string(
                    'taskbar-minimize-animation-style',
                    dockMinAnimValues[dockMinAnimRow.get_selected()] ?? 'scale'
                );
            });
            settings.connect('changed::taskbar-minimize-animation-style', () => {
                dockMinAnimRow.set_selected(dockMinAnimMap[settings.get_string('taskbar-minimize-animation-style')] ?? 0);
            });
            minimizeGroup.add(dockMinAnimRow);

            const dockMinIntoIconRow = new Adw.SwitchRow({
                title: 'Minimize into app icon',
                subtitle: 'Animate minimized windows toward their taskbar app icon',
            });
            settings.bind(
                'taskbar-minimize-into-app-icon',
                dockMinIntoIconRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            minimizeGroup.add(dockMinIntoIconRow);

            effDialog.present(window);
        });
        dockLayoutGroup.add(effectsSettingsRow);

        // --- Taskbar ---
        pageByName.set('taskbar', desktopPage);

        dockLayoutGroup.add(dockTaskbarModeRow);

        const taskbarSettingsRow = new Adw.ActionRow({
            title: 'Taskbar settings',
            subtitle: 'Panel boxes, appearance, and transparency',
            activatable: true,
        });
        taskbarSettingsRow.add_suffix(new Gtk.Image({
            icon_name: 'go-next-symbolic',
        }));
        taskbarSettingsRow.connect('activated', () => {
            const dialog = new Adw.Dialog({
                title: 'Taskbar Settings',
                content_width: 500,
                content_height: 600,
            });
            const toolbarView = new Adw.ToolbarView();
            const headerBar = new Adw.HeaderBar();
            toolbarView.add_top_bar(headerBar);
            const dialogPage = new Adw.PreferencesPage();
            toolbarView.set_content(dialogPage);
            dialog.set_child(toolbarView);

            const taskbarPanelGroup = new Adw.PreferencesGroup({
                title: 'Panel Boxes',
                description: 'Toggle GNOME panel sections in the taskbar',
            });
            dialogPage.add(taskbarPanelGroup);

            if (hasKey('taskbar-show-left-box')) {
                const showLeftBoxRow = new Adw.SwitchRow({
                    title: 'Left box',
                    subtitle: 'Activities button and app menu area',
                });
                settings.bind(
                    'taskbar-show-left-box',
                    showLeftBoxRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarPanelGroup.add(showLeftBoxRow);
            }

            if (hasKey('taskbar-show-center-box')) {
                const showCenterBoxRow = new Adw.SwitchRow({
                    title: 'Center box',
                    subtitle: 'Clock and calendar',
                });
                settings.bind(
                    'taskbar-show-center-box',
                    showCenterBoxRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarPanelGroup.add(showCenterBoxRow);
            }

            if (hasKey('taskbar-show-right-box')) {
                const showRightBoxRow = new Adw.SwitchRow({
                    title: 'Right box',
                    subtitle: 'System indicators and quick settings',
                });
                settings.bind(
                    'taskbar-show-right-box',
                    showRightBoxRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarPanelGroup.add(showRightBoxRow);
            }

            const taskbarAppearanceGroup = new Adw.PreferencesGroup({
                title: 'Appearance',
            });
            dialogPage.add(taskbarAppearanceGroup);

            if (hasKey('taskbar-thickness')) {
                const taskbarThicknessRow = new Adw.SpinRow({
                    title: 'Thickness',
                    subtitle: '0 = auto (48 bottom, 64 side). Manual range: 40\u2013220 px',
                    adjustment: new Gtk.Adjustment({
                        lower: 0,
                        upper: 220,
                        step_increment: 1,
                        page_increment: 8,
                    }),
                });
                settings.bind(
                    'taskbar-thickness',
                    taskbarThicknessRow,
                    'value',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarAppearanceGroup.add(taskbarThicknessRow);
            }

            if (hasKey('taskbar-icon-size')) {
                const taskbarIconSizeRow = new Adw.SpinRow({
                    title: 'Icon size',
                    subtitle: 'App and grid-button icon size in px (0 = auto, 16\u201364)',
                    adjustment: new Gtk.Adjustment({
                        lower: 0,
                        upper: 64,
                        step_increment: 1,
                        page_increment: 4,
                    }),
                });
                settings.bind(
                    'taskbar-icon-size',
                    taskbarIconSizeRow,
                    'value',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarAppearanceGroup.add(taskbarIconSizeRow);
            }

            if (hasKey('taskbar-panel-background-opacity')) {
                const taskbarBgOpacityRow = new Adw.SpinRow({
                    title: 'Background opacity',
                    subtitle: 'Taskbar background opacity percentage (10\u2013100)',
                    adjustment: new Gtk.Adjustment({
                        lower: 10,
                        upper: 100,
                        step_increment: 1,
                        page_increment: 5,
                    }),
                });
                settings.bind(
                    'taskbar-panel-background-opacity',
                    taskbarBgOpacityRow,
                    'value',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarAppearanceGroup.add(taskbarBgOpacityRow);
            }

            if (hasKey('taskbar-dynamic-opacity')) {
                const dynOpacityRow = new Adw.SwitchRow({
                    title: 'Dynamic transparency',
                    subtitle: 'Transparent when no maximized windows; opaque when one is',
                });
                settings.bind(
                    'taskbar-dynamic-opacity',
                    dynOpacityRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                taskbarAppearanceGroup.add(dynOpacityRow);

                if (hasKey('taskbar-dynamic-opacity-min')) {
                    const dynOpacityMinRow = new Adw.SpinRow({
                        title: 'Minimum opacity',
                        subtitle: 'Taskbar opacity when no maximized windows (10\u2013100%)',
                        adjustment: new Gtk.Adjustment({
                            lower: 10,
                            upper: 100,
                            step_increment: 5,
                            page_increment: 10,
                        }),
                    });
                    settings.bind(
                        'taskbar-dynamic-opacity-min',
                        dynOpacityMinRow,
                        'value',
                        Gio.SettingsBindFlags.DEFAULT
                    );
                    dynOpacityRow.bind_property(
                        'active', dynOpacityMinRow, 'sensitive',
                        GObject.BindingFlags.SYNC_CREATE
                    );
                    taskbarAppearanceGroup.add(dynOpacityMinRow);
                }
            }

            dialog.present(window);
        });
        dockLayoutGroup.add(taskbarSettingsRow);

        // --- Notifications (Desktop tab) ---
        if (hasKey('notification-banner-position')) {
            const notifGroup = new Adw.PreferencesGroup({
                title: 'Notifications',
                description: 'Notification banner appearance (large displays only)',
            });
            desktopPage.add(notifGroup);

            const notifPosRow = new Adw.ComboRow({
                title: 'Banner position',
                subtitle: 'Where notification banners appear on screen',
                model: new Gtk.StringList({ strings: [
                    'Default (top center)',
                    'Top left',
                    'Top center',
                    'Top right',
                    'Bottom left',
                    'Bottom center',
                    'Bottom right',
                ] }),
            });
            notifPosRow.set_selected(settings.get_int('notification-banner-position'));
            notifPosRow.connect('notify::selected', () => {
                settings.set_int('notification-banner-position', notifPosRow.get_selected());
            });
            settings.connect('changed::notification-banner-position', () => {
                notifPosRow.set_selected(settings.get_int('notification-banner-position'));
            });
            notifGroup.add(notifPosRow);
        }

        // --- Notification Panel (Desktop tab) ---
        if (hasKey('desktop-notification-panel-enabled')) {
            const notifPanelDesktopGroup = new Adw.PreferencesGroup({
                title: 'Notification Panel',
                description: 'Convergence notification panel on desktop',
            });
            desktopPage.add(notifPanelDesktopGroup);

            const notifPanelRow = new Adw.SwitchRow({
                title: 'Convergence notification panel',
                subtitle: 'Replace GNOME Quick Settings with the Convergence notification panel in desktop mode',
            });
            settings.bind(
                'desktop-notification-panel-enabled',
                notifPanelRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            notifPanelDesktopGroup.add(notifPanelRow);

            if (hasKey('notification-panel-scale-desktop')) {
                const desktopPanelScaleRow = new Adw.SpinRow({
                    title: 'Panel scale in desktop mode',
                    subtitle: 'Scale the full notification panel UI in desktop mode (50 to 200%)',
                    adjustment: new Gtk.Adjustment({
                        lower: 50,
                        upper: 200,
                        step_increment: 5,
                        page_increment: 10,
                    }),
                });
                settings.bind(
                    'notification-panel-scale-desktop',
                    desktopPanelScaleRow,
                    'value',
                    Gio.SettingsBindFlags.DEFAULT
                );
                notifPanelDesktopGroup.add(desktopPanelScaleRow);
            }

            if (hasKey('desktop-tray-location')) {
                const trayLocationRow = new Adw.ComboRow({
                    title: 'Tray area location',
                    subtitle: 'Where to show system tray icons on desktop',
                    model: new Gtk.StringList({ strings: [
                        'Top panel',
                        'Notification panel',
                        'Both',
                        'Hidden',
                    ] }),
                });
                const trayLocationValues = ['top-panel', 'notification-panel', 'both', 'none'];
                let currentVal = settings.get_string('desktop-tray-location');
                trayLocationRow.set_selected(Math.max(0, trayLocationValues.indexOf(currentVal)));
                trayLocationRow.connect('notify::selected', () => {
                    settings.set_string('desktop-tray-location', trayLocationValues[trayLocationRow.get_selected()]);
                });
                settings.connect('changed::desktop-tray-location', () => {
                    trayLocationRow.set_selected(Math.max(0, trayLocationValues.indexOf(settings.get_string('desktop-tray-location'))));
                });
                notifPanelDesktopGroup.add(trayLocationRow);
            }
        }

        // --- Top Panel (Desktop tab) ---
        if (hasKey('desktop-tray-enabled')) {
            const topPanelGroup = new Adw.PreferencesGroup({
                title: 'Top Panel',
                description: 'Desktop top panel features',
            });
            desktopPage.add(topPanelGroup);

            const desktopTrayRow = new Adw.SwitchRow({
                title: 'Tray area icons',
                subtitle: 'Show system tray icons in the desktop top panel with interactive menus',
            });
            settings.bind(
                'desktop-tray-enabled',
                desktopTrayRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            topPanelGroup.add(desktopTrayRow);

            if (hasKey('desktop-max-notification-icons')) {
                const desktopMaxNotifIconsRow = new Adw.SpinRow({
                    title: 'Max notification icons',
                    subtitle: 'Limit visible notification icons in the top panel. Extra notifications show as a dot.',
                    adjustment: new Gtk.Adjustment({
                        lower: 1, upper: 10, step_increment: 1, page_increment: 2,
                    }),
                });
                settings.bind('desktop-max-notification-icons', desktopMaxNotifIconsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
                topPanelGroup.add(desktopMaxNotifIconsRow);
            }
        }

        // --- Phone tab ---
        const phonePage = new Adw.PreferencesPage({
            title: 'Phone',
            icon_name: 'phone-symbolic',
        });
        phonePage.set_name('phone');
        pageByName.set('phone', phonePage);
        window.add(phonePage);

        // --- Status Bar ---
        const statusBarGroup = new Adw.PreferencesGroup({
            title: 'Status Bar',
            description: 'Adjust height and padding to accommodate notches, camera punch holes, or display border radius',
        });
        phonePage.add(statusBarGroup);

        if (hasKey('panel-height')) {
            const panelHeightRow = new Adw.SpinRow({
                title: 'Status bar height',
                subtitle: 'Custom height in pixels (0 = GNOME default)',
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 100, step_increment: 1, page_increment: 5,
                }),
            });
            settings.bind('panel-height', panelHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            statusBarGroup.add(panelHeightRow);
        }

        if (hasKey('panel-padding-left')) {
            const leftPadRow = new Adw.SpinRow({
                title: 'Left padding',
                subtitle: 'Pixels of padding on the left side of the status bar',
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 100, step_increment: 1, page_increment: 5,
                }),
            });
            settings.bind('panel-padding-left', leftPadRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            statusBarGroup.add(leftPadRow);
        }

        if (hasKey('panel-padding-right')) {
            const rightPadRow = new Adw.SpinRow({
                title: 'Right padding',
                subtitle: 'Pixels of padding on the right side of the status bar',
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 100, step_increment: 1, page_increment: 5,
                }),
            });
            settings.bind('panel-padding-right', rightPadRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            statusBarGroup.add(rightPadRow);
        }

        if (hasKey('statusbar-max-notification-icons')) {
            const maxNotifIconsRow = new Adw.SpinRow({
                title: 'Max notification icons',
                subtitle: 'Limit visible notification icons in the status bar. Extra notifications show as a dot.',
                adjustment: new Gtk.Adjustment({
                    lower: 1, upper: 10, step_increment: 1, page_increment: 2,
                }),
            });
            settings.bind('statusbar-max-notification-icons', maxNotifIconsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
            statusBarGroup.add(maxNotifIconsRow);
        }

        // --- Layout ---
        const phoneLayoutGroup = new Adw.PreferencesGroup({
            title: 'Layout',
        });
        phonePage.add(phoneLayoutGroup);

        if (hasKey('gesture-bar-height')) {
            const gestureBarHeightRow = new Adw.SpinRow({
                title: 'Gesture bar height',
                subtitle: 'Bottom gesture bar height in pixels on phone displays',
                adjustment: new Gtk.Adjustment({
                    lower: 8,
                    upper: 64,
                    step_increment: 1,
                    page_increment: 4,
                }),
            });
            settings.bind(
                'gesture-bar-height',
                gestureBarHeightRow,
                'value',
                Gio.SettingsBindFlags.DEFAULT
            );
            phoneLayoutGroup.add(gestureBarHeightRow);
        }

        if (hasKey('phone-panel-corner-offset')) {
            const panelCornerOffsetRow = new Adw.SpinRow({
                title: 'Status bar corner vertical offset',
                subtitle: 'Push the status bar corners down from the top of the screen',
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 128,
                    step_increment: 1,
                    page_increment: 4,
                }),
            });
            settings.bind(
                'phone-panel-corner-offset',
                panelCornerOffsetRow,
                'value',
                Gio.SettingsBindFlags.DEFAULT
            );
            phoneLayoutGroup.add(panelCornerOffsetRow);
        }

        if (hasKey('edge-back-gesture-enabled')) {
            const edgeBackRow = new Adw.SwitchRow({
                title: 'Edge swipe back gesture',
                subtitle: 'Swipe inward from the left or right screen edge to go back',
            });
            settings.bind(
                'edge-back-gesture-enabled',
                edgeBackRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            phoneLayoutGroup.add(edgeBackRow);
        }

        // --- Auto-Rotate ---
        if (hasKey('auto-rotate-tilt-lock')) {
            const rotateGroup = new Adw.PreferencesGroup({
                title: 'Auto-Rotate',
            });
            phonePage.add(rotateGroup);

            const tiltLockRow = new Adw.SwitchRow({
                title: 'Suppress rotation when lying down',
                subtitle: 'Prevent unwanted screen rotation when the phone is flat, such as when lying on your side',
            });
            settings.bind(
                'auto-rotate-tilt-lock',
                tiltLockRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            rotateGroup.add(tiltLockRow);
        }

        // --- Notification Panel ---
        const notifPanelGroup = new Adw.PreferencesGroup({
            title: 'Notification Panel',
            description: 'Phone notification panel behaviour',
        });
        phonePage.add(notifPanelGroup);

        if (hasKey('tray-notification-enabled')) {
            const trayNotifRow = new Adw.SwitchRow({
                title: 'Tray area notification',
                subtitle: 'Show system tray icons as a persistent notification with interactive menus',
            });
            settings.bind(
                'tray-notification-enabled',
                trayNotifRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            notifPanelGroup.add(trayNotifRow);
        }

        if (hasKey('notification-panel-scale-phone')) {
            const phonePanelScaleRow = new Adw.SpinRow({
                title: 'Panel scale in phone mode',
                subtitle: 'Scale the full notification panel UI in phone mode (50 to 200%)',
                adjustment: new Gtk.Adjustment({
                    lower: 50,
                    upper: 200,
                    step_increment: 5,
                    page_increment: 10,
                }),
            });
            settings.bind(
                'notification-panel-scale-phone',
                phonePanelScaleRow,
                'value',
                Gio.SettingsBindFlags.DEFAULT
            );
            notifPanelGroup.add(phonePanelScaleRow);
        }

        // --- Vibration ---
        const vibrationGroup = new Adw.PreferencesGroup({
            title: 'Vibration',
            description: 'Haptic feedback intensity and triggers',
        });
        phonePage.add(vibrationGroup);

        if (hasKey('vibration-intensity')) {
            const vibIntensityRow = new Adw.SpinRow({
                title: 'Vibration intensity',
                subtitle: 'Strength of haptic feedback (0 = off, 100 = max)',
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 100,
                    step_increment: 5,
                    page_increment: 10,
                }),
            });
            settings.bind(
                'vibration-intensity',
                vibIntensityRow,
                'value',
                Gio.SettingsBindFlags.DEFAULT
            );
            vibrationGroup.add(vibIntensityRow);
        }

        if (hasKey('vibration-on-keypress')) {
            const vibKeypressRow = new Adw.SwitchRow({
                title: 'Vibrate on keypress',
                subtitle: 'Short buzz when pressing keys on the on-screen keyboard',
            });
            settings.bind(
                'vibration-on-keypress',
                vibKeypressRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            vibrationGroup.add(vibKeypressRow);
        }

        if (hasKey('vibration-on-slider-change')) {
            const vibSliderRow = new Adw.SwitchRow({
                title: 'Vibrate on alert slider',
                subtitle: 'Short buzz when the hardware tri-state toggle is moved',
            });
            settings.bind(
                'vibration-on-slider-change',
                vibSliderRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            vibrationGroup.add(vibSliderRow);
        }

        // --- Volume OSD ---
        if (hasKey('volume-osd-side')) {
            const volumeOsdGroup = new Adw.PreferencesGroup({
                title: 'Volume OSD',
                description: 'Android-style volume slider overlay',
            });
            phonePage.add(volumeOsdGroup);

            const sideModel = new Gtk.StringList();
            sideModel.append('Left');
            sideModel.append('Right');
            const sideRow = new Adw.ComboRow({
                title: 'Volume slider side',
                subtitle: 'Screen edge where the volume slider appears',
                model: sideModel,
            });
            let currentSide = settings.get_string('volume-osd-side');
            sideRow.selected = currentSide === 'right' ? 1 : 0;
            sideRow.connect('notify::selected', () => {
                settings.set_string('volume-osd-side', sideRow.selected === 1 ? 'right' : 'left');
            });
            volumeOsdGroup.add(sideRow);
        }

        // --- Home Screen tab ---
        const homescreenPage = new Adw.PreferencesPage({
            title: 'Home Screen',
            icon_name: 'user-home-symbolic',
        });
        homescreenPage.set_name('homescreen');
        pageByName.set('homescreen', homescreenPage);
        pageByName.set('widgets', homescreenPage);
        window.add(homescreenPage);

        if (hasKey('home-feedback-sounds')) {
            const homeSoundsGroup = new Adw.PreferencesGroup({
                title: 'Sounds',
            });
            homescreenPage.add(homeSoundsGroup);

            const homeFeedbackRow = new Adw.SwitchRow({
                title: 'Home feedback sounds',
                subtitle: 'Play subtle sounds for home drag, page snap, and drop actions',
            });
            settings.bind(
                'home-feedback-sounds',
                homeFeedbackRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            homeSoundsGroup.add(homeFeedbackRow);
        }

        buildWidgetPreferenceSections({
            settings,
            hasKey,
            page: homescreenPage,
            window,
            helpers: {
                createIconChooserRow: _createIconChooserRow,
                gtk: { Adw, Gtk, Gio },
            },
        });
        // --- Debugging tab ---
        const debugPage = new Adw.PreferencesPage({
            title: 'Debugging',
            icon_name: 'preferences-other-symbolic',
        });
        debugPage.set_name('debug');
        pageByName.set('debug', debugPage);
        window.add(debugPage);

        const debugGroup = new Adw.PreferencesGroup({
            title: 'Display Detection',
            description: 'Tools for verifying device and display classification',
        });
        debugPage.add(debugGroup);

        const debugLabelRow = new Adw.SwitchRow({
            title: 'Show display debug label',
            subtitle: 'Display the detected host type and display mode in the top panel',
        });
        settings.bind(
            'show-display-debug-label',
            debugLabelRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        debugGroup.add(debugLabelRow);

        const logGroup = new Adw.PreferencesGroup({
            title: 'Log Settings',
        });
        debugPage.add(logGroup);

        const logLevelRow = new Adw.ComboRow({
            title: 'Log verbosity',
            subtitle: 'Controls how much the extension logs to journal',
            model: new Gtk.StringList({ strings: ['Warnings and errors', 'Info', 'Debug'] }),
        });
        const logLevelToIndex = { warn: 0, info: 1, debug: 2, error: 0 };
        const indexToLogLevel = ['warn', 'info', 'debug'];
        logLevelRow.set_selected(logLevelToIndex[settings.get_string('debug-log-level')] ?? 0);
        logLevelRow.connect('notify::selected', () => {
            settings.set_string(
                'debug-log-level',
                indexToLogLevel[logLevelRow.get_selected()] ?? 'warn');
        });
        settings.connect('changed::debug-log-level', () => {
            logLevelRow.set_selected(logLevelToIndex[settings.get_string('debug-log-level')] ?? 0);
        });
        logGroup.add(logLevelRow);

        const mockNotifsRow = new Adw.SwitchRow({
            title: 'Show mock notifications',
            subtitle: 'Inject sample notifications into the QS notification list for testing',
        });
        settings.bind(
            'debug-mock-notifications',
            mockNotifsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        logGroup.add(mockNotifsRow);

        if (hasKey('debug-show-app-memory')) {
            const appMemoryRow = new Adw.SwitchRow({
                title: 'Show app memory usage',
                subtitle: 'Display RAM usage next to app names in recent apps',
            });
            settings.bind(
                'debug-show-app-memory',
                appMemoryRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            logGroup.add(appMemoryRow);
        }

        // --- USB Mode ---
        if (hasKey('usb-mode') && GLib.file_test('/sys/kernel/debug/usb/a600000.usb/mode', GLib.FileTest.EXISTS)) {
            const usbGroup = new Adw.PreferencesGroup({
                title: 'USB Mode',
                description: 'Control USB host/device role. Use "Host" to connect keyboards, mice, hubs, and displays. Use "Device" for charging and USB tethering.',
            });
            debugPage.add(usbGroup);

            const usbModeRow = new Adw.ComboRow({
                title: 'USB mode',
                subtitle: 'Requires replug after switching',
                model: new Gtk.StringList({ strings: ['Default (no interference)', 'Host (peripherals)', 'Device (charging)'] }),
            });
            const usbModeToIndex = { 'default': 0, host: 1, device: 2 };
            const indexToUsbMode = ['default', 'host', 'device'];
            usbModeRow.set_selected(usbModeToIndex[settings.get_string('usb-mode')] ?? 0);
            usbModeRow.connect('notify::selected', () => {
                settings.set_string(
                    'usb-mode',
                    indexToUsbMode[usbModeRow.get_selected()] ?? 'auto');
            });
            settings.connect('changed::usb-mode', () => {
                usbModeRow.set_selected(usbModeToIndex[settings.get_string('usb-mode')] ?? 0);
            });
            usbGroup.add(usbModeRow);
        }

        // --- Browser Compatibility ---
        const browserGroup = new Adw.PreferencesGroup({
            title: 'Browser Compatibility',
            description: 'Chromium-based browsers may not trigger the on-screen keyboard. '
                + 'Copy the recommended flags and add them to the appropriate config file.',
        });
        debugPage.add(browserGroup);

        const chromiumFlags = [
            '--enable-wayland-ime',
            '--wayland-text-input-version=3',
        ].join('\n');

        const flagsRow = new Adw.ActionRow({
            title: 'Chromium / Chrome / Electron flags',
            subtitle: 'Add to ~/.config/chromium-flags.conf (or chrome-flags.conf, electron-flags.conf)',
        });
        const copyFlagsBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Copy flags to clipboard',
        });
        copyFlagsBtn.connect('clicked', () => {
            let display = Gdk.Display.get_default();
            let clipboard = display.get_clipboard();
            clipboard.set(chromiumFlags);
        });
        flagsRow.add_suffix(copyFlagsBtn);
        browserGroup.add(flagsRow);

        // --- Demo Mode ---
        if (hasKey('demo-mode')) {
            const demoGroup = new Adw.PreferencesGroup({
                title: 'Demo Mode',
                description: 'Simulate phone UI state for screenshots and testing',
            });
            debugPage.add(demoGroup);

            const demoModeRow = new Adw.SwitchRow({
                title: 'Demo mode',
                subtitle: 'Show fake signal, battery, and clock values in the status bar',
            });
            settings.bind(
                'demo-mode',
                demoModeRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            demoGroup.add(demoModeRow);
        }

        // Deep-link support for runtime navigation
        if (hasKey('prefs-open-page')) {
            try {
                let target = settings.get_string('prefs-open-page');
                if (target?.startsWith?.('widget:')) {
                    let instanceId = target.slice('widget:'.length).trim();
                    let widgetWindow = openWidgetSettingsWindow({
                        settings,
                        instanceId,
                    });
                    widgetWindow.connect('close-request', () => {
                        window.close();
                        return false;
                    });
                    widgetWindow.present();
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        window.hide();
                        return GLib.SOURCE_REMOVE;
                    });
                } else if (target && pageByName.has(target)) {
                    let targetPage = pageByName.get(target);
                    try {
                        window.set_visible_page(targetPage);
                    } catch (_e) {
                        window.set_visible_page_name?.(target);
                    }
                }
                settings.set_string('prefs-open-page', '');
            } catch (_e) {
                // Ignore invalid/unsupported page requests.
            }
        }

        // Prevent auto-focus on text input widgets (avoids OSK popup on phones)
        window.set_focus(null);
        let mapId = window.connect('map', () => {
            window.set_focus(null);
            window.disconnect(mapId);
        });

        // Pre-warm icon cache in background
        _getSystemIcons();
        window.connect('close-request', () => {
            _clearIconCache();
            return false;
        });
    }
}
