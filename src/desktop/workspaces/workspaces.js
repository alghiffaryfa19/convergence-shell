// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { Logger } from '../../shared/utilities/logger.js';
import { DisplayMode } from '../../shared/utilities/displayConfig.js';

const OVERLAY_TOGGLE_DEBOUNCE_US = 250000;
const OVERLAY_OVERVIEW_SUPPRESS_MS = 260;

/**
 * Desktop-specific workspace management. Handles independent workspaces
 * per monitor, workspace keyboard shortcuts, overview coordination,
 * and window actor visibility for desktop mode.
 */
export class DesktopWorkspaces {
    /**
     * @param {Object} controller - Extension controller
     * @param {Object} settings - GSettings instance
     * @param {Object} displayConfig - DisplayConfig instance
     */
    constructor(controller, settings, displayConfig) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._displayConfig = displayConfig ?? null;
        this._logger = new Logger('DesktopWorkspaces', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();

        this._monitorWorkspaceState = new Map();
        this._lastFocusedMonitor = this._getPrimaryDesktopMonitorIndex();
        this._lastOverlayToggleUs = 0;
        this._monitorGeneration = 0;
        this._monitorLookupCache = {
            x1: 0, y1: 0, x2: 0, y2: 0,
            generation: -1, index: 0,
        };
        this._nativeWorkspaceAnimationSuppressDepth = 0;
        this._suppressNativeWorkspaceAnimation = false;
        this._workspaceAnimationGuardUntilUs = 0;

        this._windowVisibilityDirtyActors = new Set();
        this._windowVisibilityForceFull = false;

        this._protectingVirtualWs = false;

        this._initMonitorWorkspaceState();
    }

    /**
     * Whether independent-per-monitor workspaces are active.
     * @returns {boolean}
     */
    isIndependentWorkspacesActive() {
        if (!this._displayConfig || !this._settings) return false;
        try {
            return this._displayConfig.isLargeDisplay &&
                !this._displayConfig.isSingleMonitor &&
                this._settings.get_boolean('independent-workspaces');
        } catch (_e) {
            return false;
        }
    }

    /**
     * Get the virtual workspace index for a monitor.
     * @param {number} monitorIndex
     * @returns {number|null}
     */
    getMonitorVirtualWs(monitorIndex) {
        let state = this._monitorWorkspaceState.get(monitorIndex);
        return state ? state.activeVirtualWsIndex : null;
    }

    /**
     * Initialize per-monitor workspace state.
     * @private
     */
    _initMonitorWorkspaceState() {
        this._monitorWorkspaceState.clear();
        let primaryIndex = this._getPrimaryDesktopMonitorIndex();
        let nMonitors = Main.layoutManager.monitors.length;
        let needsWs1 = false;

        for (let i = 0; i < nMonitors; i++) {
            let isDesktopMonitor = this._isDesktopMonitor(i);
            let isSecondary = isDesktopMonitor && i !== primaryIndex;
            this._monitorWorkspaceState.set(i, {
                activeVirtualWsIndex: isSecondary ? 1 : 0,
            });
            if (isSecondary) needsWs1 = true;
        }

        if (needsWs1) {
            let wsManager = global.workspace_manager;
            while (wsManager.get_n_workspaces() < 2)
                wsManager.append_new_workspace(false, global.get_current_time());
        }
        this._lastFocusedMonitor = this._getPrimaryDesktopMonitorIndex();
    }

    /**
     * Find the monitor index for given stage coordinates.
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    monitorIndexForCoords(x, y) {
        let cache = this._monitorLookupCache;
        if (cache && cache.generation === this._monitorGeneration) {
            if (x >= cache.x1 && x < cache.x2 &&
                y >= cache.y1 && y < cache.y2)
                return cache.index;
        }

        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let m = monitors[i];
            if (x >= m.x && x < m.x + m.width &&
                y >= m.y && y < m.y + m.height) {
                if (cache) {
                    cache.x1 = m.x; cache.y1 = m.y;
                    cache.x2 = m.x + m.width;
                    cache.y2 = m.y + m.height;
                    cache.generation = this._monitorGeneration;
                    cache.index = i;
                }
                return i;
            }
        }
        return this._getPrimaryDesktopMonitorIndex();
    }

    /**
     * Get the monitor index under the pointer.
     * @returns {number}
     */
    getPointerMonitorIndex() {
        try {
            let [x, y] = global.get_pointer();
            if (Number.isFinite(x) && Number.isFinite(y))
                return this.monitorIndexForCoords(x, y);
        } catch (_e) {}
        return -1;
    }

    /**
     * Read the workspace-shortcut target mode from settings.
     * @returns {'focused'|'pointer'}
     */
    getWorkspaceShortcutTargetMode() {
        try {
            let mode = this._settings?.get_string(
                'workspace-shortcut-target-monitor');
            return mode === 'focused' ? 'focused' : 'pointer';
        } catch (_e) {
            return 'pointer';
        }
    }

    /**
     * Get the target monitor for workspace shortcuts.
     * @returns {number}
     */
    getWorkspaceShortcutTargetMonitor() {
        let mode = this.getWorkspaceShortcutTargetMode();
        if (mode === 'focused') return this._lastFocusedMonitor;
        let pointerMonitor = this.getPointerMonitorIndex();
        if (pointerMonitor >= 0) return pointerMonitor;
        return this._lastFocusedMonitor;
    }

    /**
     * Handle focus-window-changed events to track the last focused monitor.
     */
    onFocusWindowChanged() {
        let focusWin = global.display.get_focus_window();
        if (focusWin) {
            let monIdx = focusWin.get_monitor();
            if (monIdx >= 0)
                this._lastFocusedMonitor = monIdx;
        }
    }

    /**
     * Toggle the app grid from the overlay key (Super).
     * @param {Object} appDrawer - AppMenu/AppDrawer reference
     */
    toggleAppGridFromOverlayKey(appDrawer) {
        if (!appDrawer) return;

        let nowUs = GLib.get_monotonic_time();
        let lastToggleUs = this._lastOverlayToggleUs ?? 0;
        if (lastToggleUs > 0 && (nowUs - lastToggleUs) < OVERLAY_TOGGLE_DEBOUNCE_US)
            return;
        this._lastOverlayToggleUs = nowUs;

        if ('hasOverview' in Main.sessionMode) {
            let hadOverview = Main.sessionMode.hasOverview;
            if (hadOverview)
                Main.sessionMode.hasOverview = false;
            this._runtimeDisposer?.restartTimeout(
                this, '_overlayHasOverviewRestoreId',
                GLib.PRIORITY_DEFAULT, OVERLAY_OVERVIEW_SUPPRESS_MS,
                () => {
                    if ('hasOverview' in Main.sessionMode)
                        Main.sessionMode.hasOverview = hadOverview;
                    return GLib.SOURCE_REMOVE;
                });
        }

        Main.overview?.hide?.();
        this._runtimeDisposer?.restartTimeout(
            this, '_overlayOverviewHideId',
            GLib.PRIORITY_DEFAULT, 0,
            () => {
                Main.overview?.hide?.();
                return GLib.SOURCE_REMOVE;
            });

        let monitorIndex = this._getActiveAppGridMonitorIndex();
        if (appDrawer.isExpanded) {
            if (appDrawer._expandedMonitorIndex === monitorIndex)
                appDrawer.collapse();
            else
                appDrawer.expand(monitorIndex);
        } else {
            appDrawer.expand(monitorIndex);
        }
    }

    /**
     * Switch workspace on a specific monitor.
     * @param {number} monitorIndex
     * @param {number} direction - +1 or -1
     */
    switchWorkspaceOnMonitor(monitorIndex, direction) {
        if (!this.isIndependentWorkspacesActive()) {
            this._controller.switchWorkspace?.(direction);
            return;
        }

        let state = this._monitorWorkspaceState.get(monitorIndex);
        if (!state) return;

        let primaryIndex = this._getPrimaryDesktopMonitorIndex();
        if (monitorIndex !== primaryIndex)
            this._ensureEmptyWorkspaceForSecondaryMonitors();

        let wsManager = global.workspace_manager;
        let newIndex = state.activeVirtualWsIndex + direction;

        if (newIndex < 0 || newIndex >= wsManager.get_n_workspaces()) return;
        if (monitorIndex !== primaryIndex && newIndex === 0) return;

        state.activeVirtualWsIndex = newIndex;

        if (monitorIndex === primaryIndex) {
            this._markWorkspaceAnimationWindow(
                this._getWorkspaceVisibilitySyncDelay(),
                'switchWorkspaceOnMonitor-primary');
            let ws = wsManager.get_workspace_by_index(newIndex);
            if (ws) ws.activate(global.get_current_time());
        }

        this.scheduleWindowVisibilitySync(
            this._getWorkspaceVisibilitySyncDelay(),
            'switchWorkspaceOnMonitor', true);
    }

    /**
     * Protect secondary monitor virtual workspaces from being removed.
     */
    protectSecondaryVirtualWorkspaces() {
        if (this._protectingVirtualWs) return;
        if (!this.isIndependentWorkspacesActive()) return;

        this._protectingVirtualWs = true;
        try {
            let wsManager = global.workspace_manager;
            let nWorkspaces = wsManager.get_n_workspaces();
            let primaryIndex = this._getPrimaryDesktopMonitorIndex();
            let maxNeeded = 0;

            for (let [monIdx, state] of this._monitorWorkspaceState) {
                if (monIdx === primaryIndex) continue;
                if (state.activeVirtualWsIndex >= nWorkspaces)
                    state.activeVirtualWsIndex = Math.max(1, nWorkspaces - 1);
                maxNeeded = Math.max(maxNeeded, state.activeVirtualWsIndex);
            }

            while (wsManager.get_n_workspaces() <= maxNeeded)
                wsManager.append_new_workspace(false, global.get_current_time());

            this._ensureEmptyWorkspaceForSecondaryMonitors();
        } finally {
            this._protectingVirtualWs = false;
        }

        this.scheduleWindowVisibilitySync(40, 'protect-secondary-vws', true);
    }

    /**
     * Assign a window to its monitor's current virtual workspace.
     * @param {Object} metaWindow
     */
    assignWindowToMonitorVirtualWorkspace(metaWindow) {
        if (!this.isIndependentWorkspacesActive()) return;
        if (!metaWindow || metaWindow.is_skip_taskbar?.()) return;

        let type = metaWindow.get_window_type();
        if (type !== Meta.WindowType.NORMAL &&
            type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG) return;
        if (metaWindow.is_on_all_workspaces?.()) return;

        let monitorIndex = metaWindow.get_monitor();
        let primaryIndex = this._getPrimaryDesktopMonitorIndex();
        if (monitorIndex === primaryIndex) return;

        let state = this._monitorWorkspaceState?.get(monitorIndex);
        if (!state) return;

        let targetWs = state.activeVirtualWsIndex;
        let currentWs = metaWindow.get_workspace()?.index?.() ?? -1;
        if (currentWs === targetWs) return;

        let wsManager = global.workspace_manager;
        while (wsManager.get_n_workspaces() <= targetWs)
            wsManager.append_new_workspace(false, global.get_current_time());

        let ws = wsManager.get_workspace_by_index(targetWs);
        if (ws) metaWindow.change_workspace(ws);
    }

    /**
     * Sync window actor visibility based on workspace state.
     * @param {Clutter.Actor[]|null} dirtyActors
     */
    syncWindowActorVisibility(dirtyActors = null) {
        let wsManager = global.workspace_manager;
        let activeWsIndex = wsManager.get_active_workspace_index();
        let independent = this.isIndependentWorkspacesActive();
        let focusedWindow = global.display?.get_focus_window?.() ?? null;

        let actors = dirtyActors && dirtyActors.length > 0
            ? dirtyActors
            : global.get_window_actors();
        let changedAny = false;

        for (let actor of actors) {
            if (!actor) continue;

            let metaWindow = null;
            try {
                if (actor.is_destroyed?.()) continue;
                metaWindow = actor.get_meta_window?.();
                if (!metaWindow) continue;
            } catch (_e) { continue; }

            let type = metaWindow.get_window_type();
            if (type !== Meta.WindowType.NORMAL &&
                type !== Meta.WindowType.DIALOG &&
                type !== Meta.WindowType.MODAL_DIALOG) continue;
            if (metaWindow.is_skip_taskbar()) continue;

            if (metaWindow.minimized) {
                this._setManagedWindowActorVisible(actor, false, true);
                changedAny = true;
                continue;
            }

            let wsIndex = metaWindow.get_workspace()?.index?.() ?? -1;
            if (wsIndex < 0) continue;

            let shouldShow = false;
            if (metaWindow.is_on_all_workspaces?.()) {
                shouldShow = true;
            } else if (independent) {
                let monitorIndex = metaWindow.get_monitor();
                let state = this._monitorWorkspaceState?.get(monitorIndex);
                let targetWs = state ? state.activeVirtualWsIndex : activeWsIndex;
                shouldShow = wsIndex === targetWs;
            } else {
                shouldShow = wsIndex === activeWsIndex;
            }

            if (focusedWindow && metaWindow === focusedWindow &&
                !metaWindow.minimized)
                shouldShow = true;

            let wasTarget = actor._convergenceTargetVisible;
            this._setManagedWindowActorVisible(actor, shouldShow, true);
            if (wasTarget !== shouldShow) changedAny = true;
        }

        if (changedAny) this._queueSceneRedraw();
    }

    /**
     * Schedule a window visibility sync with a delay.
     * @param {number} delayMs
     * @param {string} reason
     * @param {boolean} forceFullSync
     */
    scheduleWindowVisibilitySync(delayMs = 260, reason = 'unspecified',
        forceFullSync = false) {
        let delay = Math.max(0, delayMs);

        let guardUntilUs = this._workspaceAnimationGuardUntilUs ?? 0;
        let nowUs = GLib.get_monotonic_time();
        if (guardUntilUs > nowUs) {
            let guardDelayMs = Math.ceil((guardUntilUs - nowUs) / 1000);
            if (guardDelayMs > delay) delay = guardDelayMs;
        }

        if (forceFullSync)
            this._windowVisibilityForceFull = true;

        this._runtimeDisposer?.restartTimeout(
            this, '_wsVisibilitySyncId',
            GLib.PRIORITY_DEFAULT, delay,
            () => {
                let full = this._windowVisibilityForceFull === true;
                this._windowVisibilityForceFull = false;
                let dirty = this._consumeWindowVisibilityDirtyActors(full);
                if (!full && dirty.length === 0) return GLib.SOURCE_REMOVE;
                this.syncWindowActorVisibility(dirty);
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Restore all managed window actors to their natural visible state.
     */
    restoreManagedWindowActors() {
        for (let actor of global.get_window_actors()) {
            let metaWindow = actor.get_meta_window?.();
            if (!metaWindow) continue;
            let type = metaWindow.get_window_type();
            if (type !== Meta.WindowType.NORMAL &&
                type !== Meta.WindowType.DIALOG) continue;
            if (metaWindow.is_skip_taskbar()) continue;

            actor._convergenceTargetVisible = true;
            actor.remove_all_transitions?.();
            actor.show();
            actor.opacity = 255;
            actor.reactive = true;
            actor.queue_relayout?.();
        }
        this._queueSceneRedraw();
    }

    /**
     * Set a managed window actor's visibility state.
     * @param {Clutter.Actor} actor
     * @param {boolean} visible
     * @param {boolean} deferSceneRedraw
     * @returns {boolean}
     * @private
     */
    _setManagedWindowActorVisible(actor, visible, deferSceneRedraw = false) {
        if (!actor || actor.is_destroyed?.()) return false;

        actor._convergenceTargetVisible = visible;

        if (visible) {
            actor.remove_all_transitions?.();
            actor.show();
            actor.opacity = 255;
            actor.reactive = true;
            actor.queue_relayout?.();
            if (!deferSceneRedraw) this._queueSceneRedraw();
            return true;
        }

        actor.remove_all_transitions?.();
        actor.opacity = 0;
        actor.hide();
        actor.opacity = 255;
        actor.reactive = false;
        actor.queue_relayout?.();
        if (!deferSceneRedraw) this._queueSceneRedraw();
        return true;
    }

    /**
     * Queue a compositor scene redraw.
     * @private
     */
    _queueSceneRedraw() {
        global.window_group?.queue_redraw?.();
        global.stage.queue_redraw?.();
    }

    /**
     * Consume and clear dirty-actor tracking.
     * @param {boolean} forceFull
     * @returns {Clutter.Actor[]}
     * @private
     */
    _consumeWindowVisibilityDirtyActors(forceFull) {
        if (forceFull) {
            this._windowVisibilityDirtyActors?.clear();
            return [];
        }
        if (!this._windowVisibilityDirtyActors ||
            this._windowVisibilityDirtyActors.size === 0)
            return [];
        let actors = Array.from(this._windowVisibilityDirtyActors);
        this._windowVisibilityDirtyActors.clear();
        return actors;
    }

    /**
     * Mark a window actor as needing visibility recalculation.
     * @param {Clutter.Actor} actor
     */
    markWindowVisibilityDirty(actor) {
        if (!actor) return;
        this._windowVisibilityDirtyActors.add(actor);
    }

    /**
     * Get the workspace visibility sync delay.
     * @returns {number}
     * @private
     */
    _getWorkspaceVisibilitySyncDelay() {
        let primaryDesktopMonitorIndex = this._getPrimaryDesktopMonitorIndex();
        let mode = this._displayConfig?.getDisplayMode?.(primaryDesktopMonitorIndex) ?? null;
        let isPhoneLikeDesktop = mode === DisplayMode.PHONE || mode === DisplayMode.TABLET;
        return isPhoneLikeDesktop ? 40 : 220;
    }

    /**
     * Mark a workspace animation guard window.
     * @param {number} durationMs
     * @param {string} reason
     * @private
     */
    _markWorkspaceAnimationWindow(durationMs = null, reason = 'unspecified') {
        let fallbackMs = this._getWorkspaceVisibilitySyncDelay();
        let totalMs = durationMs ?? fallbackMs;
        let nowUs = GLib.get_monotonic_time();
        let untilUs = nowUs + totalMs * 1000;
        this._workspaceAnimationGuardUntilUs = Math.max(
            this._workspaceAnimationGuardUntilUs ?? 0, untilUs);
    }

    /**
     * Get the monitor index for the active app grid target.
     * @returns {number}
     * @private
     */
    _getActiveAppGridMonitorIndex() {
        try {
            let [x, y] = global.get_pointer();
            if (Number.isFinite(x) && Number.isFinite(y))
                return this.monitorIndexForCoords(x, y);
        } catch (_e) {}
        if (Number.isInteger(this._lastFocusedMonitor))
            return this._lastFocusedMonitor;
        return this._getPrimaryDesktopMonitorIndex();
    }

    /**
     * Ensure there is at least one empty workspace for secondary monitors.
     * @private
     */
    _ensureEmptyWorkspaceForSecondaryMonitors() {
        if (!this.isIndependentWorkspacesActive()) return;

        let wsManager = global.workspace_manager;
        let nWorkspaces = wsManager.get_n_workspaces();
        let primaryIndex = this._getPrimaryDesktopMonitorIndex();
        let desktopMonitorIndices = this._getDesktopMonitorIndices();
        if (desktopMonitorIndices.length <= 1)
            return;

        for (let monIdx of desktopMonitorIndices) {
            if (monIdx === primaryIndex) continue;

            let hasEmptyWs = false;
            for (let wsIdx = 1; wsIdx < nWorkspaces; wsIdx++) {
                let ws = wsManager.get_workspace_by_index(wsIdx);
                if (!ws) continue;

                let occupied = false;
                for (let win of ws.list_windows()) {
                    if (win.get_monitor() === monIdx &&
                        !win.is_on_all_workspaces?.() &&
                        !win.is_skip_taskbar?.()) {
                        occupied = true;
                        break;
                    }
                }

                if (!occupied) {
                    hasEmptyWs = true;
                    break;
                }
            }

            if (!hasEmptyWs) {
                wsManager.append_new_workspace(false, global.get_current_time());
                return;
            }
        }
    }

    _getPrimaryDesktopMonitorIndex() {
        let monitorIndex = this._controller?.getPrimaryDesktopMonitorIndex?.();
        return Number.isInteger(monitorIndex) ? monitorIndex : Main.layoutManager.primaryIndex;
    }

    _getDesktopMonitorIndices() {
        let monitorIndices = this._controller?.getDesktopMonitorIndices?.();
        if (Array.isArray(monitorIndices) && monitorIndices.length > 0)
            return monitorIndices;
        return [this._getPrimaryDesktopMonitorIndex()];
    }

    _isDesktopMonitor(monitorIndex) {
        return this._getDesktopMonitorIndices().includes(monitorIndex);
    }

    refreshTopology() {
        this._monitorGeneration++;
        this._initMonitorWorkspaceState();
        this.scheduleWindowVisibilitySync(0, 'topology-refresh', true);
    }

    /**
     * Clean up all resources.
     */
    destroy() {
        this._monitorWorkspaceState.clear();
        this._windowVisibilityDirtyActors.clear();
        this._runtimeDisposer.dispose();
        this._logger?.destroy?.();
    }
}
