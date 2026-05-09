// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';

function _requireShellEnv(runtimeEnv) {
    let St = runtimeEnv?.St ?? null;
    let Clutter = runtimeEnv?.Clutter ?? null;
    if (!St || !Clutter)
        throw new Error('At a Glance widget requires shell runtime env');
    return { St, Clutter };
}

function _activateCalendar(runtimeEnv, home) {
    let appSystem = runtimeEnv?.Shell?.AppSystem?.get_default?.() ?? null;
    if (!appSystem)
        return false;
    let calendarApp = appSystem.lookup_app('org.gnome.Calendar.desktop') ||
        appSystem.lookup_app('gnome-calendar.desktop');
    if (calendarApp) {
        calendarApp.activate();
        return true;
    }
    home?._openSystemControlCenter?.('datetime');
    return true;
}

export const AT_A_GLANCE_WIDGET_DEFINITION = {
    widgetType: 'at_a_glance',
    label: 'At a Glance',
    description: 'Date, weather and next info',
    defaultColSpan: 4,
    defaultRowSpan: 1,
    minColSpan: 3,
    minRowSpan: 1,

    buildPreview({ runtimeEnv }) {
        let { St, Clutter } = _requireShellEnv(runtimeEnv);
        let box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let now = GLib.DateTime.new_now_local();
        box.add_child(new St.Label({
            text: now ? now.format('%A, %B %e') : 'Today',
            style: 'color: white; font-size: 14px; font-weight: 600; text-align: left;',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        }));
        box.add_child(new St.Label({
            text: '\u26C5 12\u00B0  Partly Cloudy',
            style: 'color: rgba(255,255,255,0.8); font-size: 12px; margin-top: 4px;',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        }));
        return box;
    },

    onActivate({ home, runtimeEnv }) {
        return _activateCalendar(runtimeEnv, home);
    },
};
