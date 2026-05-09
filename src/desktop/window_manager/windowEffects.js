// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { Logger } from '../../shared/utilities/logger.js';
import { isWindowMaximized } from '../../shared/utilities/uiUtils.js';

const ROUNDED_CORNERS_DECL = `
uniform vec4 bounds;
uniform float clipRadius;
uniform float exponent;
uniform vec2 pixelStep;

float circleBounds(vec2 p, vec2 center, float cr) {
    vec2 delta = p - center;
    float distSquared = dot(delta, delta);
    float outerRadius = cr + 0.5;
    if (distSquared >= (outerRadius * outerRadius))
        return 0.0;
    float innerRadius = cr - 0.5;
    if (distSquared <= (innerRadius * innerRadius))
        return 1.0;
    return outerRadius - sqrt(distSquared);
}

float squircleBounds(vec2 p, vec2 center, float cr, float exp) {
    vec2 delta = abs(p - center);
    float dist = pow(pow(delta.x, exp) + pow(delta.y, exp), 1.0 / exp);
    return clamp(cr - dist + 0.5, 0.0, 1.0);
}
`;

const ROUNDED_CORNERS_CODE = `
vec2 p = cogl_tex_coord0_in.xy / pixelStep;

if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w) {
    cogl_color_out *= 0.0;
    return;
}

vec2 center;
float centerLeft  = bounds.x + clipRadius;
float centerRight = bounds.z - clipRadius;

if (p.x < centerLeft)
    center.x = centerLeft;
else if (p.x > centerRight)
    center.x = centerRight;
else
    return;

float centerTop    = bounds.y + clipRadius;
float centerBottom = bounds.w - clipRadius;

if (p.y < centerTop)
    center.y = centerTop;
else if (p.y > centerBottom)
    center.y = centerBottom;
else
    return;

if (exponent <= 2.0)
    cogl_color_out *= circleBounds(p, center, clipRadius);
else
    cogl_color_out *= squircleBounds(p, center, clipRadius, exponent);
`;

/**
 * GLSL effect for rounding the corners of live MetaWindowActors.
 * Supports both circular and squircle (superellipse) corners.
 */
const WindowRoundedEffect = GObject.registerClass(
class WindowRoundedEffect extends Shell.GLSLEffect {
    _init(params = {}) {
        super._init(params);
        this._boundsLoc = this.get_uniform_location('bounds');
        this._clipRadiusLoc = this.get_uniform_location('clipRadius');
        this._exponentLoc = this.get_uniform_location('exponent');
        this._pixelStepLoc = this.get_uniform_location('pixelStep');
        this._boundsBuf = [0, 0, 0, 0];
        this._radiusBuf = [0];
        this._exponentBuf = [2.0];
        this._pixelBuf = [0, 0];
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(
            Cogl.SnippetHook.FRAGMENT,
            ROUNDED_CORNERS_DECL,
            ROUNDED_CORNERS_CODE,
            false);
    }

    /**
     * Update shader uniforms for the given actor geometry.
     * @param {number} radius
     * @param {Clutter.Actor} actor
     * @param {number[]} contentOffset - [ox, oy, ow, oh]
     * @param {number} smoothing
     * @returns {boolean}
     */
    updateUniforms(radius, actor, contentOffset, smoothing) {
        if (!actor || actor.width <= 1 || actor.height <= 1) return false;
        if (!Number.isFinite(radius) || radius <= 0) return false;

        let [ox, oy, ow, oh] = contentOffset;
        let b = this._boundsBuf;
        b[0] = ox + 1;
        b[1] = oy + 1;
        b[2] = ox + actor.width + ow;
        b[3] = oy + actor.height + oh;

        let p = this._pixelBuf;
        p[0] = 1 / actor.width;
        p[1] = 1 / actor.height;

        let exponent = smoothing * 10 + 2;
        let scaledRadius = radius * 0.5 * exponent;
        let maxW = b[2] - b[0];
        let maxH = b[3] - b[1];
        let maxRadius = Math.min(maxW, maxH) * 0.5;
        if (scaledRadius > maxRadius) {
            exponent *= maxRadius / scaledRadius;
            scaledRadius = maxRadius;
        }

        this._radiusBuf[0] = scaledRadius;
        this._exponentBuf[0] = exponent;

        this.set_uniform_float(this._boundsLoc, 4, b);
        this.set_uniform_float(this._clipRadiusLoc, 1, this._radiusBuf);
        this.set_uniform_float(this._exponentLoc, 1, this._exponentBuf);
        this.set_uniform_float(this._pixelStepLoc, 2, p);
        this.queue_repaint();
        return true;
    }
});

/**
 * Simpler clip effect for small clone containers (e.g. preview thumbnails).
 */
export const RoundedClipEffect = GObject.registerClass(
class RoundedClipEffect extends Shell.GLSLEffect {
    _init(params = {}) {
        super._init(params);
        this._boundsLoc = this.get_uniform_location('bounds');
        this._clipRadiusLoc = this.get_uniform_location('clipRadius');
        this._exponentLoc = this.get_uniform_location('exponent');
        this._pixelStepLoc = this.get_uniform_location('pixelStep');
        this._boundsBuf = [1, 1, 0, 0];
        this._radiusBuf = [24.0];
        this._exponentBuf = [2.0];
        this._pixelBuf = [0, 0];
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(
            Cogl.SnippetHook.FRAGMENT,
            ROUNDED_CORNERS_DECL,
            ROUNDED_CORNERS_CODE,
            false);
    }

    vfunc_paint_target(node, paintContext) {
        let actor = this.get_actor();
        let w = actor.width, h = actor.height;
        if (w <= 1 || h <= 1) {
            super.vfunc_paint_target(node, paintContext);
            return;
        }
        let b = this._boundsBuf;
        b[2] = w;
        b[3] = h;
        this._radiusBuf[0] = this._radius ?? 24.0;
        this._exponentBuf[0] = 2.0;
        let p = this._pixelBuf;
        p[0] = 1 / w;
        p[1] = 1 / h;
        this.set_uniform_float(this._boundsLoc, 4, b);
        this.set_uniform_float(this._clipRadiusLoc, 1, this._radiusBuf);
        this.set_uniform_float(this._exponentLoc, 1, this._exponentBuf);
        this.set_uniform_float(this._pixelStepLoc, 2, p);
        super.vfunc_paint_target(node, paintContext);
    }
});

/**
 * Manages window corner rounding effects and taskbar-adjusted work areas
 * for desktop mode.
 */
export class WindowEffects {
    /**
     * @param {Object} controller - Extension controller
     * @param {Object} settings - GSettings instance
     */
    constructor(controller, settings) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._logger = new Logger('WindowEffects', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();

        this._windowSignals = new Map();
        this._taskbarBoundsTimers = new Map();
        this._taskbarBoundsInFlight = new Set();

        this._cornerRadiusEnabled = undefined;
        this._cornerRadius = undefined;
        this._cornerSmoothing = undefined;
        this._contentOffsetBuf = [0, 0, 0, 0];
    }

    /**
     * Get the target actor for applying effects to a MetaWindow.
     * @param {Object} metaWindow
     * @returns {Clutter.Actor|null}
     */
    getEffectActor(metaWindow) {
        let windowActor;
        try {
            windowActor = metaWindow.get_compositor_private();
        } catch (_e) {
            return null;
        }
        if (!windowActor) return null;

        let clientType;
        try {
            clientType = metaWindow.get_client_type();
        } catch (_e) {
            return null;
        }
        let target = clientType === Meta.WindowClientType.X11
            ? windowActor.get_first_child() ?? windowActor
            : windowActor;

        if (!target || target.is_finalized?.()) return null;
        try {
            if (!windowActor.get_texture()) return null;
        } catch (_e) {
            return null;
        }
        return target;
    }

    /**
     * Compute the content offset between buffer-rect and frame-rect.
     * @param {Object} metaWindow
     * @returns {number[]}
     */
    computeContentOffset(metaWindow) {
        let bufferRect = metaWindow.get_buffer_rect();
        let frameRect = metaWindow.get_frame_rect();
        let buf = this._contentOffsetBuf;
        buf[0] = frameRect.x - bufferRect.x;
        buf[1] = frameRect.y - bufferRect.y;
        buf[2] = frameRect.width - bufferRect.width;
        buf[3] = frameRect.height - bufferRect.height;
        return buf;
    }

    /**
     * Apply rounded corner effect to a window.
     * @param {Object} metaWindow
     */
    applyCornerRadius(metaWindow) {
        let enabled = this._cornerRadiusEnabled;
        let radius = this._cornerRadius;
        let smoothing = this._cornerSmoothing;

        if (enabled === undefined) {
            try {
                enabled = this._settings.get_boolean('rounded-corners-enabled');
            } catch (_e) { enabled = false; }
            try {
                radius = this._settings.get_int('window-corner-radius');
            } catch (_e) { radius = 0; }
            try {
                smoothing = this._settings.get_double('window-corner-smoothing');
            } catch (_e) { smoothing = 0; }
            this._cornerRadiusEnabled = enabled;
            this._cornerRadius = radius;
            this._cornerSmoothing = smoothing;
        }

        if (!enabled || radius === 0 || metaWindow.fullscreen) {
            this.removeCornerRadius(metaWindow);
            return;
        }

        let actor = this.getEffectActor(metaWindow);
        if (!actor || actor.width <= 1 || actor.height <= 1) {
            this.removeCornerRadius(metaWindow);
            return;
        }

        let effect = actor.get_effect('convergence-rounded');
        if (!effect) {
            try {
                effect = new WindowRoundedEffect();
                actor.add_effect_with_name('convergence-rounded', effect);
            } catch (_e) {
                return;
            }
        }

        let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let scaledRadius = radius * scaleFactor;
        let offset = this.computeContentOffset(metaWindow);
        try {
            let applied = effect.updateUniforms(scaledRadius, actor, offset, smoothing);
            if (!applied)
                this.removeCornerRadius(metaWindow);
        } catch (_e) {
            this.removeCornerRadius(metaWindow);
        }
    }

    /**
     * Remove the rounded corner effect from a window.
     * @param {Object} metaWindow
     */
    removeCornerRadius(metaWindow) {
        let actor = this.getEffectActor(metaWindow);
        if (!actor) return;
        actor.remove_effect_by_name('convergence-rounded');
    }

    /**
     * Handle fullscreen state changes.
     * @param {Object} metaWindow
     */
    onFullscreenChanged(metaWindow) {
        if (metaWindow.fullscreen)
            this.removeCornerRadius(metaWindow);
        else
            this.applyCornerRadius(metaWindow);
    }

    /**
     * Recompute corner radius for all tracked windows (e.g. after settings change).
     */
    updateAllCornerRadius() {
        this._cornerRadiusEnabled = undefined;
        this._cornerRadius = undefined;
        this._cornerSmoothing = undefined;
        for (let metaWindow of this._windowSignals.keys())
            this.applyCornerRadius(metaWindow);
    }

    /**
     * Check whether taskbar bounds should be reserved for a window.
     * @param {Object} metaWindow
     * @returns {boolean}
     */
    shouldReserveTaskbarBounds(metaWindow) {
        if (!metaWindow) return false;
        let type = metaWindow.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
            return false;
        if (metaWindow.minimized || metaWindow.fullscreen) return false;

        try {
            let mode = this._settings?.get_string('taskbar-secondary-mode') ?? 'visible';
            return mode === 'visible';
        } catch (_e) {
            return false;
        }
    }

    /**
     * Compute the taskbar-adjusted work area for a window.
     * @param {Object} metaWindow
     * @returns {{x:number,y:number,width:number,height:number}|null}
     */
    computeTaskbarAdjustedWorkArea(metaWindow) {
        if (!this.shouldReserveTaskbarBounds(metaWindow)) return null;

        let monIdx = metaWindow.get_monitor();
        let taskbarRect = this._controller.getTaskbarRectForMonitor?.(monIdx);
        if (!taskbarRect) return null;

        let wa = metaWindow.get_work_area_current_monitor();
        if (!wa) return null;

        let right = wa.x + wa.width;
        let bottom = wa.y + wa.height;

        let taskbarPos = 'left';
        try {
            if (this._settings?.settings_schema?.has_key?.('taskbar-position'))
                taskbarPos = this._settings.get_string('taskbar-position');
        } catch (_e) {}
        let horizontalTaskbar = (taskbarPos !== 'left' && taskbarPos !== 'right');

        let x = wa.x, y = wa.y, w = wa.width, h = wa.height;

        if (horizontalTaskbar) {
            h = Math.floor(taskbarRect.y - wa.y);
        } else {
            let centerX = taskbarRect.x + taskbarRect.width / 2;
            let waCenterX = wa.x + wa.width / 2;
            if (centerX <= waCenterX) {
                x = Math.ceil(taskbarRect.x + taskbarRect.width);
                w = right - x;
            } else {
                w = Math.floor(taskbarRect.x - wa.x);
            }
        }

        w = Math.max(320, w);
        h = Math.max(220, h);
        if (x + w > right) w = Math.max(320, right - x);
        if (y + h > bottom) h = Math.max(220, bottom - y);

        if (w <= 0 || h <= 0) return null;
        return { x, y, width: w, height: h };
    }

    /**
     * Schedule enforcement of taskbar bounds for a window.
     * @param {Object} metaWindow
     * @param {number} delayMs
     */
    scheduleTaskbarBoundsEnforce(metaWindow, delayMs = 0) {
        if (!metaWindow || !this._windowSignals.has(metaWindow)) return;

        let prev = this._taskbarBoundsTimers.get(metaWindow);
        if (prev) {
            GLib.source_remove(prev);
            this._runtimeDisposer.untrackTimeout(prev);
        }

        let tid = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(0, delayMs), () => {
                this._runtimeDisposer.untrackTimeout(tid);
                this._taskbarBoundsTimers.delete(metaWindow);
                this._enforceTaskbarBounds(metaWindow);
                return GLib.SOURCE_REMOVE;
            });
        this._runtimeDisposer.trackTimeout(tid);
        this._taskbarBoundsTimers.set(metaWindow, tid);
    }

    /**
     * Enforce taskbar bounds for a specific window.
     * @param {Object} metaWindow
     * @private
     */
    _enforceTaskbarBounds(metaWindow) {
        if (!this._windowSignals.has(metaWindow)) return;
        if (this._taskbarBoundsInFlight.has(metaWindow)) return;

        let maxFlags = 0;
        try { maxFlags = metaWindow.get_maximized?.() ?? 0; } catch (_e) {}
        if (maxFlags !== 0 && maxFlags !== Meta.MaximizeFlags.BOTH) return;
        if (isWindowMaximized(metaWindow)) return;

        let area = this.computeTaskbarAdjustedWorkArea(metaWindow);
        if (!area) return;

        let frame = metaWindow.get_frame_rect();
        if (!frame) return;

        let nx = frame.x, ny = frame.y, nw = frame.width, nh = frame.height;
        if (nx < area.x) { nw -= area.x - nx; nx = area.x; }
        if (ny < area.y) { nh -= area.y - ny; ny = area.y; }
        if (nx + nw > area.x + area.width) nw = area.x + area.width - nx;
        if (ny + nh > area.y + area.height) nh = area.y + area.height - ny;
        nw = Math.max(nw, 320);
        nh = Math.max(nh, 220);

        let changed = false;
        this._taskbarBoundsInFlight.add(metaWindow);

        if (nx !== frame.x || ny !== frame.y ||
            nw !== frame.width || nh !== frame.height) {
            try {
                metaWindow.move_resize_frame(true, nx, ny, nw, nh);
                changed = true;
            } catch (_e) {
                changed = true;
            }
        }

        if (changed) {
            let clearId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._runtimeDisposer.untrackTimeout(clearId);
                this._taskbarBoundsInFlight.delete(metaWindow);
                return GLib.SOURCE_REMOVE;
            });
            this._runtimeDisposer.trackTimeout(clearId);
        } else {
            this._taskbarBoundsInFlight.delete(metaWindow);
        }
    }

    // ── Minimize-to-icon ───────────────────────────────────────────

    /**
     * Connect to global.window_manager minimize/unminimize signals
     * to set icon geometry so the minimize animation targets the
     * app's taskbar icon.
     */
    connectMinimizeSignals() {
        let wm = global.window_manager;
        if (!wm) return;

        this._runtimeDisposer.connect(wm, 'minimize', (_wm, actor) => {
            this._onMinimize(actor);
        });
        this._runtimeDisposer.connect(wm, 'unminimize', (_wm, actor) => {
            this._onUnminimize(actor);
        });
    }

    /**
     * Handle a minimize event: set icon geometry to the taskbar icon position.
     * @param {Object} actor - The MetaWindowActor
     * @private
     */
    _onMinimize(actor) {
        if (!this._isMinimizeToIconEnabled()) return;
        let metaWindow = actor?.meta_window ?? actor?.metaWindow;
        if (!metaWindow) return;

        this._setIconGeometryForWindow(metaWindow);
    }

    /**
     * Handle an unminimize event: set icon geometry so the animation
     * originates from the taskbar icon.
     * @param {Object} actor - The MetaWindowActor
     * @private
     */
    _onUnminimize(actor) {
        if (!this._isMinimizeToIconEnabled()) return;
        let metaWindow = actor?.meta_window ?? actor?.metaWindow;
        if (!metaWindow) return;

        this._setIconGeometryForWindow(metaWindow);
    }

    /**
     * Set the icon geometry on a window so Mutter's minimize/unminimize
     * animation targets the correct taskbar icon position.
     * @param {Object} metaWindow
     * @private
     */
    _setIconGeometryForWindow(metaWindow) {
        let tracker = Shell.WindowTracker.get_default();
        let app = tracker?.get_window_app?.(metaWindow);
        if (!app) return;

        let appId = app.get_id();
        let monIndex = metaWindow.get_monitor();

        let icons = this._controller?.taskbarIcons;
        if (!icons) return;

        let rect = icons.getTaskbarIconRect(appId, monIndex);
        if (!rect) return;

        try {
            // Mtk.Rectangle in GNOME 46+, Meta.Rectangle in older
            let RectClass = Meta.Rectangle ?? null;
            if (!RectClass) {
                try {
                    let Mtk = imports.gi.Mtk;
                    RectClass = Mtk.Rectangle;
                } catch (_e) {}
            }
            if (RectClass) {
                let iconRect = new RectClass({
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                });
                metaWindow.set_icon_geometry(iconRect);
            }
        } catch (_e) {
            // set_icon_geometry may not be available on all versions
        }
    }

    /**
     * Check whether minimize-to-icon is enabled in settings.
     * @returns {boolean}
     * @private
     */
    _isMinimizeToIconEnabled() {
        try {
            return this._settings?.get_boolean('taskbar-minimize-into-app-icon') ?? false;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Enforce taskbar bounds for all tracked windows.
     */
    enforceTaskbarBoundsForAll() {
        for (let metaWindow of this._windowSignals.keys())
            this.scheduleTaskbarBoundsEnforce(metaWindow, 20);
    }

    /**
     * Clean up all resources.
     */
    destroy() {
        for (let [, timerId] of this._taskbarBoundsTimers) {
            GLib.source_remove(timerId);
            this._runtimeDisposer.untrackTimeout(timerId);
        }
        this._taskbarBoundsTimers.clear();
        this._taskbarBoundsInFlight.clear();
        this._windowSignals.clear();
        this._runtimeDisposer.dispose();
        this._logger?.destroy?.();
    }
}
