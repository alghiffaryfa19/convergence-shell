// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Logger } from '../../shared/utilities/logger.js';

/**
 * GObject actor that draws a concave quarter-circle wedge at a taskbar
 * corner junction (where taskbar meets screen edge or panel).
 */
const TaskbarCornerActor = GObject.registerClass(
class TaskbarCornerActor extends St.DrawingArea {
    _init(hSide, vSide) {
        super._init({ style_class: 'convergence-taskbar-corner' });
        this._hSide = hSide;
        this._vSide = vSide;
        this._cornerRadius = 0;
    }

    setCornerParams(radius, r, g, b, a) {
        let changed = this._cornerRadius !== radius ||
            this._r !== r || this._g !== g || this._b !== b || this._a !== a;
        this._cornerRadius = radius;
        this._r = r;
        this._g = g;
        this._b = b;
        this._a = a;
        if (changed) {
            this.set_size(radius, radius);
            this.queue_repaint();
        }
    }

    vfunc_repaint() {
        let r = this._cornerRadius;
        if (r <= 0) return;

        let cr = this.get_context();
        cr.setOperator(Cairo.Operator.SOURCE);

        if (this._hSide === 'left' && this._vSide === 'top') {
            cr.moveTo(0, 0);
            cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
        } else if (this._hSide === 'left' && this._vSide === 'bottom') {
            cr.moveTo(0, r);
            cr.arc(r, 0, r, Math.PI / 2, Math.PI);
        } else if (this._hSide === 'right' && this._vSide === 'top') {
            cr.moveTo(r, 0);
            cr.arc(0, r, r, 3 * Math.PI / 2, 2 * Math.PI);
        } else if (this._hSide === 'right' && this._vSide === 'bottom') {
            cr.moveTo(r, r);
            cr.arc(0, 0, r, 0, Math.PI / 2);
        }
        cr.closePath();

        cr.setSourceRGBA(this._r ?? 0, this._g ?? 0, this._b ?? 0, this._a ?? 0.92);
        cr.fill();
        cr.$dispose();
    }
});

/**
 * GObject actor that draws a convex quarter-circle at a display corner
 * (masking physical screen rounding).
 */
const ScreenCornerActor = GObject.registerClass(
class ScreenCornerActor extends St.DrawingArea {
    _init(corner) {
        super._init({ style_class: 'convergence-screen-corner' });
        this._corner = corner;
        this._cornerRadius = 0;
    }

    setCornerParams(radius, r, g, b, a) {
        let changed = this._cornerRadius !== radius ||
            this._r !== r || this._g !== g || this._b !== b || this._a !== a;
        this._cornerRadius = radius;
        this._r = r;
        this._g = g;
        this._b = b;
        this._a = a;
        if (changed) {
            this.set_size(radius, radius);
            this.queue_repaint();
        }
    }

    vfunc_repaint() {
        let r = this._cornerRadius;
        if (r <= 0) return;

        let cr = this.get_context();
        cr.setOperator(Cairo.Operator.SOURCE);

        switch (this._corner) {
        case 'tl':
            cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
            cr.lineTo(0, 0);
            break;
        case 'tr':
            cr.arc(0, r, r, 3 * Math.PI / 2, 2 * Math.PI);
            cr.lineTo(r, 0);
            break;
        case 'bl':
            cr.arc(r, 0, r, Math.PI / 2, Math.PI);
            cr.lineTo(0, r);
            break;
        case 'br':
            cr.arc(0, 0, r, 0, Math.PI / 2);
            cr.lineTo(r, r);
            break;
        }
        cr.closePath();

        cr.setSourceRGBA(this._r ?? 0, this._g ?? 0, this._b ?? 0, this._a ?? 1);
        cr.fill();
        cr.$dispose();
    }
});

/**
 * Manages hover animations (SIMPLE/RIPPLE/PLANK) and taskbar corner radius
 * actors for the desktop taskbar.
 */
export class TaskbarAnimations {
    /**
     * @param {Object} taskbar - Parent Taskbar instance
     * @param {Object} controller - Extension controller
     * @param {Object} settings - GSettings instance
     */
    constructor(taskbar, controller, settings) {
        this._taskbar = taskbar;
        this._controller = controller;
        this._settings = settings ?? null;
        this._logger = new Logger('TaskbarAnimations', this._settings);

        this._taskbarCorners = null;
        this._hoverAnimClickCooldownUntil = 0;
    }

    /**
     * Read hover animation settings from GSettings.
     * @returns {Object|null} Settings object or null if disabled
     */
    getHoverAnimSettings() {
        let s = this._settings;
        if (!s || !s.get_boolean('taskbar-animate-hover'))
            return null;

        let dc = this._controller?.displayConfig;
        if (dc) {
            if (dc.isSmallDisplay) return null;
            let mode = dc.activeInputMode;
            if (mode === 'touch' || mode === 'Touch') return null;
        }

        return {
            type: s.get_string('taskbar-hover-animation-type'),
            duration: Math.max(0, s.get_int('taskbar-hover-animation-duration')),
            rotation: s.get_int('taskbar-hover-animation-rotation'),
            travel: Math.max(-1, s.get_double('taskbar-hover-animation-travel')),
            zoom: Math.max(0.5, s.get_double('taskbar-hover-animation-zoom')),
            convexity: Math.max(0, s.get_double('taskbar-hover-animation-convexity')),
            extent: Math.max(1, s.get_int('taskbar-hover-animation-extent')),
        };
    }

    /**
     * Create a raised clone of a button's icon for hover animation.
     * @param {St.Button} button
     * @private
     */
    _createHoverClone(button) {
        if (button._convergenceRaisedClone) return;
        let icon = button._convergenceIcon ?? button.child?.get_first_child?.();
        if (!icon) return;

        let app = button._convergenceApp;
        let settings = this.getHoverAnimSettings();
        let maxZoom = settings?.zoom ?? 1.3;

        let baseSize = icon.icon_size ?? icon.width;
        let hiResSize = Math.ceil(baseSize * maxZoom);
        let clone;
        if (app && hiResSize > baseSize) {
            clone = app.create_icon_texture(hiResSize);
            clone.set({ reactive: false, width: baseSize, height: baseSize });
        } else {
            clone = new Clutter.Clone({ source: icon, reactive: false });
        }
        clone.set_pivot_point(0.5, 0.5);

        let [width, height] = button.get_transformed_size();
        let container = new St.Bin({
            child: clone,
            width,
            height,
            reactive: false,
        });

        let [stageX, stageY] = button.get_transformed_position();
        container.set_position(
            stageX - (button.translation_x || 0),
            stageY - (button.translation_y || 0));

        icon.opacity = 0;
        Main.uiGroup.add_child(container);
        button._convergenceRaisedClone = clone;
        button._convergenceRaisedCloneContainer = container;
        button._convergenceRaisedOrigIcon = icon;
    }

    /**
     * Destroy the raised clone for a button.
     * @param {St.Button} button
     */
    destroyHoverClone(button) {
        let clone = button._convergenceRaisedClone;
        if (!clone) return;
        let icon = button._convergenceRaisedOrigIcon ?? clone.source;
        let container = button._convergenceRaisedCloneContainer;

        clone.remove_all_transitions();
        if (icon && !icon.is_destroyed?.()) icon.opacity = 255;
        if (container && !container.is_destroyed?.()) container.destroy();
        delete button._convergenceRaisedClone;
        delete button._convergenceRaisedCloneContainer;
        delete button._convergenceRaisedOrigIcon;
    }

    /**
     * Animate a clone to a given raise level (0 = resting, 1 = fully raised).
     * @param {St.Button} button
     * @param {number} level
     * @param {Object} settings
     */
    hoverAnimRaise(button, level, settings) {
        if (!settings) return;
        let clone = button._convergenceRaisedClone;

        if (level <= 0 && !clone) return;

        if (level > 0 && !clone) {
            if (this._hoverAnimClickCooldownUntil &&
                GLib.get_monotonic_time() / 1000 < this._hoverAnimClickCooldownUntil)
                return;
            this._createHoverClone(button);
            clone = button._convergenceRaisedClone;
            if (!clone) return;
        }

        clone.remove_all_transitions();

        let vertical = this._taskbar.isSideTaskbarLayout();
        let duration = settings.duration;
        let rotation = settings.rotation;
        let travel = settings.travel;
        let zoom = settings.zoom;

        let translationDirection = vertical ? 1 : -1;

        let row = button.get_parent();
        let items = row ? row.get_children().filter(c => c instanceof St.Button) : [];
        let index = items.indexOf(button);
        let rotationDirection = items.length > 1
            ? (index - (items.length - 1) / 2) / ((items.length - 1) / 2)
            : 0;

        let origIcon = button._convergenceRaisedOrigIcon ?? clone.source;
        let [width, height] = origIcon?.get_transformed_size?.() ?? [0, 0];
        if (!width && !height)
            [width, height] = button.get_transformed_size();

        let travelSign = travel >= 0 ? 1 : -1;
        let absTrav = Math.abs(travel);
        let translationMax = absTrav < 0.001 ? 0
            : (vertical ? width : height) * (absTrav + (zoom - 1) / 2);
        let translationEnd = translationMax * level;
        let translationProp = vertical ? 'translation_x' : 'translation_y';
        let translationDone = clone[translationProp] || 0;
        let translationTodo = Math.abs(translationEnd - Math.abs(translationDone));
        let scale = 1 + (zoom - 1) * level;
        let rotAngle = rotationDirection * rotation * level;
        let time = translationMax > 0
            ? Math.abs((duration * translationTodo) / translationMax)
            : duration;

        let params = {
            scale_x: scale,
            scale_y: scale,
            rotation_angle_z: rotAngle,
            duration: Math.round(time),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (level <= 0) {
                    if (settings.type !== 'SIMPLE') {
                        let parentRow = button.get_parent();
                        if (parentRow?.hover) return;
                    }
                    this.destroyHoverClone(button);
                }
            },
        };
        params[translationProp] = translationDirection * travelSign * translationEnd;
        clone.ease(params);
    }

    /**
     * Translate a button itself (PLANK stretch effect).
     * @param {St.Button} button
     * @param {number} translation
     * @param {Object} settings
     */
    hoverAnimStretch(button, translation, settings) {
        if (!settings) return;
        let prop = this._taskbar.isSideTaskbarLayout() ? 'translation_y' : 'translation_x';
        button.remove_all_transitions();
        button.ease({
            [prop]: settings.zoom * translation,
            duration: settings.duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Update all icons in a taskbar row based on pointer position (RIPPLE/PLANK).
     * @param {St.BoxLayout} row
     * @param {number} pointerX
     * @param {number} pointerY
     */
    hoverAnimUpdateRow(row, pointerX, pointerY) {
        let settings = this.getHoverAnimSettings();
        if (!settings) return;
        let vertical = this._taskbar.isSideTaskbarLayout();

        if (!pointerX || !pointerY)
            [pointerX, pointerY] = global.get_pointer();

        let children = row.get_children().filter(
            c => c instanceof St.Button && c._convergenceApp);
        for (let button of children) {
            let [x, y] = button.get_transformed_position();
            let [width, height] = button.get_transformed_size();
            let centerX = x + width / 2;
            let centerY = y + height / 2;
            let size = vertical ? height : width;
            let difference = vertical ? pointerY - centerY : pointerX - centerX;
            let distance = Math.abs(difference);
            let maxDistance = (settings.extent / 2) * size;

            if (settings.type === 'PLANK') {
                let translation = distance <= maxDistance
                    ? distance / (2 + (8 * distance) / maxDistance)
                    : maxDistance / 10;
                if (difference > 0) translation *= -1;
                this.hoverAnimStretch(button, translation, settings);
            }

            if (distance <= maxDistance) {
                let level = (maxDistance - distance) / maxDistance;
                level = Math.pow(level, settings.convexity);
                this.hoverAnimRaise(button, level, settings);
            } else {
                this.hoverAnimRaise(button, 0, settings);
            }
        }
    }

    /**
     * Drop all hover animations on a row (reset to resting state).
     * @param {St.BoxLayout} row
     */
    hoverAnimDropRow(row) {
        let settings = this.getHoverAnimSettings();
        let children = row.get_children().filter(
            c => c instanceof St.Button && c._convergenceApp);
        for (let button of children) {
            this.hoverAnimRaise(button, 0, settings ?? {
                type: 'SIMPLE', duration: 120, rotation: 0,
                travel: 0, zoom: 1, convexity: 1, extent: 4,
            });
            if (button.translation_x || button.translation_y) {
                button.remove_all_transitions();
                button.ease({
                    translation_x: 0, translation_y: 0,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }

    /**
     * Wire hover animation event handlers onto a taskbar row.
     * @param {St.BoxLayout} row
     */
    connectRow(row) {
        row.reactive = true;
        row.track_hover = true;

        let motionId = row.connect('motion-event', (_actor, event) => {
            let settings = this.getHoverAnimSettings();
            if (!settings) return Clutter.EVENT_PROPAGATE;
            if (settings.type === 'RIPPLE' || settings.type === 'PLANK') {
                let [px, py] = event.get_coords();
                this.hoverAnimUpdateRow(row, px, py);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        let leaveId = row.connect('leave-event', () => {
            let settings = this.getHoverAnimSettings();
            if (!settings) return Clutter.EVENT_PROPAGATE;
            let [stageX, stageY] = global.get_pointer();
            let [ok, x, y] = row.transform_stage_point(stageX, stageY);
            if (ok && row.allocation.contains(x, y))
                return Clutter.EVENT_PROPAGATE;
            if (settings.type === 'RIPPLE' || settings.type === 'PLANK')
                this.hoverAnimDropRow(row);
            return Clutter.EVENT_PROPAGATE;
        });

        row._convergenceHoverAnimSignals = [motionId, leaveId];
    }

    /**
     * Disconnect hover animation handlers from a taskbar row.
     * @param {St.BoxLayout} row
     */
    disconnectRow(row) {
        if (!row._convergenceHoverAnimSignals) return;
        for (let id of row._convergenceHoverAnimSignals)
            row.disconnect(id);
        delete row._convergenceHoverAnimSignals;
        this.hoverAnimDropRow(row);
    }

    /**
     * Wire per-button hover handlers (SIMPLE mode enter/leave).
     * @param {St.Button} button
     */
    connectButton(button) {
        let enterId = button.connect('enter-event', () => {
            let settings = this.getHoverAnimSettings();
            if (!settings) return Clutter.EVENT_PROPAGATE;
            if (settings.type === 'SIMPLE')
                this.hoverAnimRaise(button, 1, settings);
            return Clutter.EVENT_PROPAGATE;
        });

        let leaveId = button.connect('leave-event', () => {
            let settings = this.getHoverAnimSettings();
            if (!settings) return Clutter.EVENT_PROPAGATE;
            if (settings.type === 'SIMPLE')
                this.hoverAnimRaise(button, 0, settings);
            return Clutter.EVENT_PROPAGATE;
        });

        button._convergenceHoverAnimSignals = [enterId, leaveId];
    }

    /**
     * Immediately destroy all hover clones in a row (synchronous cleanup).
     * @param {St.BoxLayout} row
     */
    immediateCleanupRow(row) {
        if (!row) return;
        for (let child of row.get_children()) {
            if (child._convergenceRaisedClone)
                this.destroyHoverClone(child);
        }
    }

    /**
     * Sync taskbar corner actors (concave wedge corners at taskbar edges).
     */
    syncTaskbarCorners() {
        let sideTaskbar = this._taskbar.isSideTaskbarLayout();
        let taskbar = this._taskbar.isTaskbarMode();

        if (!taskbar) {
            this.removeTaskbarCorners();
            return;
        }
        if (this._taskbar._fullscreenHidden) {
            this.removeTaskbarCorners();
            return;
        }
        if (!this._taskbar._actor?.visible) {
            this.removeTaskbarCorners();
            return;
        }

        let monitor = this._taskbar.getTaskbarAnchorMonitor();
        if (!monitor) {
            this.removeTaskbarCorners();
            return;
        }

        let radius = 0;
        try {
            radius = this._settings?.get_int('window-corner-radius') ?? 0;
        } catch (_e) {}
        if (radius <= 0) {
            this.removeTaskbarCorners();
            return;
        }

        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let r = Math.round(radius * scale);
        let panelH = Main.panel?.visible ? (Main.panel.height || 0) : 0;

        if (!this._taskbarCorners)
            this._taskbarCorners = {};
        let corners = this._taskbarCorners;

        let ensureCorner = (key, hSide, vSide, alpha) => {
            if (!corners[key]) {
                corners[key] = new TaskbarCornerActor(hSide, vSide);
                Main.layoutManager.uiGroup.add_child(corners[key]);
            }
            corners[key]._hSide = hSide;
            corners[key]._vSide = vSide;
            corners[key].setCornerParams(r, 0, 0, 0, alpha);
            return corners[key];
        };

        let remove = (key) => {
            if (corners[key]) {
                corners[key].get_parent()?.remove_child(corners[key]);
                corners[key].destroy();
                corners[key] = null;
            }
        };

        let bgAlpha = this._taskbar._dynamicOpacityAlpha ??
            this._taskbar._readTaskbarBackgroundOpacity();
        let overlayAlpha = Math.max(0.08, bgAlpha * 0.25);
        let combinedAlpha = bgAlpha + overlayAlpha * (1 - bgAlpha);

        let taskbarPos = this._taskbar._readTaskbarPosition();
        let taskbarRect = this._taskbar.getTaskbarRect();
        if (!taskbarRect) {
            this.removeTaskbarCorners();
            return;
        }
        let taskbarW = taskbarRect.width;

        if (sideTaskbar) {
            let top = ensureCorner('top', taskbarPos, 'top', combinedAlpha);
            if (taskbarPos === 'left')
                top.set_position(monitor.x + taskbarW, monitor.y + panelH);
            else
                top.set_position(monitor.x + monitor.width - taskbarW - r, monitor.y + panelH);

            let bottom = ensureCorner('bottom', taskbarPos, 'bottom', combinedAlpha);
            if (taskbarPos === 'left')
                bottom.set_position(monitor.x + taskbarW, monitor.y + monitor.height - r);
            else
                bottom.set_position(monitor.x + monitor.width - taskbarW - r,
                    monitor.y + monitor.height - r);

            // Panel far corner (opposite side of panel from taskbar)
            let farSide = taskbarPos === 'left' ? 'right' : 'left';
            let panelFar = ensureCorner('panelFar', farSide, 'top', combinedAlpha);
            if (farSide === 'right')
                panelFar.set_position(monitor.x + monitor.width - r, monitor.y + panelH);
            else
                panelFar.set_position(monitor.x, monitor.y + panelH);

            remove('bottomLeft');
            remove('bottomRight');
            remove('panelLeft');
            remove('panelRight');
        } else {
            let bl = ensureCorner('bottomLeft', 'left', 'bottom', combinedAlpha);
            bl.set_position(monitor.x, taskbarRect.y - r);

            let br = ensureCorner('bottomRight', 'right', 'bottom', combinedAlpha);
            br.set_position(monitor.x + monitor.width - r, taskbarRect.y - r);

            // Panel far corners (where panel meets desktop on left and right)
            if (panelH > 0) {
                let panelLeft = ensureCorner('panelLeft', 'left', 'top', combinedAlpha);
                panelLeft.set_position(monitor.x, monitor.y + panelH);

                let panelRight = ensureCorner('panelRight', 'right', 'top', combinedAlpha);
                panelRight.set_position(monitor.x + monitor.width - r, monitor.y + panelH);
            } else {
                remove('panelLeft');
                remove('panelRight');
            }

            remove('top');
            remove('bottom');
            remove('panelFar');
        }

        let screenDefs = [
            { key: 'screenTL', type: 'tl', x: monitor.x, y: monitor.y },
            { key: 'screenTR', type: 'tr',
                x: monitor.x + monitor.width - r, y: monitor.y },
            { key: 'screenBL', type: 'bl',
                x: monitor.x, y: monitor.y + monitor.height - r },
            { key: 'screenBR', type: 'br',
                x: monitor.x + monitor.width - r, y: monitor.y + monitor.height - r },
        ];
        for (let def of screenDefs) {
            if (!corners[def.key]) {
                corners[def.key] = new ScreenCornerActor(def.type);
                Main.layoutManager.uiGroup.add_child(corners[def.key]);
            }
            corners[def.key].setCornerParams(r, 0, 0, 0, 1);
            corners[def.key].set_position(def.x, def.y);
        }
    }

    /**
     * Remove all taskbar corner actors.
     */
    removeTaskbarCorners() {
        if (!this._taskbarCorners) return;
        let allKeys = ['top', 'bottom', 'panelFar',
            'panelLeft', 'panelRight',
            'bottomLeft', 'bottomRight',
            'screenTL', 'screenTR', 'screenBL', 'screenBR',
            'appGridHot'];
        for (let key of allKeys) {
            let actor = this._taskbarCorners[key];
            if (actor) {
                if (actor._isChrome)
                    Main.layoutManager.removeChrome(actor);
                else
                    actor.get_parent()?.remove_child(actor);
                actor.destroy();
            }
        }
        this._taskbarCorners = null;
    }

    /**
     * Clean up all resources.
     */
    destroy() {
        this.removeTaskbarCorners();
        this._logger?.destroy?.();
    }
}
