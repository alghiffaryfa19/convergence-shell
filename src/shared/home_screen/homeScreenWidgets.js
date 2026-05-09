// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { WIDGET_CATALOG, getWidgetSizeLimits, buildWidgetPreview } from './widgets/widgetCatalog.js';
import { createWidgetInstance, getWidgetDefinition } from './widgets/widgetFramework.js';
import { ensureWidgetInstanceId } from './widgets/widgetInstanceStore.js';
import { addClickCursor, createLongPressController, getAdaptiveScale } from '../utilities/uiUtils.js';
/**
 * Widget actor creation, click handlers, widget menus, resize mode,
 * and widget picker for the home screen.
 */
export class HomeScreenWidgets {
    /**
     * @param {object} homeScreen - The HomeScreen instance.
     */
    constructor(homeScreen) {
        this._home = homeScreen;
    }

    /**
     * Create a widget button for the home grid.
     * @param {object} item - Widget grid item.
     * @returns {St.Button}
     */
    createWidgetActor(item) {
        let h = this._home;
        let colSpan = item.colSpan || 1;
        let rowSpan = item.rowSpan || 1;
        let w = colSpan * h._cellW + (colSpan - 1) * h._colSpacing;
        let hh = rowSpan * h._cellH + (rowSpan - 1) * h._rowSpacing;
        let def = getWidgetDefinition(item.widgetType, { allowMissing: true });
        let runtimeEnv = {
            Gio,
            GLib,
            Clutter,
            St,
            Shell,
            Main,
            PopupMenu,
        };

        let instance = createWidgetInstance(item.widgetType, h._settings, item, runtimeEnv);
        let content;
        if (instance) {
            content = instance.buildContent(w, hh, colSpan, rowSpan, h._getHomeMonitor(), this.gridMetrics(), runtimeEnv);
            if (instance.onSave)
                instance.onSave(() => h._saveHomeLayout?.());
            h._widgetInstances.set(item, instance);
        } else {
            content = new St.Widget({ width: w, height: hh });
        }

        let widgetTypeClass = item.widgetType
            ? `convergence-widget-type-${item.widgetType.replace(/_/g, '-')}`
            : '';
        let button = new St.Button({
            child: content,
            width: w, height: hh,
            style_class: `convergence-widget-container ${widgetTypeClass}`.trim(),
            style: 'padding: 0; margin: 0;',
        });
        addClickCursor(button, h._runtimeDisposer);

        let lpFired = false;
        let lpController = createLongPressController(500, (x, y) => {
            lpFired = true;
            h._beginHomeDndReady(button, item, null, x, y);
        });

        let startLp = (x, y) => { lpFired = false; h._cancelHomeDndMenuTimer(); lpController.start(x, y); };
        let cancelLp = () => { lpController.cancel(); h._cancelHomeDndMenuTimer(); h._setHomeDndReadyVisual(button, false); };
        let markLongPressFired = () => { lpFired = true; };
        let touchStartX = 0, touchStartY = 0, touchTracking = false;
        let touchCancelDist = Math.max(10, Math.round(12 * (h._scale ?? 1)));
        let touchCancelDistSq = touchCancelDist * touchCancelDist;
        let isIconWidget = def?.interactionStyle === 'icon';
        let lastInputWasTouch = false;
        let lastClickTime = 0;

        if (isIconWidget) {
            button.connect('notify::hover', () => {
                if (lastInputWasTouch) return;
                if (button.hover) content.add_style_pseudo_class?.('hover');
                else content.remove_style_pseudo_class?.('hover');
            });
        }

        if (def?.handleCapturedEvent) {
            button.connect('captured-event', (_actor, event) => {
                return def.handleCapturedEvent({
                    event,
                    home: h,
                    button,
                    item,
                    instance,
                    ops: {
                        cancelLongPress: cancelLp,
                        markLongPressFired,
                        showDefaultWidgetMenu: (anchor, widgetItem, ex, ey) =>
                            this.showWidgetMenu(anchor, widgetItem, ex, ey),
                    },
                    runtimeEnv,
                });
            });
        }

        button.connect('button-press-event', (_actor, event) => {
            if (h._widgetResizeActive && h._widgetResizeBtn === button) return Clutter.EVENT_STOP;
            lastInputWasTouch = false;
            let btn = event.get_button ? event.get_button() : 0;
            if (btn === Clutter.BUTTON_SECONDARY) {
                cancelLp(); lpFired = true;
                let [ex, ey] = event.get_coords();
                if (def?.handleSecondaryButtonPress?.({
                    event,
                    home: h,
                    button,
                    item,
                    instance,
                    ops: {
                        cancelLongPress: cancelLp,
                        markLongPressFired,
                    },
                    runtimeEnv,
                }))
                    return Clutter.EVENT_STOP;
                this.showWidgetMenu(button, item, ex, ey);
                return Clutter.EVENT_STOP;
            }
            content.add_style_pseudo_class?.('active');
            let [x, y] = event.get_coords();
            startLp(x, y);
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            if (h._widgetResizeActive && h._widgetResizeBtn === button) return Clutter.EVENT_STOP;
            content.remove_style_pseudo_class?.('active');
            cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('touch-event', (_actor, event) => {
            if (h._widgetResizeActive && h._widgetResizeBtn === button) return Clutter.EVENT_STOP;
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                lastInputWasTouch = true;
                if (def?.shouldBypassTouchLongPress?.({
                    event,
                    home: h,
                    button,
                    item,
                    instance,
                    runtimeEnv,
                }))
                    return Clutter.EVENT_PROPAGATE;
                content.add_style_pseudo_class?.('active');
                let [x, y] = event.get_coords();
                touchStartX = x; touchStartY = y; touchTracking = true;
                startLp(x, y);
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (touchTracking && !lpFired && !h._homeDndActive && !h._homeDndReady) {
                    let [x, y] = event.get_coords();
                    let dx = x - touchStartX, dy = y - touchStartY;
                    if (dx * dx + dy * dy >= touchCancelDistSq) {
                        content.remove_style_pseudo_class?.('active');
                        cancelLp(); touchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END) {
                content.remove_style_pseudo_class?.('active');
                content.remove_style_pseudo_class?.('hover');
                touchTracking = false; cancelLp();
            } else if (type === Clutter.EventType.TOUCH_CANCEL) {
                content.remove_style_pseudo_class?.('active');
                content.remove_style_pseudo_class?.('hover');
                touchTracking = false; cancelLp(); lpFired = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('leave-event', (_actor, event) => {
            if (h._widgetResizeActive && h._widgetResizeBtn === button) return Clutter.EVENT_STOP;
            let source = event.get_source_device();
            if (source && source.get_device_type() !== Clutter.InputDeviceType.TOUCHSCREEN_DEVICE) {
                content.remove_style_pseudo_class?.('active');
                cancelLp();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', () => {
            if (h._widgetResizeActive && h._widgetResizeBtn === button) return;
            cancelLp();
            if (lpFired) return;
            if (h._homeDndReady) { h._resetHomeDndReadyState(); lpFired = true; return; }
            if (isIconWidget) {
                if (lastInputWasTouch) { h._deselectFileIcon(); this.onWidgetClicked(item, def, instance, runtimeEnv); lpFired = true; return; }
                let now = GLib.get_monotonic_time() / 1000;
                if (now - lastClickTime < 400) { lastClickTime = 0; h._deselectFileIcon(); this.onWidgetClicked(item, def, instance, runtimeEnv); lpFired = true; }
                else { lastClickTime = now; h._selectFileIcon(item, content); }
            } else { this.onWidgetClicked(item, def, instance, runtimeEnv); lpFired = true; }
        });
        def?.bindActor?.({
            home: h,
            button,
            content,
            item,
            instance,
            ops: {
                cancelLongPress: cancelLp,
                markLongPressFired,
                showDefaultWidgetMenu: (anchor, widgetItem, ex, ey) =>
                    this.showWidgetMenu(anchor, widgetItem, ex, ey),
            },
            runtimeEnv,
        });

        return button;
    }

    /** Handle click on a widget. */
    onWidgetClicked(item, def = null, instance = null, runtimeEnv = null) {
        let h = this._home;
        if (def?.onActivate?.({ home: h, item, instance, runtimeEnv })) {
            return;
        }
    }

    openWidgetSettings(widgetItem) {
        let h = this._home;
        if (!widgetItem?.instanceId)
            return false;

        try {
            if (h._settings?.settings_schema?.has_key?.('prefs-open-page'))
                h._settings.set_string('prefs-open-page', `widget:${widgetItem.instanceId}`);
        } catch (_error) {}

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                Main.extensionManager?.openExtensionPrefs?.('convergence@daniel-blandford.github.io', '', {});
                return GLib.SOURCE_REMOVE;
            } catch (_error) {}

            try {
                GLib.spawn_command_line_async('gnome-extensions prefs convergence@daniel-blandford.github.io');
            } catch (_error) {}
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    /** Show the widget context menu. */
    showWidgetMenu(anchor, widgetItem, x, y) {
        let h = this._home;
        let def = getWidgetDefinition(widgetItem.widgetType, { allowMissing: true });
        let instance = h._widgetInstances?.get(widgetItem) ?? null;
        let populate = menu => {
            def?.populateWidgetMenu?.({
                home: h,
                menu,
                anchor,
                item: widgetItem,
                instance,
                runtimeEnv: { Gio, GLib, Clutter, St, Shell, Main, PopupMenu },
                addMenuItem: (targetMenu, label, cb) => h._addHomeNativeMenuItem(targetMenu, label, cb),
            });
            if (def?.buildInstanceSettings && widgetItem?.instanceId)
                h._addHomeNativeMenuItem(menu, 'Settings', () => this.openWidgetSettings(widgetItem));
            if (def?.supportsResize !== false) {
                h._addHomeNativeMenuItem(menu, 'Resize', () => this.enterWidgetResizeMode(anchor, widgetItem));
            }
            h._addHomeNativeMenuItem(menu, 'Remove', () => h._removeHomeIcon(widgetItem));
        };
        if (x != null && y != null)
            h._showHomeNativeMenuAtPoint(x, y, populate);
        else
            h._showHomeNativeMenu(anchor, populate);
    }

    /** Enter the Android-style widget resize mode. */
    enterWidgetResizeMode(button, item) {
        let h = this._home;
        if (h._widgetResizeActive)
            this.exitWidgetResizeMode();

        h._widgetResizeActive = true;
        h._widgetResizeItem = item;
        h._widgetResizeBtn = button;
        h._widgetResizeEdge = null;
        h._widgetResizeLastFinishTime = 0;

        h._homeGridRows = h._computeGridRows();
        if (!h._springLoaded)
            h.enterSpringLoaded();

        let colSpan = item.colSpan || 1;
        let rowSpan = item.rowSpan || 1;
        let w = colSpan * h._cellW + (colSpan - 1) * h._colSpacing;
        let hh = rowSpan * h._cellH + (rowSpan - 1) * h._rowSpacing;

        let overlay = new St.Widget({
            reactive: true,
            layout_manager: new Clutter.FixedLayout(),
            width: w, height: hh,
        });

        overlay.add_child(new St.Widget({
            style_class: 'convergence-widget-resize-outline',
            width: w, height: hh,
        }));

        let touchSize = 48;
        let visualSize = 24;
        let touchOffset = (touchSize - visualSize) / 2;
        let handles = [
            { edge: 'left',   x: -touchSize / 2,       y: hh / 2 - touchSize / 2 },
            { edge: 'right',  x: w - touchSize / 2,     y: hh / 2 - touchSize / 2 },
            { edge: 'top',    x: w / 2 - touchSize / 2, y: -touchSize / 2 },
            { edge: 'bottom', x: w / 2 - touchSize / 2, y: hh - touchSize / 2 },
        ];

        for (let { edge, x, y } of handles) {
            let handle = new St.Button({
                reactive: true, width: touchSize, height: touchSize,
                style: 'background-color: transparent; border: none; padding: 0;',
            });
            let dot = new St.Widget({
                style_class: 'convergence-widget-resize-handle',
                width: visualSize, height: visualSize,
            });
            dot.set_position(touchOffset, touchOffset);
            handle.add_child(dot);
            handle._resizeEdge = edge;
            handle.set_position(x, y);

            handle.connect('button-press-event', (_actor, event) => {
                let [ex, ey] = event.get_coords();
                this._startWidgetResize(edge, ex, ey);
                return Clutter.EVENT_STOP;
            });
            handle.connect('touch-event', (_actor, event) => {
                if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                    let [ex, ey] = event.get_coords();
                    this._startWidgetResize(edge, ex, ey);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            overlay.add_child(handle);
        }

        h._widgetResizeOverlay = overlay;
        button.add_child(overlay);

        h._widgetResizeCaptureId = h._runtimeDisposer.connect(global.stage, 'captured-event',
            (_a, event) => this._onWidgetResizeCaptured(event));
    }

    _onWidgetResizeCaptured(event) {
        let h = this._home;
        let type = event.type();

        if (h._widgetResizeEdge) {
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                let [x, y] = event.get_coords();
                this._updateWidgetResize(x, y);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE ||
                type === Clutter.EventType.TOUCH_END ||
                type === Clutter.EventType.TOUCH_CANCEL) {
                let [x, y] = event.get_coords();
                this._finishWidgetResize(x, y);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            let [ex, ey] = event.get_coords();
            if (h._widgetResizeBtn) {
                let [bx, by] = h._widgetResizeBtn.get_transformed_position();
                let bw = h._widgetResizeBtn.get_width();
                let bh = h._widgetResizeBtn.get_height();
                if (ex >= bx - 24 && ex <= bx + bw + 24 && ey >= by - 24 && ey <= by + bh + 24)
                    return Clutter.EVENT_PROPAGATE;
            }
            this.exitWidgetResizeMode();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _startWidgetResize(edge, x, y) {
        let h = this._home;
        let item = h._widgetResizeItem;
        if (!item) return;
        h._widgetResizeEdge = edge;
        h._widgetResizeStartX = x;
        h._widgetResizeStartY = y;
        h._widgetResizeOrigCol = item.col;
        h._widgetResizeOrigRow = item.row;
        h._widgetResizeOrigColSpan = item.colSpan || 1;
        h._widgetResizeOrigRowSpan = item.rowSpan || 1;
    }

    _updateWidgetResize(x, y) {
        let h = this._home;
        let item = h._widgetResizeItem;
        if (!item || !h._widgetResizeEdge) return;

        let edge = h._widgetResizeEdge;
        let cellW = h._cellW + h._colSpacing;
        let cellH = h._cellH + h._rowSpacing;
        let cellDeltaX = Math.round((x - h._widgetResizeStartX) / cellW);
        let cellDeltaY = Math.round((y - h._widgetResizeStartY) / cellH);
        let limits = getWidgetSizeLimits(item.widgetType, h._homeCols);
        let maxRows = h._homeGridRows || h._computeGridRows();

        let newCol = h._widgetResizeOrigCol;
        let newRow = h._widgetResizeOrigRow;
        let newColSpan = h._widgetResizeOrigColSpan;
        let newRowSpan = h._widgetResizeOrigRowSpan;

        if (edge === 'right') newColSpan += cellDeltaX;
        else if (edge === 'left') { newColSpan -= cellDeltaX; newCol += cellDeltaX; }
        else if (edge === 'bottom') newRowSpan += cellDeltaY;
        else if (edge === 'top') { newRowSpan -= cellDeltaY; newRow += cellDeltaY; }

        newColSpan = Math.max(limits.minColSpan, Math.min(limits.maxColSpan, newColSpan));
        newRowSpan = Math.max(limits.minRowSpan, Math.min(limits.maxRowSpan, newRowSpan));
        newCol = Math.max(0, newCol);
        newRow = Math.max(0, newRow);
        if (newCol + newColSpan > h._homeCols) newCol = h._homeCols - newColSpan;
        if (newRow + newRowSpan > maxRows) newRow = maxRows - newRowSpan;

        if (edge === 'left') newCol = Math.max(0, h._widgetResizeOrigCol + h._widgetResizeOrigColSpan - newColSpan);
        if (edge === 'top') newRow = Math.max(0, h._widgetResizeOrigRow + h._widgetResizeOrigRowSpan - newRowSpan);

        if (!h._canPlaceWidget(newCol, newRow, newColSpan, newRowSpan, item)) return;
        if (newCol === item.col && newRow === item.row &&
            newColSpan === (item.colSpan || 1) && newRowSpan === (item.rowSpan || 1)) return;

        item.col = newCol; item.row = newRow;
        item.colSpan = newColSpan; item.rowSpan = newRowSpan;

        let btn = h._widgetResizeBtn;
        if (btn) {
            let w = newColSpan * h._cellW + (newColSpan - 1) * h._colSpacing;
            let hh = newRowSpan * h._cellH + (newRowSpan - 1) * h._rowSpacing;
            btn.set_size(w, hh);
            btn.set_position(
                newCol * (h._cellW + h._colSpacing),
                newRow * (h._cellH + h._rowSpacing));
            this._updateResizeOverlay(w, hh);
        }

        h._clearCellHighlight();
        h._reflowIconsForWidget(newCol, newRow, newColSpan, newRowSpan);
    }

    _updateResizeOverlay(w, hh) {
        let overlay = this._home._widgetResizeOverlay;
        if (!overlay) return;
        overlay.set_size(w, hh);
        let touchSize = 48;
        for (let child of overlay.get_children()) {
            if (child.style_class === 'convergence-widget-resize-outline') child.set_size(w, hh);
            else if (child._resizeEdge) {
                switch (child._resizeEdge) {
                    case 'left': child.set_position(-touchSize / 2, hh / 2 - touchSize / 2); break;
                    case 'right': child.set_position(w - touchSize / 2, hh / 2 - touchSize / 2); break;
                    case 'top': child.set_position(w / 2 - touchSize / 2, -touchSize / 2); break;
                    case 'bottom': child.set_position(w / 2 - touchSize / 2, hh - touchSize / 2); break;
                }
            }
        }
    }

    _finishWidgetResize(x, y) {
        let h = this._home;
        if (!h._widgetResizeItem || !h._widgetResizeEdge) { h._widgetResizeEdge = null; return; }

        for (let [displacedItem, pos] of h._widgetDisplacedPositions) {
            displacedItem.col = pos.col; displacedItem.row = pos.row;
        }
        h._widgetDisplacedPositions.clear();
        h._widgetResizeEdge = null;
        h._widgetResizeLastFinishTime = GLib.get_monotonic_time() / 1000;
        h._widgetResizeLastFinishX = x;
        h._widgetResizeLastFinishY = y;
        h._clearCellHighlight();
        h._markManualHomeCellEdit();
        h._saveHomeLayout();
    }

    /** Exit widget resize mode. */
    exitWidgetResizeMode() {
        let h = this._home;
        if (h._widgetResizeCaptureId) {
            h._runtimeDisposer.untrackConnection(global.stage, h._widgetResizeCaptureId);
            global.stage.disconnect(h._widgetResizeCaptureId);
            h._widgetResizeCaptureId = 0;
        }
        if (h._widgetResizeOverlay) {
            if (h._widgetResizeOverlay.get_parent())
                h._widgetResizeOverlay.get_parent().remove_child(h._widgetResizeOverlay);
            h._widgetResizeOverlay.destroy();
            h._widgetResizeOverlay = null;
        }
        h._widgetResizeActive = false;
        h._widgetResizeItem = null;
        h._widgetResizeBtn = null;
        h._widgetResizeEdge = null;
        h._widgetDisplacedPositions.clear();
        if (h._springLoaded) h.exitSpringLoaded();
        else h._renderHomeGrid();
    }

    /** Open the widget picker bottom sheet. */
    openWidgetPicker() {
        let h = this._home;
        this.closeWidgetPicker();

        let monitor = h._getHomeMonitor();
        let originX = monitor?.x ?? 0;
        let originY = monitor?.y ?? 0;
        let screenW = monitor?.width ?? global.stage.width;
        let screenH = monitor?.height ?? global.stage.height;
        let sheetH = Math.round(screenH * 0.55);

        let popup = new St.Widget({
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            style_class: 'convergence-widget-picker',
        });

        popup.add_child(new St.Widget({ x_expand: true, y_expand: true, reactive: false, style_class: 'convergence-widget-picker-glass' }));
        popup.add_child(new St.Widget({ x_expand: true, y_expand: true, reactive: false, style_class: 'convergence-widget-picker-tint' }));

        let content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true });
        popup.add_child(content);

        let sheetHeader = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, reactive: true });
        content.add_child(sheetHeader);
        sheetHeader.add_child(new St.Widget({ style_class: 'convergence-widget-picker-handle', x_align: Clutter.ActorAlign.CENTER }));
        sheetHeader.add_child(new St.Label({ text: 'Widgets', style_class: 'convergence-widget-picker-title', x_align: Clutter.ActorAlign.CENTER, style: 'margin-bottom: 16px;' }));

        // Pull-to-dismiss from the header pill area
        let headerTouchY = 0, headerDrag = 0, headerTouching = false;
        const HEADER_DISMISS_THRESHOLD = sheetH * 0.25;
        sheetHeader.connect('captured-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                headerTouching = true;
                headerDrag = 0;
                headerTouchY = event.get_coords()[1];
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                headerTouching = false;
                if (headerDrag > HEADER_DISMISS_THRESHOLD) {
                    this.closeWidgetPicker();
                } else {
                    popup.remove_all_transitions();
                    popup.ease({ y: popup._convergenceOpenY, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                    headerDrag = 0;
                }
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.TOUCH_UPDATE && headerTouching) {
                let [, ey] = event.get_coords();
                let dy = ey - headerTouchY;
                headerTouchY = ey;
                headerDrag += dy;
                headerDrag = Math.max(0, headerDrag);
                popup.y = popup._convergenceOpenY + headerDrag * 0.6;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Plain clipped container — avoids St.ScrollView's persistent
        // scrollbar and broken touch handling on gnome-shell-mobile 48.
        // Estimate header height (~60px) and subtract from sheet height.
        let scrollH = sheetH - 70;
        let scrollClip = new St.Widget({
            x_expand: true,
            reactive: true,
            clip_to_allocation: true,
            height: scrollH,
        });
        content.add_child(scrollClip);

        let list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: false,
            style: 'padding: 0 20px 20px 20px; spacing: 16px;',
        });
        scrollClip.add_child(list);

        // Android-style touch scroll with velocity fling and pull-to-dismiss
        let touchY = 0, touching = false, scrollY = 0;
        let dismissDrag = 0;  // how far the sheet has been pulled down
        let isDismissing = false;
        let samples = [];
        let flingId = 0;
        const DISMISS_THRESHOLD = sheetH * 0.25;

        let clamp = () => {
            let max = Math.max(0, list.height - scrollClip.height);
            scrollY = Math.max(0, Math.min(max, scrollY));
            list.translation_y = -scrollY;
        };
        let stopFling = () => { if (flingId) { GLib.source_remove(flingId); flingId = 0; } };

        let fling = () => {
            stopFling();
            if (samples.length === 0) return;
            let wSum = 0, vSum = 0;
            for (let i = 0; i < samples.length; i++) {
                let w = i + 1;
                vSum += samples[i].v * w;
                wSum += w;
            }
            let v = Math.max(-3, Math.min(3, vSum / wSum));
            if (Math.abs(v) < 0.15) return;
            flingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (Math.abs(v) < 0.02) { flingId = 0; return GLib.SOURCE_REMOVE; }
                scrollY += v * 16;
                let max = Math.max(0, list.height - scrollClip.height);
                if (scrollY <= 0 || scrollY >= max) {
                    scrollY = Math.max(0, Math.min(max, scrollY));
                    list.translation_y = -scrollY;
                    flingId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                list.translation_y = -scrollY;
                v *= 0.985;
                return GLib.SOURCE_CONTINUE;
            });
        };

        let snapBack = () => {
            dismissDrag = 0;
            isDismissing = false;
            popup.remove_all_transitions();
            popup.ease({
                y: popup._convergenceOpenY,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        };

        scrollClip.connect('captured-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                stopFling();
                touching = true;
                isDismissing = false;
                dismissDrag = 0;
                touchY = event.get_coords()[1];
                samples = [];
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                touching = false;
                if (isDismissing) {
                    if (dismissDrag > DISMISS_THRESHOLD) {
                        this.closeWidgetPicker();
                    } else {
                        snapBack();
                    }
                    return Clutter.EVENT_STOP;
                }
                fling();
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.TOUCH_UPDATE && touching) {
                let [, ey] = event.get_coords();
                let now = GLib.get_monotonic_time() / 1000;
                let dy = touchY - ey;  // positive = scroll up
                let dt = samples.length > 0 ? Math.max(1, now - samples[samples.length - 1].t) : 16;

                // Pull-to-dismiss: when at scroll top and dragging down
                if (isDismissing) {
                    dismissDrag += -dy;  // dy negative = pulling down
                    dismissDrag = Math.max(0, dismissDrag);
                    // Rubber-band: diminishing movement as you pull further
                    let rubberDrag = dismissDrag * 0.6;
                    popup.y = popup._convergenceOpenY + rubberDrag;
                    touchY = ey;
                    return Clutter.EVENT_STOP;
                }

                if (scrollY <= 0 && dy < 0) {
                    // At top and pulling down — switch to dismiss mode
                    isDismissing = true;
                    dismissDrag = -dy;
                    touchY = ey;
                    return Clutter.EVENT_STOP;
                }

                samples.push({ v: dy / dt, t: now });
                if (samples.length > 5) samples.shift();
                touchY = ey;
                scrollY += dy;
                clamp();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        for (let def of WIDGET_CATALOG) {
            let alreadyAdded = def.unique && h._homeGridItems.some(i => i.type === 'widget' && i.widgetType === def.widgetType);
            let card = new St.BoxLayout({ style_class: 'convergence-widget-picker-item', orientation: Clutter.Orientation.VERTICAL, x_expand: true, reactive: true, style: 'padding: 16px; spacing: 12px;' });
            list.add_child(card);

            let previewBox = new St.Widget({ style_class: 'convergence-widget-picker-preview', x_expand: true, x_align: Clutter.ActorAlign.CENTER, height: 100, layout_manager: new Clutter.BinLayout() });
            card.add_child(previewBox);
            previewBox.add_child(buildWidgetPreview(def.widgetType, h._settings));

            let bottomRow = new St.BoxLayout({ vertical: false, x_expand: true, style: 'spacing: 12px;' });
            card.add_child(bottomRow);
            let textBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
            bottomRow.add_child(textBox);
            textBox.add_child(new St.Label({ text: def.label, style_class: 'convergence-widget-picker-item-label' }));
            textBox.add_child(new St.Label({ text: `${def.description}  \u00B7  ${def.defaultColSpan}\u00D7${def.defaultRowSpan}`, style_class: 'convergence-widget-picker-item-desc' }));

            if (alreadyAdded) {
                bottomRow.add_child(new St.Label({ text: 'Added', style_class: 'convergence-widget-picker-added', y_align: Clutter.ActorAlign.CENTER }));
            } else {
                let addBtn = new St.Button({ style_class: 'convergence-widget-picker-add-btn', label: 'Add', y_align: Clutter.ActorAlign.CENTER });
                addBtn.connect('clicked', () => { this._addWidgetToHomeScreen(def); this.closeWidgetPicker(); });
                bottomRow.add_child(addBtn);
            }
        }

        let uiScale = getAdaptiveScale({ profile: 'panel', monitor, logicalWidth: screenW, referenceWidth: 600, min: 0.95, max: 1.2 });
        let sideMargin = Math.round(16 * uiScale);
        let minSheetW = Math.round(420 * uiScale);
        let maxSheetW = Math.round(760 * uiScale);
        let sheetW = Math.min(Math.max(240, screenW - sideMargin * 2), Math.max(minSheetW, Math.min(maxSheetW, minSheetW)));

        popup.set_size(sheetW, sheetH);
        list.set_width(sheetW);
        scrollClip.set_width(sheetW);

        let sheetX = originX + Math.round((screenW - sheetW) / 2);
        popup.set_position(sheetX, originY + screenH);
        popup._convergenceOpenY = originY + screenH - sheetH;
        popup._convergenceClosedY = originY + screenH;

        h._widgetPickerPopup = popup;
        Main.layoutManager.uiGroup.add_child(popup);
        popup.ease({ y: popup._convergenceOpenY, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });

        h._widgetPickerCaptureId = h._runtimeDisposer.connect(global.stage, 'captured-event', (_a, event) => {
            let type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            let [ex, ey] = event.get_coords();
            let [px, py] = popup.get_transformed_position();
            let [pw, ph] = [popup.get_width(), popup.get_height()];
            if (ex >= px && ex <= px + pw && ey >= py && ey <= py + ph)
                return Clutter.EVENT_PROPAGATE;
            this.closeWidgetPicker();
            return Clutter.EVENT_STOP;
        });
    }

    _addWidgetToHomeScreen(widgetDef) {
        let h = this._home;
        if (widgetDef.unique && h._homeGridItems.some(i => i.type === 'widget' && i.widgetType === widgetDef.widgetType))
            return;
        let cell = h._findNextAvailableCellForWidget(widgetDef.defaultColSpan, widgetDef.defaultRowSpan, h._homeCurrentPage);
        if (!cell) return;
        h._homeGridItems.push({
            type: 'widget', widgetType: widgetDef.widgetType,
            instanceId: ensureWidgetInstanceId({ type: 'widget' }),
            col: cell.col, row: cell.row,
            page: cell.page ?? h._homeCurrentPage,
            colSpan: widgetDef.defaultColSpan, rowSpan: widgetDef.defaultRowSpan,
        });
        h._saveHomeLayout();
        h._renderHomeGrid();
    }

    /** Close the widget picker. */
    closeWidgetPicker() {
        let h = this._home;
        h._runtimeDisposer.clearTimeoutRef(h, '_widgetPickerArmCaptureId');
        if (h._widgetPickerCaptureId) {
            h._runtimeDisposer.untrackConnection(global.stage, h._widgetPickerCaptureId);
            global.stage.disconnect(h._widgetPickerCaptureId);
            h._widgetPickerCaptureId = 0;
        }
        let popup = h._widgetPickerPopup;
        h._widgetPickerPopup = null;
        if (!popup) return;
        popup.reactive = false;
        popup.ease({
            y: popup._convergenceClosedY ?? global.stage.height,
            duration: 200, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                if (popup.get_parent()) popup.get_parent().remove_child(popup);
                popup.destroy();
            },
        });
    }

    /** Get current grid metrics for widget content builders. */
    gridMetrics() {
        let h = this._home;
        return {
            scale: h._scale,
            iconSize: h._iconSize,
            labelPadH: h._labelPadH,
            labelFontSize: h._labelFontSize,
            labelMarginTop: h._labelMarginTop,
            labelMaxHeight: h._labelMaxHeight,
        };
    }
}
