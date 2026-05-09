// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Logger } from '../../shared/utilities/logger.js';
import {
    SCROLL_MULTIPLIER,
    SCROLL_END_TIMEOUT,
} from '../../shared/utilities/gestureConstants.js';

import {
    DrawerState,
    DRAG_CLAIM_THRESHOLD,
    KINETIC_DECEL,
    KINETIC_MIN_VELOCITY,
    RUBBER_BAND_FACTOR,
    ANIMATION_DURATION,
} from './appDrawer.js';

/**
 * Phone drawer gesture handler.
 *
 * Manages vertical swipe to expand/collapse the drawer, horizontal swipe
 * to change pages, continuous grid scrolling, DnD initiation from long-press,
 * trackpad smooth-scroll gestures, and folder spring-loaded drop targets.
 */
export class DrawerGestures {
    /**
     * @param {import('./appDrawer.js').AppDrawer} drawer - Parent drawer.
     * @param {import('gi://Gio').Settings|null} settings - Extension GSettings.
     */
    constructor(drawer, settings) {
        this._drawer = drawer;
        this._settings = settings ?? null;
        this._logger = new Logger('DrawerGestures', this._settings);
    }

    // ── Captured event dispatcher ─────────────────────────────────────

    /**
     * Top-level captured-event handler wired to the drawer actor.
     * @param {Clutter.Event} event
     * @returns {number} Clutter.EVENT_STOP or Clutter.EVENT_PROPAGATE
     */
    onDrawerCapturedEvent(event) {
        let type = event.type();
        let d = this._drawer;

        if (type === Clutter.EventType.KEY_PRESS && d._dndActive) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                d._cancelDnd?.();
                return Clutter.EVENT_STOP;
            }
        }

        if (type === Clutter.EventType.SCROLL && !d._dndActive) {
            let dir = event.get_scroll_direction();

            if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [sdx, sdy] = event.get_scroll_delta();
                return this._handleSmoothScroll(sdx, sdy, event);
            }

            if (d._state === DrawerState.EXPANDED) {
                let direction = 0;
                if (dir === Clutter.ScrollDirection.DOWN ||
                    dir === Clutter.ScrollDirection.RIGHT)
                    direction = 1;
                else if (dir === Clutter.ScrollDirection.UP ||
                         dir === Clutter.ScrollDirection.LEFT)
                    direction = -1;
                if (direction !== 0) {
                    this._stepGrid(direction);
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN)
            return this._onCapturedPress(event);

        if (type === Clutter.EventType.MOTION ||
            type === Clutter.EventType.TOUCH_UPDATE)
            return this._onCapturedMotion(event);

        if (type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL)
            return this._onCapturedRelease(event);

        return Clutter.EVENT_PROPAGATE;
    }

    // ── Press / motion / release ──────────────────────────────────────

    /** @private */
    _onCapturedPress(event) {
        let d = this._drawer;
        this._cancelScrollGesture();
        d._pagesContainer.remove_all_transitions();

        if (d._dndActive)
            d._cancelDnd?.();

        let [x, y] = event.get_coords();
        d._pressed = true;
        d._dragClaimed = false;
        d._dragDirection = null;
        d._dragInputIsMouse = (event.type() === Clutter.EventType.BUTTON_PRESS);
        d._dragStartX = x;
        d._dragStartY = y;
        d._dragStartTranslation = d._actor.translation_y;
        d._dragStartPageX = d._pagesContainer.translation_x;
        d._dragStartScrollY = d._pagesContainer.translation_y;
        d._gridScrollVelocity = 0;
        d._gridScrollLastY = y;
        d._gridScrollLastTime = GLib.get_monotonic_time();
        d._dragTimestamp = GLib.get_monotonic_time();
        return Clutter.EVENT_PROPAGATE;
    }

    /** @private */
    _onCapturedMotion(event) {
        let d = this._drawer;

        if (d._dndActive) {
            let [x, y] = event.get_coords();
            this._trackDndMotion(x, y);
            return Clutter.EVENT_STOP;
        }

        if (!d._pressed)
            return Clutter.EVENT_PROPAGATE;

        let [x, y] = event.get_coords();
        return this._processMotion(x, y);
    }

    /** @private */
    _processMotion(x, y) {
        let d = this._drawer;
        let dx = Math.abs(x - d._dragStartX);
        let dy = Math.abs(y - d._dragStartY);

        if (!d._dragClaimed) {
            let scale = d._getLayoutMonitor?.()?.geometry_scale ?? 1;
            let scaledThreshold = scale > 1
                ? Math.max(4, Math.round(DRAG_CLAIM_THRESHOLD / scale))
                : DRAG_CLAIM_THRESHOLD;
            if (Math.max(dx, dy) > scaledThreshold) {
                if (d._activeLpCancel) {
                    d._activeLpCancel();
                    d._activeLpCancel = null;
                }

                if (dy >= dx) {
                    if (d._state === DrawerState.EXPANDED) {
                        // When expanded, only allow downward swipe to collapse.
                        // Upward swipe is ignored — horizontal paging handles
                        // page navigation, no vertical grid scroll needed.
                        let swipeDown = (y - d._dragStartY) > 0;
                        if (swipeDown) {
                            d._dragDirection = 'vertical';
                            if (d._expandedContent)
                                d._expandedContent.visible = true;
                            d._setGestureBlurActive(true);
                        }
                    } else {
                        // From dock: vertical swipe expands/collapses
                        d._dragDirection = 'vertical';
                        if (d._expandedContent)
                            d._expandedContent.visible = true;
                        d._setGestureBlurActive(true);
                    }
                } else if (d._state === DrawerState.EXPANDED) {
                    d._dragDirection = 'horizontal';
                } else if (!d._dragInputIsMouse) {
                    d._dragDirection = 'workspace';
                    d._controller?.startWorkspaceSwipe?.(x);
                }

                d._dragClaimed = true;
                if (!d._scrollGestureActive) {
                    d._grab = global.stage.grab(d._actor);
                }
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
        }

        if (d._dragDirection === 'vertical') {
            let delta = y - d._dragStartY;
            let newTranslation = d._dragStartTranslation + delta;
            newTranslation = Math.max(d._expandedTranslation,
                Math.min(d._dockTranslation, newTranslation));
            d._actor.translation_y = newTranslation;

            let range = d._dockTranslation - d._expandedTranslation;
            let progress = range > 0
                ? 1 - (newTranslation - d._expandedTranslation) / range
                : 0;
            d._backdrop.opacity = Math.round(progress * 180);
            if (progress > 0 && !d._backdrop.visible)
                d._backdrop.show();
            let contentAlpha = Math.min(1, progress / 0.1);
            d._expandedContent.opacity = Math.round(contentAlpha * 255);

            d._controller?.onDrawerDragProgress?.(progress, d._getLayoutMonitorIndex?.());

            let atExpanded = newTranslation <= d._expandedTranslation + 20;
            if (atExpanded && d._emergencyDisableId === 0) {
                d._emergencyDisableId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, 10000, () => {
                        d._emergencyDisableId = 0;
                        Main.extensionManager.disableExtension('convergence@daniel-blandford.github.io');
                        return GLib.SOURCE_REMOVE;
                    });
            } else if (!atExpanded && d._emergencyDisableId !== 0) {
                GLib.source_remove(d._emergencyDisableId);
                d._emergencyDisableId = 0;
            }
        } else if (d._dragDirection === 'horizontal') {
            let deltaX = x - d._dragStartX;
            let newX = d._dragStartPageX + deltaX;
            let pw = d._pageWidth || d._drawerWidth;
            let minX = -((d._pages.length - 1) * pw);
            newX = Math.max(minX, Math.min(0, newX));
            d._pagesContainer.translation_x = newX;
        } else if (d._dragDirection === 'workspace') {
            d._controller?.updateWorkspaceSwipe?.(x);
        } else if (d._dragDirection === 'grid-scroll') {
            let deltaY = y - d._dragStartY;
            let rawY = d._dragStartScrollY + deltaY;
            let { maxScroll } = d._getScrollBounds();

            if (rawY > 0)
                rawY = rawY * RUBBER_BAND_FACTOR;
            else if (rawY < -maxScroll)
                rawY = -maxScroll + (rawY + maxScroll) * RUBBER_BAND_FACTOR;

            d._pagesContainer.translation_y = rawY;

            let now = GLib.get_monotonic_time();
            let dt = Math.max(1, (now - d._gridScrollLastTime) / 1000);
            let vy = (y - d._gridScrollLastY) / dt;
            d._gridScrollVelocity = 0.7 * vy + 0.3 * d._gridScrollVelocity;
            d._gridScrollLastY = y;
            d._gridScrollLastTime = now;

            // If the user scrolls past the top of the grid and keeps
            // pulling down, transition from grid-scroll to vertical
            // collapse so they can close the drawer from inside the grid.
            if (d._pagesContainer.translation_y >= 0 && deltaY > 60) {
                d._dragDirection = 'vertical';
                d._dragStartY = y;
                d._dragStartTranslation = d._actor.translation_y;
                d._pagesContainer.translation_y = 0;
                d._setGestureBlurActive(true);
            }
        }

        return Clutter.EVENT_STOP;
    }

    /** @private */
    _onCapturedRelease(event) {
        let d = this._drawer;

        if (d._dndActive) {
            d._pressed = false;
            d._dragClaimed = false;
            d._dragDirection = null;
            if (d._grab) {
                d._grab.dismiss();
                d._grab = null;
            }
            let [x, y] = event.get_coords();
            d._finishDnd?.(x, y);
            return Clutter.EVENT_STOP;
        }

        if (!d._pressed)
            return Clutter.EVENT_PROPAGATE;

        let [x, y] = event.get_coords();
        return this._processRelease(x, y);
    }

    /** @private */
    _processRelease(x, y) {
        let d = this._drawer;
        d._pressed = false;
        d._cancelEmergencyDisable();
        let wasClaimed = d._dragClaimed;
        let direction = d._dragDirection;
        d._dragClaimed = false;
        d._dragDirection = null;
        d._setGestureBlurActive(false);

        if (d._grab) {
            d._grab.dismiss();
            d._grab = null;
        }

        if (!wasClaimed)
            return Clutter.EVENT_PROPAGATE;

        let elapsed = (GLib.get_monotonic_time() - d._dragTimestamp) / 1000;

        if (direction === 'vertical') {
            let dy = y - d._dragStartY;
            let velocity = dy / Math.max(elapsed, 1);
            if (velocity > 0.5) {
                d._animateTo(DrawerState.DOCK);
            } else if (velocity < -0.5) {
                d._animateTo(DrawerState.EXPANDED);
            } else {
                let midpoint = (d._expandedTranslation + d._dockTranslation) / 2;
                if (d._actor.translation_y < midpoint)
                    d._animateTo(DrawerState.EXPANDED);
                else
                    d._animateTo(DrawerState.DOCK);
            }
        } else if (direction === 'horizontal') {
            let deltaX = x - d._dragStartX;
            let velocityX = deltaX / Math.max(elapsed, 1);
            let targetPage = d._currentPage;

            if (velocityX > 0.3)
                targetPage = Math.max(0, d._currentPage - 1);
            else if (velocityX < -0.3)
                targetPage = Math.min(d._pages.length - 1, d._currentPage + 1);
            else {
                let pw = d._pageWidth || d._drawerWidth;
                let currentX = d._pagesContainer.translation_x;
                targetPage = Math.round(-currentX / pw);
                targetPage = Math.max(0, Math.min(d._pages.length - 1, targetPage));
            }

            d.snapToPage(targetPage);
        } else if (direction === 'workspace') {
            let deltaX = x - d._dragStartX;
            let velocityX = deltaX / Math.max(elapsed, 1);
            d._controller?.endWorkspaceSwipe?.(x, velocityX);
        } else if (direction === 'grid-scroll') {
            let velocity = d._gridScrollVelocity;
            let currentY = d._pagesContainer.translation_y;
            let { maxScroll } = d._getScrollBounds();

            if (currentY > 0 || currentY < -maxScroll) {
                let target = currentY > 0 ? 0 : -maxScroll;
                d._pagesContainer.ease({
                    translation_y: target,
                    duration: 280,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                let absV = Math.abs(velocity);
                if (absV >= KINETIC_MIN_VELOCITY) {
                    let distance = velocity / -Math.log(KINETIC_DECEL);
                    let targetY = Math.max(-maxScroll,
                        Math.min(0, currentY + distance));
                    let duration = Math.min(1800, Math.max(300,
                        Math.abs(targetY - currentY) / absV * 1.5));
                    d._pagesContainer.ease({
                        translation_y: targetY,
                        duration: Math.round(duration),
                        mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                    });
                }
            }
        }

        return Clutter.EVENT_STOP;
    }

    // ── DnD motion tracking ───────────────────────────────────────────

    /** @private */
    _trackDndMotion(x, y) {
        let d = this._drawer;
        if (d._dndSafetyTimerId) {
            GLib.source_remove(d._dndSafetyTimerId);
            d._dndSafetyTimerId = 0;
        }
        if (d._dndGhost) {
            let cellW = d._iconCellW || 48;
            d._dndGhost.set_position(x - cellW / 2, y - cellW / 2);
        }
        d._updateRemoveZoneHover?.(x, y);

        // Detect drag above the drawer's grid area → collapse to home screen
        // Samsung: dragging an icon above the drawer reveals the home screen
        let gridTop = 0;
        if (d._gridClip) {
            let [, gy] = d._gridClip.get_transformed_position();
            gridTop = gy;
        } else if (d._actor) {
            let [, ay] = d._actor.get_transformed_position();
            gridTop = ay;
        }

        if (y < gridTop - 30 && !d._dndWasExpanded && !d._dndFromDock) {
            // Dragged above drawer — collapse to show home screen
            // (skip for dock-originated drags: drawer is already collapsed
            // and we need the remove zone to stay visible)
            d._dndWasExpanded = true;
            d._clearDndPreview?.();
            d._cancelEdgeScroll?.();
            d._hideDndRemoveZone?.();
            d._highlightDockForDrop?.(false);
            d.collapse();
        } else if (y >= gridTop && d._dndWasExpanded) {
            // Dragged back into drawer — re-expand
            d._dndWasExpanded = false;
            d._controller?.getPhoneHomeScreenForMonitor?.(d._getLayoutMonitorIndex())
                ?.cancelExternalDndHover?.();
            d.expand();
            d._showDndRemoveZone?.();
            if (!d._dndFromDock)
                d._highlightDockForDrop?.(true);
        }

        // Show hover feedback on home screen while dragging over it
        if (d._dndWasExpanded) {
            d._dndHomeTarget =
                d._controller?.getPhoneHomeScreenForMonitor?.(d._getLayoutMonitorIndex())
                    ?.showExternalDndHover?.(x, y) ?? null;
        }

        // Dock drop indicator works in both expanded and collapsed states
        // since the dock is always visible at the bottom.
        d._updateDockDropIndicator?.(x, y);

        if (!d._dndWasExpanded) {
            d._updateDndPreview?.(x, y);

            // Edge scroll: auto-advance pages when dragging near screen edges
            let screenW = global.stage.width;
            let edgeZone = 40;
            if (x < edgeZone)
                d._startEdgeScroll?.(-1);
            else if (x > screenW - edgeZone)
                d._startEdgeScroll?.(1);
            else
                d._cancelEdgeScroll?.();
        }
    }

    // ── Trackpad smooth-scroll gesture ────────────────────────────────

    /**
     * Handle a trackpad two-finger scroll event.
     * @param {number} sdx - Horizontal scroll delta.
     * @param {number} sdy - Vertical scroll delta.
     * @param {Clutter.Event} event
     * @returns {number}
     */
    _handleSmoothScroll(sdx, sdy, event) {
        let d = this._drawer;

        if (d._pressed && !d._scrollGestureActive)
            return Clutter.EVENT_PROPAGATE;

        if (!d._scrollGestureActive) {
            let [cursorX, cursorY] = event.get_coords();
            d._scrollGestureActive = true;
            d._setGestureBlurActive(true);
            d._scrollAccumX = 0;
            d._scrollAccumY = 0;

            d._pagesContainer.remove_all_transitions();

            d._pressed = true;
            d._dragClaimed = false;
            d._dragDirection = null;
            d._dragInputIsMouse = false;
            d._dragStartX = cursorX;
            d._dragStartY = cursorY;
            d._dragStartTranslation = d._actor.translation_y;
            d._dragStartPageX = d._pagesContainer.translation_x;
            d._dragStartScrollY = d._pagesContainer.translation_y;
            d._gridScrollVelocity = 0;
            d._gridScrollLastY = cursorY;
            d._gridScrollLastTime = GLib.get_monotonic_time();
            d._dragTimestamp = GLib.get_monotonic_time();
        }

        d._scrollAccumX += sdx * SCROLL_MULTIPLIER;
        d._scrollAccumY += sdy * SCROLL_MULTIPLIER;

        let virtualX = d._dragStartX + d._scrollAccumX;
        let virtualY = d._dragStartY + d._scrollAccumY;

        this._processMotion(virtualX, virtualY);
        this._renewScrollTimeout();
        return Clutter.EVENT_STOP;
    }

    /** @private */
    _renewScrollTimeout() {
        let d = this._drawer;
        if (d._scrollTimeoutId)
            GLib.source_remove(d._scrollTimeoutId);

        if (!this._scrollTimeoutCb) {
            this._scrollTimeoutCb = () => {
                d._scrollTimeoutId = 0;
                if (d._scrollGestureActive) {
                    d._scrollGestureActive = false;
                    d._setGestureBlurActive(false);
                    if (d._pressed) {
                        let vx = d._dragStartX + d._scrollAccumX;
                        let vy = d._dragStartY + d._scrollAccumY;
                        this._processRelease(vx, vy);
                    }
                }
                return GLib.SOURCE_REMOVE;
            };
        }
        d._scrollTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCROLL_END_TIMEOUT, this._scrollTimeoutCb);
    }

    /** Cancel an in-progress trackpad scroll gesture. */
    _cancelScrollGesture() {
        let d = this._drawer;
        if (d._scrollTimeoutId) {
            GLib.source_remove(d._scrollTimeoutId);
            d._scrollTimeoutId = 0;
        }
        d._scrollGestureActive = false;
        d._setGestureBlurActive(false);
    }

    /**
     * Step the grid by one page (for discrete scroll events).
     * @param {number} direction - 1 for next, -1 for previous.
     */
    _stepGrid(direction) {
        let d = this._drawer;
        if (d._pages.length > 1) {
            let target = Math.max(0, Math.min(
                d._pages.length - 1, d._currentPage + direction));
            if (target !== d._currentPage)
                d.snapToPage(target);
        }
    }

    destroy() {
        this._cancelScrollGesture();
        this._logger?.destroy?.();
        this._drawer = null;
        this._settings = null;
    }
}
