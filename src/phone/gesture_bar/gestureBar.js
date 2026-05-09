// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getAdaptiveScale } from '../../shared/utilities/uiUtils.js';
import { SCROLL_MULTIPLIER, SCROLL_END_TIMEOUT } from '../../shared/utilities/gestureConstants.js';

const BAR_HEIGHT = 20;
const ZONE_EXTEND = 0;
const SWIPE_UP_THRESHOLD = 20;
const DIRECTION_THRESHOLD = 4;
const LONG_PRESS_TIMEOUT = 420;
const FLICK_VELOCITY = 0.4;
const SLOW_DRAG_THRESHOLD = 0.2;
const PAUSE_HOLD_MS = 180;
const PAUSE_VELOCITY_THRESHOLD = 0.04;

/**
 * GestureBar -- phone bottom gesture bar with pill indicator.
 *
 * A reactive St.Widget anchored to the bottom of the phone display.
 * Handles vertical swipe (home / recent apps), horizontal swipe
 * (workspace / stack navigation), long-press (keyboard toggle),
 * and trackpad smooth-scroll equivalents.
 */
export const GestureBar = GObject.registerClass(
class GestureBar extends St.Widget {
    /**
     * @param {Object} controller - convergence controller instance
     * @param {Gio.Settings|null} settings - extension settings
     * @param {Object} [opts]
     * @param {number} [opts.monitorIndex]
     */
    _init(controller, settings = null, opts = {}) {
        super._init({
            style_class: 'convergence-bottom-bar',
            reactive: false,
            layout_manager: new Clutter.BinLayout(),
            height: BAR_HEIGHT,
        });

        this._controller = controller;
        this._settings = settings ?? null;
        this._monitorIndex = Number.isInteger(opts.monitorIndex) ? opts.monitorIndex : null;
        this._settingsBarHeightChangedId = 0;
        this._uiScale = 1;
        this._barHeight = BAR_HEIGHT;
        this._zoneExtend = ZONE_EXTEND;
        this._swipeUpThreshold = SWIPE_UP_THRESHOLD;
        this._directionThreshold = DIRECTION_THRESHOLD;
        this._refreshMetrics();

        this._pill = new St.Widget({
            style_class: 'convergence-pill',
            width: Math.round(100 * this._uiScale),
            height: Math.max(3, Math.round(4 * this._uiScale)),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._pill);

        this._zone = new St.Widget({
            reactive: true,
            width: 1,
            height: this._barHeight + this._zoneExtend,
            x: 0,
            y: 0,
        });
        this._grab = null;
        this._active = false;
        this._startX = 0;
        this._startY = 0;
        this._direction = null;
        this._gestureMonitor = null;
        this._longPressId = 0;
        this._longPressTriggered = false;

        this._scrollGestureActive = false;
        this._scrollAccumX = 0;
        this._scrollAccumY = 0;
        this._scrollTimeoutId = 0;

        this._zone.connect('button-press-event', (_a, ev) => {
            this._cancelScrollGesture();
            return this._onPress(ev);
        });
        this._zone.connect('motion-event', (_a, ev) => this._onMotion(ev));
        this._zone.connect('button-release-event', (_a, ev) => this._onRelease(ev));
        this._zone.connect('touch-event', (_a, ev) => {
            let t = ev.type();
            if (t === Clutter.EventType.TOUCH_BEGIN) {
                this._cancelScrollGesture();
                return this._onPress(ev);
            }
            if (t === Clutter.EventType.TOUCH_UPDATE)
                return this._onMotion(ev);
            if (t === Clutter.EventType.TOUCH_END ||
                t === Clutter.EventType.TOUCH_CANCEL)
                return this._onRelease(ev);
            return Clutter.EVENT_PROPAGATE;
        });
        this._zone.connect('scroll-event', (_a, ev) => {
            let dir = ev.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [sdx, sdy] = ev.get_scroll_delta();
                return this._handleSmoothScroll(sdx, sdy, ev);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._updateGeometry();

        // Suppress GNOME's bottom-edge OSK swipe so it doesn't compete
        // with the gesture bar.  The gesture bar handles keyboard toggling
        // via long-press instead.
        this._suppressOskEdgeDrag();

        // Visible bar and touch zone live in uiGroup so they stay above
        // maximised phone windows (addTopChrome gets hidden by Mutter).
        Main.layoutManager.uiGroup.add_child(this);
        Main.layoutManager.uiGroup.add_child(this._zone);
        Main.layoutManager.uiGroup.set_child_above_sibling(this, null);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._zone, null);

        // Invisible strut via addTopChrome reserves work-area space so
        // maximised windows stop above the gesture bar.
        let isSmall = controller?.getMonitorRole?.(this._getLayoutMonitorIndex()) === 'phone';
        this._strut = new St.Widget({
            name: 'convergence-gesture-bar-strut',
            opacity: 0, reactive: false,
        });
        this._updateStrutGeometry();
        Main.layoutManager.addTopChrome(this._strut, {
            affectsStruts: isSmall,
            trackFullscreen: false,
        });
        // Start hidden — showBar() will raise and reveal
        this.opacity = 0;
        this._zone.hide();

        // Re-raise whenever the window stack changes so the bar stays
        // above newly opened/focused windows.
        this._restackedId = global.display.connect('restacked', () => {
            if (this.opacity > 0 && !this._isKeyboardVisible()) {
                let ug = Main.layoutManager.uiGroup;
                ug.set_child_above_sibling(this, null);
                ug.set_child_above_sibling(this._zone, null);
            }
        });

        if (this._settings?.settings_schema?.has_key?.('gesture-bar-height')) {
            this._settingsBarHeightChangedId = this._settings.connect(
                'changed::gesture-bar-height', () => this.relayout());
        }

        // Reposition when the on-screen keyboard shows/hides so the
        // gesture bar sits above it instead of drawing over the top.
        // Delay connecting signals briefly — GNOME's keyboardBox reports
        // as visible with full height during early startup before
        // settling, which would incorrectly hide the gesture bar.
        this._kbSignals = [];
        this._kbReadyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._kbReadyId = 0;
            let kbBox = Main.layoutManager?.keyboardBox;
            if (kbBox) {
                this._kbSignals.push(
                    kbBox.connect('notify::visible', () => this._onKeyboardChanged()),
                    kbBox.connect('notify::height', () => this._onKeyboardChanged()));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // -- Metrics --

    _refreshMetrics() {
        let baseBarHeight = BAR_HEIGHT;
        if (this._controller?.getMonitorRole?.(this._getLayoutMonitorIndex()) === 'phone' &&
            this._settings?.settings_schema?.has_key?.('gesture-bar-height')) {
            try {
                baseBarHeight = this._settings.get_int('gesture-bar-height');
            } catch (_e) {
                baseBarHeight = BAR_HEIGHT;
            }
        }
        baseBarHeight = Math.max(8, Math.min(64, baseBarHeight));

        this._uiScale = getAdaptiveScale({
            profile: 'gesture',
            referenceWidth: 600,
            min: 0.95,
            max: 1.2,
        });
        this._barHeight = Math.round(baseBarHeight * this._uiScale);
        this._zoneExtend = Math.round(ZONE_EXTEND * this._uiScale);
        this._swipeUpThreshold = Math.round(SWIPE_UP_THRESHOLD * this._uiScale);
        this._directionThreshold = Math.max(6, Math.round(DIRECTION_THRESHOLD * this._uiScale));
        this.height = this._barHeight;
        if (this._pill)
            this._pill.set_size(Math.round(100 * this._uiScale), Math.max(3, Math.round(4 * this._uiScale)));
    }

    // -- Gesture handling --

    _isTouchOnPill(x) {
        if (!this._pill) return false;
        let [pillX] = this._pill.get_transformed_position();
        let pillW = this._pill.width;
        let pad = Math.round(24 * this._uiScale);
        return x >= pillX - pad && x <= pillX + pillW + pad;
    }

    _onPress(event) {
        let [x, y] = event.get_coords();
        this._startX = x;
        this._startY = y;
        this._gestureMonitor = this._resolveGestureMonitor(x, y);
        this._active = true;
        this._direction = null;
        this._longPressTriggered = false;
        this._recentAppsTriggered = false;
        this._fromHome = false;
        this._pillSwipe = this._isTouchOnPill(x);
        this._lastMotionY = y;
        this._lastMotionTime = GLib.get_monotonic_time() / 1000;
        this._pressTime = this._lastMotionTime;
        this._velocityY = 0;
        this._pauseStartTime = 0;
        this._horizontalScrollActive = false;
        this._cumulativeHDx = 0;
        this._lastScrollX = x;
        this._horizontalVelocity = 0;
        this._lastScrollTime = GLib.get_monotonic_time() / 1000;
        this._clearWindowCornerRadius();
        this._scheduleLongPress();
        this._grab = global.stage.grab(this._zone);
        this._animatePillPress();
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._active) return Clutter.EVENT_STOP;
        let [x, y] = event.get_coords();
        return this._processMotion(x, y);
    }

    _processMotion(x, y) {
        let dx = x - this._startX;
        let dy = this._startY - y;
        let metrics = this._getGestureMetrics();
        let slop = Math.max(6, Math.round(6 * this._uiScale));

        if (Math.abs(dx) > slop || Math.abs(dy) > slop)
            this._cancelLongPress();

        if (!this._direction) {
            let adx = Math.abs(dx);
            let ady = Math.abs(dy);
            if (Math.max(adx, ady) < this._directionThreshold)
                return Clutter.EVENT_STOP;

            this._direction = adx > ady ? 'horizontal' : 'vertical';
            this._dyOffset = dy;

            if (this._direction === 'vertical') {
                let np = this._controller.notificationPanel;
                if (np?.isOpen) {
                    np.close();
                    this._notifPanelDismissed = true;
                    return Clutter.EVENT_STOP;
                }

                let ps = this._controller.phoneWindowStack;
                let recentApps = this._controller.getPhoneRecentAppsForMonitor?.(this._getLayoutMonitorIndex())
                    ?? this._controller.recentApps;
                let isHome = ps?.isActive
                    ? ps.getActiveWindow(this._getLayoutMonitorIndex()) === null
                    : (global.workspace_manager.get_active_workspace_index() === 0);
                if (recentApps?.isVisible) {
                    this._recentAppsTriggered = true;
                    recentApps.hide();
                } else if (isHome) {
                    this._fromHome = true;
                    this._controller.prepareRecentAppsFromHome(this._getLayoutMonitorIndex());
                } else {
                    // Prepare the carousel first so the card rect is
                    // available when the home gesture queries it.
                    this._controller.prepareRecentApps(this._getLayoutMonitorIndex());
                    this._controller.startHomeGesture(this._getLayoutMonitorIndex());
                }
            } else {
                this._controller.startWorkspaceSwipe(this._startX, this._startY, this._getLayoutMonitorIndex());
            }
        }

        if (this._notifPanelDismissed)
            return Clutter.EVENT_STOP;

        if (this._direction === 'vertical') {
            // Feature 6: dragging back below start cancels the gesture
            if (dy <= 0 && !this._fromHome && !this._recentAppsTriggered) {
                this._animatePillVertical(0);
                this._controller.updateHomeGesture(0, this._getLayoutMonitorIndex());
                this._controller.updateRecentAppsProgress(0, this._getLayoutMonitorIndex());
                this._lastMotionY = y;
                this._lastMotionTime = GLib.get_monotonic_time() / 1000;
                this._velocityY = 0;
                return Clutter.EVENT_STOP;
            }

            let effectiveDy = Math.max(0, dy - (this._dyOffset || 0));
            let progress;

            if (this._fromHome) {
                let gestureRange = Math.round(350 * this._uiScale);
                let rawProgress = Math.min(1, effectiveDy / gestureRange);
                progress = Math.cbrt(rawProgress);
            } else {
                let gestureRange = Math.round(150 * this._uiScale);
                let rawProgress = Math.min(1, effectiveDy / gestureRange);
                progress = Math.sqrt(rawProgress);
            }

            this._animatePillVertical(progress);

            if (this._fromHome) {
                this._controller.updateRecentAppsFromHomeProgress(progress, this._getLayoutMonitorIndex());
            } else if (!this._recentAppsTriggered) {
                // Scroll the carousel first so the card position is
                // up to date when updateHomeGesture queries it.
                // Only activate horizontal scrolling if the gesture's
                // horizontal component is significant relative to vertical
                // — prevents accidental quick-switch on diagonal swipes.
                let hdx = x - this._lastScrollX;
                let totalADx = Math.abs(x - this._startX);
                let totalADy = Math.abs(this._startY - y);
                if (!this._horizontalScrollActive) {
                    let deadZone = Math.round(40 * this._uiScale);
                    let hRatio = totalADy > 0 ? totalADx / totalADy : 0;
                    if (totalADx > deadZone && hRatio > 0.6)
                        this._horizontalScrollActive = true;
                }
                if (this._horizontalScrollActive) {
                    this._lastScrollX = x;
                    if (Math.abs(hdx) > 0.5) {
                        this._controller.scrollRecentAppsByDelta(hdx, this._getLayoutMonitorIndex());
                        let now = GLib.get_monotonic_time() / 1000;
                        let hdt = now - this._lastScrollTime;
                        if (hdt > 0) {
                            let instantHVel = hdx / hdt;
                            this._horizontalVelocity = this._horizontalVelocity * 0.6 + instantHVel * 0.4;
                        }
                        this._lastScrollTime = now;
                    }
                }

                this._controller.updateHomeGesture(progress, this._getLayoutMonitorIndex());
                this._controller.updateRecentAppsProgress(progress, this._getLayoutMonitorIndex());

                // Feature 7: progressive corner rounding on the departing window
                this._updateWindowCornerRadius(progress);
            }

            if (!this._recentAppsTriggered) {
                let now = GLib.get_monotonic_time() / 1000;
                let dt = now - this._lastMotionTime;
                if (dt > 0) {
                    let instantVel = Math.abs(y - this._lastMotionY) / dt;
                    this._velocityY = this._velocityY * 0.6 + instantVel * 0.4;
                }

                // Feature 2: detect pause mid-gesture for recent apps
                if (!this._fromHome && this._velocityY < PAUSE_VELOCITY_THRESHOLD && progress > 0.15) {
                    if (!this._pauseStartTime)
                        this._pauseStartTime = now;
                    else if (now - this._pauseStartTime > PAUSE_HOLD_MS && !this._recentAppsTriggered) {
                        this._recentAppsTriggered = true;
                        this._pauseStartTime = 0;
                        this._clearWindowCornerRadius();
                        this._controller.haptics?.vibrate?.(8);
                        this._controller.commitRecentApps(this._getLayoutMonitorIndex());
                    }
                } else {
                    this._pauseStartTime = 0;
                }

                this._lastMotionY = y;
                this._lastMotionTime = now;
            }
        } else if (this._direction === 'horizontal') {
            this._animatePillHorizontal(dx);
            this._controller.updateWorkspaceSwipe(x, this._getLayoutMonitorIndex());
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._active) return Clutter.EVENT_STOP;
        this._active = false;
        this._cancelLongPress();
        this._clearWindowCornerRadius();
        this._animatePillRelease();
        if (this._grab) { this._grab.dismiss(); this._grab = null; }

        let [x, y] = event.get_coords();
        if (this._longPressTriggered) {
            this._longPressTriggered = false;
            this._direction = null;
            this._gestureMonitor = null;
            return Clutter.EVENT_STOP;
        }
        let result = this._processRelease(x, y);
        this._gestureMonitor = null;
        return result;
    }

    _scheduleLongPress() {
        this._cancelLongPress();
        this._longPressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_TIMEOUT, () => {
            this._longPressId = 0;
            if (!this._active || this._direction)
                return GLib.SOURCE_REMOVE;
            this._longPressTriggered = true;
            this._controller.showKeyboard?.();
            if (this._grab) {
                this._grab.dismiss();
                this._grab = null;
            }
            this._active = false;
            this._direction = null;
            this._gestureMonitor = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLongPress() {
        if (!this._longPressId)
            return;
        GLib.source_remove(this._longPressId);
        this._longPressId = 0;
    }

    _processRelease(x, y) {
        let dx = x - this._startX;
        let dy = this._startY - y;
        let metrics = this._getGestureMetrics();
        this._pauseStartTime = 0;

        if (this._notifPanelDismissed) {
            this._notifPanelDismissed = false;
            this._direction = null;
            return Clutter.EVENT_STOP;
        }

        if (this._direction === 'vertical') {
            this._clearWindowCornerRadius();
            let didHorizontalScroll = this._horizontalScrollActive;
            let hVelocity = this._horizontalVelocity || 0;
            this._horizontalScrollActive = false;
            this._horizontalVelocity = 0;

            // Quick-switch: if user scrolled to a different app, switch
            // directly to it instead of entering the recents overview.
            if (didHorizontalScroll && !this._fromHome && !this._recentAppsTriggered) {
                let monIdx = this._getLayoutMonitorIndex();
                this._controller.snapRecentAppsScroll(hVelocity, monIdx);
                let targetWindow = this._controller.getCenteredRecentWindow?.(monIdx);
                if (targetWindow) {
                    this._controller.haptics?.vibrate?.(8);
                    let cardRect = this._controller.getCenteredRecentCardRect?.(monIdx);
                    this._controller.cancelPreparedRecentApps(monIdx);
                    this._controller.quickSwitchToWindow(targetWindow, cardRect, monIdx);
                    this._direction = null;
                    return Clutter.EVENT_STOP;
                }
            } else if (didHorizontalScroll) {
                this._controller.snapRecentAppsScroll(hVelocity, this._getLayoutMonitorIndex());
            }

            // Feature 6: if finger dragged back below start, cancel
            if (dy <= 0 && !this._fromHome && !this._recentAppsTriggered) {
                this._controller.cancelPreparedRecentApps(this._getLayoutMonitorIndex());
                this._controller.endHomeGesture(0, this._getLayoutMonitorIndex());
                this._direction = null;
                return Clutter.EVENT_STOP;
            }

            if (this._fromHome) {
                this._fromHome = false;
                let effectiveDy = Math.max(0, dy - (this._dyOffset || 0));
                let gestureRange = Math.round(350 * this._uiScale);
                let rawProgress = Math.min(1, effectiveDy / gestureRange);
                let progress = Math.cbrt(rawProgress);

                let velocity = this._velocityY || 0;
                let now = GLib.get_monotonic_time() / 1000;
                let dtRelease = now - (this._lastMotionTime || now);
                if (dtRelease > 0 && dtRelease < 100) {
                    let releaseVel = Math.abs(y - (this._lastMotionY || y)) / dtRelease;
                    velocity = Math.max(velocity, releaseVel);
                }
                let totalDt = now - (this._pressTime || now);
                if (totalDt > 0) {
                    let overallVel = dy / totalDt;
                    velocity = Math.max(velocity, overallVel);
                }

                if (velocity > FLICK_VELOCITY || progress > 0.35)
                    this._controller.commitRecentAppsFromHome(this._getLayoutMonitorIndex());
                else
                    this._controller.cancelRecentAppsFromHome(this._getLayoutMonitorIndex());
            } else if (this._recentAppsTriggered) {
                this._recentAppsTriggered = false;
            } else if (dy > this._swipeUpThreshold) {
                let effectiveDy = Math.max(0, dy - (this._dyOffset || 0));
                let gestureRange = Math.round(150 * this._uiScale);
                let rawProgress = Math.min(1, effectiveDy / gestureRange);
                let progress = Math.sqrt(rawProgress);

                let velocity = this._velocityY || 0;
                let now = GLib.get_monotonic_time() / 1000;
                let dtRelease = now - (this._lastMotionTime || now);
                if (dtRelease > 0 && dtRelease < 100) {
                    let releaseVel = Math.abs(y - (this._lastMotionY || y)) / dtRelease;
                    velocity = Math.max(velocity, releaseVel);
                }
                let totalDt = now - (this._pressTime || now);
                if (totalDt > 0) {
                    let overallVel = dy / totalDt;
                    velocity = Math.max(velocity, overallVel);
                }

                if (velocity > FLICK_VELOCITY) {
                    this._controller.cancelPreparedRecentApps(this._getLayoutMonitorIndex());
                    this._controller.endHomeGesture(Math.max(progress, 1.0), this._getLayoutMonitorIndex());
                } else if (progress > SLOW_DRAG_THRESHOLD) {
                    this._controller.haptics?.vibrate?.(8);
                    this._controller.commitRecentApps(this._getLayoutMonitorIndex());
                } else {
                    this._controller.cancelPreparedRecentApps(this._getLayoutMonitorIndex());
                    this._controller.endHomeGesture(0, this._getLayoutMonitorIndex());
                }
            } else {
                this._controller.cancelPreparedRecentApps(this._getLayoutMonitorIndex());
                this._controller.endHomeGesture(0, this._getLayoutMonitorIndex());
            }
        } else if (this._direction === 'horizontal') {
            let elapsed = 1;
            let vel = dx / Math.max(elapsed, 1);
            let normVel = vel / Math.max(1, metrics.width);
            this._controller.endWorkspaceSwipe(x, normVel, this._getLayoutMonitorIndex());
        }

        this._direction = null;
        return Clutter.EVENT_STOP;
    }

    // -- Pill animations --

    _pillDefaultWidth() {
        return Math.round(100 * this._uiScale);
    }

    _animatePillPress() {
        if (!this._pill) return;
        this._pill.remove_all_transitions();
        this._pill.ease({
            width: Math.round(this._pillDefaultWidth() * 1.15),
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._pill.style = 'background-color: rgba(255, 255, 255, 1.0); border-radius: 2px;';
    }

    _animatePillVertical(progress) {
        if (!this._pill) return;
        let defaultW = this._pillDefaultWidth();
        let targetW = Math.round(defaultW * (1.0 - progress * 0.6));
        this._pill.width = Math.max(Math.round(16 * this._uiScale), targetW);
    }

    _animatePillHorizontal(dx) {
        if (!this._pill) return;
        let maxOffset = Math.round(80 * this._uiScale);
        let raw = dx * 0.5;
        // Rubber-band bounce at the ends
        if (Math.abs(raw) > maxOffset) {
            let sign = raw > 0 ? 1 : -1;
            let over = Math.abs(raw) - maxOffset;
            raw = sign * (maxOffset + over * 0.2);
        }
        this._pill.translation_x = raw;
    }

    _animatePillRelease() {
        if (!this._pill) return;
        this._pill.remove_all_transitions();
        this._pill.ease({
            width: this._pillDefaultWidth(),
            translation_x: 0,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._pill.style = null;
    }

    // -- Progressive window corner radius during home gesture --

    _updateWindowCornerRadius(progress) {
        let ps = this._controller.phoneWindowStack;
        let activeWindow = ps?.getActiveWindow?.(this._getLayoutMonitorIndex());
        if (!activeWindow) return;
        let actor = activeWindow.get_compositor_private?.();
        if (!actor) return;

        let maxRadius = Math.round(44 * this._uiScale);
        let radius = Math.round(maxRadius * Math.min(1, progress * 2));

        if (!this._gestureCornerEffect) {
            this._gestureCornerEffect = { actor, prevStyle: actor.style ?? '' };
        }
        actor.style = `border-radius: ${radius}px;`;
    }

    _clearWindowCornerRadius() {
        if (this._gestureCornerEffect) {
            let { actor, prevStyle } = this._gestureCornerEffect;
            try {
                actor.style = prevStyle || null;
            } catch (_e) {}
            this._gestureCornerEffect = null;
        }
    }

    // -- Trackpad smooth-scroll gesture --

    _handleSmoothScroll(sdx, sdy, event) {
        if (this._active && !this._scrollGestureActive)
            return Clutter.EVENT_PROPAGATE;

        if (!this._scrollGestureActive) {
            let [cursorX, cursorY] = event.get_coords();
            this._scrollGestureActive = true;
            this._scrollAccumX = 0;
            this._scrollAccumY = 0;
            this._gestureMonitor = this._resolveGestureMonitor(cursorX, cursorY);
            this._startX = cursorX;
            this._startY = cursorY;
            this._active = true;
            this._direction = null;
        }

        this._scrollAccumX += sdx * SCROLL_MULTIPLIER;
        this._scrollAccumY += sdy * SCROLL_MULTIPLIER;

        let virtualX = this._startX + this._scrollAccumX;
        let virtualY = this._startY + this._scrollAccumY;

        this._processMotion(virtualX, virtualY);
        this._renewScrollTimeout();
        return Clutter.EVENT_STOP;
    }

    _renewScrollTimeout() {
        if (this._scrollTimeoutId)
            GLib.source_remove(this._scrollTimeoutId);
        if (!this._scrollTimeoutCb) {
            this._scrollTimeoutCb = () => {
                this._scrollTimeoutId = 0;
                if (this._scrollGestureActive) {
                    this._scrollGestureActive = false;
                    if (this._active) {
                        this._active = false;
                        let vx = this._startX + this._scrollAccumX;
                        let vy = this._startY + this._scrollAccumY;
                        this._processRelease(vx, vy);
                    }
                }
                return GLib.SOURCE_REMOVE;
            };
        }
        this._scrollTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCROLL_END_TIMEOUT, this._scrollTimeoutCb);
    }

    _cancelScrollGesture() {
        this._cancelLongPress();
        if (this._scrollTimeoutId) {
            GLib.source_remove(this._scrollTimeoutId);
            this._scrollTimeoutId = 0;
        }
        if (this._scrollGestureActive) {
            this._scrollGestureActive = false;
            if (this._active) {
                this._active = false;
                if (this._fromHome) {
                    this._fromHome = false;
                    this._controller.cancelRecentAppsFromHome(this._getLayoutMonitorIndex());
                } else if (this._direction === 'vertical') {
                    this._controller.cancelHomeGesture();
                }
                this._direction = null;
            }
        }
        this._gestureMonitor = null;
    }

    // -- Geometry --

    _resolveGestureMonitor(x, y) {
        let monitors = Main.layoutManager.monitors ?? [];
        if (Number.isFinite(x) && Number.isFinite(y) &&
            typeof this._controller?.monitorIndexForCoords === 'function') {
            let idx = this._controller.monitorIndexForCoords(x, y);
            if (Number.isInteger(idx) && idx >= 0 && idx < monitors.length)
                return monitors[idx];
        }
        return monitors[this._getLayoutMonitorIndex()] ?? Main.layoutManager.primaryMonitor ?? monitors[0] ?? null;
    }

    _getGestureMetrics() {
        let monitor = this._gestureMonitor;
        if (!monitor)
            monitor = Main.layoutManager.primaryMonitor ?? Main.layoutManager.monitors?.[0] ?? null;
        return {
            width: monitor?.width ?? global.stage.width,
            height: monitor?.height ?? global.stage.height,
        };
    }

    _getLayoutMonitor() {
        return Main.layoutManager.monitors?.[this._getLayoutMonitorIndex()]
            ?? Main.layoutManager.primaryMonitor
            ?? Main.layoutManager.monitors?.[0]
            ?? null;
    }

    _getLayoutMonitorIndex() {
        let monitors = Main.layoutManager.monitors ?? [];
        let preferredIndex = this._monitorIndex;
        if (!Number.isInteger(preferredIndex))
            preferredIndex = this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex;
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < monitors.length)
            return preferredIndex;
        return Main.layoutManager.primaryIndex;
    }

    _isKeyboardVisible() {
        let kbBox = Main.layoutManager?.keyboardBox;
        // The keyboardBox can be "visible" with zero height when the OSK
        // is not actually shown.  Only treat it as visible when it has
        // meaningful height (> 50px avoids false positives).
        return !!(kbBox?.visible && kbBox.height > 50);
    }

    _onKeyboardChanged() {
        if (this._isKeyboardVisible()) {
            this.opacity = 0;
            this._zone.reactive = false;
            this._zone.hide();
        } else {
            this.opacity = 255;
            this._zone.reactive = true;
            this._zone.show();
        }
    }

    _updateStrutGeometry() {
        if (!this._strut) return;
        let monitor = this._getLayoutMonitor();
        let monitorBottom = monitor
            ? monitor.y + monitor.height
            : global.stage.height;
        this._strut.width = monitor?.width ?? global.stage.width;
        this._strut.x = monitor?.x ?? 0;
        this._strut.y = monitorBottom - this._barHeight;
        this._strut.height = this._barHeight;
    }

    _updateGeometry() {
        this._refreshMetrics();
        let monitor = this._getLayoutMonitor();
        this.width = monitor?.width ?? global.stage.width;
        this.x = monitor?.x ?? 0;
        let monitorBottom = monitor
            ? monitor.y + monitor.height
            : global.stage.height;
        this.y = monitorBottom - this._barHeight;
        this._updateStrutGeometry();
    }

    _updateZonePosition() {
        let monitor = this._getLayoutMonitor();
        let monitorX = monitor?.x ?? 0;
        let monitorBottom = monitor
            ? monitor.y + monitor.height
            : global.stage.height;
        this._zone.height = this._barHeight + this._zoneExtend;
        this._zone.width = monitor?.width ?? global.stage.width;
        this._zone.x = monitorX;
        this._zone.y = monitorBottom - this._barHeight - this._zoneExtend;
    }

    /** Recalculate geometry after monitor or settings changes. */
    relayout() {
        this._updateGeometry();
        this._updateZonePosition();
    }

    setMonitorIndex(monitorIndex = null) {
        this._monitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        this.relayout();
    }

    refreshTopology(monitorIndex = null) {
        this._cancelScrollGesture();
        this._cancelLongPress();
        if (this._active) {
            this._active = false;
            if (this._grab) {
                this._grab.dismiss();
                this._grab = null;
            }
            if (this._fromHome) {
                this._fromHome = false;
                this._controller.cancelRecentAppsFromHome(this._getLayoutMonitorIndex());
            } else if (this._direction === 'vertical') {
                this._controller.cancelHomeGesture();
            }
            this._direction = null;
        }
        this.setMonitorIndex(monitorIndex);
    }

    // -- Show / Hide --

    /** Show the gesture bar and activate touch zone. */
    showBar() {
        this._updateGeometry();
        this._updateZonePosition();
        this.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._zone.show();
        this._zone.reactive = true;

        // Raise both the visible bar and touch zone to the top of uiGroup
        // so the pill is visible over maximised windows and the dock/drawer.
        let uiGroup = Main.layoutManager.uiGroup;
        uiGroup.set_child_above_sibling(this, null);
        uiGroup.set_child_above_sibling(this._zone, null);
    }

    /** Hide the gesture bar and deactivate touch zone. */
    hideBar() {
        this._cancelScrollGesture();
        this._cancelLongPress();
        if (this._active) {
            this._active = false;
            if (this._grab) { this._grab.dismiss(); this._grab = null; }
            if (this._fromHome) {
                this._fromHome = false;
                this._controller.cancelRecentAppsFromHome(this._getLayoutMonitorIndex());
            } else if (this._direction === 'vertical') {
                this._controller.cancelHomeGesture();
            }
            this._direction = null;
        }
        this._zone.reactive = false;
        this.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._zone.hide();
    }

    // -- OSK edge suppression --

    _suppressOskEdgeDrag() {
        // Disable all EdgeDragAction instances on the global stage that
        // trigger the OSK.  GNOME adds these in KeyboardManager._syncEnabled().
        this._disabledEdgeDrags = [];
        try {
            let actions = global.stage.get_actions();
            for (let action of actions) {
                // EdgeDragAction for the keyboard lives on EDGE_BOTTOM
                if (action.constructor?.name === 'EdgeDragAction' &&
                    action.enabled) {
                    action.enabled = false;
                    this._disabledEdgeDrags.push(action);
                }
            }
        } catch (_e) {}
    }

    _restoreOskEdgeDrag() {
        for (let action of this._disabledEdgeDrags ?? [])
            action.enabled = true;
        this._disabledEdgeDrags = null;
    }

    // -- Cleanup --

    destroy() {
        this._restoreOskEdgeDrag();
        this._cancelScrollGesture();
        this._cancelLongPress();
        if (this._grab) { this._grab.dismiss(); this._grab = null; }
        if (this._settingsBarHeightChangedId && this._settings) {
            try {
                this._settings.disconnect(this._settingsBarHeightChangedId);
            } catch (_e) {}
            this._settingsBarHeightChangedId = 0;
        }
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = 0;
        }
        if (this._kbReadyId) {
            GLib.source_remove(this._kbReadyId);
            this._kbReadyId = 0;
        }
        let kbBox = Main.layoutManager?.keyboardBox;
        if (kbBox && this._kbSignals) {
            for (let id of this._kbSignals) {
                try { kbBox.disconnect(id); } catch (_e) {}
            }
        }
        this._kbSignals = null;
        this._settings = null;
        if (this._strut) {
            Main.layoutManager.removeChrome(this._strut);
            this._strut.destroy();
            this._strut = null;
        }
        if (this._zone?.get_parent())
            this._zone.get_parent().remove_child(this._zone);
        this._zone.destroy();
        this._zone = null;
        if (this.get_parent())
            this.get_parent().remove_child(this);
        super.destroy();
    }
});
