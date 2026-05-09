// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Logger } from '../../shared/utilities/logger.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';

const PREVIEW_DELAY_MS = 420;
const PREVIEW_THUMB_W = 200;
const PREVIEW_THUMB_H = 130;
const PREVIEW_GRACE_MS = 300;
const PREVIEW_WATCHDOG_MS = 250;
const PEEK_ENTER_DELAY_MS = 200;
const PEEK_DIM_OPACITY = 80;

/**
 * Window preview tooltips shown on taskbar icon hover.
 * Displays thumbnail clones of an app's windows with close buttons,
 * peek-on-hover, and click-to-activate.
 */
export class TaskbarPreviews {
    /**
     * @param {Object} taskbar - Parent Taskbar instance
     * @param {Object} settings - GSettings instance
     */
    constructor(taskbar, settings) {
        this._taskbar = taskbar;
        this._settings = settings ?? null;
        this._logger = new Logger('TaskbarPreviews', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();

        this._windowPreviewPopup = null;
        this._windowPreviewAnchor = null;
        this._windowPreviewAnchorDestroyId = 0;
        this._windowPreviewTimerId = 0;
        this._previewGraceTimerId = 0;
        this._previewWatchdogId = 0;
        this._peekedWindows = null;
        this._previewTooltipSuppressUntil = 0;

        this._taskbarTooltip = null;
        this._taskbarTooltipId = 0;
        this._taskbarTooltipAnchor = null;
    }

    /**
     * Show a window preview popup for the given anchor button and app.
     * @param {St.Button} anchor
     * @param {Object} app - Shell.App
     */
    showWindowPreview(anchor, app) {
        if (!anchor || !app) return;

        this.hideTaskbarTooltip();
        this.hideWindowPreview();
        this._previewTooltipSuppressUntil = 0;

        let windows = app.get_windows().filter(w => {
            if (w.get_window_type() !== Meta.WindowType.NORMAL) return false;
            if (w.is_skip_taskbar()) return false;
            return true;
        });

        let previewsEnabled = true;
        try {
            if (this._settings?.settings_schema?.has_key?.('taskbar-show-window-previews'))
                previewsEnabled = this._settings.get_boolean('taskbar-show-window-previews');
        } catch (_e) {}

        if (windows.length === 0 || !previewsEnabled) {
            this.showTaskbarTooltip(anchor, app.get_name?.() ?? app.get_id?.() ?? '');
            return;
        }

        this._runtimeDisposer.restartTimeout(
            this,
            '_windowPreviewTimerId',
            GLib.PRIORITY_DEFAULT,
            PREVIEW_DELAY_MS,
            () => {
                if (!anchor?.get_parent()) return GLib.SOURCE_REMOVE;

                let wins = app.get_windows().filter(w =>
                    w.get_window_type() === Meta.WindowType.NORMAL &&
                    !w.is_skip_taskbar());
                if (wins.length === 0) return GLib.SOURCE_REMOVE;

                let popup = new St.Widget({
                    style_class: 'convergence-window-preview-popup',
                    layout_manager: new Clutter.BoxLayout({
                        orientation: Clutter.Orientation.VERTICAL,
                    }),
                    reactive: true,
                    opacity: 0,
                });

                let header = new St.Label({
                    text: app.get_name?.() ?? '',
                    style_class: 'convergence-window-preview-header',
                });
                popup.add_child(header);

                let row = new St.BoxLayout({
                    style_class: 'convergence-window-preview-row',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                popup.add_child(row);

                for (let metaWindow of wins) {
                    let thumb = this._createPreviewThumbnail(metaWindow, popup);
                    if (thumb) row.add_child(thumb);
                }

                Main.layoutManager.uiGroup.add_child(popup);

                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (!popup.get_parent()) return GLib.SOURCE_REMOVE;
                    this._positionPreviewPopup(anchor, popup);
                    popup.ease({
                        opacity: 255, duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    return GLib.SOURCE_REMOVE;
                });

                let enterId = popup.connect('enter-event', () => {
                    this._cancelPreviewGraceDismiss();
                    return Clutter.EVENT_PROPAGATE;
                });
                let leaveId = popup.connect('leave-event', () => {
                    this._dismissPreviewGracefully();
                    return Clutter.EVENT_PROPAGATE;
                });
                popup._previewSignalIds = [enterId, leaveId];

                this._windowPreviewPopup = popup;
                this._windowPreviewAnchor = anchor;
                this._runtimeDisposer.replaceConnection(this, '_windowPreviewAnchorDestroyId', anchor, 'destroy', () => {
                    this._windowPreviewAnchorDestroyId = 0;
                    this._windowPreviewAnchor = null;
                    this.hideWindowPreview();
                });
                this._startPreviewWatchdog();
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Show a simple text tooltip near a taskbar icon.
     * @param {St.Button} anchor
     * @param {string} text
     */
    showTaskbarTooltip(anchor, text) {
        if (!anchor || !text) return;
        this.hideTaskbarTooltip();
        this._runtimeDisposer.restartTimeout(
            this,
            '_taskbarTooltipId',
            GLib.PRIORITY_DEFAULT,
            420,
            () => {
                if (!anchor?.get_parent()) return GLib.SOURCE_REMOVE;

                let tooltip = new St.Label({
                    style_class: 'convergence-taskbar-tooltip',
                    text,
                    opacity: 0,
                });
                Main.layoutManager.uiGroup.add_child(tooltip);

                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (!tooltip.get_parent()) return GLib.SOURCE_REMOVE;
                    this._positionPreviewPopup(anchor, tooltip);
                    tooltip.ease({
                        opacity: 255, duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    return GLib.SOURCE_REMOVE;
                });

                this._taskbarTooltip = tooltip;
                this._taskbarTooltipAnchor = anchor;
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Hide the text tooltip.
     */
    hideTaskbarTooltip() {
        this._runtimeDisposer.clearTimeoutRef(this, '_taskbarTooltipId');
        if (this._taskbarTooltip) {
            let tooltip = this._taskbarTooltip;
            this._taskbarTooltip = null;
            this._taskbarTooltipAnchor = null;
            tooltip.ease({
                opacity: 0, duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (tooltip.get_parent())
                        tooltip.get_parent().remove_child(tooltip);
                    tooltip.destroy();
                },
            });
        }
    }

    /**
     * Hide the window preview popup immediately.
     */
    hideWindowPreview() {
        this._runtimeDisposer.clearTimeoutRef(this, '_windowPreviewTimerId');
        this._cancelPreviewGraceDismiss();
        this._stopPreviewWatchdog();
        this._unpeekWindows();

        this._runtimeDisposer.clearConnectionRef(
            this, '_windowPreviewAnchorDestroyId', this._windowPreviewAnchor);
        this._windowPreviewAnchor = null;

        if (this._windowPreviewPopup)
            this._previewTooltipSuppressUntil =
                GLib.get_monotonic_time() / 1000 + 500;

        if (this._windowPreviewPopup) {
            let popup = this._windowPreviewPopup;
            this._windowPreviewPopup = null;

            if (popup._previewSignalIds) {
                for (let id of popup._previewSignalIds)
                    popup.disconnect(id);
                popup._previewSignalIds = null;
            }
            popup.reactive = false;
            popup.ease({
                opacity: 0, duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (popup.get_parent())
                        popup.get_parent().remove_child(popup);
                    popup.destroy();
                },
            });
        }
    }

    /**
     * Check whether the tooltip is suppressed (post-preview cooldown).
     * @returns {boolean}
     */
    isPreviewTooltipSuppressed() {
        if (!this._previewTooltipSuppressUntil) return false;
        let now = GLib.get_monotonic_time() / 1000;
        return now < this._previewTooltipSuppressUntil;
    }

    /**
     * Create a single window thumbnail card for the preview popup.
     * @param {Object} metaWindow
     * @param {St.Widget} popup
     * @returns {St.Widget|null}
     * @private
     */
    _createPreviewThumbnail(metaWindow, popup) {
        let windowActor = metaWindow.get_compositor_private();
        if (!windowActor) return null;

        let card = new St.Widget({
            style_class: 'convergence-window-preview-thumb',
            width: PREVIEW_THUMB_W,
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });
        card.set_layout_manager(new Clutter.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
        }));

        let cloneContainer = new St.Widget({
            clip_to_allocation: true,
            width: PREVIEW_THUMB_W,
            height: PREVIEW_THUMB_H,
        });
        let clone = new Clutter.Clone({ source: windowActor });
        cloneContainer.add_child(clone);

        let syncScale = () => {
            let cw = cloneContainer.width, ch = cloneContainer.height;
            if (windowActor.width > 0 && windowActor.height > 0) {
                let s = Math.min(cw / windowActor.width, ch / windowActor.height);
                clone.set_scale(s, s);
                let scaledW = windowActor.width * s;
                let scaledH = windowActor.height * s;
                clone.set_position(
                    Math.round((cw - scaledW) / 2),
                    Math.round((ch - scaledH) / 2));
            }
        };
        clone.connect('notify::allocation', syncScale);
        card.add_child(cloneContainer);

        let closeBtn = new St.Button({
            style_class: 'convergence-window-preview-close',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        closeBtn.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 10,
        }));
        closeBtn.connect('clicked', () => {
            metaWindow.delete(global.get_current_time());
            card.destroy();
            if (popup) {
                let row = popup.get_children()?.[1];
                if (row && row.get_n_children() === 0)
                    this.hideWindowPreview();
            }
        });
        cloneContainer.add_child(closeBtn);

        let title = new St.Label({
            text: metaWindow.get_title() || 'Untitled',
            style_class: 'convergence-window-preview-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.set_ellipsize(3);
        title.clutter_text.set_max_length(30);
        card.add_child(title);

        let peekTimerId = 0;
        card.connect('notify::hover', () => {
            let hovered = card.hover;
            closeBtn.ease({
                opacity: hovered ? 255 : 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            if (hovered) {
                if (peekTimerId) GLib.source_remove(peekTimerId);
                peekTimerId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, PEEK_ENTER_DELAY_MS, () => {
                        peekTimerId = 0;
                        this._peekWindow(metaWindow);
                        return GLib.SOURCE_REMOVE;
                    });
            } else {
                if (peekTimerId) {
                    GLib.source_remove(peekTimerId);
                    peekTimerId = 0;
                }
                this._unpeekWindows();
            }
        });

        card.connect('button-release-event', (_actor, event) => {
            let btn = event.get_button?.() ?? 1;
            if (btn === 1) {
                metaWindow.activate(global.get_current_time());
                this.hideWindowPreview();
                return Clutter.EVENT_STOP;
            }
            if (btn === 2) {
                metaWindow.delete(global.get_current_time());
                return Clutter.EVENT_STOP;
            }
            if (btn === 3) {
                try {
                    Main.wm._showWindowMenu(
                        global.display, metaWindow,
                        Meta.WindowMenuType.WM, card);
                } catch (_e) {}
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        let destroyId = windowActor.connect('destroy', () => {
            if (card.get_parent()) card.destroy();
            if (popup) {
                let row = popup.get_children()?.[1];
                if (row && row.get_n_children() === 0)
                    this.hideWindowPreview();
            }
        });
        card.connect('destroy', () => {
            if (peekTimerId) {
                GLib.source_remove(peekTimerId);
                peekTimerId = 0;
            }
            try { windowActor.disconnect(destroyId); } catch (_e) {}
        });

        return card;
    }

    /**
     * Position a preview popup or tooltip relative to an anchor button.
     * @param {St.Button} anchor
     * @param {Clutter.Actor} popup
     * @private
     */
    _positionPreviewPopup(anchor, popup) {
        if (!anchor || !popup) return;
        let taskbarPos = this._taskbar._readTaskbarPosition();
        let [ax, ay] = anchor.get_transformed_position();
        let aw = anchor.width;
        let ah = anchor.height;
        let pw = popup.width;
        let ph = popup.height;
        let monitor = this._taskbar.getTaskbarAnchorMonitor() ??
            Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        let margin = 4;
        let x, y;

        if (taskbarPos === 'left') {
            x = ax + aw + margin;
            y = ay + Math.round((ah - ph) / 2);
        } else if (taskbarPos === 'right') {
            x = ax - pw - margin;
            y = ay + Math.round((ah - ph) / 2);
        } else {
            x = ax + Math.round((aw - pw) / 2);
            y = ay - ph - margin;
        }

        if (monitor) {
            x = Math.max(monitor.x + margin,
                Math.min(x, monitor.x + monitor.width - pw - margin));
            y = Math.max(monitor.y + margin,
                Math.min(y, monitor.y + monitor.height - ph - margin));
        }

        popup.set_position(Math.round(x), Math.round(y));
    }

    /**
     * Dim all windows except the target (peek effect).
     * @param {Object} metaWindow
     * @private
     */
    _peekWindow(metaWindow) {
        this._unpeekWindows();
        let targetActor = metaWindow.get_compositor_private();
        if (!targetActor) return;

        // Save the currently focused window so we can re-raise it on unpeek
        let focusApp = global.display.focus_window;
        this._peekedPrevFocusWindow = focusApp ?? null;

        this._peekedWindows = [];
        let workspace = global.workspace_manager.get_active_workspace();
        let windowActors = global.get_window_actors();
        for (let actor of windowActors) {
            let win = actor.get_meta_window?.();
            if (!win || actor === targetActor) continue;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (win.is_on_all_workspaces() || win.get_workspace() === workspace) {
                this._peekedWindows.push({ actor, origOpacity: actor.opacity });
                actor.ease({
                    opacity: PEEK_DIM_OPACITY, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }

        if (metaWindow.has_focus?.() === false) {
            try { metaWindow.raise(); } catch (_e) {}
        }
    }

    /**
     * Restore all peeked windows to their original opacity.
     * @private
     */
    _unpeekWindows() {
        if (!this._peekedWindows) return;
        for (let { actor, origOpacity } of this._peekedWindows) {
            try {
                actor.ease({
                    opacity: origOpacity, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } catch (_e) {}
        }
        this._peekedWindows = null;

        // Re-raise the previously focused window to restore z-order
        let prev = this._peekedPrevFocusWindow;
        this._peekedPrevFocusWindow = null;
        if (prev && !prev.is_hidden?.()) {
            try { prev.raise(); } catch (_e) {}
        }
    }

    /**
     * Dismiss the preview with a grace period (allows moving pointer to popup).
     * @private
     */
    _dismissPreviewGracefully() {
        this._cancelPreviewGraceDismiss();
        this._runtimeDisposer.restartTimeout(
            this,
            '_previewGraceTimerId',
            GLib.PRIORITY_DEFAULT,
            PREVIEW_GRACE_MS,
            () => {
                if (this._isPointerOverPreviewOrAnchor()) return GLib.SOURCE_REMOVE;
                this.hideWindowPreview();
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Cancel any pending grace-period dismiss.
     * @private
     */
    _cancelPreviewGraceDismiss() {
        this._runtimeDisposer.clearTimeoutRef(this, '_previewGraceTimerId');
    }

    /**
     * Check whether the pointer is over the preview popup or anchor button.
     * @returns {boolean}
     * @private
     */
    _isPointerOverPreviewOrAnchor() {
        let [x, y] = global.get_pointer();
        if (this._pointInActor(this._windowPreviewPopup, x, y)) return true;
        if (this._pointInActor(this._windowPreviewAnchor, x, y)) return true;
        return false;
    }

    /**
     * Test whether a point falls within an actor's bounds.
     * @param {Clutter.Actor|null} actor
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     * @private
     */
    _pointInActor(actor, x, y) {
        if (!actor?.get_parent() || !actor.visible || actor.width <= 0)
            return false;
        try {
            let [ax, ay] = actor.get_transformed_position();
            return x >= ax && x <= ax + actor.width &&
                   y >= ay && y <= ay + actor.height;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Start a watchdog timer that hides the preview if pointer leaves.
     * @private
     */
    _startPreviewWatchdog() {
        this._stopPreviewWatchdog();
        this._previewWatchdogId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, PREVIEW_WATCHDOG_MS, () => {
                if (!this._windowPreviewPopup) {
                    this._previewWatchdogId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (!this._isPointerOverPreviewOrAnchor()) {
                    this.hideWindowPreview();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        this._runtimeDisposer.trackTimeout(this._previewWatchdogId);
    }

    /**
     * Stop the watchdog timer.
     * @private
     */
    _stopPreviewWatchdog() {
        this._runtimeDisposer.clearTimeoutRef(this, '_previewWatchdogId');
    }

    /**
     * Clean up all resources.
     */
    destroy() {
        this.hideWindowPreview();
        this.hideTaskbarTooltip();
        this._runtimeDisposer?.dispose?.();
        this._runtimeDisposer = null;
        this._logger?.destroy?.();
    }
}
