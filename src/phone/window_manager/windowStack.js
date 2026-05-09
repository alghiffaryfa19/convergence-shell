// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isWindowMaximized } from '../../shared/utilities/uiUtils.js';

/**
 * WindowStack -- workspace-free window management for phone displays.
 *
 * Manages an ordered stack of windows on the phone monitor. Only one
 * window is visible at a time (the "active" window). All phone windows
 * are made sticky (appear on all Mutter workspaces) so they are not
 * affected by desktop workspace switches during convergence.
 */
export class WindowStack {
    /**
     * @param {Object} controller - convergence controller instance
     * @param {Object} [opts]
     * @param {number} [opts.monitorIndex]
     */
    constructor(controller, opts = {}) {
        this._controller = controller;
        this._monitorIndex = Number.isInteger(opts.monitorIndex) ? opts.monitorIndex : null;
        this._records = new Map();
        this._syncScheduled = false;
        this._onActiveChanged = null;
    }

    /**
     * Monitor index for the phone's built-in display.
     * In standalone mode this is the primary monitor.
     * In convergence mode it is the secondary (built-in) monitor.
     */
    get monitorIndex() {
        let monitors = Main.layoutManager.monitors;
        let preferredIndex = this._monitorIndex;
        if (!Number.isInteger(preferredIndex))
            preferredIndex = this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex;
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < monitors.length)
            return preferredIndex;
        return Main.layoutManager.primaryIndex;
    }

    /**
     * True when the phone window stack should be the active window
     * management model (phone or tablet host).
     */
    get isActive() {
        let dc = this._controller.displayConfig;
        let role = this._controller?.getMonitorRole?.(this.monitorIndex);
        return role === 'phone' ||
            dc?.hostType === 'phone' ||
            dc?.hostType === 'tablet';
    }

    /** True when in convergence mode (phone + external display). */
    get isConvergenceMode() {
        return this.isActive && !this._controller.displayConfig?.isSingleMonitor;
    }

    _resolveMonitorIndex(monitorIndex = null) {
        let monitors = Main.layoutManager.monitors ?? [];
        let preferredIndex = Number.isInteger(monitorIndex) ? monitorIndex : this.monitorIndex;
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < monitors.length)
            return preferredIndex;
        return this.monitorIndex;
    }

    _getRecord(monitorIndex = null, create = true) {
        let resolvedMonitorIndex = this._resolveMonitorIndex(monitorIndex);
        let record = this._records.get(resolvedMonitorIndex) ?? null;
        if (!record && create) {
            record = {
                stack: [],
                activeIndex: -1,
                splitWindows: null,
            };
            this._records.set(resolvedMonitorIndex, record);
        }
        return record;
    }

    _findRecordForWindow(metaWindow) {
        for (let [monitorIndex, record] of this._records) {
            if (record.stack.includes(metaWindow))
                return { monitorIndex, record };
        }
        return null;
    }

    getWindowMonitorIndex(metaWindow) {
        return this._findRecordForWindow(metaWindow)?.monitorIndex ?? null;
    }

    migrateRecords(fromMonitorIndices = [], toMonitorIndex = null) {
        let targetMonitorIndex = this._resolveMonitorIndex(toMonitorIndex);
        let targetRecord = this._getRecord(targetMonitorIndex);
        let migrated = false;

        for (let sourceMonitorIndex of fromMonitorIndices) {
            if (!Number.isInteger(sourceMonitorIndex) || sourceMonitorIndex === targetMonitorIndex)
                continue;

            let sourceRecord = this._getRecord(sourceMonitorIndex, false);
            if (!sourceRecord)
                continue;

            let sourceActiveWindow =
                sourceRecord.activeIndex >= 0 &&
                sourceRecord.activeIndex < sourceRecord.stack.length
                    ? sourceRecord.stack[sourceRecord.activeIndex]
                    : null;

            if (sourceRecord.splitWindows) {
                for (let splitWindow of sourceRecord.splitWindows) {
                    try {
                        if (!isWindowMaximized(splitWindow))
                            splitWindow.maximize(Meta.MaximizeFlags.BOTH);
                    } catch (_e) {}
                }
                sourceRecord.splitWindows = null;
            }

            for (let metaWindow of sourceRecord.stack) {
                if (!targetRecord.stack.includes(metaWindow))
                    targetRecord.stack.push(metaWindow);

                try {
                    if (!metaWindow.is_on_all_workspaces())
                        metaWindow.stick();
                } catch (_e) {}

                try {
                    metaWindow.move_to_monitor?.(targetMonitorIndex);
                } catch (_e) {}
            }

            if (sourceActiveWindow) {
                let nextActiveIndex = targetRecord.stack.indexOf(sourceActiveWindow);
                if (nextActiveIndex >= 0)
                    targetRecord.activeIndex = nextActiveIndex;
            } else if (targetRecord.activeIndex < 0 && targetRecord.stack.length > 0) {
                targetRecord.activeIndex = targetRecord.stack.length - 1;
            }

            this._records.delete(sourceMonitorIndex);
            migrated = true;
        }

        if (migrated) {
            this._scheduleSyncVisibility();
            this._notifyActiveChanged(targetMonitorIndex);
        }
    }

    /**
     * Add a new window to the stack and make it active.
     * @param {Meta.Window} metaWindow
     */
    pushWindow(metaWindow, monitorIndex = null) {
        // Prefer the caller-specified monitor (the phone monitor) over
        // the window's current monitor, which may be the primary desktop
        // monitor when first mapped in convergence mode.
        let targetMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (Number.isInteger(metaWindow?.get_monitor?.()) ? metaWindow.get_monitor() : null);
        let record = this._getRecord(targetMonitorIndex);
        if (!record || record.stack.includes(metaWindow))
            return;

        record.stack.push(metaWindow);
        record.activeIndex = record.stack.length - 1;

        if (!metaWindow.is_on_all_workspaces())
            metaWindow.stick();

        // Ensure the window is on the target phone monitor before
        // maximizing — otherwise maximize uses the primary (desktop)
        // monitor dimensions.
        if (Number.isInteger(targetMonitorIndex) &&
            metaWindow.get_monitor() !== targetMonitorIndex)
            metaWindow.move_to_monitor(targetMonitorIndex);

        if (!record.splitWindows?.has(metaWindow) && !isWindowMaximized(metaWindow))
            metaWindow.maximize(Meta.MaximizeFlags.BOTH);

        this._scheduleSyncVisibility();
        this._notifyActiveChanged(targetMonitorIndex);
    }

    /**
     * Remove a window from the stack (window closing).
     * @param {Meta.Window} metaWindow
     */
    removeWindow(metaWindow, monitorIndex = null) {
        let found = this._findRecordForWindow(metaWindow);
        let targetMonitorIndex = found?.monitorIndex ?? monitorIndex;
        let record = found?.record ?? this._getRecord(targetMonitorIndex, false);
        if (!record)
            return;
        let idx = record.stack.indexOf(metaWindow);
        if (idx < 0)
            return;

        record.stack.splice(idx, 1);
        record.splitWindows?.delete(metaWindow);

        if (record.stack.length === 0) {
            record.activeIndex = -1;
            record.splitWindows = null;
            if (Number.isInteger(targetMonitorIndex))
                this._records.delete(targetMonitorIndex);
        } else if (idx <= record.activeIndex) {
            record.activeIndex = Math.max(0, record.activeIndex - 1);
        }

        this._scheduleSyncVisibility();
        this._notifyActiveChanged(targetMonitorIndex);
    }

    /**
     * Check if a window is managed by this stack.
     * @param {Meta.Window} metaWindow
     * @returns {boolean}
     */
    hasWindow(metaWindow, monitorIndex = null) {
        if (Number.isInteger(monitorIndex))
            return this._getRecord(monitorIndex, false)?.stack.includes(metaWindow) ?? false;
        return !!this._findRecordForWindow(metaWindow);
    }

    /**
     * Bring a window to the top and make it the active (visible) window.
     * @param {Meta.Window} metaWindow
     */
    activateWindow(metaWindow, monitorIndex = null) {
        let found = this._findRecordForWindow(metaWindow);
        let targetMonitorIndex = found?.monitorIndex ?? monitorIndex;
        let record = found?.record ?? this._getRecord(targetMonitorIndex, false);
        if (!record)
            return;
        let idx = record.stack.indexOf(metaWindow);
        if (idx < 0)
            return;

        if (record.splitWindows && !record.splitWindows.has(metaWindow))
            this.exitSplitMode(targetMonitorIndex);

        record.stack.splice(idx, 1);
        record.stack.push(metaWindow);
        record.activeIndex = record.stack.length - 1;

        if (metaWindow.minimized)
            metaWindow.unminimize();

        if (!record.splitWindows?.has(metaWindow) && !isWindowMaximized(metaWindow))
            metaWindow.maximize(Meta.MaximizeFlags.BOTH);

        metaWindow.activate(global.get_current_time());
        this.syncVisibility();
        this._notifyActiveChanged(targetMonitorIndex);
    }

    /**
     * Focus a window by stack index without reordering the stack.
     * Used by the pill swipe gesture to keep stable stack ordering.
     * @param {number} index
     */
    focusWindowAtIndex(index, monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record || index < 0 || index >= record.stack.length)
            return;
        let metaWindow = record.stack[index];

        if (record.splitWindows && !record.splitWindows.has(metaWindow))
            this.exitSplitMode(monitorIndex);

        record.activeIndex = index;

        if (!record.splitWindows?.has(metaWindow) && !isWindowMaximized(metaWindow))
            metaWindow.maximize(Meta.MaximizeFlags.BOTH);

        metaWindow.activate(global.get_current_time());
        this.syncVisibility();
        this._notifyActiveChanged(monitorIndex);
    }

    /** Hide all windows and show the home screen. */
    goHome(monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record)
            return;
        if (record.splitWindows)
            this.exitSplitMode(monitorIndex);
        record.activeIndex = -1;
        this._scheduleSyncVisibility();
        this._notifyActiveChanged(monitorIndex);
    }

    /**
     * Get the ordered stack (oldest first, most recent last).
     * @returns {Meta.Window[]}
     */
    getStack(monitorIndex = null) {
        return [...(this._getRecord(monitorIndex, false)?.stack ?? [])];
    }

    /**
     * Get the currently active (visible) window, or null if on home screen.
     * @returns {Meta.Window|null}
     */
    getActiveWindow(monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record || record.activeIndex < 0 || record.activeIndex >= record.stack.length)
            return null;
        return record.stack[record.activeIndex];
    }

    /** True if there are any windows in the stack. */
    hasWindows(monitorIndex = null) {
        return (this._getRecord(monitorIndex, false)?.stack.length ?? 0) > 0;
    }

    /** Number of windows in the stack. */
    get length() {
        return this.getStack().length;
    }

    /**
     * Get the previous window in the stack (for swipe-back).
     * @returns {Meta.Window|null}
     */
    getPreviousWindow(monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record || record.activeIndex <= 0)
            return null;
        return record.stack[record.activeIndex - 1];
    }

    /**
     * Get the next window in the stack (for swipe-forward).
     * @returns {Meta.Window|null}
     */
    getNextWindow(monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record || record.activeIndex < 0 || record.activeIndex >= record.stack.length - 1)
            return null;
        return record.stack[record.activeIndex + 1];
    }

    /** Make all stack windows sticky (on all workspaces). */
    stickAll() {
        for (let record of this._records.values()) {
            for (let w of record.stack) {
                if (!w.is_on_all_workspaces())
                    w.stick();
            }
        }
    }

    /** Remove sticky status from all stack windows. */
    unstickAll() {
        for (let record of this._records.values()) {
            for (let w of record.stack) {
                if (w.is_on_all_workspaces())
                    w.unstick();
            }
        }
    }

    /**
     * Absorb all normal windows currently on a given monitor into the stack.
     * Used when an external display disconnects and windows migrate to phone.
     * @param {number} monitorIndex
     */
    absorbWindowsFromMonitor(monitorIndex) {
        for (let actor of global.get_window_actors()) {
            let mw = actor?.get_meta_window?.();
            if (!mw) continue;
            if (mw.is_skip_taskbar()) continue;
            let type = mw.get_window_type();
            if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
                continue;
            if (mw.get_monitor() === monitorIndex && !this.hasWindow(mw, monitorIndex)) {
                let record = this._getRecord(monitorIndex);
                record.stack.push(mw);
                if (!mw.is_on_all_workspaces())
                    mw.stick();
                if (!isWindowMaximized(mw))
                    mw.maximize(Meta.MaximizeFlags.BOTH);
            }
        }
        let record = this._getRecord(monitorIndex, false);
        if (record) {
            if (record.stack.length > 0)
                record.activeIndex = record.stack.length - 1;
            else
                record.activeIndex = -1;
        }

        this._scheduleSyncVisibility();
        this._notifyActiveChanged(monitorIndex);
    }

    /**
     * Release a window from the stack (e.g. dragged to desktop monitor).
     * Unsticks the window so it participates in normal workspace management.
     * @param {Meta.Window} metaWindow
     */
    releaseWindow(metaWindow, monitorIndex = null) {
        let found = this._findRecordForWindow(metaWindow);
        let targetMonitorIndex = found?.monitorIndex ?? monitorIndex;
        let record = found?.record ?? this._getRecord(targetMonitorIndex, false);
        if (!record)
            return;
        let idx = record.stack.indexOf(metaWindow);
        if (idx < 0)
            return;

        record.stack.splice(idx, 1);
        if (metaWindow.is_on_all_workspaces())
            metaWindow.unstick();

        if (record.stack.length === 0) {
            record.activeIndex = -1;
            record.splitWindows = null;
            if (Number.isInteger(targetMonitorIndex))
                this._records.delete(targetMonitorIndex);
        } else if (idx <= record.activeIndex) {
            record.activeIndex = Math.max(0, record.activeIndex - 1);
        }

        this._scheduleSyncVisibility();
        this._notifyActiveChanged(targetMonitorIndex);
    }

    _notifyActiveChanged(monitorIndex = null) {
        if (this._onActiveChanged) {
            let active = this.getActiveWindow(monitorIndex);
            let record = this._getRecord(monitorIndex, false);
            this._onActiveChanged(active, !record || record.activeIndex < 0, this._resolveMonitorIndex(monitorIndex));
        }
    }

    /**
     * Ensure only the active window's compositor actor is visible on the
     * phone monitor. All other stack windows are hidden.
     */
    syncVisibility() {
        this._syncScheduled = false;
        for (let [phoneMon, record] of this._records) {
            let activeWindow = this.getActiveWindow(phoneMon);
            let splitSet = record.splitWindows;

            for (let metaWindow of record.stack) {
                let actor = metaWindow.get_compositor_private?.();
                if (!actor || actor.is_destroyed?.())
                    continue;

                if (metaWindow.get_monitor() !== phoneMon)
                    continue;

                let shouldShow = ((metaWindow === activeWindow) && !metaWindow.minimized)
                    || (splitSet?.has(metaWindow) && !metaWindow.minimized);

                if (shouldShow) {
                    actor.remove_all_transitions();
                    actor.show();
                    actor.opacity = 255;
                    actor.reactive = true;
                    if (actor.scale_x !== 1 || actor.scale_y !== 1) {
                        actor.scale_x = 1;
                        actor.scale_y = 1;
                    }
                    actor.set_pivot_point(0, 0);
                    actor.translation_x = 0;
                    actor.translation_y = 0;
                } else {
                    actor.hide();
                    actor.reactive = false;
                }
            }
        }
    }

    _scheduleSyncVisibility() {
        if (this._syncScheduled)
            return;
        this._syncScheduled = true;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this.syncVisibility();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Re-maximize all windows in the stack. */
    remaxAll() {
        for (let [monitorIndex, record] of this._records) {
            if (record.splitWindows)
                this.exitSplitMode(monitorIndex);
            for (let w of record.stack) {
                if (!isWindowMaximized(w))
                    w.maximize(Meta.MaximizeFlags.BOTH);
            }
        }
    }

    // -- Split-screen support --

    /** True when split-screen mode is active. */
    get isSplitActive() {
        let record = this._getRecord(null, false);
        return record?.splitWindows !== null && record.splitWindows.size === 2;
    }

    hasSplitWindows(monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        return record?.splitWindows !== null && record.splitWindows.size === 2;
    }

    /**
     * Check if a window is one of the split-screen pair.
     * @param {Meta.Window} metaWindow
     * @returns {boolean}
     */
    isSplitWindow(metaWindow, monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        return record?.splitWindows?.has(metaWindow) ?? false;
    }

    /** Return the other split window, or null. */
    getSplitPartner(metaWindow, monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record?.splitWindows?.has(metaWindow))
            return null;
        for (let w of record.splitWindows) {
            if (w !== metaWindow) return w;
        }
        return null;
    }

    /**
     * Pre-register a window as a split candidate.
     * @param {Meta.Window} metaWindow
     */
    markForSplit(metaWindow, monitorIndex = null) {
        let targetMonitorIndex = Number.isInteger(metaWindow?.get_monitor?.())
            ? metaWindow.get_monitor()
            : monitorIndex;
        let record = this._getRecord(targetMonitorIndex);
        if (!record.splitWindows)
            record.splitWindows = new Set();
        record.splitWindows.add(metaWindow);
    }

    /**
     * Enter split-screen mode with two windows.
     * @param {Meta.Window} window1
     * @param {Meta.Window} window2
     */
    enterSplitMode(window1, window2, monitorIndex = null) {
        let targetMonitorIndex = Number.isInteger(window2?.get_monitor?.())
            ? window2.get_monitor()
            : monitorIndex;
        let record = this._getRecord(targetMonitorIndex);
        record.splitWindows = new Set([window1, window2]);
        let idx = record.stack.indexOf(window2);
        if (idx >= 0)
            record.activeIndex = idx;
        this.syncVisibility();
    }

    /** Exit split-screen mode. Re-maximizes the split windows. */
    exitSplitMode(monitorIndex = null) {
        let record = this._getRecord(monitorIndex, false);
        if (!record?.splitWindows)
            return;
        let windows = [...record.splitWindows];
        record.splitWindows = null;
        for (let w of windows) {
            let actor = w.get_compositor_private?.();
            if (!actor || actor.is_destroyed?.())
                continue;
            if (!isWindowMaximized(w))
                w.maximize(Meta.MaximizeFlags.BOTH);
        }
        this._scheduleSyncVisibility();
    }

    /** Clean up: unstick all windows and clear the stack. */
    setMonitorIndex(monitorIndex = null) {
        this._monitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        this._scheduleSyncVisibility();
        this._notifyActiveChanged(monitorIndex);
    }

    /** Clean up: unstick all windows and clear the stack. */
    destroy() {
        for (let [monitorIndex, record] of this._records) {
            if (record.splitWindows)
                this.exitSplitMode(monitorIndex);
        }
        this.unstickAll();
        this._records.clear();
        this._controller = null;
    }
}
