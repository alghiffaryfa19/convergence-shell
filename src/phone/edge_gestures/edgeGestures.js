// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getAdaptiveScale } from '../../shared/utilities/uiUtils.js';

const EDGE_WIDTH = 16;
const SWIPE_THRESHOLD = 80;
const ACTIVATION_THRESHOLD = 12;

/**
 * EdgeGestures -- phone-only left/right edge swipe-back gesture.
 *
 * Creates invisible reactive zones along the left and right screen edges.
 * Swiping inward from either edge triggers a back navigation action via
 * the controller. A directional arrow indicator provides visual feedback
 * during the gesture.
 */
export class EdgeGestures {
    /**
     * @param {Object} controller - convergence controller instance
     */
    constructor(controller) {
        this._controller = controller;
        this._zones = [];
        this._edgeWidth = EDGE_WIDTH;
        this._swipeThreshold = SWIPE_THRESHOLD;
        this._activationThreshold = ACTIVATION_THRESHOLD;
        this._backArrowOffsetY = 20;

        this._buildEdgeZones();
    }

    _refreshMetrics(monitor = null) {
        let s = getAdaptiveScale({
            profile: 'gesture',
            monitor,
            referenceWidth: 600,
            min: 0.95,
            max: 1.2,
        });
        this._edgeWidth = Math.round(EDGE_WIDTH * s);
        this._swipeThreshold = Math.round(SWIPE_THRESHOLD * s);
        this._activationThreshold = Math.max(8, Math.round(ACTIVATION_THRESHOLD * s));
        this._backArrowOffsetY = Math.round(20 * s);
    }

    _buildEdgeZones() {
        let monitors = Main.layoutManager.monitors ?? [];
        if (monitors.length === 0)
            return;
        let phoneMonitorIndices = this._controller?.getPhoneMonitorIndices?.()
            ?? [this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex];

        for (let phoneMonitorIndex of phoneMonitorIndices) {
            let monitor = monitors[phoneMonitorIndex] ?? null;
            if (!monitor)
                continue;

            let panelHeight = this._controller?.getPhoneTopInset?.(phoneMonitorIndex) ?? Main.panel?.height ?? 0;
            this._refreshMetrics(monitor);
            let topInset = panelHeight;
            let zoneY = monitor.y + topInset;
            let zoneH = Math.max(1, monitor.height - topInset - 20);

            this._zones.push(this._createEdgeZone(
                monitor.x, zoneY,
                this._edgeWidth, zoneH,
                'left', phoneMonitorIndex
            ));
            this._zones.push(this._createEdgeZone(
                monitor.x + monitor.width - this._edgeWidth,
                zoneY,
                this._edgeWidth,
                zoneH,
                'right', phoneMonitorIndex
            ));
        }
    }

    _createEdgeZone(x, y, width, height, side, monitorIndex) {
        let zone = new St.Widget({
            style_class: 'convergence-edge-zone',
            reactive: true,
            x, y, width, height,
        });

        let gestureState = {
            pressed: false,
            claimed: false,
            startX: 0,
            startY: 0,
            grab: null,
            arrow: null,
            monitorIndex,
            zone,
        };

        zone.connect('button-press-event', (_actor, event) => {
            return this._onEdgePress(event, gestureState, side);
        });
        zone.connect('motion-event', (_actor, event) => {
            return this._onEdgeMotion(event, gestureState, side);
        });
        zone.connect('button-release-event', (_actor, event) => {
            return this._onEdgeRelease(event, gestureState, side);
        });
        zone.connect('touch-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN)
                return this._onEdgePress(event, gestureState, side);
            else if (type === Clutter.EventType.TOUCH_UPDATE)
                return this._onEdgeMotion(event, gestureState, side);
            else if (type === Clutter.EventType.TOUCH_END ||
                     type === Clutter.EventType.TOUCH_CANCEL)
                return this._onEdgeRelease(event, gestureState, side);
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.addTopChrome(zone);
        Main.layoutManager.uiGroup.set_child_below_sibling(
            zone, Main.layoutManager.modalDialogGroup);
        return zone;
    }

    /** Tear down and rebuild edge zones after geometry change. */
    relayout() {
        this._destroyZones();
        this._buildEdgeZones();
    }

    _onEdgePress(event, state, _side) {
        let [x, y] = event.get_coords();
        state.pressed = true;
        state.claimed = false;
        state.startX = x;
        state.startY = y;
        state.arrow = null;
        return Clutter.EVENT_PROPAGATE;
    }

    _onEdgeMotion(event, state, side) {
        if (!state.pressed)
            return Clutter.EVENT_PROPAGATE;

        let [x] = event.get_coords();
        let dx = side === 'left' ? (x - state.startX) : (state.startX - x);

        if (!state.claimed && dx > this._activationThreshold) {
            state.claimed = true;
            state.grab = global.stage.grab(state.zone);

            let [, y] = event.get_coords();
            let monitor = Main.layoutManager.monitors[state.monitorIndex];
            let isRight = side === 'right';
            state.arrow = new St.Label({
                text: isRight ? '\u25C0' : '\u25B6',
                style_class: 'convergence-back-arrow',
                x: isRight ? (monitor.x + monitor.width - this._backArrowOffsetY) : 0,
                y: y - this._backArrowOffsetY,
                opacity: 0,
            });
            Main.layoutManager.addTopChrome(state.arrow);
            Main.layoutManager.uiGroup.set_child_below_sibling(
                state.arrow, Main.layoutManager.modalDialogGroup);
            state.arrow.ease({
                opacity: 200, duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        if (!state.claimed)
            return Clutter.EVENT_PROPAGATE;

        if (state.arrow) {
            let progress = Math.min(1, Math.max(0, dx / this._swipeThreshold));
            if (side === 'right') {
                let monitor = Main.layoutManager.monitors[state.monitorIndex];
                state.arrow.x = (monitor.x + monitor.width - this._backArrowOffsetY) - dx * 0.5;
            } else {
                state.arrow.x = dx * 0.5;
            }
            state.arrow.opacity = Math.round(100 + progress * 155);
            let scale = 0.8 + progress * 0.6;
            state.arrow.set_scale(scale, scale);
        }

        return Clutter.EVENT_STOP;
    }

    _onEdgeRelease(event, state, side) {
        if (!state.pressed)
            return Clutter.EVENT_PROPAGATE;

        let wasClaimed = state.claimed;
        state.pressed = false;
        state.claimed = false;

        if (state.grab) {
            state.grab.dismiss();
            state.grab = null;
        }

        if (!wasClaimed)
            return Clutter.EVENT_PROPAGATE;

        let [x] = event.get_coords();
        let dx = side === 'left' ? (x - state.startX) : (state.startX - x);

        if (state.arrow) {
            let arrow = state.arrow;
            state.arrow = null;
            arrow.ease({
                opacity: 0, duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    Main.layoutManager.removeChrome(arrow);
                    arrow.destroy();
                },
            });
        }

        if (dx > this._swipeThreshold)
            this._controller.goBack(state.monitorIndex);

        return Clutter.EVENT_STOP;
    }

    _destroyZones() {
        for (let zone of this._zones) {
            Main.layoutManager.removeChrome(zone);
            zone.destroy();
        }
        this._zones = [];
    }

    destroy() {
        this._destroyZones();
    }
}
