// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Clutter from 'gi://Clutter';
import St from 'gi://St';

const SLIDER_HEIGHT = 200;
const SLIDER_WIDTH = 42;
const TRACK_RADIUS = 21;
const CONTAINER_PADDING = 10;
const ICON_SIZE = 18;
const EXPAND_BTN_SIZE = 32;
const RING_BTN_SIZE = 32;
const STREAM_SLIDER_HEIGHT = 140;
const STREAM_LABEL_SIZE = 11;

const VOLUME_ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
];

const RING_MODES = ['ring', 'vibrate', 'silent'];
const RING_ICONS = [
    'audio-volume-high-symbolic',
    'audio-input-microphone-muted-symbolic',
    'notifications-disabled-symbolic',
];

/**
 * VolumeOsdWidget — Android-style vertical pill volume slider.
 *
 * Positioned on the left or right screen edge. Supports touch drag,
 * an expand button for additional audio streams, and a ring/vibrate/silent
 * toggle.
 */
export class VolumeOsdWidget {
    /**
     * @param {object} opts
     * @param {string} opts.side - 'left' or 'right'
     * @param {function} opts.onValueChanged - callback(value: 0-1)
     * @param {function} opts.onInteraction - callback() to reset auto-hide timer
     */
    constructor(opts = {}) {
        this._side = opts.side ?? 'left';
        this._maxValue = opts.maxValue ?? 1.0;
        this._onValueChanged = opts.onValueChanged ?? null;
        this._onInteraction = opts.onInteraction ?? null;
        this._value = 0;
        this._dragging = false;
        this._ringMode = 0;
        this._expanded = false;
        this._destroyed = false;
        this._streams = [];
        this._streamSliders = [];
        this._normalMark = null;

        this._buildUI();
    }

    get actor() { return this._container; }
    get value() { return this._value; }

    set value(v) {
        this._value = Math.max(0, Math.min(this._maxValue, v));
        this._updateSliderVisual();
        this._updateVolumeIcon();
    }

    get maxValue() { return this._maxValue; }

    set maxValue(v) {
        let newMax = Math.max(1.0, v);
        if (newMax === this._maxValue) return;
        this._maxValue = newMax;
        this._updateNormalMark();
        this._updateSliderVisual();
    }

    get side() { return this._side; }

    set side(s) {
        if (s === this._side) return;
        this._side = s;
    }

    _buildUI() {
        // Outer container — positioned absolutely on screen
        this._container = new St.BoxLayout({
            style_class: 'convergence-volume-osd',
            vertical: true,
            reactive: true,
            opacity: 0,
            visible: false,
        });

        // Expand button (chevron) — hidden until streams are provided
        this._expandBtn = new St.Button({
            style_class: 'convergence-volume-osd-expand-btn',
            child: new St.Icon({
                icon_name: 'view-more-horizontal-symbolic',
                style: `icon-size: ${Math.round(ICON_SIZE * 0.8)}px;`,
            }),
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._expandBtn.connect('clicked', () => this._toggleExpand());
        this._container.add_child(this._expandBtn);

        // Main slider area
        this._sliderBox = new St.Widget({
            style_class: 'convergence-volume-osd-slider-box',
            reactive: true,
            width: SLIDER_WIDTH,
            height: SLIDER_HEIGHT,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._container.add_child(this._sliderBox);

        // Track background
        this._track = new St.Widget({
            style_class: 'convergence-volume-osd-track',
            width: SLIDER_WIDTH,
            height: SLIDER_HEIGHT,
        });
        this._sliderBox.add_child(this._track);

        // Fill (from bottom up)
        this._fill = new St.Widget({
            style_class: 'convergence-volume-osd-fill',
            width: SLIDER_WIDTH,
            height: 0,
        });
        this._sliderBox.add_child(this._fill);

        // 100% marker line — only visible when overamplification is active
        this._normalMark = new St.Widget({
            style_class: 'convergence-volume-osd-normal-mark',
            width: SLIDER_WIDTH,
            height: 2,
            visible: false,
        });
        this._sliderBox.add_child(this._normalMark);
        this._updateNormalMark();

        // Volume icon at bottom of slider
        this._volumeIcon = new St.Icon({
            style_class: 'convergence-volume-osd-icon',
            icon_name: 'audio-volume-high-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._sliderBox.add_child(this._volumeIcon);

        // Touch/mouse interaction on the slider box
        this._sliderBox.connect('button-press-event', (_a, event) => this._onPress(event));
        this._sliderBox.connect('motion-event', (_a, event) => this._onMotion(event));
        this._sliderBox.connect('button-release-event', () => this._onRelease());
        this._sliderBox.connect('touch-event', (_a, event) => this._onTouch(event));

        // Expanded panel for multiple streams (initially hidden)
        this._expandedPanel = new St.BoxLayout({
            style_class: 'convergence-volume-osd-expanded',
            vertical: false,
            visible: false,
            opacity: 0,
        });
        this._container.add_child(this._expandedPanel);
    }

    _onPress(event) {
        this._dragging = true;
        this._updateValueFromEvent(event);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        this._updateValueFromEvent(event);
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        this._dragging = false;
        return Clutter.EVENT_STOP;
    }

    _onTouch(event) {
        let type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._dragging = true;
            this._updateValueFromEvent(event);
            return Clutter.EVENT_STOP;
        } else if (type === Clutter.EventType.TOUCH_UPDATE) {
            if (this._dragging) {
                this._updateValueFromEvent(event);
                return Clutter.EVENT_STOP;
            }
        } else if (type === Clutter.EventType.TOUCH_END ||
                   type === Clutter.EventType.TOUCH_CANCEL) {
            this._dragging = false;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _updateValueFromEvent(event) {
        let [absX_, absY] = event.get_coords();
        let [sliderX_, sliderY] = this._sliderBox.get_transformed_position();
        let sliderH = this._sliderBox.height;

        // y=0 is top of slider (max volume), y=sliderH is bottom (volume 0%)
        let relY = absY - sliderY;
        let fraction = 1.0 - Math.max(0, Math.min(1, relY / sliderH));
        let newValue = fraction * this._maxValue;

        this._value = newValue;
        this._updateSliderVisual();
        this._updateVolumeIcon();
        this._onValueChanged?.(this._value);
        this._onInteraction?.();
    }

    _updateNormalMark() {
        if (!this._normalMark) return;
        if (this._maxValue <= 1.0) {
            this._normalMark.visible = false;
            return;
        }
        // Position the marker at the 100% (1.0) point on the slider
        let normalFraction = 1.0 / this._maxValue;
        let markY = SLIDER_HEIGHT - Math.round(normalFraction * SLIDER_HEIGHT);
        this._normalMark.set_position(0, markY);
        this._normalMark.visible = true;
    }

    _updateSliderVisual() {
        let fraction = this._value / this._maxValue;
        let fillH = Math.round(fraction * SLIDER_HEIGHT);
        this._fill.height = fillH;
        this._fill.set_position(0, SLIDER_HEIGHT - fillH);

        // Keep icon centered at bottom of slider — use fixed size
        // (ICON_SIZE + padding from CSS) to avoid layout-dependent flicker.
        let iconSize = ICON_SIZE + 12;
        this._volumeIcon.set_position(
            Math.round((SLIDER_WIDTH - iconSize) / 2),
            SLIDER_HEIGHT - iconSize - 4);
    }

    _updateVolumeIcon() {
        let idx;
        if (this._value <= 0)
            idx = 0;
        else if (this._value < 0.33)
            idx = 1;
        else if (this._value < 0.66)
            idx = 2;
        else
            idx = 3;
        this._volumeIcon.icon_name = VOLUME_ICONS[idx];

    }

    _cycleRingMode() {
        this._ringMode = (this._ringMode + 1) % RING_MODES.length;
        this._ringBtn.child.icon_name = RING_ICONS[this._ringMode];
        this._onInteraction?.();
    }

    _toggleExpand() {
        this._onInteraction?.();
        if (this._expanded) {
            this._collapse();
        } else {
            this._expand();
        }
    }

    /**
     * Set additional audio streams to show in expanded mode.
     * @param {Array<{name: string, icon: string, value: number, onChanged: function}>} streams
     */
    setStreams(streams) {
        this._streams = streams;
        // Hide expand button if no extra streams
        this._expandBtn.visible = streams.length > 0;
        this._rebuildExpandedSliders();
    }

    _rebuildExpandedSliders() {
        this._expandedPanel.destroy_all_children();
        this._streamSliders = [];

        for (let stream of this._streams) {
            let col = new St.BoxLayout({
                vertical: true,
                style_class: 'convergence-volume-osd-stream-col',
                x_align: Clutter.ActorAlign.CENTER,
            });

            let label = new St.Label({
                text: stream.name,
                style_class: 'convergence-volume-osd-stream-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            col.add_child(label);

            let sliderBox = new St.Widget({
                style_class: 'convergence-volume-osd-slider-box convergence-volume-osd-stream-slider',
                reactive: true,
                width: SLIDER_WIDTH - 8,
                height: STREAM_SLIDER_HEIGHT,
            });

            let track = new St.Widget({
                style_class: 'convergence-volume-osd-track',
                width: SLIDER_WIDTH - 8,
                height: STREAM_SLIDER_HEIGHT,
            });
            sliderBox.add_child(track);

            let fill = new St.Widget({
                style_class: 'convergence-volume-osd-fill',
                width: SLIDER_WIDTH - 8,
                height: Math.round(stream.value * STREAM_SLIDER_HEIGHT),
            });
            fill.set_position(0, STREAM_SLIDER_HEIGHT - fill.height);
            sliderBox.add_child(fill);

            let icon = new St.Icon({
                icon_name: stream.icon,
                style_class: 'convergence-volume-osd-icon',
                x_align: Clutter.ActorAlign.CENTER,
            });
            sliderBox.add_child(icon);

            // Drag on sub-slider
            let dragging = false;
            let updateFromEvent = (event) => {
                let [_ax, ay] = event.get_coords();
                let [_sx, sy] = sliderBox.get_transformed_position();
                let h = sliderBox.height;
                let val = 1.0 - Math.max(0, Math.min(1, (ay - sy) / h));
                fill.height = Math.round(val * h);
                fill.set_position(0, h - fill.height);
                stream.onChanged?.(val);
                this._onInteraction?.();
            };

            sliderBox.connect('button-press-event', (_a, ev) => { dragging = true; updateFromEvent(ev); return Clutter.EVENT_STOP; });
            sliderBox.connect('motion-event', (_a, ev) => { if (dragging) { updateFromEvent(ev); return Clutter.EVENT_STOP; } return Clutter.EVENT_PROPAGATE; });
            sliderBox.connect('button-release-event', () => { dragging = false; return Clutter.EVENT_STOP; });
            sliderBox.connect('touch-event', (_a, ev) => {
                let t = ev.type();
                if (t === Clutter.EventType.TOUCH_BEGIN) { dragging = true; updateFromEvent(ev); return Clutter.EVENT_STOP; }
                if (t === Clutter.EventType.TOUCH_UPDATE && dragging) { updateFromEvent(ev); return Clutter.EVENT_STOP; }
                if (t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.TOUCH_CANCEL) { dragging = false; return Clutter.EVENT_STOP; }
                return Clutter.EVENT_PROPAGATE;
            });

            col.add_child(sliderBox);
            this._expandedPanel.add_child(col);
            this._streamSliders.push({ fill, sliderBox, stream });
        }
    }

    _expand() {
        if (this._expanded) return;
        this._expanded = true;
        this._expandedPanel.visible = true;
        this._expandedPanel.opacity = 0;
        this._expandedPanel.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._expandBtn.child.icon_name = 'view-less-horizontal-symbolic';
    }

    _collapse() {
        if (!this._expanded) return;
        this._expanded = false;
        this._expandedPanel.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._expandedPanel.visible = false;
            },
        });
        this._expandBtn.child.icon_name = 'view-more-horizontal-symbolic';
    }

    show(side) {
        if (side) this._side = side;

        // Already fully visible — just reset the hide timer, no animation
        if (this._container.visible && this._container.opacity === 255)
            return;

        this._container.remove_all_transitions();
        this._container.visible = true;

        let slideOffset = this._side === 'right' ? 40 : -40;
        this._container.translation_x = slideOffset;
        this._container.ease({
            opacity: 255,
            translation_x: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    hide() {
        let slideOffset = this._side === 'right' ? 40 : -40;
        this._container.ease({
            opacity: 0,
            translation_x: slideOffset,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this._container.visible = false;
                if (this._expanded)
                    this._collapse();
            },
        });
    }

    /**
     * Position the widget on the given monitor.
     * @param {object} monitor - {x, y, width, height}
     * @param {number} topInset - status bar height
     */
    position(monitor, topInset = 0) {
        if (!monitor) return;
        let margin = 8;
        // Place at ~33% down the usable area to align with typical
        // physical volume button placement (upper third of device).
        let usableH = monitor.height - topInset;
        let yCenter = monitor.y + topInset + Math.round(usableH * 0.33);
        let containerH = this._container.height || 300;
        let y = yCenter - Math.round(containerH / 2);

        let x;
        if (this._side === 'right')
            x = monitor.x + monitor.width - this._container.width - margin;
        else
            x = monitor.x + margin;

        this._container.set_position(x, y);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._container?.destroy();
        this._container = null;
    }
}
