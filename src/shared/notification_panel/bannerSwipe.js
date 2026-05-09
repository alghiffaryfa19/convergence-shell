// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { RuntimeDisposer } from '../utilities/runtimeDisposer.js';

const SWIPE_THRESHOLD = 0.35;      // 35% of banner width to dismiss horizontally
const VERTICAL_THRESHOLD = 0.30;   // 30% of banner height for vertical gestures
const CLAIM_PX = 12;               // minimum movement to claim a gesture direction
const ANIM_MS = 180;               // animation duration for dismiss/snap-back
const EXPAND_ANIM_MS = 250;        // animation duration for expand/collapse
const AUTO_HIDE_MS = 5000;         // Android-style 5 second auto-hide
const SNOOZE_MS = 60000;           // 1 minute snooze (Android behaviour)
const LONG_PRESS_MS = 600;         // long-press threshold

/**
 * BannerGestures — Android-style gesture handling for GNOME Shell's
 * notification banners (the popup that appears at the top of the screen).
 *
 * Gestures:
 *   Swipe left/right  → dismiss (move to notification tray)
 *   Swipe up           → snooze for 1 minute
 *   Swipe down         → expand to show full body + action buttons
 *   Tap                → handled natively by GNOME Shell (opens notification)
 *   Long press         → open per-app notification settings
 *
 * Auto-hide: banners auto-dismiss after 5 seconds (Android default).
 */
export class BannerSwipeDismiss {
    constructor() {
        this._runtimeDisposer = new RuntimeDisposer();
        this._swipeState = null;
        this._lastBanner = null;
        this._origUpdateTimeout = null;

        let tray = Main.messageTray;
        this._tray = tray;
        this._bannerBin = tray?._bannerBin ?? null;

        if (this._bannerBin) {
            this._runtimeDisposer.replaceConnection(this, '_childAddedId', this._bannerBin,
                'child-added', (_bin, child) => this._onBannerAdded(child));
            let existing = this._bannerBin.get_first_child();
            if (existing) this._onBannerAdded(existing);
        }

        // Override GNOME's auto-hide timeout to use the Android-style 5s
        this._patchAutoHideTimeout();
    }

    // ── Auto-hide timeout override ──────────────────────────────────

    _patchAutoHideTimeout() {
        if (!this._tray) return;

        this._origUpdateTimeout = this._tray._updateNotificationTimeout
            ?.bind(this._tray);
        if (!this._origUpdateTimeout) return;

        this._tray._updateNotificationTimeout = (timeout) => {
            // Replace GNOME's default 4s with our 5s, but preserve 0 (clear)
            if (timeout > 0)
                timeout = AUTO_HIDE_MS;
            // Android behaviour: timer always runs, no need for user
            // interaction first. Force the activity flag so _updateState
            // will expire the banner when the timeout fires.
            this._tray._userActiveWhileNotificationShown = true;
            this._origUpdateTimeout(timeout);
        };
    }

    _restoreAutoHideTimeout() {
        if (this._origUpdateTimeout && this._tray) {
            this._tray._updateNotificationTimeout =
                this._origUpdateTimeout;
            this._origUpdateTimeout = null;
        }
    }

    // ── Banner hooking ──────────────────────────────────────────────

    _onBannerAdded(actor) {
        if (!actor || actor === this._lastBanner) return;
        this._lastBanner = actor;

        if (actor._convergenceSwipeHooked) return;
        actor._convergenceSwipeHooked = true;

        this._runtimeDisposer.connect(actor, 'captured-event', (_a, event) => {
            return this._onBannerEvent(actor, event);
        });
    }

    // ── Gesture handling ────────────────────────────────────────────

    _onBannerEvent(banner, event) {
        let type = event.type();

        // ── Touch/click start ───────────────────────────────────────
        if (type === Clutter.EventType.TOUCH_BEGIN ||
            type === Clutter.EventType.BUTTON_PRESS) {
            let [x, y] = event.get_coords();
            this._swipeState = {
                startX: x,
                startY: y,
                direction: null,   // 'horizontal', 'vertical-up', 'vertical-down'
                claimed: false,
            };
            this._startLongPress(banner);
            return Clutter.EVENT_PROPAGATE;
        }

        // ── Move ────────────────────────────────────────────────────
        if ((type === Clutter.EventType.TOUCH_UPDATE ||
             type === Clutter.EventType.MOTION) && this._swipeState) {
            let [x, y] = event.get_coords();
            let dx = x - this._swipeState.startX;
            let dy = y - this._swipeState.startY;

            // Cancel long-press once the finger moves enough
            if (Math.abs(dx) > 6 || Math.abs(dy) > 6)
                this._cancelLongPress();

            if (!this._swipeState.claimed) {
                if (Math.abs(dx) > CLAIM_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
                    this._swipeState.claimed = true;
                    this._swipeState.direction = 'horizontal';
                } else if (Math.abs(dy) > CLAIM_PX) {
                    this._swipeState.claimed = true;
                    this._swipeState.direction = dy < 0 ? 'vertical-up' : 'vertical-down';
                } else {
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            if (this._swipeState.direction === 'horizontal') {
                banner.translation_x = dx;
                banner.opacity = Math.max(50,
                    Math.round(255 * (1 - Math.abs(dx) / (banner.width || 400))));
                return Clutter.EVENT_STOP;
            }

            if (this._swipeState.direction === 'vertical-up') {
                // Clamp to upward only (negative translation)
                let clampedDy = Math.min(0, dy);
                banner.translation_y = clampedDy;
                banner.opacity = Math.max(50,
                    Math.round(255 * (1 - Math.abs(clampedDy) / (banner.height || 200))));
                return Clutter.EVENT_STOP;
            }

            if (this._swipeState.direction === 'vertical-down') {
                // Visual feedback: slight downward pull (capped)
                let pull = Math.max(0, Math.min(dy, 80));
                banner.translation_y = pull * 0.3;
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        // ── Touch/click end ─────────────────────────────────────────
        if ((type === Clutter.EventType.TOUCH_END ||
             type === Clutter.EventType.TOUCH_CANCEL ||
             type === Clutter.EventType.BUTTON_RELEASE) && this._swipeState) {

            this._cancelLongPress();

            if (!this._swipeState.claimed) {
                this._swipeState = null;
                return Clutter.EVENT_PROPAGATE;
            }

            let dir = this._swipeState.direction;
            this._swipeState = null;

            if (dir === 'horizontal')
                return this._endHorizontalSwipe(banner);
            if (dir === 'vertical-up')
                return this._endSwipeUp(banner);
            if (dir === 'vertical-down')
                return this._endSwipeDown(banner);

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ── Swipe left/right → dismiss ──────────────────────────────────

    _endHorizontalSwipe(banner) {
        let dx = banner.translation_x;
        let bannerW = banner.width || 400;
        let fraction = Math.abs(dx) / bannerW;

        if (fraction >= SWIPE_THRESHOLD) {
            let direction = dx > 0 ? 1 : -1;
            banner.ease({
                translation_x: direction * bannerW,
                opacity: 0,
                duration: ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._dismissBanner(),
            });
        } else {
            this._snapBack(banner);
        }
        return Clutter.EVENT_STOP;
    }

    // ── Swipe up → snooze (suppress for 1 minute) ──────────────────

    _endSwipeUp(banner) {
        let dy = banner.translation_y;
        let bannerH = banner.height || 200;
        let fraction = Math.abs(dy) / bannerH;

        if (fraction >= VERTICAL_THRESHOLD) {
            // Slide up off-screen, then snooze
            banner.ease({
                translation_y: -bannerH,
                opacity: 0,
                duration: ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._snoozeBanner(),
            });
        } else {
            this._snapBack(banner);
        }
        return Clutter.EVENT_STOP;
    }

    // ── Swipe down → expand ─────────────────────────────────────────

    _endSwipeDown(banner) {
        // Reset the pull visual
        banner.ease({
            translation_y: 0,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._expandBanner();
        return Clutter.EVENT_STOP;
    }

    // ── Long press → notification settings ──────────────────────────

    _startLongPress(banner) {
        this._cancelLongPress();
        this._runtimeDisposer.restartTimeout(this, '_longPressId', GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            // Only fire if we haven't claimed a swipe
            if (this._swipeState && !this._swipeState.claimed) {
                this._swipeState = null;
                this._openNotificationSettings(banner);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLongPress() {
        this._runtimeDisposer.clearTimeoutRef(this, '_longPressId');
    }

    // ── Actions ─────────────────────────────────────────────────────

    _dismissBanner() {
        try {
            let notification = this._tray?._notification;
            if (notification)
                notification.destroy(2); // DISMISSED
        } catch (_e) {}
    }

    _snoozeBanner() {
        try {
            let notification = this._tray?._notification;
            if (!notification) return;

            let source = notification.source;

            // Acknowledge to suppress the banner immediately
            notification.acknowledged = true;

            // Hide the current banner
            try { this._tray._hideNotification(true); } catch (_e) {}

            // After SNOOZE_MS, un-acknowledge so future notifications from
            // this source can pulse again. The original notification stays
            // in the tray — we just suppress its banner for a minute.
            let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SNOOZE_MS, () => {
                this._runtimeDisposer.untrackTimeout(timerId);
                try {
                    if (notification && !notification.acknowledged)
                        return GLib.SOURCE_REMOVE;
                    notification.acknowledged = false;
                    // Re-request the banner if the notification still exists
                    if (source)
                        source.emit('notification-request-banner', notification);
                } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
            this._runtimeDisposer.trackTimeout(timerId);
        } catch (_e) {}
    }

    _expandBanner() {
        try {
            let tray = this._tray;
            if (!tray) return;

            let banner = tray._banner;
            if (!banner || banner.expanded) return;

            // Expand the banner to show full body + action buttons
            banner.expand(true);

            // Prevent auto-hide while expanded — keep the banner on screen
            tray._pointerInNotification = true;

            // Listen for unexpand to restore auto-hide
            let unexpandId = banner.connect('unexpanded', () => {
                try { banner.disconnect(unexpandId); } catch (_e) {}
                tray._pointerInNotification = false;
            });
        } catch (_e) {}
    }

    _openNotificationSettings(banner) {
        try {
            let notification = this._tray?._notification;
            if (!notification) return;

            // Try to get the app ID from the notification source
            let appId = notification.source?.app?.get_id?.()
                     || notification.source?._appId
                     || null;

            // Dismiss the banner first
            try { this._tray._hideNotification(true); } catch (_e) {}

            if (appId) {
                // Open GNOME Settings → Notifications → specific app
                // The app-id needs to be canonicalized for the GSettings path
                let canonicalId = appId.replace(/\.desktop$/, '')
                    .toLowerCase().replace(/[^a-z0-9]/g, '-');
                try {
                    Gio.Subprocess.new(
                        ['gnome-control-center', 'notifications', canonicalId],
                        Gio.SubprocessFlags.NONE);
                } catch (_e) {
                    // Fallback: open notifications panel without app filter
                    Gio.Subprocess.new(
                        ['gnome-control-center', 'notifications'],
                        Gio.SubprocessFlags.NONE);
                }
            } else {
                Gio.Subprocess.new(
                    ['gnome-control-center', 'notifications'],
                    Gio.SubprocessFlags.NONE);
            }
        } catch (_e) {}
    }

    // ── Utilities ───────────────────────────────────────────────────

    _snapBack(banner) {
        banner.ease({
            translation_x: 0,
            translation_y: 0,
            opacity: 255,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // ── Cleanup ─────────────────────────────────────────────────────

    destroy() {
        this._restoreAutoHideTimeout();
        this._runtimeDisposer?.dispose?.();
        this._swipeState = null;
        this._lastBanner = null;
    }
}
