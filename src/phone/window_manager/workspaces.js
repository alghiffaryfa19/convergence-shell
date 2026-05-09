// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Logger } from '../../shared/utilities/logger.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { DisplayConfig } from '../../shared/utilities/displayConfig.js';
import { snapToPixel, isWindowMaximized } from '../../shared/utilities/uiUtils.js';
import { WindowStack } from './windowStack.js';

const LOG_PREFIX = 'PhoneWorkspaces';

const SWIPE_FLING_VELOCITY = 0.38;
const SWIPE_SNAP_PULL_RATIO = 0.18;
const SWIPE_RUBBER_BAND = 0.26;
const SPLIT_RATIO_MIN = 0.3;
const SPLIT_RATIO_MAX = 0.7;
const SPLIT_DISMISS_THRESHOLD = 0.15;
const DIVIDER_HEIGHT = 14;

/**
 * PhoneWorkspaces -- phone-specific workspace and window management.
 *
 * Handles gesture-driven workspace switching via the window stack,
 * single-window visibility, home screen toggling, back navigation,
 * split-screen support, window creation/tracking, minimize animations
 * toward dock icon positions, and integration with the gesture bar
 * and recent apps overlay.
 */
export class PhoneWorkspaces {
    /**
     * @param {Object} controller - convergence controller instance
     * @param {Object} settings - GSettings for the extension
     * @param {Object} [opts]
     * @param {number} [opts.monitorIndex]
     */
    constructor(controller, settings, opts = {}) {
        this._controller = controller;
        this._settings = settings;
        this._monitorIndex = Number.isInteger(opts.monitorIndex) ? opts.monitorIndex : null;
        this._runtimeDisposer = new RuntimeDisposer();
        this._windowSignals = new Map();
        this._windowActorSignals = new Map();
        this._minimizeAnimState = new Map();
        this._swipe = null;
        this._swipingWorkspace = false;
        this._homeGesture = null;
        this._pendingGestureReset = null;
        this._splitState = null;
        this._splitMonitorIndex = null;
        this._splitFirstWindow = null;
        this._splitFirstPosition = null;
        this._splitPendingSecondPick = false;
        this._windowVisibilityDirtyActors = new Set();
        this._windowVisibilityForceFull = false;
        this._workspaceAnimationGuardUntilUs = 0;
        this._nativeWorkspaceAnimationSuppressDepth = 0;
        this._suppressNativeWorkspaceAnimation = false;
        this._suppressGlobalWsChanged = false;

        this._setup();
    }

    _getPhoneMonitorIndex() {
        let monitors = Main.layoutManager.monitors ?? [];
        let preferredIndex = this._monitorIndex;
        if (!Number.isInteger(preferredIndex))
            preferredIndex = this._controller?.getPhoneMonitorIndex?.()
                ?? this._controller?.phoneWindowStack?.monitorIndex
                ?? Main.layoutManager.primaryIndex;
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < monitors.length)
            return preferredIndex;
        return Main.layoutManager.primaryIndex;
    }

    _getPhoneMonitor() {
        return Main.layoutManager.monitors?.[this._getPhoneMonitorIndex()]
            ?? Main.layoutManager.primaryMonitor
            ?? Main.layoutManager.monitors?.[0]
            ?? null;
    }

    _applyInteractionMonitorIndex(monitorIndex = null) {
        if (Number.isInteger(monitorIndex))
            this._monitorIndex = monitorIndex;
    }

    // ── Initialisation ───────────────────────────────────────────────

    /**
     * Wire up signals for window creation, workspace changes, and
     * absorb any existing windows into the phone window stack.
     */
    _setup() {
        this._runtimeDisposer.connect(
            global.display, 'window-created',
            (_display, metaWindow) => this._onWindowCreated(metaWindow)
        );

        let wsManager = global.workspace_manager;
        this._runtimeDisposer.connect(
            wsManager, 'active-workspace-changed',
            () => this._onWorkspaceChanged()
        );

        this._runtimeDisposer.connect(
            global.display, 'workareas-changed',
            () => this._scheduleRemaxWindows()
        );

        this._runtimeDisposer.connect(
            Main.layoutManager, 'monitors-changed',
            () => this._scheduleRemaxWindows()
        );

        // Absorb pre-existing windows into the phone stack, but only
        // those on phone-role monitors — leave desktop windows alone.
        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive) {
            let phoneMonIdx = this._getPhoneMonitorIndex();
            for (let actor of global.get_window_actors()) {
                let metaWindow = actor.get_meta_window();
                if (!metaWindow || !this._isNormalWindow(metaWindow))
                    continue;
                let winMon = metaWindow.get_monitor();
                let role = this._controller.getMonitorRole?.(winMon);
                if (role === 'desktop')
                    continue;
                phoneStack.pushWindow(metaWindow, phoneMonIdx);
                this._trackWindow(metaWindow);
            }
        }
    }

    // ── Window type predicates ───────────────────────────────────────

    /**
     * Test whether a meta window is a regular application window.
     * @param {Meta.Window} metaWindow
     * @returns {boolean}
     */
    _isNormalWindow(metaWindow) {
        if (metaWindow.is_skip_taskbar())
            return false;
        let type = metaWindow.get_window_type();
        return type === Meta.WindowType.NORMAL ||
               type === Meta.WindowType.DIALOG;
    }

    /**
     * Test whether a compositor actor belongs to a managed window.
     * @param {Clutter.Actor} actor
     * @returns {boolean}
     */
    _isManagedWindowActor(actor) {
        if (!actor?.get_meta_window)
            return false;
        let metaWindow = actor.get_meta_window();
        if (!metaWindow)
            return false;
        let type = metaWindow.get_window_type();
        if (type !== Meta.WindowType.NORMAL &&
            type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG)
            return false;
        if (metaWindow.is_skip_taskbar())
            return false;
        return true;
    }

    // ── Window creation and tracking ─────────────────────────────────

    /**
     * Handle a newly created window. Push it to the phone stack,
     * maximise it, and start tracking signals.
     * @param {Meta.Window} metaWindow
     */
    _onWindowCreated(metaWindow) {
        if (!this._isNormalWindow(metaWindow))
            return;

        let phoneStack = this._controller.phoneWindowStack;
        if (!phoneStack?.isActive)
            return;

        let pendingPhoneMon = this._controller.consumePendingPhoneLaunchMonitorIndex?.();
        let launchMonitorIndex = pendingPhoneMon
            ?? metaWindow.get_monitor?.()
            ?? this._getPhoneMonitorIndex();

        // In convergence mode, windows launched from the desktop taskbar
        // or while the phone display is off should not be captured by
        // the phone stack.
        if (pendingPhoneMon == null) {
            if (this._controller.isPhoneDisplayOff)
                return;
            if (this._controller.consumePendingDesktopLaunch?.())
                return;
            let role = this._controller.getMonitorRole?.(launchMonitorIndex);
            if (role === 'desktop')
                return;
        }

        // If waiting for the second split-screen window, route it to split
        if (this._splitPendingSecondPick && this._splitFirstWindow) {
            this._splitPendingSecondPick = false;
            phoneStack.markForSplit(metaWindow, launchMonitorIndex);
            let tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._runtimeDisposer.untrackTimeout(tid);
                phoneStack.pushWindow(metaWindow, launchMonitorIndex);
                this._trackWindow(metaWindow);
                this._completeSplitScreen(metaWindow);
                return GLib.SOURCE_REMOVE;
            });
            this._runtimeDisposer.trackTimeout(tid);
            return;
        }

        // Exit split-screen when a new window arrives
        this._exitSplitScreen();

        let tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._runtimeDisposer.untrackTimeout(tid);
            phoneStack.pushWindow(metaWindow, launchMonitorIndex);
            this._trackWindow(metaWindow);
            return GLib.SOURCE_REMOVE;
        });
        this._runtimeDisposer.trackTimeout(tid);
    }

    /**
     * Set up per-window signal tracking for size, workspace, fullscreen,
     * minimise, and close events.
     * @param {Meta.Window} metaWindow
     */
    _trackWindow(metaWindow) {
        if (this._windowSignals.has(metaWindow))
            return;

        let signals = [];
        let phoneStack = this._controller.phoneWindowStack;

        // Re-maximise if user tries to unmaximise (unless in split or floating)
        let sizeId = metaWindow.connect('size-changed', () => {
            let inStack = phoneStack?.hasWindow(metaWindow, this._getPhoneMonitorIndex()) ?? false;
            if (inStack && !isWindowMaximized(metaWindow)) {
                if (this._isSplitScreenWindow(metaWindow))
                    return;
                if (metaWindow._isFloatingPopup)
                    return;
                this._maximizeWindow(metaWindow);
            }
        });
        signals.push(sizeId);

        // Phone windows are sticky so workspace-changed is mostly a no-op
        let wsId = metaWindow.connect('workspace-changed', () => {});
        signals.push(wsId);

        let unmId = metaWindow.connect('unmanaging', () => {
            this._onWindowClosing(metaWindow);
        });
        signals.push(unmId);

        let fsId = metaWindow.connect('notify::fullscreen', () => {});
        signals.push(fsId);

        let minId = metaWindow.connect('notify::minimized', () => {
            this._onWindowMinimizedChanged(metaWindow);
        });
        signals.push(minId);

        this._windowSignals.set(metaWindow, signals);
    }

    /**
     * Clean up when a window closes.
     * @param {Meta.Window} metaWindow
     */
    _onWindowClosing(metaWindow) {
        this._minimizeAnimState.delete(metaWindow);

        // Disconnect per-window signals
        let signals = this._windowSignals.get(metaWindow);
        if (signals) {
            for (let id of signals) {
                try { metaWindow.disconnect(id); } catch (_e) {}
            }
            this._windowSignals.delete(metaWindow);
        }

        // Check split status before removing, since removeWindow cleans
        // the closing window out of the splitWindows set.
        let phoneStack = this._controller.phoneWindowStack;
        let phoneMonitorIndex = this._getPhoneMonitorIndex();
        let wasSplit = this._isSplitScreenWindow(metaWindow);
        let survivor = null;
        if (wasSplit) {
            // Try local splitState first; fall back to windowStack
            // (split may have been initiated by recentApps module).
            if (this._splitState) {
                survivor = this._splitState.topWindow === metaWindow
                    ? this._splitState.bottomWindow
                    : this._splitState.topWindow;
            } else {
                survivor = phoneStack?.getSplitPartner(metaWindow, phoneMonitorIndex) ?? null;
            }
        }

        // Remove from phone stack first so the closing window is gone
        // before exitSplitMode tries to re-maximize split windows.
        if (phoneStack?.hasWindow(metaWindow, phoneMonitorIndex))
            phoneStack.removeWindow(metaWindow, phoneMonitorIndex);

        // Exit split-screen if a split window was closing.
        // Always call exitSplitMode via the stack even when _splitState
        // is null, so the surviving window gets re-maximised.
        if (wasSplit) {
            if (this._splitState)
                this._exitSplitScreen(survivor);
            else {
                phoneStack?.exitSplitMode(phoneMonitorIndex);
                if (survivor)
                    phoneStack?.activateWindow(survivor, phoneMonitorIndex);
                else
                    phoneStack?.goHome(phoneMonitorIndex);
            }
        }

        this._controller.onWindowClosing?.(metaWindow);
    }

    /**
     * Maximise a window.
     * @param {Meta.Window} metaWindow
     */
    _maximizeWindow(metaWindow) {
        if (!isWindowMaximized(metaWindow))
            metaWindow.maximize(Meta.MaximizeFlags.BOTH);
    }

    /**
     * Force all tracked windows to re-maximise to the current work area.
     */
    remaxAllWindows() {
        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive) {
            phoneStack.remaxAll();
            return;
        }
        for (let metaWindow of this._windowSignals.keys())
            metaWindow.maximize(Meta.MaximizeFlags.BOTH);
    }

    // ── Remax scheduling ─────────────────────────────────────────────

    /**
     * Schedule a re-maximise pass after the work area changes.
     */
    _scheduleRemaxWindows() {
        this._cancelRemaxWindows();
        this._runtimeDisposer.replaceConnection(
            this, '_remaxWorkareasId',
            global.display, 'workareas-changed',
            () => {
                this._cancelRemaxWindows();
                this.remaxAllWindows();
            }
        );
        this._runtimeDisposer?.restartTimeout(
            this, '_remaxTimeoutId',
            GLib.PRIORITY_DEFAULT, 200,
            () => {
                this._cancelRemaxWindows();
                this.remaxAllWindows();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Cancel any pending re-maximise timers.
     */
    _cancelRemaxWindows() {
        this._runtimeDisposer?.clearConnectionRef(this, '_remaxWorkareasId', global.display);
        this._runtimeDisposer?.clearTimeoutRef(this, '_remaxTimeoutId');
    }

    // ── Minimize animations ──────────────────────────────────────────

    /**
     * Handle a window's minimised state changing. Phone stack windows
     * resync visibility; otherwise play an icon-target animation.
     * @param {Meta.Window} metaWindow
     */
    _onWindowMinimizedChanged(metaWindow) {
        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive && phoneStack.hasWindow(metaWindow, this._getPhoneMonitorIndex())) {
            phoneStack.syncVisibility();
            return;
        }

        let actor = metaWindow.get_compositor_private();
        if (!actor)
            return;

        if (metaWindow.minimized) {
            let [ax, ay] = actor.get_transformed_position();
            this._minimizeAnimState.set(metaWindow, {
                scaleX: actor.scale_x,
                scaleY: actor.scale_y,
                tx: actor.translation_x,
                ty: actor.translation_y,
                opacity: actor.opacity,
                x: ax + actor.width / 2,
                y: ay + actor.height / 2,
            });
            let target = this._getMinimizeTarget(metaWindow, actor);
            let mon = this._getPhoneMonitor();
            let dx = snapToPixel(target.x - (ax + actor.width / 2), mon);
            let dy = snapToPixel(target.y - (ay + actor.height / 2), mon);
            actor.remove_all_transitions();
            actor.set_pivot_point(0.5, 0.5);
            actor.ease({
                translation_x: dx,
                translation_y: dy,
                scale_x: 0.1,
                scale_y: 0.1,
                opacity: 0,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            let state = this._minimizeAnimState.get(metaWindow);
            this._minimizeAnimState.delete(metaWindow);
            actor.remove_all_transitions();

            let target = this._getMinimizeTarget(metaWindow, actor);
            let mon = this._getPhoneMonitor();
            let cx = actor.x + actor.width / 2;
            let cy = actor.y + actor.height / 2;
            let dx = snapToPixel(target.x - cx, mon);
            let dy = snapToPixel(target.y - cy, mon);

            actor.set_pivot_point(0.5, 0.5);
            actor.translation_x = dx;
            actor.translation_y = dy;
            actor.scale_x = 0.1;
            actor.scale_y = 0.1;
            actor.opacity = 0;

            actor.ease({
                translation_x: state?.tx ?? 0,
                translation_y: state?.ty ?? 0,
                scale_x: state?.scaleX ?? 1,
                scale_y: state?.scaleY ?? 1,
                opacity: state?.opacity ?? 255,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    /**
     * Compute the screen position to minimise toward. Prefers the
     * window's dock icon if available, otherwise the bottom-centre.
     * @param {Meta.Window} metaWindow
     * @param {Clutter.Actor} actor
     * @returns {{x: number, y: number}}
     */
    _getMinimizeTarget(metaWindow, actor) {
        let [ax, ay] = actor.get_transformed_position();
        let cx = ax + actor.width / 2;
        let cy = ay + actor.height / 2;

        let tracker = Shell.WindowTracker.get_default();
        let app = tracker.get_window_app(metaWindow);
        let appId = app?.get_id?.();
        let dockTarget = this._controller.getDockIconTarget?.(appId);
        if (dockTarget)
            return dockTarget;

        let monitor = this._getPhoneMonitor();
        if (monitor) {
            cx = snapToPixel(monitor.x + monitor.width / 2, monitor);
            cy = snapToPixel(monitor.y + monitor.height - 10, monitor);
        }
        return { x: cx, y: cy };
    }

    // ── Window visibility management ─────────────────────────────────

    /**
     * Set a managed window actor visible or hidden.
     * @param {Clutter.Actor} actor
     * @param {boolean} visible
     * @param {boolean} [deferSceneRedraw=false]
     * @returns {boolean} true if the actor was managed
     */
    _setManagedWindowActorVisible(actor, visible, deferSceneRedraw = false) {
        if (!this._isManagedWindowActor(actor))
            return false;
        if (actor.is_destroyed?.())
            return false;

        if (visible &&
            actor.visible &&
            actor.reactive &&
            actor.opacity === 255 &&
            actor._convergenceTargetVisible === true)
            return true;

        if (!visible &&
            !actor.visible &&
            !actor.reactive &&
            actor._convergenceTargetVisible === false)
            return true;

        actor._convergenceTargetVisible = visible;
        if (actor._convergenceHideTimeoutId) {
            GLib.source_remove(actor._convergenceHideTimeoutId);
            actor._convergenceHideTimeoutId = 0;
        }

        if (visible) {
            actor.remove_all_transitions?.();
            this._clearGestureStateForActor(actor, true);
            actor.show();
            actor.opacity = 255;
            actor.reactive = true;
            if (actor.scale_x !== 1 || actor.scale_y !== 1) {
                actor.scale_x = 1;
                actor.scale_y = 1;
            }
            actor.set_pivot_point(0, 0);
            this._roundActorTranslation(actor);
            actor.queue_relayout?.();
            if (!deferSceneRedraw)
                this._queueSceneRedraw();
            return true;
        }

        actor.remove_all_transitions?.();
        this._clearGestureStateForActor(actor, true);
        actor.opacity = 0;
        actor.hide();
        actor.opacity = 255;
        actor.reactive = false;
        actor.queue_relayout?.();
        if (!deferSceneRedraw)
            this._queueSceneRedraw();
        return true;
    }

    /**
     * Restore all managed window actors to their default visible state.
     * Used during teardown.
     */
    _restoreManagedWindowActors() {
        for (let actor of global.get_window_actors()) {
            if (!this._isManagedWindowActor(actor))
                continue;
            if (actor._convergenceHideTimeoutId) {
                GLib.source_remove(actor._convergenceHideTimeoutId);
                actor._convergenceHideTimeoutId = 0;
            }
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
     * Queue a compositor redraw so visibility changes take effect.
     */
    _queueSceneRedraw() {
        global.window_group?.queue_redraw?.();
        global.stage.queue_redraw?.();
    }

    /**
     * Round an actor's translation to avoid sub-pixel rendering.
     * @param {Clutter.Actor} actor
     */
    _roundActorTranslation(actor) {
        if (!actor)
            return;
        actor.translation_x = Math.round(actor.translation_x);
        actor.translation_y = Math.round(actor.translation_y);
    }

    /**
     * Mark a specific actor as needing visibility re-evaluation.
     * @param {Clutter.Actor} actor
     */
    _markWindowVisibilityDirtyActor(actor) {
        if (!actor)
            return;
        this._windowVisibilityDirtyActors.add(actor);
    }

    /**
     * Mark a meta window as needing visibility re-evaluation.
     * @param {Meta.Window} metaWindow
     */
    _markWindowVisibilityDirtyMetaWindow(metaWindow) {
        if (!metaWindow)
            return;
        let actor = metaWindow.get_compositor_private?.();
        if (actor)
            this._windowVisibilityDirtyActors.add(actor);
    }

    /**
     * Consume the dirty actor set, returning the list (or null for a
     * full resync).
     * @param {boolean} forceFull
     * @returns {Clutter.Actor[]|null}
     */
    _consumeWindowVisibilityDirtyActors(forceFull) {
        if (forceFull) {
            this._windowVisibilityDirtyActors.clear();
            return null;
        }
        if (this._windowVisibilityDirtyActors.size === 0)
            return [];
        let actors = Array.from(this._windowVisibilityDirtyActors);
        this._windowVisibilityDirtyActors.clear();
        return actors;
    }

    /**
     * Schedule a delayed window visibility sync pass.
     * @param {number} [delayMs=40] - delay in milliseconds
     * @param {string} [reason='unspecified'] - debug label
     * @param {boolean} [forceFullSync=false] - resync all actors
     */
    _scheduleWindowVisibilitySync(delayMs = 40, reason = 'unspecified', forceFullSync = false) {
        let delay = Math.max(0, delayMs);
        let guardUntilUs = this._workspaceAnimationGuardUntilUs;
        let nowUs = GLib.get_monotonic_time();
        if (guardUntilUs > nowUs) {
            let guardDelayMs = Math.ceil((guardUntilUs - nowUs) / 1000);
            if (guardDelayMs > delay)
                delay = guardDelayMs;
        }

        if (forceFullSync)
            this._windowVisibilityForceFull = true;

        this._runtimeDisposer?.restartTimeout(
            this, '_wsVisibilitySyncId',
            GLib.PRIORITY_DEFAULT, delay,
            () => {
                let full = this._windowVisibilityForceFull === true;
                this._windowVisibilityForceFull = false;
                let dirtyActors = this._consumeWindowVisibilityDirtyActors(full);
                if (!full && dirtyActors.length === 0)
                    return GLib.SOURCE_REMOVE;
                this._syncWindowActorVisibility(dirtyActors);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Synchronise compositor actor visibility with the phone stack.
     * The phone stack owns which window is active; non-stack windows on
     * the active workspace are shown normally.
     * @param {Clutter.Actor[]|null} [dirtyActors=null]
     */
    _syncWindowActorVisibility(dirtyActors = null) {
        let wsManager = global.workspace_manager;
        let activeWsIndex = wsManager.get_active_workspace_index();
        let focusedWindow = global.display?.get_focus_window?.() ?? null;
        let phoneStack = this._controller.phoneWindowStack ?? null;
        let phoneStackActive = phoneStack?.isActive ?? false;

        let actors = dirtyActors && dirtyActors.length > 0
            ? dirtyActors
            : global.get_window_actors();
        let changedAny = false;

        for (let actor of actors) {
            if (!actor)
                continue;

            let metaWindow = null;
            try {
                if (actor.is_destroyed?.())
                    continue;
                metaWindow = actor.get_meta_window?.();
                if (!metaWindow)
                    continue;
                if (metaWindow.get_compositor_private?.() !== actor)
                    continue;
            } catch (_err) {
                continue;
            }

            let type = metaWindow.get_window_type();
            if (type !== Meta.WindowType.NORMAL &&
                type !== Meta.WindowType.DIALOG &&
                type !== Meta.WindowType.MODAL_DIALOG)
                continue;
            if (metaWindow.is_skip_taskbar())
                continue;

            let wasTarget = actor._convergenceTargetVisible;

            if (metaWindow.minimized) {
                this._setManagedWindowActorVisible(actor, false, true);
                if (wasTarget !== false)
                    changedAny = true;
                continue;
            }

            // When the phone stack is active, it owns all visibility
            // decisions for its monitor — skip workspace-based logic
            // entirely.  The stack's own syncVisibility() handles it.
            if (phoneStackActive) {
                if (phoneStack.hasWindow(metaWindow, this._getPhoneMonitorIndex()))
                    continue;
                // Non-stack windows on the phone monitor: hide them
                // so they don't interfere with the stack.
                let phoneMon = phoneStack.monitorIndex ?? -1;
                if (phoneMon >= 0 && metaWindow.get_monitor() === phoneMon) {
                    this._setManagedWindowActorVisible(actor, false, true);
                    continue;
                }
            }

            // Desktop windows: use workspace index for visibility
            let wsIndex = metaWindow.get_workspace()?.index?.() ?? -1;
            if (wsIndex < 0)
                continue;

            let shouldShow = false;
            if (metaWindow.is_on_all_workspaces?.())
                shouldShow = true;
            else
                shouldShow = wsIndex === activeWsIndex;

            // Never hide the focused window
            if (focusedWindow && metaWindow === focusedWindow && !metaWindow.minimized)
                shouldShow = true;

            this._setManagedWindowActorVisible(actor, shouldShow, true);
            if (wasTarget !== shouldShow)
                changedAny = true;
        }

        // Trigger phone stack visibility sync
        if (phoneStackActive)
            phoneStack.syncVisibility();

        if (changedAny)
            this._queueSceneRedraw();
    }

    /**
     * Recover the focused window's actor visibility after an overview
     * or workspace transition.
     */
    _recoverFocusedWindowActorVisibility() {
        let focused = global.display?.get_focus_window?.();
        if (!focused || focused.minimized)
            return;
        let actor = focused.get_compositor_private?.();
        if (!actor || actor.is_destroyed?.())
            return;
        this._setManagedWindowActorVisible(actor, true, true);
        this._queueSceneRedraw();
    }

    // ── Gesture actor state helpers ──────────────────────────────────

    /**
     * Restore an actor to its saved pre-gesture state.
     * @param {Object|null} state
     */
    _restoreGestureActorState(state) {
        if (!state?.actor)
            return;
        try {
            state.actor.remove_all_transitions?.();
            state.actor.set_pivot_point(state.savedPivotX, state.savedPivotY);
            state.actor.set_scale(state.savedScaleX, state.savedScaleY);
            state.actor.opacity = state.savedOpacity;
            state.actor.translation_x = state.savedTX;
            state.actor.translation_y = state.savedTY;
            this._roundActorTranslation(state.actor);
        } catch (_e) {}
    }

    /**
     * Clear any gesture state referencing a particular actor.
     * @param {Clutter.Actor} actor
     * @param {boolean} [restore=true]
     */
    _clearGestureStateForActor(actor, restore = true) {
        if (!actor)
            return;

        if (this._homeGesture?.actor === actor) {
            if (restore)
                this._restoreGestureActorState(this._homeGesture);
            this._homeGesture = null;
        }

        if (this._pendingGestureReset?.actor === actor) {
            if (restore)
                this._restoreGestureActorState(this._pendingGestureReset);
            this._pendingGestureReset = null;
        }
    }

    // ── Workspace animation suppression ──────────────────────────────

    /**
     * Run a callback with Mutter's native workspace animation suppressed.
     * @param {Function} fn
     * @returns {*} return value of fn
     */
    withNativeWorkspaceAnimationSuppressed(fn) {
        this._nativeWorkspaceAnimationSuppressDepth++;
        this._suppressNativeWorkspaceAnimation = true;
        try {
            return fn();
        } finally {
            this._nativeWorkspaceAnimationSuppressDepth = Math.max(
                0, this._nativeWorkspaceAnimationSuppressDepth - 1);
            this._suppressNativeWorkspaceAnimation =
                this._nativeWorkspaceAnimationSuppressDepth > 0;
        }
    }

    /**
     * Extend the workspace animation guard window so that delayed
     * visibility syncs do not fire too early.
     * @param {number|null} [durationMs=null]
     * @param {string} [reason='unspecified']
     */
    _markWorkspaceAnimationWindow(durationMs = null, reason = 'unspecified') {
        let totalMs = durationMs ?? 40;
        let clampedMs = Math.max(0, totalMs);
        let nowUs = GLib.get_monotonic_time();
        let untilUs = nowUs + clampedMs * 1000;
        this._workspaceAnimationGuardUntilUs = Math.max(
            this._workspaceAnimationGuardUntilUs, untilUs);
    }

    // ── Workspace swipe (finger-following via window stack) ──────────

    /**
     * Check whether the phone has any running app windows.
     * @returns {boolean}
     */
    hasRunningApps() {
        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive)
            return phoneStack.hasWindows(this._getPhoneMonitorIndex());
        return false;
    }

    /**
     * Begin a horizontal workspace swipe. On phone this swipes between
     * window stack entries rather than Mutter workspaces.
     * @param {number} startX - starting x coordinate
     * @param {number} startY - starting y coordinate
     */
    startWorkspaceSwipe(startX, startY, monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        if (this._swipe)
            return;

        this._controller.getPhoneAppDrawerForMonitor?.(this._getPhoneMonitorIndex())
            ?.collapse?.();

        let phoneStack = this._controller.phoneWindowStack;
        if (!phoneStack?.isActive)
            return;

        let activeWindow = phoneStack.getActiveWindow(this._getPhoneMonitorIndex());
        let activeIdx = activeWindow
            ? phoneStack.getStack(this._getPhoneMonitorIndex()).indexOf(activeWindow)
            : -1;
        let isHome = activeIdx < 0;

        // Block swipe when on home with no apps
        if (isHome && !phoneStack.hasWindows(this._getPhoneMonitorIndex()))
            return;

        let phoneMon = this._getPhoneMonitor();
        let screenW = phoneMon?.width > 0 ? phoneMon.width : global.stage.width;
        let stackLen = phoneStack.getStack(this._getPhoneMonitorIndex()).length;

        let prevStackIdx = isHome ? -1 : (activeIdx > 0 ? activeIdx - 1 : -2);
        let nextStackIdx = isHome ? 0 : (activeIdx < stackLen - 1 ? activeIdx + 1 : -1);

        this._swipe = {
            startX,
            screenW,
            actors: [],
            phoneActiveIdx: activeIdx,
            phonePrevIdx: prevStackIdx,
            phoneNextIdx: nextStackIdx,
            phoneIsHome: isHome,
            currentIndex: isHome ? -2 : activeIdx,
            prevIndex: prevStackIdx,
            nextIndex: nextStackIdx,
        };
        this._swipingWorkspace = true;

        // Gather actors: current, prev, next
        if (isHome)
            this._gatherPhoneSwipeActorsHome(0);
        else
            this._gatherPhoneSwipeActors(activeIdx, 0);

        if (prevStackIdx === -2)
            this._gatherPhoneSwipeActorsHome(-screenW);
        else if (prevStackIdx >= 0)
            this._gatherPhoneSwipeActors(prevStackIdx, -screenW);

        if (nextStackIdx >= 0)
            this._gatherPhoneSwipeActors(nextStackIdx, screenW);
    }

    /**
     * Gather compositor actors for a phone stack entry, saving state.
     * @param {number} stackIndex
     * @param {number} offsetX
     */
    _gatherPhoneSwipeActors(stackIndex, offsetX) {
        let phoneStack = this._controller.phoneWindowStack;
        if (!phoneStack)
            return;
        let stack = phoneStack.getStack(this._getPhoneMonitorIndex());
        if (stackIndex < 0 || stackIndex >= stack.length)
            return;

        let metaWindow = stack[stackIndex];
        let actor = metaWindow.get_compositor_private?.();
        if (!actor)
            return;

        // Restore pending gesture state if needed
        if (this._pendingGestureReset?.actor === actor) {
            let g = this._pendingGestureReset;
            this._pendingGestureReset = null;
            try {
                actor.set_pivot_point(g.savedPivotX, g.savedPivotY);
                actor.set_scale(g.savedScaleX, g.savedScaleY);
                actor.opacity = g.savedOpacity;
                actor.translation_x = g.savedTX;
                actor.translation_y = g.savedTY;
            } catch (_e) {}
        }

        this._swipe.actors.push({
            actor,
            wsIndex: stackIndex,
            savedVisible: actor.visible,
            savedTX: actor.translation_x,
            savedOpacity: actor.opacity,
        });
        if (offsetX !== 0) {
            actor.show();
            actor.opacity = 255;
        }
        actor.translation_x = actor.translation_x + offsetX;
    }

    /**
     * Gather home screen actors for the phone swipe.
     * @param {number} offsetX
     */
    _gatherPhoneSwipeActorsHome(offsetX) {
        let actors = [];
        let phoneMonitorIndex = this._getPhoneMonitorIndex();
        let phoneHomeScreen = this._controller.getPhoneHomeScreenForMonitor?.(phoneMonitorIndex);
        if (phoneHomeScreen?._actor)
            actors.push(phoneHomeScreen._actor);
        let appDrawer = this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex);
        if (appDrawer?._actor)
            actors.push(appDrawer._actor);

        for (let actor of actors) {
            if (this._pendingGestureReset?.actor === actor) {
                let g = this._pendingGestureReset;
                this._pendingGestureReset = null;
                try {
                    actor.set_pivot_point(g.savedPivotX, g.savedPivotY);
                    actor.set_scale(g.savedScaleX, g.savedScaleY);
                    actor.opacity = g.savedOpacity;
                    actor.translation_x = g.savedTX;
                    actor.translation_y = g.savedTY;
                } catch (_e) {}
            }

            this._swipe.actors.push({
                actor,
                wsIndex: -2,
                savedVisible: actor.visible,
                savedTX: actor.translation_x,
                savedOpacity: actor.opacity,
            });
            if (offsetX !== 0) {
                actor.show();
                actor.opacity = 255;
            }
            actor.translation_x = actor.translation_x + offsetX;
        }
    }

    /**
     * Update the workspace swipe with a new finger position.
     * @param {number} currentX
     */
    updateWorkspaceSwipe(currentX, monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        if (!this._swipe)
            return;
        let { startX, currentIndex, screenW, prevIndex, nextIndex, actors } = this._swipe;
        let dx = currentX - startX;

        let noPrev = prevIndex === -1;
        let noNext = nextIndex === -1;
        if (noPrev && dx > 0)
            dx = dx * SWIPE_RUBBER_BAND;
        if (noNext && dx < 0)
            dx = dx * SWIPE_RUBBER_BAND;

        for (let entry of actors) {
            let base = entry.wsIndex === currentIndex ? 0
                : entry.wsIndex === prevIndex ? -screenW : screenW;
            entry.actor.translation_x = entry.savedTX + base + dx;
        }
    }

    /**
     * Finish the workspace swipe, deciding whether to snap to the
     * previous, current, or next window based on velocity and distance.
     * @param {number} currentX
     * @param {number} velocity - normalised pixels/ms
     */
    endWorkspaceSwipe(currentX, velocity, monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        if (!this._swipe)
            return;
        let { startX, currentIndex, screenW, prevIndex, nextIndex, actors } = this._swipe;
        let dx = currentX - startX;

        let noPrev = prevIndex === -1;
        let noNext = nextIndex === -1;
        if (noPrev && dx > 0)
            dx = dx * SWIPE_RUBBER_BAND;
        if (noNext && dx < 0)
            dx = dx * SWIPE_RUBBER_BAND;

        let hasPrev = !noPrev;
        let hasNext = !noNext;
        let targetIndex = currentIndex;

        if (Math.abs(velocity) >= SWIPE_FLING_VELOCITY) {
            if (velocity > 0 && hasPrev)
                targetIndex = prevIndex;
            else if (velocity < 0 && hasNext)
                targetIndex = nextIndex;
        } else if (Math.abs(dx) >= screenW * SWIPE_SNAP_PULL_RATIO) {
            if (dx > 0 && hasPrev)
                targetIndex = prevIndex;
            else if (dx < 0 && hasNext)
                targetIndex = nextIndex;
        }

        let shift;
        if (targetIndex === currentIndex)
            shift = 0;
        else if (targetIndex === prevIndex)
            shift = screenW;
        else
            shift = -screenW;

        let animDuration = Math.max(170, Math.min(340, 280));

        for (let entry of actors) {
            let base = entry.wsIndex === currentIndex ? 0
                : entry.wsIndex === prevIndex ? -screenW : screenW;
            entry.actor.ease({
                translation_x: entry.savedTX + base + shift,
                duration: animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (this._swipeTimeout) {
            GLib.source_remove(this._swipeTimeout);
            this._runtimeDisposer?.untrackTimeout(this._swipeTimeout);
        }
        this._swipeTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, animDuration + 20,
            () => {
                this._swipeTimeout = 0;
                this._finishWorkspaceSwipe(targetIndex);
                return GLib.SOURCE_REMOVE;
            }
        );
        this._runtimeDisposer?.trackTimeout(this._swipeTimeout);
    }

    /**
     * Commit the workspace swipe result to the phone stack.
     * @param {number} targetIndex - stack index or -2 for home
     */
    _finishWorkspaceSwipe(targetIndex) {
        if (!this._swipe)
            return;
        let { actors } = this._swipe;
        let phoneStack = this._controller.phoneWindowStack;
        let stack = phoneStack?.getStack(this._getPhoneMonitorIndex()) ?? [];
        let isTargetHome = targetIndex === -2 || targetIndex < 0;

        // Hide non-target actors and restore saved state
        for (let entry of actors) {
            if (entry.wsIndex !== targetIndex)
                entry.actor.hide();
            entry.actor.translation_x = entry.savedTX;
        }

        if (isTargetHome) {
            let phoneMonitorIndex = this._getPhoneMonitorIndex();
            phoneStack?.goHome(phoneMonitorIndex);
            let phoneHomeScreen = this._controller.getPhoneHomeScreenForMonitor?.(phoneMonitorIndex);
            if (phoneHomeScreen) {
                phoneHomeScreen._actor.show();
                phoneHomeScreen._actor.opacity = 255;
                phoneHomeScreen._visible = true;
            }
            let drawer = this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex);
            if (drawer) {
                drawer._actor?.remove_all_transitions?.();
                drawer._actor?.show();
            }
            this._controller.getPhoneGestureBarForMonitor?.(phoneMonitorIndex)?.showBar?.();
        } else if (targetIndex >= 0 && targetIndex < stack.length) {
            let phoneMonitorIndex = this._getPhoneMonitorIndex();
            phoneStack?.focusWindowAtIndex(targetIndex, phoneMonitorIndex);
            this._controller.getPhoneHomeScreenForMonitor?.(phoneMonitorIndex)?.hide?.();
            this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex)?._actor?.hide?.();
            this._controller.getPhoneGestureBarForMonitor?.(phoneMonitorIndex)?.showBar?.();
        }

        this._swipe = null;
        this._swipingWorkspace = false;
        phoneStack?.syncVisibility();
    }

    // ── Home gesture (swipe up to go home) ───────────────────────────

    /**
     * Begin the home gesture. Saves the active window's actor state
     * and prepares for progressive shrink-to-card animation.
     */
    startHomeGesture(monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        if (this._homeGesture)
            return;

        let phoneStack = this._controller.phoneWindowStack;
        let activeWindow = phoneStack?.getActiveWindow?.();
        if (!activeWindow) {
            this._homeGesture = { actor: null, fallback: true };
            return;
        }

        let actor = activeWindow.get_compositor_private();
        if (!actor) {
            this._homeGesture = { actor: null, fallback: true };
            return;
        }

        this._homeGesture = {
            actor,
            savedPivotX: actor.pivot_point.x,
            savedPivotY: actor.pivot_point.y,
            savedScaleX: actor.scale_x,
            savedScaleY: actor.scale_y,
            savedOpacity: actor.opacity,
            savedTX: actor.translation_x,
            savedTY: actor.translation_y,
            startX: actor.x,
            startY: actor.y,
            startW: actor.width,
            startH: actor.height,
            baseScaleX: actor.scale_x,
            baseScaleY: actor.scale_y,
        };

        // Compute a static fallback target rect in case the live card
        // rect is not yet available from the recent apps carousel.
        let monitor = this._getPhoneMonitor();
        if (monitor) {
            let panelH = this._controller?.getPhoneTopInset?.(this._getPhoneMonitorIndex()) ?? Main.panel?.height ?? 0;
            let bottomBarH = this._controller.getPhoneGestureBarForMonitor?.(this._getPhoneMonitorIndex())?.height ?? 20;
            let appSpaceH = monitor.height - panelH - bottomBarH;
            let cardW = Math.round(monitor.width * 0.72);
            let refW = 1280;
            let rawScale = monitor.width / refW;
            let uiScale = Math.max(0.95, Math.min(1.2, rawScale));
            let headerH = Math.round(88 * uiScale);
            let btnAreaH = Math.round(56 * uiScale);
            let maxCardH = appSpaceH - headerH - btnAreaH;
            let windowAspect = appSpaceH / monitor.width;
            let cardH = Math.min(Math.round(cardW * windowAspect), maxCardH);
            let cardX = monitor.x + Math.round((monitor.width - cardW) / 2);
            let cardY = monitor.y + panelH +
                Math.round((appSpaceH - cardH - headerH) / 2) + headerH;
            this._homeGesture.fallbackTargetX = cardX;
            this._homeGesture.fallbackTargetY = cardY;
            this._homeGesture.fallbackTargetW = cardW;
            this._homeGesture.fallbackTargetH = cardH;
        }

        // Set pivot to top-left for position-based interpolation
        let curPX = actor.pivot_point.x;
        let curPY = actor.pivot_point.y;
        let sx = actor.scale_x;
        let sy = actor.scale_y;
        let w = actor.width;
        let h = actor.height;
        if (w > 0 && h > 0) {
            actor.translation_x += curPX * w * (1 - sx);
            actor.translation_y += curPY * h * (1 - sy);
        }
        actor.set_pivot_point(0, 0);
    }

    /**
     * Update the home gesture with the current swipe progress.
     * Interpolates the window from full-screen toward the card rect.
     * @param {number} progress - 0..1
     */
    updateHomeGesture(progress, monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        if (!this._homeGesture?.actor)
            return;
        let g = this._homeGesture;
        let { actor, startX, startY, startW, startH } = g;

        // Query the live card rect from the recent apps carousel,
        // falling back to the static approximation.
        let liveRect = this._controller.getActiveWindowCardRect?.(
            this._getPhoneMonitorIndex());
        let targetX = liveRect?.x ?? g.fallbackTargetX;
        let targetY = liveRect?.y ?? g.fallbackTargetY;
        let targetW = liveRect?.width ?? g.fallbackTargetW;
        let targetH = liveRect?.height ?? g.fallbackTargetH;

        if (targetW && targetH && startW > 0 && startH > 0) {
            let x = startX + (targetX - startX) * progress;
            let y = startY + (targetY - startY) * progress;
            let scaleX = (startW + (targetW - startW) * progress) / startW;
            let scaleY = (startH + (targetH - startH) * progress) / startH;

            if (Number.isFinite(scaleX) && Number.isFinite(scaleY)) {
                actor.set_scale(scaleX, scaleY);
                actor.translation_x = x - startX;
                actor.translation_y = y - startY;
            }
        } else {
            let factor = 1.0 - progress * 0.35;
            actor.set_scale(factor, factor);
        }

        actor.opacity = 255;
    }

    /**
     * End the home gesture. If progress > 0.3 the gesture commits
     * (shrink and go home), otherwise spring back.
     * @param {number} progress - 0..1
     */
    endHomeGesture(progress, monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        let interactionMonitorIndex = this._getPhoneMonitorIndex();
        if (!this._homeGesture)
            return;

        if (!this._homeGesture.actor) {
            let commit = progress > 0.3;
            this._homeGesture = null;
            if (commit)
                this.goHome(interactionMonitorIndex);
            return;
        }

        let { actor, baseScaleX, baseScaleY } = this._homeGesture;

        if (progress > 0.3) {
            // Animate to the exact card rect, then reveal the card
            let liveRect = this._controller.getActiveWindowCardRect?.(
                interactionMonitorIndex);
            let { startW, startH } = this._homeGesture;
            let tW = liveRect?.width ?? startW * 0.4;
            let tH = liveRect?.height ?? startH * 0.4;
            let tX = liveRect ? liveRect.x - this._homeGesture.startX : 0;
            let tY = liveRect ? liveRect.y - this._homeGesture.startY : 0;
            let finalScaleX = startW > 0 ? tW / startW : 0.4;
            let finalScaleY = startH > 0 ? tH / startH : 0.4;

            actor.ease({
                scale_x: finalScaleX,
                scale_y: finalScaleY,
                translation_x: tX,
                translation_y: tY,
                opacity: liveRect ? 255 : 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    // Reveal the carousel card and hide the window actor
                    this._controller.revealActiveCard?.(interactionMonitorIndex);
                    this._pendingGestureReset = this._homeGesture;
                    this._homeGesture = null;
                    this.goHome(interactionMonitorIndex);
                },
            });
        } else {
            actor.ease({
                scale_x: baseScaleX ?? 1,
                scale_y: baseScaleY ?? 1,
                opacity: 255,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    this._resetHomeGestureActor();
                },
            });
        }
    }

    /**
     * Cancel the home gesture (e.g. when transitioning to recent apps
     * from a hold gesture).
     */
    cancelHomeGesture() {
        if (!this._homeGesture)
            return;
        this._resetHomeGestureActor();
    }

    /**
     * Restore the actor used by the home gesture to its original state.
     */
    _resetHomeGestureActor() {
        if (!this._homeGesture)
            return;
        let { actor, savedPivotX, savedPivotY, savedScaleX, savedScaleY,
              savedOpacity, savedTX, savedTY } = this._homeGesture;
        try {
            actor.set_pivot_point(savedPivotX, savedPivotY);
            actor.set_scale(savedScaleX, savedScaleY);
            actor.opacity = savedOpacity;
            actor.translation_x = savedTX;
            actor.translation_y = savedTY;
        } catch (_e) {}
        this._homeGesture = null;
    }

    /**
     * Quick-switch: animate a window from a card rect to full screen.
     * Resets the current home gesture actor first, then scales the
     * target window's compositor actor from the card position up.
     * @param {Meta.Window} metaWindow
     * @param {{x,y,width,height}|null} cardRect - starting rect
     * @param {number} monitorIndex
     */
    quickSwitchToWindow(metaWindow, cardRect, monitorIndex = null) {
        // Clean up the departing window's gesture state
        this._resetHomeGestureActor();

        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive)
            phoneStack.activateWindow(metaWindow, monitorIndex ?? this._getPhoneMonitorIndex());

        let actor = metaWindow.get_compositor_private?.();
        if (!actor || !cardRect) return;

        let startW = actor.width;
        let startH = actor.height;
        if (startW <= 0 || startH <= 0) return;

        let scaleX = cardRect.width / startW;
        let scaleY = cardRect.height / startH;
        let tx = cardRect.x - actor.x;
        let ty = cardRect.y - actor.y;

        actor.set_pivot_point(0, 0);
        actor.set_scale(scaleX, scaleY);
        actor.translation_x = tx;
        actor.translation_y = ty;
        actor.opacity = 255;
        actor.show();

        actor.ease({
            scale_x: 1, scale_y: 1,
            translation_x: 0, translation_y: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                actor.set_pivot_point(0, 0);
            },
        });
    }

    // ── Home and workspace navigation ────────────────────────────────

    /**
     * Navigate to the home screen. Hides all phone windows and shows
     * the home screen, app drawer, and bottom bar.
     */
    goHome(monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        this._controller.windowManager?.hideRecentApps?.(this._getPhoneMonitorIndex());
        this._exitSplitScreen();

        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive) {
            let phoneMonitorIndex = this._getPhoneMonitorIndex();
            phoneStack.goHome(phoneMonitorIndex);
            this._controller.getPhoneHomeScreenForMonitor?.(phoneMonitorIndex)?.show?.();
            this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex)?.show?.();
            this._controller.getPhoneGestureBarForMonitor?.(phoneMonitorIndex)?.showBar?.();
        }
    }

    /**
     * Open the recent apps overlay.
     */
    showRecentApps(monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        this._controller.windowManager?.showRecentApps?.(this._getPhoneMonitorIndex());
    }

    /**
     * Called when the active workspace changes. On a standalone phone
     * display, workspace changes are managed by the stack, so this is
     * usually a no-op.
     */
    _onWorkspaceChanged() {
        if (this._swipingWorkspace)
            return;
        if (this._suppressGlobalWsChanged)
            return;

        // Phone stack on a standalone phone ignores workspace changes
        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive)
            return;

        this._scheduleWindowVisibilitySync(40, 'onWorkspaceChanged', true);
    }

    // ── Back navigation ──────────────────────────────────────────────

    /**
     * Handle a back gesture. Sends Alt+Left to the focused window;
     * if the window does not navigate (title unchanged), close it
     * and return home.
     */
    goBack(monitorIndex = null) {
        this._applyInteractionMonitorIndex(monitorIndex);
        // Close edge panel if open
        if (this._controller.edgePanel?.isOpen) {
            this._controller.edgePanel.close();
            return;
        }

        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive) {
            let active = phoneStack.getActiveWindow(this._getPhoneMonitorIndex());
            if (!active) {
                // Already home -- collapse drawer if expanded
                if (this._controller.getPhoneAppDrawerForMonitor?.(this._getPhoneMonitorIndex())?.isExpanded)
                    this._controller.getPhoneAppDrawerForMonitor?.(this._getPhoneMonitorIndex())?.collapse?.();
                return;
            }
            this._sendBackOrClose(active, () => this.goHome(this._getPhoneMonitorIndex()));
            return;
        }

        // No phone stack -- go home
        this.goHome(this._getPhoneMonitorIndex());
    }

    /**
     * Send Alt+Left to the window. If the title doesn't change within
     * a timeout, close the window and invoke the fallback.
     * @param {Meta.Window} metaWindow
     * @param {Function} goHomeFn
     */
    _sendBackOrClose(metaWindow, goHomeFn) {
        let titleBefore = metaWindow.get_title();
        this._sendBackNavigation();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            try {
                let actor = metaWindow.get_compositor_private?.();
                if (!actor)
                    return GLib.SOURCE_REMOVE;
            } catch (_) {
                return GLib.SOURCE_REMOVE;
            }

            let titleAfter = metaWindow.get_title();
            if (titleAfter === titleBefore) {
                goHomeFn?.();
                metaWindow.delete(global.get_current_time());
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Simulate Alt+Left key press using a virtual keyboard device.
     */
    _sendBackNavigation() {
        let seat = Clutter.get_default_backend().get_default_seat();
        let vkbd = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE);
        let now = global.get_current_time();

        vkbd.notify_keyval(now, Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        vkbd.notify_keyval(now, Clutter.KEY_Left, Clutter.KeyState.PRESSED);
        vkbd.notify_keyval(now, Clutter.KEY_Left, Clutter.KeyState.RELEASED);
        vkbd.notify_keyval(now, Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
    }

    // ── Split-screen support ─────────────────────────────────────────

    /**
     * Test whether a window is currently in split-screen mode.
     * @param {Meta.Window} metaWindow
     * @returns {boolean}
     */
    _isSplitScreenWindow(metaWindow) {
        let phoneStack = this._controller.phoneWindowStack;
        return phoneStack?.isSplitWindow(metaWindow) ?? false;
    }

    /**
     * Test whether split-screen is currently active.
     * @returns {boolean}
     */
    isSplitScreenActive() {
        let phoneStack = this._controller.phoneWindowStack;
        return phoneStack?.hasSplitWindows?.(this._getPhoneMonitorIndex()) ?? false;
    }

    /**
     * Get the available bounds for split-screen layout.
     * @returns {{monitorIndex: number, x: number, y: number, width: number, height: number}|null}
     */
    _getSplitBounds() {
        let monIdx = Number.isInteger(this._splitMonitorIndex)
            ? this._splitMonitorIndex
            : this._getPhoneMonitorIndex();
        let monitor = Main.layoutManager.monitors[monIdx] ??
                      this._getPhoneMonitor();
        if (!monitor)
            return null;

        let panelH = this._controller?.getPhoneTopInset?.(monIdx) ?? Main.panel?.height ?? 0;
        let bottomBarH = this._controller.getPhoneGestureBarForMonitor?.(monIdx)?.height ?? 20;
        return {
            monitorIndex: monIdx,
            x: monitor.x,
            y: monitor.y + panelH,
            width: monitor.width,
            height: monitor.height - panelH - bottomBarH,
        };
    }

    /**
     * Enter split-screen drop mode from the recent apps overlay.
     * Creates a floating drag clone and shows top/bottom drop zones.
     * @param {Object} card - the recent apps card
     */
    enterSplitDropMode(card) {
        if (!card?._metaWindow)
            return;
        this._splitDropCard = card;
        this._splitDropZone = null;

        let cardBody = card._cardBody || card;
        let [cardX, cardY] = cardBody.get_transformed_position();
        let cardW = cardBody.width;
        let cardH = cardBody.height;

        card.ease({ opacity: 0, duration: 150 });

        // Dim other cards
        let strip = this._controller.recentCardsStrip ??
                    this._controller.recentCardsBox;
        if (strip) {
            for (let child of strip.get_children()) {
                if (child !== card && child._metaWindow)
                    child.ease({ opacity: 60, duration: 150 });
            }
        }

        let dragScale = 0.65;
        let dragW = Math.round(cardW * dragScale);
        let dragH = Math.round(cardH * dragScale);

        this._buildSplitDropZones();

        this._splitDragClone = new Clutter.Clone({
            source: cardBody,
            width: dragW,
            height: dragH,
            x: Math.round(cardX + (cardW - dragW) / 2),
            y: Math.round(cardY + (cardH - dragH) / 2),
            opacity: 220,
        });
        this._splitDragClone.set_pivot_point(0.5, 0.5);

        let overlay = this._controller.recentOverlay;
        if (overlay)
            overlay.add_child(this._splitDragClone);

        this._splitDragClone.set_scale(0.8, 0.8);
        this._splitDragClone.ease({
            scale_x: 1, scale_y: 1,
            opacity: 230,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /**
     * Build the top/bottom/floating drop zone overlay for split-screen.
     */
    _buildSplitDropZones() {
        let bounds = this._getSplitBounds();
        if (!bounds)
            return;

        let zoneGap = 8;
        let topH = Math.round(bounds.height * 0.38);
        let bottomH = Math.round(bounds.height * 0.38);
        let centerH = bounds.height - topH - bottomH - zoneGap * 2;
        let centerY = topH + zoneGap;

        this._splitZoneOverlay = new St.Widget({
            x: 0, y: 0,
            width: bounds.width, height: bounds.height,
            reactive: false,
        });

        let makeZone = (x, y, w, h, iconName, label) => {
            let zone = new St.Widget({
                style_class: 'convergence-split-zone',
                layout_manager: new Clutter.BinLayout(),
                x, y, width: w, height: h,
            });
            let box = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true, y_expand: true,
            });
            let icon = new St.Icon({
                icon_name: iconName,
                icon_size: 28,
                style: 'color: white; margin-bottom: 8px;',
                x_align: Clutter.ActorAlign.CENTER,
            });
            let lbl = new St.Label({
                text: label,
                style_class: 'convergence-split-zone-label',
            });
            box.add_child(icon);
            box.add_child(lbl);
            zone.add_child(box);
            return zone;
        };

        this._splitTopZone = makeZone(
            0, 0, bounds.width, topH,
            'go-up-symbolic', 'Split top');

        this._splitFloatingZone = makeZone(
            Math.round(bounds.width * 0.15), centerY,
            Math.round(bounds.width * 0.7), centerH,
            'window-restore-symbolic', 'Floating window');

        this._splitBottomZone = makeZone(
            0, centerY + centerH + zoneGap, bounds.width, bottomH,
            'go-down-symbolic', 'Split bottom');

        this._splitZoneOverlay.add_child(this._splitTopZone);
        this._splitZoneOverlay.add_child(this._splitFloatingZone);
        this._splitZoneOverlay.add_child(this._splitBottomZone);

        let overlay = this._controller.recentOverlay;
        if (overlay)
            overlay.add_child(this._splitZoneOverlay);

        this._splitZoneOverlay.opacity = 0;
        this._splitZoneOverlay.ease({
            opacity: 255, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /**
     * Update which drop zone is highlighted based on finger position.
     * @param {number} y - screen y coordinate
     */
    updateSplitDropHighlight(y) {
        let bounds = this._getSplitBounds();
        if (!bounds)
            return;

        let topThreshold = bounds.y + bounds.height * 0.38;
        let bottomThreshold = bounds.y + bounds.height * (1 - 0.38);
        let zone;
        if (y < topThreshold)
            zone = 'top';
        else if (y > bottomThreshold)
            zone = 'bottom';
        else
            zone = 'floating';

        if (zone === this._splitDropZone)
            return;
        this._splitDropZone = zone;

        let zones = [
            [this._splitTopZone, 'top'],
            [this._splitFloatingZone, 'floating'],
            [this._splitBottomZone, 'bottom'],
        ];
        for (let [zoneWidget, name] of zones) {
            if (!zoneWidget)
                continue;
            zoneWidget.remove_all_transitions();
            if (zone === name) {
                zoneWidget.ease({
                    opacity: 255,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                zoneWidget.style =
                    'background-color: rgba(80, 140, 255, 0.55); ' +
                    'border: 3px solid rgba(120, 180, 255, 0.95); ' +
                    'border-radius: 20px; margin: 8px;';
            } else {
                zoneWidget.ease({
                    opacity: 140,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                zoneWidget.style = null;
            }
        }
    }

    /**
     * Commit the split-screen drop. Begins split-screen or creates
     * a floating window depending on the highlighted zone.
     */
    commitSplitDrop() {
        let card = this._splitDropCard;
        let zone = this._splitDropZone;

        if (!card?._metaWindow || !zone) {
            this.cancelSplitDrop();
            return;
        }

        let metaWindow = card._metaWindow;
        this._cleanupSplitDropUI();

        if (zone === 'floating')
            this._makeFloatingWindow(metaWindow);
        else
            this._beginSplitScreen(metaWindow, zone);
    }

    /**
     * Cancel a split-screen drop in progress.
     */
    cancelSplitDrop() {
        let strip = this._controller.recentCardsStrip ??
                    this._controller.recentCardsBox;
        if (strip) {
            for (let child of strip.get_children()) {
                if (child._metaWindow)
                    child.ease({ opacity: 255, duration: 150 });
            }
        }
        this._cleanupSplitDropUI();
    }

    /**
     * Remove all split-screen drop mode UI actors.
     */
    _cleanupSplitDropUI() {
        if (this._splitDragClone) {
            this._splitDragClone.destroy();
            this._splitDragClone = null;
        }
        if (this._splitZoneOverlay) {
            this._splitZoneOverlay.destroy();
            this._splitZoneOverlay = null;
        }
        this._splitTopZone = null;
        this._splitBottomZone = null;
        this._splitFloatingZone = null;
        this._splitDropCard = null;
        this._splitDropZone = null;
    }

    /**
     * Begin split-screen by snapping the first window to a half and
     * showing the app drawer for second-app selection.
     * @param {Meta.Window} metaWindow
     * @param {string} position - 'top' or 'bottom'
     */
    _beginSplitScreen(metaWindow, position) {
        this._splitMonitorIndex = this._getPhoneMonitorIndex();
        this._splitFirstWindow = metaWindow;
        this._splitFirstPosition = position;

        let phoneStack = this._controller.phoneWindowStack;
        phoneStack?.markForSplit(metaWindow, this._getPhoneMonitorIndex());

        this._placeWindowInHalf(metaWindow, position, 0.5);

        if (phoneStack) {
            phoneStack.goHome(this._getPhoneMonitorIndex());
            phoneStack.syncVisibility();
        }

        this._showAppDrawerForSecondPick(metaWindow);
    }

    /**
     * Place a window in the top or bottom half of the screen.
     * @param {Meta.Window} metaWindow
     * @param {string} position - 'top' or 'bottom'
     * @param {number} ratio - vertical ratio (0..1)
     */
    _placeWindowInHalf(metaWindow, position, ratio) {
        let bounds = this._getSplitBounds();
        if (!bounds)
            return;

        if (isWindowMaximized(metaWindow))
            metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);

        let gap = Math.round(DIVIDER_HEIGHT / 2);
        let topH = Math.round(bounds.height * ratio) - gap;
        let bottomH = bounds.height - topH - DIVIDER_HEIGHT;
        let x = bounds.x;
        let w = bounds.width;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            if (position === 'top')
                metaWindow.move_resize_frame(true, x, bounds.y, w, topH);
            else
                metaWindow.move_resize_frame(true, x, bounds.y + topH + DIVIDER_HEIGHT, w, bottomH);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Show the app drawer for picking the second split-screen app.
     * Watches for focus changes on existing windows or new windows.
     * @param {Meta.Window} firstWindow
     */
    _showAppDrawerForSecondPick(firstWindow) {
        let phoneMonitorIndex = this._getPhoneMonitorIndex();
        this._controller.windowManager?.hideRecentApps?.(phoneMonitorIndex);
        this._splitPendingSecondPick = true;

        this._splitFocusWatchId = global.display.connect(
            'notify::focus-window',
            () => {
                if (!this._splitPendingSecondPick)
                    return;
                let focused = global.display.get_focus_window();
                if (!focused || focused === firstWindow)
                    return;
                let ps = this._controller.phoneWindowStack;
                if (!ps?.hasWindow(focused, phoneMonitorIndex))
                    return;
                this._splitPendingSecondPick = false;
                this._disconnectSplitFocusWatch();
                this._completeSplitScreen(focused);
            }
        );

        let appDrawer = this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex);
        if (appDrawer) {
            appDrawer.show?.();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                appDrawer.expand?.();
                return GLib.SOURCE_REMOVE;
            });
        }

        this._splitDrawerCollapsedAt = 0;
        this._splitDrawerWatchId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 300,
            () => {
                if (!this._splitPendingSecondPick) {
                    this._splitDrawerWatchId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                let drawer = this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex);
                let expanded = drawer?.isExpanded ?? false;
                if (expanded) {
                    this._splitDrawerCollapsedAt = 0;
                    return GLib.SOURCE_CONTINUE;
                }
                let now = GLib.get_monotonic_time() / 1000;
                if (this._splitDrawerCollapsedAt === 0) {
                    this._splitDrawerCollapsedAt = now;
                    return GLib.SOURCE_CONTINUE;
                }
                if (now - this._splitDrawerCollapsedAt < 3000)
                    return GLib.SOURCE_CONTINUE;

                this._splitDrawerWatchId = 0;
                this._splitPendingSecondPick = false;
                this._disconnectSplitFocusWatch();
                this._exitSplitScreen(null, phoneMonitorIndex);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Disconnect split-screen focus and drawer watcher signals.
     */
    _disconnectSplitFocusWatch() {
        if (this._splitFocusWatchId) {
            global.display.disconnect(this._splitFocusWatchId);
            this._splitFocusWatchId = 0;
        }
        if (this._splitDrawerWatchId) {
            GLib.source_remove(this._splitDrawerWatchId);
            this._splitDrawerWatchId = 0;
        }
        this._splitDrawerCollapsedAt = 0;
    }

    /**
     * Complete split-screen by placing the second window in the
     * remaining half and building the divider.
     * @param {Meta.Window} secondWindow
     */
    _completeSplitScreen(secondWindow) {
        let phoneMonitorIndex = Number.isInteger(this._splitMonitorIndex)
            ? this._splitMonitorIndex
            : this._getPhoneMonitorIndex();
        this._splitPendingSecondPick = false;
        this._disconnectSplitFocusWatch();

        let firstWindow = this._splitFirstWindow;
        let firstPos = this._splitFirstPosition;
        if (!firstWindow || !firstPos) {
            this._controller.windowManager?.hideRecentApps?.(phoneMonitorIndex);
            return;
        }

        let secondPos = firstPos === 'top' ? 'bottom' : 'top';
        let phoneStack = this._controller.phoneWindowStack;
        phoneStack?.markForSplit(secondWindow, phoneMonitorIndex);
        this._placeWindowInHalf(secondWindow, secondPos, 0.5);
        this._controller.windowManager?.hideRecentApps?.(phoneMonitorIndex);

        if (phoneStack) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                phoneStack.enterSplitMode(firstWindow, secondWindow, phoneMonitorIndex);
                this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex)?.hide?.();

                this._splitState = {
                    topWindow: firstPos === 'top' ? firstWindow : secondWindow,
                    bottomWindow: firstPos === 'bottom' ? firstWindow : secondWindow,
                    ratio: 0.5,
                };
                this._buildSplitDivider();
                return GLib.SOURCE_REMOVE;
            });
        }

        this._splitFirstWindow = null;
        this._splitFirstPosition = null;
    }

    /**
     * Build the draggable divider between split-screen windows.
     */
    _buildSplitDivider() {
        this._destroySplitDivider();

        let bounds = this._getSplitBounds();
        if (!bounds || !this._splitState)
            return;

        let gap = Math.round(DIVIDER_HEIGHT / 2);
        let topH = Math.round(bounds.height * this._splitState.ratio) - gap;
        let dividerY = bounds.y + topH;

        this._splitDivider = new St.Widget({
            style_class: 'convergence-split-divider',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            x: bounds.x,
            y: dividerY,
            width: bounds.width,
            height: DIVIDER_HEIGHT,
        });

        let handle = new St.Widget({
            style_class: 'convergence-split-divider-handle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._splitDivider.add_child(handle);

        this._splitDividerGesture = null;

        this._splitDivider.connect('captured-event', (_a, event) => {
            let type = event.type();

            if (type === Clutter.EventType.TOUCH_BEGIN ||
                type === Clutter.EventType.BUTTON_PRESS) {
                let [, y] = event.get_coords();
                this._splitDividerGesture = {
                    startY: y,
                    startRatio: this._splitState?.ratio ?? 0.5,
                    grab: global.stage.grab(this._splitDivider),
                };
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.TOUCH_UPDATE ||
                type === Clutter.EventType.MOTION) {
                let g = this._splitDividerGesture;
                if (!g?.grab)
                    return Clutter.EVENT_PROPAGATE;

                let splitBounds = this._getSplitBounds();
                if (!splitBounds)
                    return Clutter.EVENT_STOP;

                let [, y] = event.get_coords();
                let dy = y - g.startY;
                let newRatio = g.startRatio + dy / splitBounds.height;
                newRatio = Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, newRatio));
                this._resizeSplitWindows(newRatio, splitBounds);
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.TOUCH_END ||
                type === Clutter.EventType.TOUCH_CANCEL ||
                type === Clutter.EventType.BUTTON_RELEASE) {
                let g = this._splitDividerGesture;
                if (g?.grab) {
                    g.grab.dismiss();
                    g.grab = null;
                }
                this._splitDividerGesture = null;

                let ratio = this._splitState?.ratio ?? 0.5;
                if (ratio <= SPLIT_DISMISS_THRESHOLD)
                    this._exitSplitScreen(this._splitState?.bottomWindow);
                else if (ratio >= 1 - SPLIT_DISMISS_THRESHOLD)
                    this._exitSplitScreen(this._splitState?.topWindow);

                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.addTopChrome(this._splitDivider);
    }

    /**
     * Resize split-screen windows to the given ratio.
     * @param {number} ratio
     * @param {Object} [bounds]
     */
    _resizeSplitWindows(ratio, bounds) {
        if (!this._splitState)
            return;
        if (!bounds)
            bounds = this._getSplitBounds();
        if (!bounds)
            return;

        this._splitState.ratio = ratio;

        let gap = Math.round(DIVIDER_HEIGHT / 2);
        let topH = Math.round(bounds.height * ratio) - gap;
        let bottomH = bounds.height - topH - DIVIDER_HEIGHT;
        let dividerY = bounds.y + topH;

        let top = this._splitState.topWindow;
        let bottom = this._splitState.bottomWindow;

        if (top)
            top.move_resize_frame(true, bounds.x, bounds.y, bounds.width, topH);
        if (bottom)
            bottom.move_resize_frame(true, bounds.x, dividerY + DIVIDER_HEIGHT, bounds.width, bottomH);

        if (this._splitDivider)
            this._splitDivider.y = dividerY;
    }

    /**
     * Destroy the split-screen divider widget.
     */
    _destroySplitDivider() {
        if (this._splitDividerGesture?.grab) {
            this._splitDividerGesture.grab.dismiss();
            this._splitDividerGesture = null;
        }
        if (this._splitDivider) {
            Main.layoutManager.removeChrome(this._splitDivider);
            this._splitDivider.destroy();
            this._splitDivider = null;
        }
    }

    /**
     * Exit split-screen mode. Optionally activate a surviving window,
     * otherwise return to the home screen.
     * @param {Meta.Window|null} [activateWindow=null]
     */
    _exitSplitScreen(activateWindow = null, monitorIndex = null) {
        let phoneMonitorIndex = Number.isInteger(monitorIndex)
            ? monitorIndex
            : (Number.isInteger(this._splitMonitorIndex)
                ? this._splitMonitorIndex
                : this._getPhoneMonitorIndex());
        let hadSplit = !!this._splitState;
        let hadPending = !!this._splitFirstWindow;

        if (!hadSplit && !hadPending)
            return;

        this._splitPendingSecondPick = false;
        this._disconnectSplitFocusWatch();
        this._destroySplitDivider();

        let phoneStack = this._controller.phoneWindowStack;
        phoneStack?.exitSplitMode(phoneMonitorIndex);

        this._splitState = null;
        this._splitMonitorIndex = null;
        this._splitFirstWindow = null;
        this._splitFirstPosition = null;

        if (activateWindow && phoneStack?.hasWindow(activateWindow, phoneMonitorIndex))
            phoneStack.activateWindow(activateWindow, phoneMonitorIndex);
        else
            phoneStack?.goHome(phoneMonitorIndex);
    }

    /**
     * Make a window float above others in a centred popup.
     * @param {Meta.Window} metaWindow
     */
    _makeFloatingWindow(metaWindow) {
        if (!metaWindow)
            return;

        let phoneStack = this._controller.phoneWindowStack;
        metaWindow._isFloatingPopup = true;
        phoneStack?.removeWindow(metaWindow, this._getPhoneMonitorIndex());

        if (metaWindow.is_on_all_workspaces())
            metaWindow.unstick();
        if (metaWindow.get_maximized())
            metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);

        let bounds = this._getSplitBounds();
        if (bounds) {
            let w = Math.round(bounds.width * 0.55);
            let h = Math.round(bounds.height * 0.5);
            let x = bounds.x + Math.round((bounds.width - w) / 2);
            let y = bounds.y + Math.round((bounds.height - h) / 2);
            metaWindow.move_resize_frame(false, x, y, w, h);
        }

        metaWindow.make_above();
        metaWindow.activate(global.get_current_time());
        this._controller.windowManager?.hideRecentApps?.();
    }

    // ── Relayout ─────────────────────────────────────────────────────

    /**
     * Trigger a relayout pass for all managed windows.
     */
    relayout() {
        this.remaxAllWindows();
    }

    setMonitorIndex(monitorIndex = null) {
        this._monitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        this.relayout();
    }

    refreshTopology(monitorIndex = null) {
        if (this._splitState)
            this._exitSplitScreen();
        this.setMonitorIndex(monitorIndex);
    }

    // ── Teardown ─────────────────────────────────────────────────────

    /**
     * Destroy the PhoneWorkspaces instance and clean up all state.
     */
    destroy() {
        this._controller.windowManager?.hideRecentApps?.();
        this._exitSplitScreen();

        this._restoreManagedWindowActors();

        for (let [metaWindow, signals] of this._windowSignals) {
            for (let id of signals) {
                try { metaWindow.disconnect(id); } catch (_e) {}
            }
        }
        this._windowSignals.clear();
        this._windowActorSignals.clear();
        this._minimizeAnimState.clear();

        if (this._swipeTimeout) {
            GLib.source_remove(this._swipeTimeout);
            this._runtimeDisposer?.untrackTimeout(this._swipeTimeout);
            this._swipeTimeout = 0;
        }

        this._runtimeDisposer?.dispose();
        this._runtimeDisposer = null;
    }
}
