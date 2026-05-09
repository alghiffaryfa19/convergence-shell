// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { VolumeOsdWidget } from './volumeOsdWidget.js';

const AUTO_HIDE_MS = 2500;

/**
 * VolumeOsd — intercepts GNOME's OSD on phone monitors and shows an
 * Android-style vertical volume slider instead.
 *
 * Only volume-related OSDs (icons starting with 'audio-volume') are
 * intercepted; brightness and other OSDs pass through to the default.
 */
export class VolumeOsd {
    /**
     * @param {object} controller - Convergence controller
     * @param {Gio.Settings} settings - Extension settings
     */
    constructor(controller, settings) {
        this._controller = controller;
        this._settings = settings;
        this._widgets = new Map(); // monitorIndex -> VolumeOsdWidget
        this._hideTimeoutId = 0;
        this._destroyed = false;
        this._side = 'left';

        this._maxLevel = 1.0;

        try {
            this._side = settings.get_string('volume-osd-side') || 'left';
        } catch (_e) {}

        this._settingsSignalId = settings.connect('changed::volume-osd-side', () => {
            try {
                this._side = settings.get_string('volume-osd-side') || 'left';
            } catch (_e) {}
            for (let [, widget] of this._widgets)
                widget.side = this._side;
        });

        this._interceptOsd();
    }

    // ── OSD interception ──────────────────────────────────────────────

    _interceptOsd() {
        let mgr = Main.osdWindowManager;
        if (!mgr) return;

        // GNOME 49 has show() on the manager
        if (typeof mgr.show === 'function') {
            this._origShow = mgr.show.bind(mgr);
            mgr.show = (monitorIndex, icon, label, level, maxLevel) => {
                if (this._shouldIntercept(monitorIndex, icon))
                    this._onOsdShow(monitorIndex, icon, label, level, maxLevel);
                else
                    this._origShow(monitorIndex, icon, label, level, maxLevel);
            };
        }

        // Some GNOME 49 builds also expose showOne / showAll
        if (typeof mgr.showOne === 'function') {
            this._origShowOne = mgr.showOne.bind(mgr);
            mgr.showOne = (monitorIndex, icon, label, level, maxLevel) => {
                if (this._shouldIntercept(monitorIndex, icon))
                    this._onOsdShow(monitorIndex, icon, label, level, maxLevel);
                else
                    this._origShowOne(monitorIndex, icon, label, level, maxLevel);
            };
        }

        if (typeof mgr.showAll === 'function') {
            this._origShowAll = mgr.showAll.bind(mgr);
            mgr.showAll = (icon, label, level, maxLevel) => {
                // showAll targets every monitor — intercept phone ones
                let phoneIndices = this._controller?.getPhoneMonitorIndices?.() ?? [];
                let intercepted = false;
                for (let idx of phoneIndices) {
                    if (this._isVolumeIcon(icon)) {
                        this._onOsdShow(idx, icon, label, level, maxLevel);
                        intercepted = true;
                    }
                }
                if (!intercepted)
                    this._origShowAll(icon, label, level, maxLevel);
            };
        }
    }

    _restoreOsd() {
        let mgr = Main.osdWindowManager;
        if (!mgr) return;

        if (this._origShow)
            mgr.show = this._origShow;
        if (this._origShowOne)
            mgr.showOne = this._origShowOne;
        if (this._origShowAll)
            mgr.showAll = this._origShowAll;

        this._origShow = null;
        this._origShowOne = null;
        this._origShowAll = null;
    }

    _shouldIntercept(monitorIndex, icon) {
        if (!this._isVolumeIcon(icon))
            return false;
        let phoneIndices = this._controller?.getPhoneMonitorIndices?.() ?? [];
        return phoneIndices.includes(monitorIndex);
    }

    _isVolumeIcon(icon) {
        if (!icon) return false;
        let name = typeof icon === 'string' ? icon : (icon.get_names?.() ?? []).join('');
        return name.includes('audio-volume');
    }

    // ── OSD display ───────────────────────────────────────────────────

    _onOsdShow(monitorIndex, _icon, _label, level, maxLevel) {
        let widget = this._getOrCreateWidget(monitorIndex);
        if (!widget) return;

        // maxLevel > 1 means overamplification is active (e.g. 1.5 for 150%)
        // maxLevel of -1 or undefined means no max was provided
        let effectiveMax = (maxLevel && maxLevel > 1) ? maxLevel : 1.0;
        this._maxLevel = effectiveMax;
        widget.maxValue = effectiveMax;
        widget.value = level;
        this._positionWidget(widget, monitorIndex);
        widget.show(this._side);
        this._resetHideTimer();
    }

    _getOrCreateWidget(monitorIndex) {
        if (this._widgets.has(monitorIndex))
            return this._widgets.get(monitorIndex);

        let widget = new VolumeOsdWidget({
            side: this._side,
            maxValue: this._maxLevel,
            onValueChanged: (value) => this._onSliderChanged(monitorIndex, value),
            onInteraction: () => this._resetHideTimer(),
        });

        Main.uiGroup.add_child(widget.actor);
        this._widgets.set(monitorIndex, widget);
        return widget;
    }

    _positionWidget(widget, monitorIndex) {
        let monitors = Main.layoutManager.monitors ?? [];
        let monitor = monitors[monitorIndex];
        if (!monitor) return;
        let topInset = this._controller?.getPhoneTopInset?.(monitorIndex) ?? 0;
        widget.position(monitor, topInset);
    }

    _onSliderChanged(monitorIndex, value) {
        // Sync to GNOME's volume control
        let volumeSlider = this._findGnomeVolumeSlider();
        if (volumeSlider)
            volumeSlider.value = value;
    }

    _findGnomeVolumeSlider() {
        // Try through the quick settings volume output indicator
        try {
            let qs = Main.panel?.statusArea?.quickSettings;
            if (!qs) return null;

            // Walk through quick settings items looking for the volume slider
            let items = qs._indicators?.get_children?.() ?? [];
            for (let indicator of items) {
                let qsItems = indicator.quickSettingsItems ?? [];
                for (let item of qsItems) {
                    if (item._output || item._slider) {
                        // OutputStreamSlider
                        let slider = item._slider ?? null;
                        if (slider) return slider;
                    }
                }
            }

            // Alternative: look for the volume output in the menu
            let menuItems = qs.menu?._grid?.get_children?.() ?? [];
            for (let child of menuItems) {
                if (child.constructor?.name?.includes?.('OutputStreamSlider') ||
                    child.constructor?.name?.includes?.('StreamSlider')) {
                    let innerBox = child.get_first_child?.();
                    if (!innerBox) continue;
                    for (let ch of (innerBox.get_children?.() ?? [])) {
                        if (ch.value !== undefined) return ch;
                        let nested = ch.get_first_child?.();
                        if (nested?.value !== undefined) return nested;
                    }
                }
            }
        } catch (_e) {}
        return null;
    }

    // ── Auto-hide timer ───────────────────────────────────────────────

    _resetHideTimer() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTO_HIDE_MS, () => {
            this._hideTimeoutId = 0;
            this._hideAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideAll() {
        for (let [, widget] of this._widgets)
            widget.hide();
    }

    // ── Relayout ──────────────────────────────────────────────────────

    relayout() {
        for (let [monitorIndex, widget] of this._widgets)
            this._positionWidget(widget, monitorIndex);
    }

    // ── Cleanup ───────────────────────────────────────────────────────

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }

        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        this._restoreOsd();

        for (let [, widget] of this._widgets)
            widget.destroy();
        this._widgets.clear();
    }
}
