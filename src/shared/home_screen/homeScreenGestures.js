// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { SCROLL_MULTIPLIER, SCROLL_END_TIMEOUT } from '../utilities/gestureConstants.js';

const DRAG_THRESHOLD = 10;
const SWIPE_UP_THRESHOLD = 80;
const SWIPE_DOWN_COMMIT_PX = 60;
const HOME_PAGE_RUBBER_BAND = 0.26;
const HOME_PAGE_FLING_VELOCITY = 0.38;
const HOME_PAGE_PREDICT_MS = 180;
const HOME_PAGE_SNAP_PULL_RATIO = 0.18;
const HOME_DRAWER_FLING_OPEN_VELOCITY = -0.45;
const HOME_DRAWER_COMMIT_PROGRESS = 0.42;
const HOME_DRAWER_REVEAL_DISTANCE_MIN = 72;

/**
 * Handles gesture processing for the home screen: motion tracking,
 * release handling, trackpad scroll translation, and drawer reveal.
 */
export class HomeScreenGestures {
    /**
     * @param {object} homeScreen - The HomeScreen instance to delegate actions to.
     */
    constructor(homeScreen) {
        this._home = homeScreen;
    }

    /**
     * Process a motion event from the captured event handler.
     * @param {Clutter.Event} event
     * @returns {number} Clutter event propagation flag.
     */
    onGestureMotion(event) {
        let [x, y] = event.get_coords();
        return this._processMotion(x, y);
    }

    _processMotion(x, y) {
        let h = this._home;
        let dx = Math.abs(x - h._startX);
        let dy = Math.abs(y - h._startY);

        if (!h._claimed) {
            let threshold = h._pressOnButton
                ? Math.max(DRAG_THRESHOLD * 3, Math.round(24 * (h._scale ?? 1)))
                : DRAG_THRESHOLD;
            if (Math.max(dx, dy) < threshold)
                return Clutter.EVENT_PROPAGATE;

            h._cancelBgLongPress();
            let mode = h._controller?.displayConfig?.activeInputMode;
            let touchInput = mode === 'touch' || mode === 'Touch' ||
                             mode === 'mixed' || mode === 'Mixed';
            let horizontalBias = touchInput ? 0.86 : 1;

            if (dx > (dy * horizontalBias)) {
                if (!h._lastPressWasTouch && !h._scrollGestureActive) {
                    h._pressed = false;
                    return Clutter.EVENT_PROPAGATE;
                }
                h._dragDirection = 'horizontal';
                h._claimed = true;
                if (!h._scrollGestureActive)
                    h._grab = global.stage.grab(h._actor);
                h._homePageSwipeStartX = h._homePagesContainer.translation_x;
            } else if (y < h._startY) {
                if (!h._lastPressWasTouch || h._scrollGestureActive) {
                    h._pressed = false;
                    return Clutter.EVENT_PROPAGATE;
                }
                let np = h._controller?.notificationPanel;
                np?.selectPhoneMonitor?.();
                if (np?.isOpen) {
                    h._dragDirection = 'vertical-up-close-panel';
                    h._claimed = true;
                    if (!h._grab)
                        h._grab = global.stage.grab(h._actor);
                    np.progressiveCloseBegin();
                } else {
                    h._dragDirection = 'vertical-up';
                    h._claimed = true;
                    this._startHomeDrawerReveal();
                }
            } else {
                if (!h._lastPressWasTouch || h._scrollGestureActive) {
                    h._pressed = false;
                    return Clutter.EVENT_PROPAGATE;
                }
                let np = h._controller?.notificationPanel;
                np?.selectPhoneMonitor?.(h._getHomeMonitorIndex?.());
                if (np && !np.isOpen) {
                    h._dragDirection = 'vertical-down';
                    h._claimed = true;
                    if (!h._grab)
                        h._grab = global.stage.grab(h._actor);
                    np.progressiveOpenBegin(false);
                } else {
                    this._endHomeDrawerReveal(false);
                    h._pressed = false;
                    return Clutter.EVENT_PROPAGATE;
                }
            }
        }

        if (h._dragDirection === 'horizontal') {
            let deltaX = x - h._startX;
            let rawX = h._homePageSwipeStartX + deltaX;
            let pw = h._homePageWidth || 1;
            let pageCount = h._homePages.length;
            let minX = -((pageCount - 1) * pw);
            let newX = rawX;
            if (newX > 0)
                newX = newX * HOME_PAGE_RUBBER_BAND;
            else if (newX < minX)
                newX = minX + ((newX - minX) * HOME_PAGE_RUBBER_BAND);
            h._homePagesContainer.translation_x = newX;
            return Clutter.EVENT_STOP;
        }

        if (h._dragDirection === 'vertical-up')
            this._updateHomeDrawerRevealProgress(y);

        if (h._dragDirection === 'vertical-up-close-panel') {
            let np = h._controller?.notificationPanel;
            np?.selectPhoneMonitor?.(h._getHomeMonitorIndex?.());
            if (np) {
                let dy = h._startY - y;
                let panelH = np._progressiveClosePanelH || np._panel?.height || 300;
                let progress = Math.max(0, Math.min(1, dy / panelH));
                np.progressiveCloseUpdate(progress);
            }
        }

        if (h._dragDirection === 'vertical-down') {
            let np = h._controller?.notificationPanel;
            np?.selectPhoneMonitor?.(h._getHomeMonitorIndex?.());
            if (np) {
                let dy = y - h._startY;
                let panelH = np._progressivePanelH || np._panel?.height || 300;
                let progress = Math.max(0, Math.min(1, dy / panelH));
                np.progressiveOpenUpdate(progress);
            }
        }

        return Clutter.EVENT_STOP;
    }

    /**
     * Process a release event from the captured event handler.
     * @param {Clutter.Event} event
     * @returns {number} Clutter event propagation flag.
     */
    onGestureRelease(event) {
        let [x, y] = event.get_coords();
        return this._processRelease(x, y);
    }

    _processRelease(x, y) {
        let h = this._home;
        h._cancelBgLongPress();
        let wasClaimed = h._claimed;
        let direction = h._dragDirection;
        h._pressed = false;
        h._claimed = false;
        h._pressOnButton = false;
        h._dragDirection = null;

        if (h._grab) {
            h._grab.dismiss();
            h._grab = null;
        }

        if (!wasClaimed)
            return Clutter.EVENT_PROPAGATE;

        if (direction === 'horizontal') {
            let elapsed = (GLib.get_monotonic_time() - h._dragTimestamp) / 1000;
            let deltaX = x - h._startX;
            let velocityX = deltaX / Math.max(elapsed, 1);
            let pw = h._homePageWidth || 1;
            let currentX = h._homePagesContainer.translation_x;
            let predictedX = currentX + (velocityX * HOME_PAGE_PREDICT_MS);
            let targetPage = Math.round(-predictedX / pw);
            targetPage = Math.max(0, Math.min(h._homePages.length - 1, targetPage));

            if (Math.abs(velocityX) >= HOME_PAGE_FLING_VELOCITY) {
                targetPage = velocityX > 0
                    ? Math.max(0, h._homeCurrentPage - 1)
                    : Math.min(h._homePages.length - 1, h._homeCurrentPage + 1);
            } else if (Math.abs(deltaX) >= pw * HOME_PAGE_SNAP_PULL_RATIO) {
                targetPage = deltaX > 0
                    ? Math.max(0, h._homeCurrentPage - 1)
                    : Math.min(h._homePages.length - 1, h._homeCurrentPage + 1);
            }

            h._homeSnapToPage(targetPage, true, velocityX);
            return Clutter.EVENT_STOP;
        }

        if (direction === 'vertical-up') {
            let dy = h._startY - y;
            let elapsed = (GLib.get_monotonic_time() - h._dragTimestamp) / 1000;
            let velocityY = (y - h._startY) / Math.max(elapsed, 1);
            let useTouchProfile = h._shouldUseTouchHomeDrawerRevealProfile();
            let shouldOpen = false;

            if (useTouchProfile) {
                let revealDistance = this._getHomeDrawerRevealDistance();
                let revealProgress = Math.max(0, Math.min(1, dy / Math.max(1, revealDistance)));
                shouldOpen = revealProgress >= HOME_DRAWER_COMMIT_PROGRESS ||
                    velocityY < HOME_DRAWER_FLING_OPEN_VELOCITY;
            } else {
                shouldOpen = dy > SWIPE_UP_THRESHOLD ||
                    velocityY < HOME_DRAWER_FLING_OPEN_VELOCITY;
            }

            this._endHomeDrawerReveal(shouldOpen);
            return Clutter.EVENT_STOP;
        }

        if (direction === 'vertical-up-close-panel') {
            let np = h._controller?.notificationPanel;
            np?.selectPhoneMonitor?.();
            if (np) {
                let dy = h._startY - y;
                np.progressiveCloseEnd(dy >= SWIPE_DOWN_COMMIT_PX);
            }
            return Clutter.EVENT_STOP;
        }

        if (direction === 'vertical-down') {
            let np = h._controller?.notificationPanel;
            np?.selectPhoneMonitor?.();
            if (np) {
                let dy = y - h._startY;
                np.progressiveOpenEnd(dy >= SWIPE_DOWN_COMMIT_PX);
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Handle trackpad two-finger smooth scroll as a continuous gesture.
     * @param {number} sdx - Scroll delta X.
     * @param {number} sdy - Scroll delta Y.
     * @param {Clutter.Event} event
     * @returns {number} Clutter event propagation flag.
     */
    handleSmoothScroll(sdx, sdy, event) {
        let h = this._home;

        if (h._pressed && !h._scrollGestureActive)
            return Clutter.EVENT_PROPAGATE;

        if (h._scrollGestureActive && !h._pressed) {
            this._renewScrollTimeout();
            return Clutter.EVENT_PROPAGATE;
        }

        if (!h._scrollGestureActive) {
            let [cursorX, cursorY] = event.get_coords();
            h._scrollGestureActive = true;
            h._scrollAccumX = 0;
            h._scrollAccumY = 0;
            h._pressed = true;
            h._claimed = false;
            h._dragDirection = null;
            h._startX = cursorX;
            h._startY = cursorY;
            h._dragTimestamp = GLib.get_monotonic_time();
            h._cancelBgLongPress();
        }

        h._scrollAccumX += sdx * SCROLL_MULTIPLIER;
        h._scrollAccumY += sdy * SCROLL_MULTIPLIER;

        let virtualX = h._startX + h._scrollAccumX;
        let virtualY = h._startY + h._scrollAccumY;
        let result = this._processMotion(virtualX, virtualY);

        if (!h._pressed) {
            this._renewScrollTimeout();
            return Clutter.EVENT_PROPAGATE;
        }

        this._renewScrollTimeout();
        return result;
    }

    _renewScrollTimeout() {
        let h = this._home;
        if (!this._scrollTimeoutCb) {
            this._scrollTimeoutCb = () => {
                if (h._scrollGestureActive) {
                    h._scrollGestureActive = false;
                    if (h._pressed) {
                        let vx = h._startX + h._scrollAccumX;
                        let vy = h._startY + h._scrollAccumY;
                        this._processRelease(vx, vy);
                    }
                }
                return GLib.SOURCE_REMOVE;
            };
        }
        h._runtimeDisposer.restartTimeout(
            h, '_scrollTimeoutId',
            GLib.PRIORITY_DEFAULT, SCROLL_END_TIMEOUT,
            this._scrollTimeoutCb);
    }

    /** Cancel any in-progress scroll gesture. */
    cancelScrollGesture() {
        let h = this._home;
        h._runtimeDisposer.clearTimeoutRef(h, '_scrollTimeoutId');
        h._scrollGestureActive = false;
    }

    _startHomeDrawerReveal() {
        let h = this._home;
        if (h._homeDrawerRevealActive)
            return;
        h._homeDrawerRevealActive = true;
        let monitorIndex = h._getHomeMonitorIndex?.();
        h._controller.startHomeDrawerReveal?.(monitorIndex);
        h._controller.updateHomeDrawerReveal?.(0, monitorIndex);
    }

    _getHomeDrawerRevealDistance() {
        let h = this._home;
        let monitorIndex = h._getHomeMonitorIndex?.();
        let range = h._controller.getHomeDrawerRevealRange?.(monitorIndex) ?? 0;
        if (range > 0)
            return range;

        let height = 0;
        if (h._homeActor)
            height = h._homeActor.height || h._homeActor.get_height?.() || 0;
        if (!height && global?.stage)
            height = global.stage.height || 0;
        return Math.max(HOME_DRAWER_REVEAL_DISTANCE_MIN, height * 0.5);
    }

    _updateHomeDrawerRevealProgress(currentY) {
        let h = this._home;
        if (!h._homeDrawerRevealActive)
            return;
        let dy = Math.max(0, h._startY - currentY);
        let revealDistance = this._getHomeDrawerRevealDistance();
        let progress = Math.max(0, Math.min(1, dy / Math.max(1, revealDistance)));
        h._controller.updateHomeDrawerReveal?.(progress, h._getHomeMonitorIndex?.());
    }

    _endHomeDrawerReveal(commit) {
        let h = this._home;
        if (!h._homeDrawerRevealActive)
            return;
        h._homeDrawerRevealActive = false;
        h._controller.endHomeDrawerReveal?.(commit, h._getHomeMonitorIndex?.());
    }
}
