// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import { getWidgetPreference } from './widgetInstanceStore.js';
import { RuntimeDisposer } from '../../utilities/runtimeDisposer.js';

let Clutter = null;
let St = null;

function _bindShellEnv(runtimeEnv) {
    Clutter = runtimeEnv?.Clutter ?? Clutter;
    St = runtimeEnv?.St ?? St;
    if (!Clutter || !St)
        throw new Error('Clock widget requires shell runtime env');
}

/**
 * Clock widget for the home screen. Displays the current time and date,
 * respecting the clock-format (12h/24h) and show-seconds settings.
 */
export class ClockWidget {
    /**
     * @param {Gio.Settings|null} settings - Extension settings.
     */
    constructor(settings, item = null) {
        this._settings = settings ?? null;
        this._item = item ?? null;
        this._runtimeEnv = null;
        this._timeLabel = null;
        this._dateLabel = null;
        this._wallClock = null;
        this._runtimeDisposer = new RuntimeDisposer();
    }

    /**
     * Build the clock widget content.
     * @param {number} _w - Available width.
     * @param {number} _h - Available height.
     * @returns {St.Widget} The clock content actor.
     */
    buildContent(_w, _h, _colSpan, _rowSpan, _monitor, _gridMetrics, runtimeEnv = null) {
        this._runtimeEnv = runtimeEnv ?? this._runtimeEnv;
        _bindShellEnv(this._runtimeEnv);
        let box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'convergence-widget-clock-content',
        });

        this._timeLabel = new St.Label({
            style_class: 'convergence-widget-clock-time',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._timeLabel);

        this._dateLabel = new St.Label({
            style_class: 'convergence-widget-clock-date',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._dateLabel);

        this._updateClock();

        this._wallClock = new GnomeDesktop.WallClock();
        this._runtimeDisposer.replaceConnection(this, '_wallClockId', this._wallClock, 'notify::clock', () => {
            this._updateClock();
            this._restartSecondsTimer();
        });
        this._restartSecondsTimer();

        if (this._settings) {
            for (let key of ['widget-clock-format', 'widget-clock-show-seconds']) {
                try {
                    this._runtimeDisposer.connect(this._settings, `changed::${key}`, () => this._updateClock());
                } catch (_e) {}
            }
        }

        return box;
    }

    _showsSeconds() {
        let widgetValue = getWidgetPreference(this._item, 'showSeconds', null);
        if (typeof widgetValue === 'boolean')
            return widgetValue;
        try {
            if (this._settings)
                return this._settings.get_boolean('widget-clock-show-seconds');
        } catch (_e) {}
        return true;
    }

    _restartSecondsTimer() {
        this._runtimeDisposer.clearTimeoutRef(this, '_secondsTimerId');
        if (!this._showsSeconds()) return;
        let id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
        this._secondsTimerId = id;
        this._runtimeDisposer.trackTimeout(id);
    }

    _getTimeFormat() {
        let use12h = false;
        let showSeconds = true;
        let widgetFormat = getWidgetPreference(this._item, 'format', null);
        let widgetShowSeconds = getWidgetPreference(this._item, 'showSeconds', null);
        try {
            if (this._settings) {
                use12h = (widgetFormat ?? this._settings.get_string('widget-clock-format')) === '12h';
                showSeconds = widgetShowSeconds ?? this._settings.get_boolean('widget-clock-show-seconds');
            }
        } catch (_e) {}

        if (widgetFormat != null)
            use12h = widgetFormat === '12h';
        if (widgetShowSeconds != null)
            showSeconds = !!widgetShowSeconds;

        if (use12h)
            return showSeconds ? '%I:%M:%S %p' : '%I:%M %p';
        return showSeconds ? '%H:%M:%S' : '%H:%M';
    }

    _updateClock() {
        let now = GLib.DateTime.new_now_local();
        if (now) {
            if (this._timeLabel)
                this._timeLabel.set_text(now.format(this._getTimeFormat()));
            if (this._dateLabel)
                this._dateLabel.set_text(now.format('%A, %B %e'));
        }
    }

    /** @returns {St.Label|null} */
    getTimeLabel() { return this._timeLabel; }

    /** @returns {St.Label|null} */
    getDateLabel() { return this._dateLabel; }

    /** Destroy the clock widget and free resources. */
    destroy() {
        this._runtimeDisposer?.dispose?.();
        this._wallClock = null;
        this._runtimeDisposer = null;
        this._settings = null;
        this._timeLabel = null;
        this._dateLabel = null;
    }
}

function _buildClockPreview({ runtimeEnv }) {
    _bindShellEnv(runtimeEnv);
    let box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    let now = GLib.DateTime.new_now_local();
    box.add_child(new St.Label({
        text: now ? now.format('%H:%M:%S') : '12:00:00',
        style: 'color: white; font-size: 36px; font-weight: 200; text-align: center;',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(new St.Label({
        text: now ? now.format('%A, %B %e') : 'Monday, January 1',
        style: 'color: rgba(255,255,255,0.7); font-size: 13px; margin-top: 2px;',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    return box;
}

function _activateClock({ runtimeEnv }) {
    let appSystem = runtimeEnv?.Shell?.AppSystem?.get_default?.() ?? null;
    let app = appSystem?.lookup_app?.('org.gnome.clocks.desktop') ||
        appSystem?.lookup_app?.('gnome-clocks.desktop');
    if (!app)
        return false;
    app.activate();
    return true;
}

export const CLOCK_WIDGET_DEFINITION = {
    widgetType: 'clock',
    label: 'Clock',
    description: 'Time and date',
    defaultColSpan: 3,
    defaultRowSpan: 1,
    minColSpan: 3,
    minRowSpan: 1,

    createInstance({ settings, widgetItem, runtimeEnv }) {
        let widget = new ClockWidget(settings, widgetItem);
        widget._runtimeEnv = runtimeEnv ?? null;
        return widget;
    },

    buildPreview({ runtimeEnv }) {
        return _buildClockPreview({ runtimeEnv });
    },

    onActivate(context) {
        return _activateClock(context);
    },

    buildPreferences({ settings, hasKey, page, helpers }) {
        let { Adw, Gtk, Gio } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'Clock Widget',
            description: 'Configure the clock widget on the home screen',
        });
        let added = false;

        if (hasKey('widget-clock-format')) {
            let clockFormatRow = new Adw.ComboRow({
                title: 'Time format',
                subtitle: 'Choose between 24-hour and 12-hour clock',
                model: new Gtk.StringList({ strings: ['24-hour', '12-hour'] }),
            });
            let formatToIndex = { '24h': 0, '12h': 1 };
            let indexToFormat = ['24h', '12h'];
            clockFormatRow.set_selected(formatToIndex[settings.get_string('widget-clock-format')] ?? 0);
            clockFormatRow.connect('notify::selected', () => {
                settings.set_string('widget-clock-format',
                    indexToFormat[clockFormatRow.get_selected()] ?? '24h');
            });
            settings.connect('changed::widget-clock-format', () => {
                clockFormatRow.set_selected(formatToIndex[settings.get_string('widget-clock-format')] ?? 0);
            });
            group.add(clockFormatRow);
            added = true;
        }

        if (hasKey('widget-clock-show-seconds')) {
            let clockSecondsRow = new Adw.SwitchRow({
                title: 'Show seconds',
                subtitle: 'Display seconds in the clock widget',
            });
            settings.bind(
                'widget-clock-show-seconds',
                clockSecondsRow,
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            group.add(clockSecondsRow);
            added = true;
        }

        if (added)
            page.add(group);
    },

    buildInstanceSettings({ page, store, settings, helpers }) {
        let { Adw } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'Clock',
            description: 'Customize this clock widget instance',
        });
        helpers.addComboPreference(group, {
            title: 'Time format',
            subtitle: 'Choose between 24-hour and 12-hour time',
            options: [
                { label: '24-hour', value: '24h' },
                { label: '12-hour', value: '12h' },
            ],
            getValue: () => store.getPreference('format', settings?.get_string?.('widget-clock-format') ?? '24h'),
            setValue: value => store.setPreference('format', value),
        });
        helpers.addSwitchPreference(group, {
            title: 'Show seconds',
            subtitle: 'Display seconds in this widget instance',
            getValue: () => store.getPreference('showSeconds', settings?.get_boolean?.('widget-clock-show-seconds') ?? true),
            setValue: value => store.setPreference('showSeconds', value),
        });
        page.add(group);
    },
};
