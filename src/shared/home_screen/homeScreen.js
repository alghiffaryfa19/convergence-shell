// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { getWidgetSizeLimits } from './widgets/widgetCatalog.js';
import { addClickCursor, createLongPressController, getAdaptiveScale, snapToPixel } from '../utilities/uiUtils.js';
import { REF_SCREEN_W, REF_COL_COUNT_PITCH } from '../utilities/layoutConstants.js';
import { RuntimeDisposer } from '../utilities/runtimeDisposer.js';
import { Logger } from '../utilities/logger.js';
import { HomeScreenGestures } from './homeScreenGestures.js';
import { HomeScreenMenus } from './homeScreenMenus.js';
import { HomeScreenSpringLoaded } from './homeScreenSpringLoaded.js';
import { HomeScreenDesktopFiles } from './homeScreenDesktopFiles.js';
import { HomeScreenWidgets } from './homeScreenWidgets.js';
import { getWidgetDefinition } from './widgets/widgetFramework.js';
import { ensureWidgetInstanceId } from './widgets/widgetInstanceStore.js';
import {
    SCROLL_MULTIPLIER,
    SCROLL_END_TIMEOUT,
    TOUCH_LONG_PRESS_CANCEL_DIST,
    DND_EDGE_ZONE_WIDTH as HOME_DND_EDGE_ZONE_WIDTH,
    DND_EDGE_SCROLL_DELAY as HOME_DND_EDGE_SCROLL_DELAY,
} from '../utilities/gestureConstants.js';

export const PEEK_HEIGHT = 100;
export const DRAG_THRESHOLD = 10;
export const SWIPE_UP_THRESHOLD = 80;
export const HOME_LONG_PRESS_MS = 500;
export const HOME_DND_MENU_AUTO_MS = 250;

const REF_HOME_COLS = 5;
const REF_HOME_CELL_WIDTH = 72;
const REF_HOME_CELL_HEIGHT = 88;
const REF_HOME_ICON_SIZE = 48;
const REF_HOME_COL_SPACING = 12;
const REF_HOME_ROW_SPACING = 4;
const REF_HOME_GRID_TOP_MARGIN = 0;
const REF_CELL_PITCH = REF_COL_COUNT_PITCH;
const OP6_PORTRAIT_LOGICAL_W_AT_200 = 540;
const OP6_PORTRAIT_SCALE_200 = 2;

// getAdaptiveScale now uses logical width directly (no geo_scale multiplier).
// Reference widths are halved from the old physical-pixel values so that a
// 2x-scaled reference device (OP6) produces the same scale output as before.
const HOME_GRID_REF_W_PHONE = OP6_PORTRAIT_LOGICAL_W_AT_200 / OP6_PORTRAIT_SCALE_200;  // 270
const HOME_GRID_REF_W_DESKTOP = REF_SCREEN_W / OP6_PORTRAIT_SCALE_200;                 // 216
const REORDER_ANIM_DURATION = 150;
const LAYOUT_SAVE_DEBOUNCE_MS = 120;
const HOME_GRID_BUILD_CHUNK = 16;
const FOLDER_ROWS = 4;
const FOLDER_GRID_COL_SPACING = 4;
const FOLDER_SWIPE_THRESHOLD = 10;

/**
 * Main home screen grid: customizable app grid with pages, drag-and-drop
 * reordering, folders, widgets, desktop file integration, and gestures.
 */
export class HomeScreen {
    /**
     * @param {object} controller - Extension controller.
     * @param {object} [options] - Configuration options.
     */
    constructor(controller, options = null) {
        this._controller = controller;
        let monitorIndex = options?.monitorIndex;
        this._fixedMonitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        this._logger = new Logger('HomeScreen');
        this._runtimeDisposer = new RuntimeDisposer();
        this._visible = false;
        this._firstShow = true;

        this._pressed = false;
        this._claimed = false;
        this._pressOnButton = false;
        this._dragDirection = null;
        this._startX = 0;
        this._startY = 0;
        this._dragTimestamp = 0;
        this._grab = null;
        this._scrollGestureActive = false;
        this._scrollAccumX = 0;
        this._scrollAccumY = 0;
        this._scrollTimeoutId = 0;
        this._wheelPageSnapTime = 0;

        this._settings = null;
        this._homeGridItems = [];
        this._homeGridButtons = [];
        this._homeItemRuntimeIdMap = new WeakMap();
        this._homeItemRuntimeIdNext = 1;
        this._overflowReflowSession = null;
        this._saveLayoutTimeoutId = 0;
        this._lastSavedHomeLayoutJson = null;
        this._renderGridIdleId = 0;
        this._renderGridBuildToken = 0;
        this._layoutStabilized = false;
        this._springLoaded = false;
        this._springOverlay = null;
        this._cellHighlight = null;
        this._cellHighlightCol = -1;
        this._cellHighlightRow = -1;
        this._homeGridRows = 0;
        this._homeMenu = null;
        this._homeMenuIsPopup = false;
        this._homeMenuManager = null;
        this._homeMenuAnchor = null;
        this._homeMenuCaptureId = 0;

        this._homeFolderPopup = null;
        this._homeFolderCaptureId = 0;
        this._currentHomeFolder = null;
        this._folderPages = [];
        this._folderPagesContainer = null;
        this._folderDotsContainer = null;
        this._folderCurrentPage = 0;
        this._folderPageWidth = 0;
        this._folderSwipePressed = false;
        this._folderSwipeClaimed = false;
        this._folderFingerMoved = false;
        this._folderSwipeStartX = 0;
        this._folderSwipeStartY = 0;
        this._folderSwipeStartPageX = 0;
        this._folderSwipeTimestamp = 0;

        this._homeDndReady = false;
        this._homeDndSourceBtn = null;
        this._homeDndActive = false;
        this._homeDndItem = null;
        this._homeDndApp = null;
        this._homeDndGhost = null;
        this._homeDndGrab = null;
        this._homeDndStartX = 0;
        this._homeDndStartY = 0;
        this._homeDndMenuTimerId = 0;
        this._homeDndGhostW = 0;
        this._homeDndGhostH = 0;
        this._widgetDisplacedPositions = new Map();
        this._dndRemoveZone = null;
        this._dndOverRemoveZone = false;
        this._crossMonitorDndTarget = null;

        this._homePages = [];
        this._homeInnerGrids = [];
        this._homeCurrentPage = 0;
        this._homePageWidth = 0;
        this._homePageSwipeStartX = 0;
        this._homeDrawerRevealActive = false;
        this._homeDndEdgeScrollTimerId = 0;
        this._homeDndEdgeScrollDir = 0;
        this._homeDndCompacted = false;
        this._lastPressWasTouch = false;

        this._widgetResizeActive = false;
        this._widgetResizeItem = null;
        this._widgetResizeBtn = null;
        this._widgetResizeOverlay = null;
        this._widgetResizeEdge = null;
        this._widgetResizeStartX = 0;
        this._widgetResizeStartY = 0;
        this._widgetResizeOrigCol = 0;
        this._widgetResizeOrigRow = 0;
        this._widgetResizeOrigColSpan = 0;
        this._widgetResizeOrigRowSpan = 0;
        this._widgetResizeCaptureId = 0;

        this._widgetPickerPopup = null;
        this._widgetPickerCaptureId = 0;
        this._widgetInstances = new Map();
        this._bgLongPressTimerId = 0;

        this._gestures = new HomeScreenGestures(this);
        this._menus = new HomeScreenMenus(this);
        this._springLoadedHelper = new HomeScreenSpringLoaded(this);
        this._desktopFiles = new HomeScreenDesktopFiles(this);
        this._widgets = new HomeScreenWidgets(this);

        this._build();
    }

    _isWidget(item) { return item?.type === 'widget'; }
    _isFolder(item) { return item?.type === 'folder'; }
    _isFile(item) { return item?.type === 'file'; }

    _getMonitorDisplayMode(monitorIndex = this._getHomeMonitorIndex()) {
        return this._controller?.displayConfig?.getDisplayMode?.(monitorIndex) ?? null;
    }

    _isPhoneLayoutMonitor(monitorIndex = this._getHomeMonitorIndex()) {
        let mode = this._getMonitorDisplayMode(monitorIndex);
        return mode === 'phone' || mode === 'tablet';
    }

    _isCellOccupied(col, row) {
        return !!this._getItemAtCell(col, row, this._homeCurrentPage);
    }

    _getItemAtCell(col, row, page) {
        for (let item of this._homeGridItems) {
            if ((item.page ?? 0) !== page) continue;
            if (this._isWidget(item)) {
                if (col >= item.col && col < item.col + (item.colSpan || 1) &&
                    row >= item.row && row < item.row + (item.rowSpan || 1))
                    return item;
            } else if (item.col === col && item.row === row) {
                return item;
            }
        }
        return null;
    }

    _findNextAvailableCell(page) {
        let rows = this._computeGridRows();
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < this._homeCols; col++) {
                if (!this._getItemAtCell(col, row, page))
                    return { col, row, page };
            }
        }
        return { col: 0, row: 0, page: page + 1 };
    }

    _findNextAvailableCellForWidget(colSpan, rowSpan, page) {
        let rows = this._computeGridRows();
        for (let row = 0; row <= rows - rowSpan; row++) {
            for (let col = 0; col <= this._homeCols - colSpan; col++) {
                let blocked = false;
                for (let r = row; r < row + rowSpan && !blocked; r++)
                    for (let c = col; c < col + colSpan; c++)
                        if (this._getItemAtCell(c, r, page)) { blocked = true; break; }
                if (!blocked) return { col, row, page };
            }
        }
        return { col: 0, row: 0, page: page + 1 };
    }

    _canPlaceWidget(col, row, colSpan, rowSpan, excludeItem) {
        let page = this._homeCurrentPage;
        for (let r = row; r < row + rowSpan; r++) {
            for (let c = col; c < col + colSpan; c++) {
                let occupant = this._getItemAtCell(c, r, page);
                if (occupant && occupant !== excludeItem && this._isWidget(occupant))
                    return false;
            }
        }
        return true;
    }

    _getDockHeightForMonitor(monitorIndex) {
        let isSmall = this._isPhoneLayoutMonitor(monitorIndex);
        let dockPos = isSmall ? 'bottom' : 'left';
        try {
            if (this._settings?.settings_schema?.has_key?.('taskbar-position'))
                dockPos = this._settings.get_string('taskbar-position');
        } catch (_) {}
        if (dockPos === 'left' || dockPos === 'right') return 0;
        let rect = this._controller?.getDockRectForMonitor?.(monitorIndex);
        if (rect) {
            let actorY = this._actor?.y ?? 0;
            let actorH = this._actor?.height ?? 0;
            return Math.max(0, actorH - (rect.y - actorY));
        }
        return this._shouldExpectDockOnMonitor(monitorIndex)
            ? this._computeDockHeight(monitorIndex) : 0;
    }

    _shouldExpectDockOnMonitor(monitorIndex) {
        if (this._controller?.getDockRectForMonitor?.(monitorIndex)) return true;
        try {
            let schema = this._settings?.settings_schema;
            if (schema?.has_key?.('taskbar-monitor-mode')) {
                let mode = this._settings.get_string('taskbar-monitor-mode');
                if (mode === 'single') {
                    let target = 'primary';
                    if (schema.has_key?.('taskbar-single-monitor-target'))
                        target = this._settings.get_string('taskbar-single-monitor-target');
                    if (target === 'primary')
                        return monitorIndex === (this._controller?.getPrimaryDesktopMonitorIndex?.() ?? Main.layoutManager.primaryIndex);
                    return false;
                }
            }
        } catch (_e) {}
        return true;
    }

    _computeDockHeight(monitorIndex = this._getHomeMonitorIndex()) {
        let dockSizeFactor = 1;
        let taskbarMode = false;
        let isSmall = this._isPhoneLayoutMonitor(monitorIndex);
        let dockPos = isSmall ? 'bottom' : 'left';
        try {
            if (this._settings) {
                if (this._settings.settings_schema?.has_key?.('taskbar-size-percent'))
                    dockSizeFactor = Math.max(0.3, Math.min(1.6, this._settings.get_int('taskbar-size-percent') / 100));
                if (!isSmall) {
                    taskbarMode = this._settings.get_boolean('taskbar-panel-mode');
                }
            }
        } catch (_e) {}
        if (dockPos === 'left' || dockPos === 'right') return 0;
        let dockUiScale = Math.max(0.82, Math.min(1.42, 1 + ((dockSizeFactor - 1) * 0.65)));
        let dockIconSize = Math.round((this._iconSize || REF_HOME_ICON_SIZE) * dockSizeFactor);
        let dockHeight = dockIconSize + Math.round(8 * dockUiScale) * 2 + Math.round(8 * dockUiScale) + 1 + Math.round(8 * dockUiScale);
        if (taskbarMode && dockPos === 'bottom') {
            try { let px = this._settings.get_int('taskbar-thickness'); if (px > 0) return Math.max(40, Math.min(220, px)); } catch (_e) {}
            return 48;
        }
        return dockHeight;
    }

    _updateGridMetrics() {
        let monitor = this._getHomeMonitor();
        let screenW = this._homePageWidth || this._actor?.width || monitor?.width || global.stage.width;
        let stageH = this._actor?.height || this._getHomeBounds().height;
        let aspect = screenW / Math.max(1, stageH);
        let maxGridScale = aspect >= 2.0 ? 1.45 : 1.35;
        let monitorIdx = this._getHomeMonitorIndex();
        let minGridScale = this._isPhoneLayoutMonitor(monitorIdx) ? 0.85 : 0.8;
        let monitorMode = this._controller.displayConfig?.getDisplayMode?.(monitorIdx);
        let isPhoneMode = this._isPhoneLayoutMonitor(monitorIdx);
        let contentInset = this._getHomeContentInsetPx(monitor);
        this._homeContentInset = contentInset;
        let usableW = screenW - (contentInset * 2);
        let referenceWidth = isPhoneMode ? HOME_GRID_REF_W_PHONE : HOME_GRID_REF_W_DESKTOP;
        let scale = getAdaptiveScale({ profile: 'grid', monitor, logicalWidth: screenW, referenceWidth, min: minGridScale, max: maxGridScale });
        this._scale = scale;
        let scaledPitch = REF_CELL_PITCH * scale;
        this._homeCols = Math.max(3, Math.round(usableW / scaledPitch));
        if (isPhoneMode) {
            // Reference phone (OP6): 540px wide, 22px inset each side → 496px usable, 5 cols.
            // Derive the phone cell pitch from that reference and scale to the current display.
            let refPhoneUsable = OP6_PORTRAIT_LOGICAL_W_AT_200 - (22 * 2); // 496
            let refPhonePitch = refPhoneUsable / REF_HOME_COLS;            // ~99.2
            this._homeCols = Math.max(REF_HOME_COLS, Math.round(usableW / refPhonePitch));
        }
        this._colSpacing = Math.round(REF_HOME_COL_SPACING * scale);
        this._cellW = Math.round(REF_HOME_CELL_WIDTH * scale);
        if (isPhoneMode && this._homeCols > 1) {
            let op6MonitorRef = { width: OP6_PORTRAIT_LOGICAL_W_AT_200, height: Math.round(OP6_PORTRAIT_LOGICAL_W_AT_200 * 2.11), geometry_scale: OP6_PORTRAIT_SCALE_200 };
            let op6Inset = this._getHomeContentInsetPx(op6MonitorRef);
            let op6UsableW = Math.max(1, OP6_PORTRAIT_LOGICAL_W_AT_200 - (op6Inset * 2));
            let op6Scale = getAdaptiveScale({ profile: 'grid', monitor: op6MonitorRef, logicalWidth: OP6_PORTRAIT_LOGICAL_W_AT_200, referenceWidth: HOME_GRID_REF_W_PHONE, min: minGridScale, max: maxGridScale });
            // Compute OP6 cell and spacing at reference scale
            let op6ColSpacing = Math.max(2, Math.round(REF_HOME_COL_SPACING * op6Scale));
            let op6CellW = Math.floor((op6UsableW - ((REF_HOME_COLS - 1) * op6ColSpacing)) / REF_HOME_COLS);
            // Preserve the OP6 cell:spacing ratio on any display.
            let spacingRatio = op6ColSpacing / op6CellW;
            let cols = this._homeCols;
            this._cellW = Math.max(1, Math.floor(usableW / (cols + (cols - 1) * spacingRatio)));
            this._colSpacing = Math.max(2, Math.round(this._cellW * spacingRatio));
        }
        // Icon sizes use the adaptive scale (preserving OP6 look) but are
        // capped at 78% of cell width so they fit on narrower displays.
        this._iconSize = Math.round(REF_HOME_ICON_SIZE * scale);
        let maxIcon = Math.round(this._cellW * 0.78);
        if (this._iconSize > maxIcon) this._iconSize = maxIcon;
        this._iconSize = Math.max(40, this._iconSize);
        this._folderGridSize = Math.min(Math.round(52 * scale), Math.round(this._cellW * 0.72));
        this._rowSpacing = Math.max(2, Math.round(REF_HOME_ROW_SPACING * scale));
        this._gridTopMargin = Math.round(REF_HOME_GRID_TOP_MARGIN * scale);
        // Label/padding scale with cell width to avoid overflow on narrow displays
        let labelScale = Math.min(scale, this._cellW / REF_HOME_CELL_WIDTH);
        this._labelFontSize = Math.max(9, Math.round(11 * labelScale));
        this._labelMarginTop = Math.round(4 * labelScale);
        this._labelPadH = Math.round(4 * labelScale);
        this._labelMaxHeight = Math.round(this._labelFontSize * 2.7);
        let iconAreaH = Math.max(this._iconSize, this._folderGridSize);
        this._cellH = iconAreaH + this._labelMarginTop + this._labelMaxHeight + 2 * this._labelPadH;
        this._logger.debug(
            `grid metrics monitor=${monitorIdx} mode=${monitorMode ?? 'unknown'} ` +
            `screen=${Math.round(screenW)}x${Math.round(stageH)} ` +
            `monitorRect=${monitor?.width ?? 0}x${monitor?.height ?? 0} ` +
            `inset=${contentInset} usableW=${Math.round(usableW)} scale=${this._scale.toFixed(3)} ` +
            `cols=${this._homeCols} cell=${this._cellW}x${this._cellH} ` +
            `spacing=${this._colSpacing}x${this._rowSpacing}`);
    }

    _getHomeContentInsetPx(monitor = this._getHomeMonitor()) {
        let panelH = this._getTopPanelInset();
        if (panelH <= 0) return Math.max(8, Math.round(snapToPixel(16, monitor)));
        let logicalWidth = monitor?.width ?? global.stage.width;
        let uiScale = getAdaptiveScale({ profile: 'panel', monitor, logicalWidth, referenceWidth: HOME_GRID_REF_W_DESKTOP, min: 0.9, max: 1.35 });
        return Math.max(8, Math.round(snapToPixel(16 * uiScale, monitor)));
    }

    _getHomeMonitor() {
        let monitors = Main.layoutManager.monitors ?? [];
        let idx = this._getHomeMonitorIndex(monitors);
        return monitors[idx] ?? Main.layoutManager.primaryMonitor ?? null;
    }

    _getHomeMonitorIndex(monitors = Main.layoutManager.monitors ?? []) {
        if (Number.isInteger(this._fixedMonitorIndex) && this._fixedMonitorIndex >= 0 && this._fixedMonitorIndex < monitors.length)
            return this._fixedMonitorIndex;
        let primaryDesktopMonitorIndex = this._controller?.getPrimaryDesktopMonitorIndex?.();
        if (Number.isInteger(primaryDesktopMonitorIndex) &&
            primaryDesktopMonitorIndex >= 0 && primaryDesktopMonitorIndex < monitors.length)
            return primaryDesktopMonitorIndex;
        return Main.layoutManager.primaryIndex;
    }

    _getMonitorLayoutKey() {
        // Use the stage dimensions as the canonical source for the layout
        // key. During rotation, DisplayConfig and stage update at different
        // times — using stage ensures the key always matches the grid
        // column count (which is derived from actor width, not DisplayConfig).
        let dc = this._controller?.displayConfig;
        let idx = this._getHomeMonitorIndex();
        let info = dc?._monitors?.get(idx);
        let prefix = info?.connector ?? `monitor${idx}`;
        let w = global.stage.width;
        let h = global.stage.height;
        return `${prefix}_${w}x${h}`;
    }

    /**
     * Find a stored layout from the same physical monitor in the other
     * orientation (dimensions swapped). Returns the layout data or null.
     */
    _findOrientationSibling(monitors) {
        let key = this._getMonitorLayoutKey();
        // Extract connector prefix and dimensions from our key
        let match = key.match(/^(.+)_(\d+)x(\d+)$/);
        if (!match) return null;
        let [, prefix, w, h] = match;
        // Look for the same connector with swapped dimensions
        let siblingKey = `${prefix}_${h}x${w}`;
        if (monitors[siblingKey])
            return monitors[siblingKey];
        return null;
    }

    _getTopPanelInset(monitorIndex = this._getHomeMonitorIndex()) {
        if (this._isPhoneLayoutMonitor(monitorIndex))
            return Math.max(0, this._controller?.getPhoneTopInset?.(monitorIndex) ?? 0);

        let panel = Main.panel;
        if (!panel || !panel.visible) return 0;
        if (Main.layoutManager?.panelBox && !Main.layoutManager.panelBox.visible) return 0;
        return Math.max(0, panel.height || 0);
    }

    _getHomeBounds() {
        let monitors = Main.layoutManager.monitors ?? [];
        let monitorIndex = this._getHomeMonitorIndex(monitors);
        let monitor = monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor ?? null;
        let isPrimary = (monitorIndex === (this._controller?.getPrimaryDesktopMonitorIndex?.() ?? Main.layoutManager.primaryIndex));
        let panelH = (isPrimary || this._isPhoneLayoutMonitor(monitorIndex))
            ? this._getTopPanelInset(monitorIndex) : 0;
        if (!monitor) {
            this._homeDockBottomInset = 0;
            return { x: 0, y: panelH, width: global.stage.width, height: Math.max(1, global.stage.height - panelH) };
        }
        let insets = this._getTaskbarInsetsForMonitor(monitor, monitorIndex);
        this._homeDockBottomInset = insets.bottom;
        let bounds = {
            x: monitor.x + insets.left,
            y: monitor.y + panelH,
            width: Math.max(1, monitor.width - insets.left - insets.right),
            height: Math.max(1, monitor.height - panelH - insets.bottom),
        };
        this._logger.debug(
            `home bounds monitor=${monitorIndex} primary=${isPrimary} ` +
            `monitorRect=${monitor.x},${monitor.y},${monitor.width}x${monitor.height} ` +
            `panelH=${panelH} insets=${insets.left},${insets.right},${insets.bottom} ` +
            `bounds=${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`);
        return bounds;
    }

    /**
     * Get taskbar insets for a monitor (left/right/bottom padding to avoid
     * the home screen overlapping the taskbar).
     */
    _getTaskbarInsetsForMonitor(monitor, monitorIndex) {
        let insets = { left: 0, right: 0, bottom: 0 };
        if (!monitor) return insets;

        let isSmall = this._isPhoneLayoutMonitor(monitorIndex);
        let taskbarPos = isSmall ? 'bottom' : 'left';
        try {
            if (!isSmall && this._settings?.settings_schema?.has_key?.('taskbar-position'))
                taskbarPos = this._settings.get_string('taskbar-position');
        } catch (_e) {}

        // Get the taskbar/dock thickness from the controller or settings
        let taskbarThickness = 0;
        try {
            if (isSmall) {
                // Phone mode: get dock height from the app drawer
                let appDrawer = this._controller?.getPhoneAppDrawerForMonitor?.(monitorIndex);
                if (appDrawer?._dockHeight > 0) {
                    taskbarThickness = appDrawer._dockHeight;
                } else {
                    // Fallback: estimate from _computeDockHeight
                    taskbarThickness = this._computeDockHeight(monitorIndex);
                }
                // Also account for gesture bar
                let gestureBarH = 0;
                try {
                    if (this._settings?.settings_schema?.has_key?.('gesture-bar-height'))
                        gestureBarH = this._settings.get_int('gesture-bar-height') || 20;
                    else
                        gestureBarH = 20;
                } catch (_e) { gestureBarH = 20; }
                taskbarThickness += gestureBarH;
            } else {
                let taskbarRect = this._controller?.taskbar?.getTaskbarRectForMonitor?.(monitorIndex)
                    ?? null;
                if (taskbarRect) {
                    if (taskbarPos === 'left' || taskbarPos === 'right')
                        taskbarThickness = taskbarRect.width;
                    else
                        taskbarThickness = taskbarRect.height;
                } else if (this._settings && this._shouldExpectDockOnMonitor(monitorIndex)) {
                    let px = this._settings.get_int('taskbar-thickness');
                    taskbarThickness = px > 0 ? px : 64;
                }
            }
            this._logger.debug(
                `taskbar inset monitor=${monitorIndex} pos=${taskbarPos} ` +
                `rect=${taskbarRect ? `${taskbarRect.x},${taskbarRect.y},${taskbarRect.width}x${taskbarRect.height}` : 'none'} ` +
                `thickness=${taskbarThickness}`);
        } catch (_e) {}

        if (taskbarPos === 'left')
            insets.left = taskbarThickness;
        else if (taskbarPos === 'right')
            insets.right = taskbarThickness;
        else
            insets.bottom = taskbarThickness;

        return insets;
    }

    _getHomePageSnapDuration(baseMs, velocityX = 0) {
        let monitor = this._getHomeMonitor();
        let scale = monitor?.geometry_scale ?? 1;
        let scaleMul = Math.max(0.92, Math.min(1.16, 1 + ((scale - 1) * 0.12)));
        let speed = Math.abs(velocityX);
        let velocityMul = Math.max(0.78, Math.min(1.06, 1 - (speed * 0.08)));
        return Math.round(baseMs * scaleMul * velocityMul);
    }

    _isTouchInputActive() {
        if (this._lastPressWasTouch) return true;
        let dc = this._controller?.displayConfig;
        if (!dc?.hasTouchscreen) return false;
        let mode = dc.activeInputMode;
        return mode === 'touch' || mode === 'Touch' || mode === 'mixed' || mode === 'Mixed';
    }

    _shouldUseTouchHomeDrawerRevealProfile() { return this._isTouchInputActive(); }
    _shouldUseTouchHomeIconHoldFlow() { return this._isTouchInputActive(); }

    _setHomeDndReadyVisual(button, ready) {
        if (!button) return;
        if (ready) button.add_style_class_name('convergence-home-dnd-ready');
        else button.remove_style_class_name('convergence-home-dnd-ready');
    }

    _emitHomeFeedback(kind) {
        try { if (this._settings && !this._settings.get_boolean('home-feedback-sounds')) return; } catch (_e) {}
        let soundId = 'button-pressed';
        switch (kind) {
            case 'drag-start': soundId = 'button-pressed'; break;
            case 'page-snap': soundId = 'message'; break;
            case 'drop': soundId = 'complete'; break;
            case 'remove': soundId = 'trash'; break;
        }
        try { global.display?.get_sound_player?.()?.play_from_theme?.(soundId, `Convergence ${kind}`, null); } catch (_e) {}
    }

    _scheduleHomeGridRender() {
        this._runtimeDisposer.restartTimeout(this, '_homeGridRenderId', GLib.PRIORITY_DEFAULT_IDLE, 0, () => { this._renderHomeGrid(); return GLib.SOURCE_REMOVE; });
    }

    _cancelBgLongPress() { this._menus.cancelBgLongPress(); }
    _dismissHomeMenu(fromNativeClose) { this._menus.dismissHomeMenu(fromNativeClose); }
    _removeHomeIcon(item) { this._menus.removeHomeIcon(item); }
    _beginHomeDndReady(button, item, app, x, y) { this._menus.beginHomeDndReady(button, item, app, x, y); }
    _resetHomeDndReadyState() { this._menus.resetHomeDndReadyState(); }
    _openReadyItemMenu(btn, item, app, x, y) { this._menus.openReadyItemMenu(btn, item, app, x, y); }
    _showHomeBackgroundMenu(x, y) { this._menus.showHomeBackgroundMenu(x, y); }
    _isPointOverHomeGridButton(x, y) { return this._menus.isPointOverHomeGridButton(x, y); }
    _showHomeNativeMenu(src, pop, s, a, d) { return this._menus.showHomeNativeMenu(src, pop, s, a, d); }
    _showHomeNativeMenuAtPoint(x, y, pop) { return this._menus.showHomeNativeMenuAtPoint(x, y, pop); }
    _addHomeNativeMenuItem(menu, label, action) { this._menus.addHomeNativeMenuItem(menu, label, action); }
    _openSystemControlCenter(panel) { return this._menus.openSystemControlCenter(panel); }

    enterSpringLoaded() { this._springLoadedHelper.enterSpringLoaded(); }
    exitSpringLoaded() { this._springLoadedHelper.exitSpringLoaded(); }
    updateSpringLoadedHover(x, y) { return this._springLoadedHelper.updateSpringLoadedHover(x, y); }
    _clearCellHighlight() { this._springLoadedHelper.clearCellHighlight(); }
    _reflowIconsForWidget(c, r, cs, rs) { this._springLoadedHelper._reflowIconsForWidget(c, r, cs, rs); }

    _startDesktopFileMonitor() { this._desktopFiles.startDesktopFileMonitor(); }
    _stopDesktopFileMonitor() { this._desktopFiles.stopDesktopFileMonitor(); }
    _syncDesktopFiles() { this._desktopFiles.syncDesktopFiles(); }
    _createFileIcon(item) { return this._desktopFiles.createFileIcon(item); }
    _selectFileIcon(item, box) { this._desktopFiles.selectFileIcon(item, box); }
    _deselectFileIcon() { this._desktopFiles.deselectFileIcon(); }
    _showFileMenu(x, y, item) { this._desktopFiles.showFileMenu(x, y, item); }
    _moveFileToTrash(item) { this._desktopFiles.moveFileToTrash(item); }

    _createWidgetActor(item) { return this._widgets.createWidgetActor(item); }
    _openWidgetPicker() { this._widgets.openWidgetPicker(); }
    _enterWidgetResizeMode(btn, item) { this._widgets.enterWidgetResizeMode(btn, item); }
    _exitWidgetResizeMode() { this._widgets.exitWidgetResizeMode(); }
    _gridMetrics() { return this._widgets.gridMetrics(); }

    _onGestureMotion(event) { return this._gestures.onGestureMotion(event); }
    _onGestureRelease(event) { return this._gestures.onGestureRelease(event); }
    _handleSmoothScroll(sdx, sdy, event) { return this._gestures.handleSmoothScroll(sdx, sdy, event); }
    _cancelScrollGesture() { this._gestures.cancelScrollGesture(); }
    _endHomeDrawerReveal(commit) { this._gestures._endHomeDrawerReveal(commit); }

    _cancelHomeDndMenuTimer() {
        if (this._homeDndMenuTimerId) {
            this._runtimeDisposer.untrackTimeout(this._homeDndMenuTimerId);
            GLib.source_remove(this._homeDndMenuTimerId);
            this._homeDndMenuTimerId = 0;
        }
    }

    _showDndRemoveZone() {
        if (this._dndRemoveZone) return;
        let monitor = this._getHomeMonitor();
        let scale = monitor?.geometry_scale ?? 1;
        let bounds = this._getHomeBounds();
        let topOffset = (bounds.y - (monitor?.y ?? 0)) + Math.round(16 * scale);

        let zone = new St.BoxLayout({
            style_class: 'convergence-dnd-remove-zone',
            vertical: false, reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        try { zone.add_effect_with_name('convergence-dnd-remove-zone-blur', new Shell.BlurEffect({ sigma: 24, brightness: 0.50, mode: Shell.BlurMode.BACKGROUND })); } catch (_e) {}
        zone.add_child(new St.Label({ style_class: 'convergence-dnd-remove-zone-icon', text: '\u00d7', y_align: Clutter.ActorAlign.CENTER }));
        zone.add_child(new St.Label({ style_class: 'convergence-dnd-remove-zone-label', text: 'Remove', y_align: Clutter.ActorAlign.CENTER }));
        Main.layoutManager.uiGroup.add_child(zone);
        zone.set_position(monitor.x, monitor.y + topOffset);
        let allocId = zone.connect('notify::allocation', () => {
            zone.disconnect(allocId);
            zone.set_position(Math.round(monitor.x + (monitor.width - zone.get_width()) / 2), monitor.y + topOffset);
        });
        zone.opacity = 0;
        zone.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        this._dndRemoveZone = zone;
        this._dndOverRemoveZone = false;
    }

    _hideDndRemoveZone() {
        if (!this._dndRemoveZone) return;
        let zone = this._dndRemoveZone;
        this._dndRemoveZone = null;
        this._dndOverRemoveZone = false;
        if (zone.get_parent()) zone.get_parent().remove_child(zone);
        zone.destroy();
    }

    _hitTestRemoveZone(x, y) {
        let zone = this._dndRemoveZone;
        if (!zone) return false;
        let [rx, ry] = zone.get_transformed_position();
        let rw = zone.get_width(), rh = zone.get_height();
        let pad = 16;
        return x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad;
    }

    _updateRemoveZoneHover(x, y) {
        if (!this._dndRemoveZone) return;
        let over = this._hitTestRemoveZone(x, y);
        if (over !== this._dndOverRemoveZone) {
            this._dndOverRemoveZone = over;
            if (over) this._dndRemoveZone.add_style_class_name('convergence-dnd-remove-zone-active');
            else this._dndRemoveZone.remove_style_class_name('convergence-dnd-remove-zone-active');
        }
    }

    _computeGridRows() {
        let stageH = this._actor?.height || this._getHomeBounds().height;
        let topMargin = this._homeContentInset ?? this._getHomeContentInsetPx(this._getHomeMonitor());
        let bottomPad = this._bottomSpacer?.height ?? 0;
        let dotsH = 18;
        let available = stageH - topMargin - this._gridTopMargin - dotsH - bottomPad;
        return Math.max(3, Math.floor((available + this._rowSpacing) / (this._cellH + this._rowSpacing)));
    }

    _getPageCount() {
        if (this._homeGridItems.length === 0) return 1;
        let maxPage = 0;
        for (let item of this._homeGridItems) maxPage = Math.max(maxPage, item.page ?? 0);
        return maxPage + 2;
    }

    _getItemsOnPage(page) {
        return this._homeGridItems.filter(i => (i.page ?? 0) === page);
    }

    _pruneEmptyTrailingPages() {
        let maxPage = 0;
        for (let item of this._homeGridItems) maxPage = Math.max(maxPage, item.page ?? 0);
        let pageCount = this._homeGridItems.length === 0 ? 1 : maxPage + 1;
        if (this._homeCurrentPage >= pageCount)
            this._homeCurrentPage = Math.max(0, pageCount - 1);
    }

    _markManualHomeCellEdit() {
        if (this._overflowReflowSession?.active)
            this._overflowReflowSession.manualEdited = true;
    }

    _build() {
        this._actor = new St.Widget({
            style_class: 'convergence-home-screen',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
        });
        let bounds = this._getHomeBounds();
        this._actor.set_position(bounds.x, bounds.y);
        this._actor.set_size(bounds.width, bounds.height);

        this._layout = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true });
        this._actor.add_child(this._layout);

        let initialInset = this._getHomeContentInsetPx(this._getHomeMonitor());
        this._topSpacer = new St.Widget({ height: initialInset });
        this._layout.add_child(this._topSpacer);

        this._updateGridMetrics();

        this._homeGridClip = new St.Widget({
            x_expand: true, clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
            height: 0, style: `margin-top: ${this._gridTopMargin}px;`,
        });
        this._layout.add_child(this._homeGridClip);

        this._homePagesContainer = new St.BoxLayout({ vertical: false });
        this._homeGridClip.add_child(this._homePagesContainer);

        this._homePagesContainer.connect('notify::translation-x', () => {
            this._updatePagesClip();
        });

        this._homeGridClip.connect('notify::allocation', () => {
            let box = this._homeGridClip.get_allocation_box();
            let w = box.x2 - box.x1;
            if (w > 0 && w !== this._homePageWidth) {
                let firstAllocation = this._homePageWidth === 0;
                this._homePageWidth = w;
                let prevCols = this._homeCols;
                this._updateGridMetrics();
                if (this._settings && (this._homeCols !== prevCols || firstAllocation)) {
                    this._layoutStabilized = true;
                    this._loadHomeLayout();
                }
                this._homeGridClip.style = `margin-top: ${this._gridTopMargin}px;`;
                this._scheduleHomeGridRender();
            }
        });

        this._layout.add_child(new St.Widget({ y_expand: true }));

        this._homeDotsContainer = new St.BoxLayout({
            style_class: 'convergence-page-dots',
            x_align: Clutter.ActorAlign.CENTER, x_expand: true,
        });
        this._layout.add_child(this._homeDotsContainer);

        let initMonIdx = this._getHomeMonitorIndex();
        let initDockFallback = this._getDockHeightForMonitor(initMonIdx);
        this._bottomSpacer = new St.Widget({
            height: (this._homeDockBottomInset ?? 0) > 0 ? 0 : initDockFallback,
        });
        this._layout.add_child(this._bottomSpacer);

        this._capturedId = this._runtimeDisposer.connect(this._actor, 'captured-event', this._onCaptured.bind(this));

        this._placeBehindWindows();
        this._runtimeDisposer.connect(global.display, 'restacked', () => this._placeBehindWindows());
    }

    _placeBehindWindows() {
        if (!this._actor) return;
        let targetParent = global.window_group ?? Main.layoutManager.uiGroup;
        if (!targetParent) return;
        let parent = this._actor.get_parent();
        if (parent !== targetParent) {
            if (parent) parent.remove_child(this._actor);
            targetParent.add_child(this._actor);
        }
        if (targetParent === global.window_group) {
            // Place below the first real window actor so windows render above us.
            let firstWindowActor = null;
            for (let wa of global.get_window_actors()) {
                if (wa?.get_parent?.() === targetParent) { firstWindowActor = wa; break; }
            }
            if (firstWindowActor) { targetParent.set_child_below_sibling(this._actor, firstWindowActor); return; }

            // No managed windows — place above background actors so we remain
            // visible on an empty desktop (index 0 would be behind wallpaper).
            if (typeof targetParent.set_child_at_index === 'function') {
                let childCount = targetParent.get_n_children?.() ?? 1;
                targetParent.set_child_at_index(this._actor, Math.max(0, childCount - 1));
                return;
            }
        }
        // Fallback for non-window-group parents
        if (typeof targetParent.set_child_at_index === 'function')
            targetParent.set_child_at_index(this._actor, 0);
    }

    _onCaptured(_actor, event) {
        if (this._widgetResizeActive) return Clutter.EVENT_PROPAGATE;
        if (this._homeDndActive) {
            let type = event.type();
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                let [x, y] = event.get_coords(); this._updateHomeDnd(x, y); return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                let [x, y] = event.get_coords(); this._finishHomeDnd(x, y); return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }
        if (this._homeDndReady) {
            let type = event.type();
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                let [x, y] = event.get_coords();
                let dx = x - this._homeDndStartX, dy = y - this._homeDndStartY;
                let touchThreshold = Math.max(DRAG_THRESHOLD, Math.round(14 * (this._scale ?? 1)));
                if (Math.sqrt(dx * dx + dy * dy) > touchThreshold) { this._promoteToHomeDnd(x, y); return Clutter.EVENT_STOP; }
            }
            if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
                let [rx, ry] = event.get_coords();
                this._openReadyItemMenu(this._homeDndSourceBtn, this._homeDndItem, this._homeDndApp, rx, ry);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.TOUCH_CANCEL) { this._resetHomeDndReadyState(); return Clutter.EVENT_PROPAGATE; }
            return Clutter.EVENT_PROPAGATE;
        }
        if (this._springLoaded) return Clutter.EVENT_PROPAGATE;
        let type = event.type();
        if (type === Clutter.EventType.SCROLL && !this._homeDndActive && !this._homeDndReady) {
            // Let sticky note entries handle their own scroll events
            let src = event.get_source();
            while (src && src !== this._actor) {
                if (src._stickyPageIdx !== undefined) return Clutter.EVENT_PROPAGATE;
                src = src.get_parent();
            }
            let dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [sdx, sdy] = event.get_scroll_delta();
                return this._handleSmoothScroll(sdx, sdy, event);
            }
            let now = GLib.get_monotonic_time() / 1000;
            if (now - this._wheelPageSnapTime < 300) return Clutter.EVENT_STOP;
            if (this._homePages.length > 1) {
                let target = this._homeCurrentPage;
                if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) target = Math.min(this._homePages.length - 1, target + 1);
                else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) target = Math.max(0, target - 1);
                if (target !== this._homeCurrentPage) { this._wheelPageSnapTime = now; this._homeSnapToPage(target); return Clutter.EVENT_STOP; }
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            this._lastPressWasTouch = type === Clutter.EventType.TOUCH_BEGIN;
            this._cancelScrollGesture();
            let [x, y] = event.get_coords();
            if (type === Clutter.EventType.BUTTON_PRESS && (event.get_button?.() ?? 0) === 3) {
                this._cancelBgLongPress(); this._pressed = false;
                if (!this._isPointOverHomeGridButton(x, y)) { this._showHomeBackgroundMenu(x, y); return Clutter.EVENT_STOP; }
                return Clutter.EVENT_PROPAGATE;
            }
            this._pressed = true; this._claimed = false;
            this._pressOnButton = this._isPointOverHomeGridButton(x, y);
            this._dragDirection = null; this._startX = x; this._startY = y;
            this._dragTimestamp = GLib.get_monotonic_time();
            if (!this._pressOnButton) { this._deselectFileIcon(); if (global.stage.get_key_focus()) global.stage.set_key_focus(null); }
            this._cancelBgLongPress();
            if (!this._pressOnButton) {
                this._runtimeDisposer.restartTimeout(this, '_bgLongPressTimerId', GLib.PRIORITY_DEFAULT, 500, () => {
                    if (!this._claimed && this._pressed && !this._homeDndReady && !this._homeDndActive) { this._pressed = false; this._showHomeBackgroundMenu(x, y); }
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (!this._pressed) return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) return this._onGestureMotion(event);
        if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) return this._onGestureRelease(event);
        return Clutter.EVENT_PROPAGATE;
    }

    _promoteToHomeDnd(x, y) {
        if (this._homeDndActive || !this._homeDndReady) return;
        this._cancelHomeDndMenuTimer();
        this._homeDndReady = false;
        this._homeDndActive = true;
        this._closeHomeFolderPopup();
        let sourceBtn = this._homeDndSourceBtn;
        let item = this._homeDndItem;
        this._setHomeDndReadyVisual(sourceBtn, false);
        this._homeDndSourceBtn = null;
        if (sourceBtn) sourceBtn.opacity = 100;

        let ghostW = this._cellW, ghostH = this._cellW;
        if (this._isWidget(item)) {
            let cs = item.colSpan || 1, rs = item.rowSpan || 1;
            ghostW = cs * this._cellW + (cs - 1) * this._colSpacing;
            ghostH = rs * this._cellH + (rs - 1) * this._rowSpacing;
            this._homeDndGhost = new St.Widget({ style_class: 'convergence-widget-dnd-ghost', width: ghostW, height: ghostH, opacity: 230, layout_manager: new Clutter.BinLayout() });
            let widgetDef = getWidgetDefinition(item.widgetType, { allowMissing: true });
            this._homeDndGhost.add_child(new St.Label({ text: widgetDef?.label ?? item.widgetType ?? 'Widget', style_class: 'convergence-widget-ghost-label', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true }));
        } else {
            this._homeDndGhost = new St.Widget({ style_class: 'convergence-dnd-ghost', width: ghostW, height: ghostH, opacity: 230 });
            let app = this._homeDndApp;
            if (app) this._homeDndGhost.add_child(app.create_icon_texture(this._iconSize));
        }

        this._homeDndGhostW = ghostW; this._homeDndGhostH = ghostH;
        Main.layoutManager.uiGroup.add_child(this._homeDndGhost);
        this._homeDndGhost.set_position(x - ghostW / 2, y - ghostH / 2);
        this._homeDndGhost.set_pivot_point(0.5, 0.5);
        this._homeDndGhost.ease({ scale_x: 1.15, scale_y: 1.15, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        this.enterSpringLoaded();
        this._showDndRemoveZone();
        this._homeDndGrab = global.stage.grab(this._actor);
    }

    _updateHomeDnd(x, y) {
        if (!this._homeDndActive) return;
        if (this._homeDndGhost) this._homeDndGhost.set_position(x - (this._homeDndGhostW || this._cellW) / 2, y - (this._homeDndGhostH || this._cellW) / 2);
        this._updateRemoveZoneHover(x, y);

        // Cross-monitor DnD: detect when pointer moves to a different monitor's home screen
        let targetHS = this._controller?.getHomeScreenForCoords?.(x, y);
        if (targetHS && targetHS !== this && targetHS._visible) {
            if (this._crossMonitorDndTarget !== targetHS) {
                // Leaving previous target (or source): exit its spring-loaded mode
                if (this._crossMonitorDndTarget && this._crossMonitorDndTarget !== this) {
                    this._crossMonitorDndTarget._homeDndItem = null;
                    this._crossMonitorDndTarget.exitSpringLoaded();
                } else {
                    this.exitSpringLoaded();
                }
                this._crossMonitorDndTarget = targetHS;
                // Set DnD item on target so spring-loaded highlights correctly
                targetHS._homeDndItem = this._homeDndItem;
                targetHS.enterSpringLoaded();
            }
            targetHS.updateSpringLoadedHover(x, y);
        } else if (targetHS === this || !targetHS) {
            if (this._crossMonitorDndTarget && this._crossMonitorDndTarget !== this) {
                // Returned to source monitor: exit target's spring-loaded, re-enter ours
                this._crossMonitorDndTarget._homeDndItem = null;
                this._crossMonitorDndTarget.exitSpringLoaded();
                this._crossMonitorDndTarget = null;
                this.enterSpringLoaded();
            }
            this.updateSpringLoadedHover(x, y);
        }
    }

    _finishHomeDnd(x, y) {
        if (!this._homeDndActive) return;
        if (this._hitTestRemoveZone(x, y) && this._homeDndItem) {
            this._emitHomeFeedback('remove');
            if (this._isFile(this._homeDndItem)) this._moveFileToTrash(this._homeDndItem);
            else this._removeHomeIcon(this._homeDndItem);
            this._cancelHomeDnd(); return;
        }

        // Cross-monitor drop: delegate to the target home screen
        let targetHS = this._crossMonitorDndTarget;
        if (targetHS && targetHS !== this && targetHS._visible) {
            let target = targetHS._springLoaded ? targetHS.updateSpringLoadedHover(x, y) : null;
            if (target) {
                let draggedItem = this._homeDndItem;
                let dropPage = targetHS._homeCurrentPage;
                let accepted = targetHS._acceptCrossMonitorDrop(draggedItem, target, dropPage);
                if (accepted) {
                    // Remove item from source and do a single atomic save
                    // covering both monitors to avoid settings change listeners
                    // reloading stale data from a partial write.
                    this._homeGridItems = this._homeGridItems.filter(i => i !== draggedItem);
                    this._markManualHomeCellEdit();
                    this._flushCrossMonitorSave(targetHS);
                    this._emitHomeFeedback('drop');
                }
            }
            this._cancelHomeDnd();
            return;
        }

        let target = this._springLoaded ? this.updateSpringLoadedHover(x, y) : null;
        if (target) {
            let draggedItem = this._homeDndItem;
            let dropPage = this._homeCurrentPage;

            if (draggedItem && this._isWidget(draggedItem)) {
                // Widget repositioning: check for collisions with other widgets
                let colSpan = draggedItem.colSpan || 1;
                let rowSpan = draggedItem.rowSpan || 1;
                let blocked = false;
                for (let r = target.row; r < target.row + rowSpan && !blocked; r++) {
                    for (let c = target.col; c < target.col + colSpan && !blocked; c++) {
                        let occupant = this._homeGridItems.find(i => {
                            if (i === draggedItem) return false;
                            if ((i.page ?? 0) !== dropPage) return false;
                            if (!this._isWidget(i)) return false;
                            return c >= i.col && c < i.col + (i.colSpan || 1) &&
                                   r >= i.row && r < i.row + (i.rowSpan || 1);
                        });
                        if (occupant) blocked = true;
                    }
                }
                if (!blocked) {
                    // Apply displaced positions from spring-loaded mode
                    for (let [item, pos] of this._widgetDisplacedPositions) {
                        item.col = pos.col;
                        item.row = pos.row;
                    }
                    this._homeGridItems = this._homeGridItems.filter(i => i !== draggedItem);
                    draggedItem.col = target.col;
                    draggedItem.row = target.row;
                    draggedItem.page = dropPage;
                    this._homeGridItems.push(draggedItem);
                    this._markManualHomeCellEdit(); this._saveHomeLayout(); this._emitHomeFeedback('drop');
                }
            } else if (draggedItem && !this._isFile(draggedItem)) {
                // App icon / folder repositioning
                let targetItem = this._getItemAtCell(target.col, target.row, dropPage);
                if (targetItem && this._isWidget(targetItem) && targetItem.widgetType === 'trash') {
                    // Drop onto recycle bin: remove item
                    if (this._isFile(draggedItem)) this._moveFileToTrash(draggedItem);
                    else this._removeHomeIcon(draggedItem);
                    this._emitHomeFeedback('remove');
                } else if (targetItem && (this._isWidget(targetItem) || this._isFile(targetItem))) {
                    // No-op: can't drop onto other widgets or file items
                } else if (!targetItem) {
                    this._homeGridItems = this._homeGridItems.filter(i => i !== draggedItem);
                    if (this._isFolder(draggedItem)) { draggedItem.col = target.col; draggedItem.row = target.row; draggedItem.page = dropPage; this._homeGridItems.push(draggedItem); }
                    else this._homeGridItems.push({ id: draggedItem.id, col: target.col, row: target.row, page: dropPage });
                    this._markManualHomeCellEdit(); this._saveHomeLayout(); this._emitHomeFeedback('drop');
                } else if (targetItem && this._isFolder(targetItem)) {
                    this._addToHomeFolder(draggedItem, targetItem);
                    this._markManualHomeCellEdit(); this._saveHomeLayout(); this._emitHomeFeedback('drop');
                } else if (targetItem && !this._isWidget(targetItem) && !this._isFile(targetItem)) {
                    this._createHomeFolder(draggedItem, targetItem, target.col, target.row, dropPage);
                    this._markManualHomeCellEdit(); this._saveHomeLayout(); this._emitHomeFeedback('drop');
                }
            } else if (draggedItem && this._isFile(draggedItem)) {
                // File item repositioning
                let targetItem = this._getItemAtCell(target.col, target.row, dropPage);
                if (!targetItem) {
                    this._homeGridItems = this._homeGridItems.filter(i => i !== draggedItem);
                    draggedItem.col = target.col; draggedItem.row = target.row; draggedItem.page = dropPage;
                    this._homeGridItems.push(draggedItem);
                    this._markManualHomeCellEdit(); this._saveHomeLayout(); this._emitHomeFeedback('drop');
                }
            }
        }
        this._cancelHomeDnd();
    }

    // ── External DnD (from app drawer) ─────────────────────────────

    /**
     * Accept an icon drop from the app drawer onto the home screen.
     * @param {string} appId — the app's .desktop ID
     * @param {number} x — stage x coordinate of the drop
     * @param {number} y — stage y coordinate of the drop
     */
    acceptExternalDrop(appId, x, y) {
        if (!appId) return;
        let target = this.updateSpringLoadedHover?.(x, y);
        let dropPage = this._homeCurrentPage ?? 0;

        // Find an empty cell if spring-loaded didn't give us one
        if (!target)
            target = this._findFirstEmptyCell(dropPage);
        if (!target) return;

        let targetItem = this._getItemAtCell?.(target.col, target.row, dropPage);
        if (targetItem && (this._isWidget?.(targetItem) || this._isFile?.(targetItem)))
            return; // Can't drop onto widgets or files

        if (!targetItem) {
            // Empty cell — place app shortcut
            this._homeGridItems.push({
                id: appId,
                col: target.col,
                row: target.row,
                page: dropPage,
            });
        } else if (targetItem && this._isFolder?.(targetItem)) {
            // Drop onto folder — add to it
            this._addToHomeFolder?.({ id: appId, type: 'app' }, targetItem);
        } else if (targetItem && targetItem.id) {
            // Drop onto another app — create folder
            this._createHomeFolder?.(
                { id: appId, type: 'app' }, targetItem,
                target.col, target.row, dropPage);
        }

        this._markManualHomeCellEdit?.();
        this._saveHomeLayout?.();
        this._emitHomeFeedback?.('drop');
        this.exitSpringLoaded?.();
        this._renderHomeGrid();
    }

    /**
     * Show visual hover feedback for an external DnD over the home screen.
     * @param {number} x — stage x coordinate
     * @param {number} y — stage y coordinate
     * @returns {{ col: number, row: number }|null}
     */
    showExternalDndHover(x, y) {
        if (!this._springLoaded)
            this.enterSpringLoaded?.();
        return this.updateSpringLoadedHover?.(x, y) ?? null;
    }

    /**
     * Cancel external DnD hover feedback.
     */
    cancelExternalDndHover() {
        this.exitSpringLoaded?.();
    }

    /**
     * Accept an item dropped from another monitor's home screen.
     * @param {object} draggedItem - The item being dragged.
     * @param {{ col: number, row: number }} target - Target cell on this grid.
     * @param {number} dropPage - The page to drop onto.
     * @returns {boolean} Whether the drop was accepted.
     */
    _acceptCrossMonitorDrop(draggedItem, target, dropPage) {
        if (!draggedItem) return false;

        if (this._isWidget(draggedItem)) {
            let colSpan = draggedItem.colSpan || 1;
            let rowSpan = draggedItem.rowSpan || 1;
            // Clamp widget to fit this monitor's grid
            if (colSpan > this._homeCols) colSpan = this._homeCols;
            let maxRows = this._computeGridRows();
            if (rowSpan > maxRows) rowSpan = maxRows;
            let col = Math.min(target.col, this._homeCols - colSpan);
            let row = Math.min(target.row, maxRows - rowSpan);
            // Check for collisions
            for (let r = row; r < row + rowSpan; r++) {
                for (let c = col; c < col + colSpan; c++) {
                    let occupant = this._homeGridItems.find(i => {
                        if ((i.page ?? 0) !== dropPage) return false;
                        if (!this._isWidget(i)) return false;
                        return c >= i.col && c < i.col + (i.colSpan || 1) &&
                               r >= i.row && r < i.row + (i.rowSpan || 1);
                    });
                    if (occupant) return false;
                }
            }
            let newItem = {
                type: 'widget', widgetType: draggedItem.widgetType,
                instanceId: draggedItem.instanceId,
                col, row, page: dropPage,
                colSpan, rowSpan,
            };
            if (draggedItem.widgetData) newItem.widgetData = draggedItem.widgetData;
            this._homeGridItems.push(newItem);
        } else if (this._isFolder(draggedItem)) {
            let targetItem = this._getItemAtCell(target.col, target.row, dropPage);
            if (targetItem) return false;
            this._homeGridItems.push({
                type: 'folder', name: draggedItem.name,
                apps: [...(draggedItem.apps || [])],
                col: target.col, row: target.row, page: dropPage,
            });
        } else if (this._isFile(draggedItem)) {
            let targetItem = this._getItemAtCell(target.col, target.row, dropPage);
            if (targetItem) return false;
            this._homeGridItems.push({
                type: 'file', uri: draggedItem.uri,
                col: target.col, row: target.row, page: dropPage,
            });
        } else {
            // App icon
            let targetItem = this._getItemAtCell(target.col, target.row, dropPage);
            if (targetItem && this._isWidget(targetItem)) return false;
            if (targetItem && this._isFile(targetItem)) return false;
            if (targetItem && this._isFolder(targetItem)) {
                // Drop into existing folder
                let appId = draggedItem.id;
                if (appId && !targetItem.apps.includes(appId))
                    targetItem.apps.push(appId);
            } else if (targetItem && !this._isWidget(targetItem) && !this._isFile(targetItem)) {
                // Create folder from two app icons
                let apps = [];
                if (targetItem.id) apps.push(targetItem.id);
                if (draggedItem.id) apps.push(draggedItem.id);
                this._homeGridItems = this._homeGridItems.filter(i => i !== targetItem);
                this._homeGridItems.push({
                    type: 'folder', name: 'Folder', apps,
                    col: target.col, row: target.row, page: dropPage,
                });
            } else if (!targetItem) {
                this._homeGridItems.push({
                    id: draggedItem.id,
                    col: target.col, row: target.row, page: dropPage,
                });
            } else {
                return false;
            }
        }

        this._homeDndItem = null;
        this.exitSpringLoaded();
        this._markManualHomeCellEdit();
        // Don't save here — the source will do a single atomic save via
        // _flushCrossMonitorSave that covers both monitors at once.
        this._renderHomeGrid();
        return true;
    }

    /**
     * Find the first empty cell on a page.
     */
    _findFirstEmptyCell(page) {
        let cols = this._homeCols ?? 4;
        let rows = this._homeRows ?? 5;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let occupied = this._homeGridItems?.some(i =>
                    (i.page ?? 0) === page && i.col === c && i.row === r);
                if (!occupied) return { col: c, row: r };
            }
        }
        return null;
    }

    _cancelHomeDnd() {
        if (this._homeDndGrab) { this._homeDndGrab.dismiss(); this._homeDndGrab = null; }
        if (this._homeDndGhost) {
            if (this._homeDndGhost.get_parent()) this._homeDndGhost.get_parent().remove_child(this._homeDndGhost);
            this._homeDndGhost.destroy(); this._homeDndGhost = null;
        }
        this._hideDndRemoveZone();
        // Clean up cross-monitor DnD state
        if (this._crossMonitorDndTarget && this._crossMonitorDndTarget !== this) {
            this._crossMonitorDndTarget._homeDndItem = null;
            if (this._crossMonitorDndTarget._springLoaded)
                this._crossMonitorDndTarget.exitSpringLoaded();
            else
                this._crossMonitorDndTarget._renderHomeGrid();
        }
        this._crossMonitorDndTarget = null;
        this._homeDndActive = false; this._homeDndReady = false;
        this._setHomeDndReadyVisual(this._homeDndSourceBtn, false);
        this._homeDndSourceBtn = null; this._homeDndItem = null; this._homeDndApp = null;
        this._homeDndGhostW = 0; this._homeDndGhostH = 0;
        this._widgetDisplacedPositions.clear();
        this._cancelHomeDndMenuTimer();
        this._pruneEmptyTrailingPages();
        if (this._springLoaded)
            this.exitSpringLoaded();
        else
            this._renderHomeGrid();
    }

    _createHomeFolder(draggedItem, targetItem, col, row, page) {
        if (page === undefined) page = this._homeCurrentPage;
        let apps = [];
        if (this._isFolder(targetItem)) apps.push(...targetItem.apps);
        else if (targetItem.id) apps.push(targetItem.id);
        if (this._isFolder(draggedItem)) apps.push(...draggedItem.apps);
        else if (draggedItem.id) apps.push(draggedItem.id);
        apps = [...new Set(apps)];
        this._homeGridItems = this._homeGridItems.filter(i => i !== draggedItem && i !== targetItem);
        this._homeGridItems.push({ type: 'folder', name: 'Folder', apps, col, row, page });
    }

    _addToHomeFolder(draggedItem, folderItem) {
        let newApps = this._isFolder(draggedItem) ? draggedItem.apps : [draggedItem.id];
        for (let appId of newApps) { if (!folderItem.apps.includes(appId)) folderItem.apps.push(appId); }
        this._homeGridItems = this._homeGridItems.filter(i => i !== draggedItem);
    }

    _closeHomeFolderPopup(animate = true) {
        if (this._homeFolderPopup) global.stage.set_key_focus(null);
        if (this._homeFolderCaptureId) { global.stage.disconnect(this._homeFolderCaptureId); this._homeFolderCaptureId = 0; }
        let popup = this._homeFolderPopup;
        this._homeFolderPopup = null; this._currentHomeFolder = null;
        this._folderPages = []; this._folderPagesContainer = null;
        this._folderDotsContainer = null; this._folderCurrentPage = 0;
        this._folderPageWidth = 0; this._folderSwipePressed = false; this._folderSwipeClaimed = false;
        if (!popup) return;
        if (animate) {
            popup.reactive = false;
            popup.ease({ translation_y: 14, scale_x: 0.92, scale_y: 0.92, opacity: 0, duration: 170, mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => { if (popup.get_parent()) popup.get_parent().remove_child(popup); popup.destroy(); } });
        } else { if (popup.get_parent()) popup.get_parent().remove_child(popup); popup.destroy(); }
    }

    _renderHomeGrid() {
        if (!this._homePagesContainer) return;
        if (this._renderGridIdleId) { GLib.source_remove(this._renderGridIdleId); this._renderGridIdleId = 0; }
        this._renderGridBuildToken++;
        this._updateGridMetrics();
        if (this._widgetResizeOverlay) this._widgetResizeOverlay = null;
        if (this._springOverlay) this._springOverlay = null;
        for (let inst of this._widgetInstances.values()) inst.destroy();
        this._widgetInstances.clear();
        this._homePagesContainer.destroy_all_children();
        this._homePages = []; this._homeInnerGrids = []; this._homeGridButtons = [];

        let pw = this._homePageWidth || this._actor?.width || this._getHomeBounds().width;
        let gridRows = this._computeGridRows();
        let topInset = this._homeContentInset ?? this._getHomeContentInsetPx(this._getHomeMonitor());
        let bottomPad = this._bottomSpacer?.height ?? 0;
        let dotsH = 18;
        let availableGridH = Math.max(1, (this._actor?.height || this._getHomeBounds().height) - topInset - this._gridTopMargin - dotsH - bottomPad);
        let availableGridW = Math.max(1, pw - (topInset * 2));

        // Dynamically spread cells to fill available space (matches old extension).
        // On desktop, round spacing to integers so every gap is identical
        // across the grid. Phone layouts use fractional spacing to fill the
        // narrower screen edge-to-edge without visible rounding gaps.
        let isPhone = this._isPhoneLayoutMonitor();
        if (this._homeCols > 1) {
            let minColSpacing = Math.max(2, Math.round(4 * this._scale));
            let minNeededW = this._homeCols * this._cellW + (this._homeCols - 1) * minColSpacing;
            if (minNeededW > availableGridW) {
                let maxCellW = Math.floor((availableGridW - ((this._homeCols - 1) * minColSpacing)) / this._homeCols);
                this._cellW = Math.max(Math.round(REF_HOME_ICON_SIZE * this._scale * 1.05), maxCellW);
            }
            let rawSpacing = (availableGridW - (this._homeCols * this._cellW)) / (this._homeCols - 1);
            this._colSpacing = isPhone ? rawSpacing : Math.round(rawSpacing);
        }
        if (gridRows > 1) {
            let minRowSpacing = Math.max(2, Math.round(3 * this._scale));
            let rawRowSpacing = (availableGridH - (gridRows * this._cellH)) / (gridRows - 1);
            this._rowSpacing = Math.max(minRowSpacing, isPhone ? rawRowSpacing : Math.round(rawRowSpacing));
        }

        let gridW = this._homeCols * this._cellW + (this._homeCols - 1) * this._colSpacing;
        let gridH = gridRows * this._cellH + (gridRows - 1) * this._rowSpacing;
        let pageCount = this._getPageCount();
        let appSystem = Shell.AppSystem.get_default();
        let pageBuild = [];

        for (let p = 0; p < pageCount; p++) {
            let pageWidget = new St.Widget({
                width: snapToPixel(pw),
                height: snapToPixel(gridH),
                clip_to_allocation: true,
                layout_manager: new Clutter.FixedLayout(),
            });
            let innerGrid = new St.Widget({
                width: snapToPixel(gridW),
                height: snapToPixel(gridH),
                clip_to_allocation: true,
                layout_manager: new Clutter.FixedLayout(),
            });
            innerGrid.set_position(snapToPixel(topInset), 0);
            pageWidget.add_child(innerGrid);
            pageBuild.push({ page: p, pageItems: this._getItemsOnPage(p), innerGrid });
            this._homePagesContainer.add_child(pageWidget);
            this._homePages.push(pageWidget);
            this._homeInnerGrids.push(innerGrid);
        }

        this._homeGridClip.height = gridH;
        this._updateHomePageDots();
        this._homeSnapToPage(this._homeCurrentPage, false);

        let token = this._renderGridBuildToken;
        let pageIdx = 0, itemIdx = 0;
        let buildChunk = () => {
            if (token !== this._renderGridBuildToken) return GLib.SOURCE_REMOVE;
            let built = 0;
            while (pageIdx < pageBuild.length && built < HOME_GRID_BUILD_CHUNK) {
                let pageInfo = pageBuild[pageIdx];
                let items = pageInfo.pageItems;
                while (itemIdx < items.length && built < HOME_GRID_BUILD_CHUNK) {
                    let item = items[itemIdx++];
                    let btn;
                    if (this._isWidget(item)) { btn = this._createWidgetActor(item); }
                    else if (this._isFolder(item)) btn = this._createHomeFolderIcon(item);
                    else if (this._isFile(item)) btn = this._createFileIcon(item);
                    else { let app = appSystem.lookup_app(item.id); if (!app) continue; btn = this._createHomeIcon(app, item); }
                    if (!btn) continue;
                    let xPos = snapToPixel(item.col * (this._cellW + this._colSpacing));
                    let yPos = snapToPixel(item.row * (this._cellH + this._rowSpacing));
                    btn.set_position(xPos, yPos);
                    pageInfo.innerGrid.add_child(btn);
                    this._homeGridButtons.push({ btn, item, col: item.col, row: item.row, page: pageInfo.page });
                    built++;
                }
                if (itemIdx >= items.length) { pageIdx++; itemIdx = 0; }
            }
            if (pageIdx >= pageBuild.length) { this._renderGridIdleId = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        };
        if (buildChunk() === GLib.SOURCE_CONTINUE) {
            this._renderGridIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                let keep = buildChunk();
                if (keep === GLib.SOURCE_REMOVE) this._renderGridIdleId = 0;
                return keep;
            });
        }
    }

    _createHomeIcon(app, item) {
        let pad = this._labelPadH;
        let box = new St.BoxLayout({ style_class: 'convergence-home-icon-button', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, style: `padding: ${pad}px;` });
        let icon = app.create_icon_texture(this._iconSize);
        icon.set({ x_align: Clutter.ActorAlign.CENTER });
        box.add_child(icon);
        let label = new St.Label({ text: app.get_name(), style_class: 'convergence-home-icon-label', x_expand: true, style: `height: ${this._labelMaxHeight}px; font-size: ${this._labelFontSize}px; margin-top: ${this._labelMarginTop}px;` });
        label.clutter_text.set({ ellipsize: 3, line_wrap: true, line_wrap_mode: 2, max_length: 0 });
        label.clutter_text.set_line_alignment(1);
        box.add_child(label);
        let button = new St.Button({ child: box, width: this._cellW, height: this._cellH, style: 'padding: 0; margin: 0;' });
        addClickCursor(button, this._runtimeDisposer);

        let lpFired = false;
        let lpController = createLongPressController(HOME_LONG_PRESS_MS, (x, y) => { lpFired = true; this._beginHomeDndReady(button, item, app, x, y); });
        let startLp = (x, y) => { lpFired = false; this._cancelHomeDndMenuTimer(); lpController.start(x, y); };
        let cancelLp = () => { lpController.cancel(); this._setHomeDndReadyVisual(button, false); };

        button.connect('button-press-event', (_a, event) => {
            let btn = event.get_button ? event.get_button() : 0;
            if (btn === Clutter.BUTTON_SECONDARY) { cancelLp(); lpFired = true; let [ex, ey] = event.get_coords(); this._menus.showHomeAppMenu(ex, ey, app, item); return Clutter.EVENT_STOP; }
            box.add_style_pseudo_class('active'); let [x, y] = event.get_coords(); startLp(x, y); return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => { box.remove_style_pseudo_class('active'); cancelLp(); return Clutter.EVENT_PROPAGATE; });

        let touchStartX = 0, touchStartY = 0, touchTracking = false;
        let touchCancelDistSq = Math.pow(Math.max(10, Math.round(12 * (this._scale ?? 1))), 2);
        button.connect('touch-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                box.add_style_pseudo_class('active');
                let [x, y] = event.get_coords();
                touchStartX = x; touchStartY = y; touchTracking = true;
                startLp(x, y);
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (touchTracking && !lpFired && !this._homeDndActive && !this._homeDndReady) {
                    let [x, y] = event.get_coords();
                    let dx = x - touchStartX, dy = y - touchStartY;
                    if (dx * dx + dy * dy >= touchCancelDistSq) {
                        box.remove_style_pseudo_class('active');
                        cancelLp(); touchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END) {
                box.remove_style_pseudo_class('active');
                touchTracking = false; cancelLp();
            } else if (type === Clutter.EventType.TOUCH_CANCEL) {
                box.remove_style_pseudo_class('active');
                touchTracking = false; cancelLp();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('clicked', () => {
            if (!lpFired) {
                if (this._controller.activateApp)
                    this._controller.activateApp(app, this._getHomeMonitorIndex());
                else
                    app.activate();
            }
            lpFired = false;
        });
        return button;
    }

    _createHomeFolderIcon(folderItem) {
        let pad = this._labelPadH;
        let box = new St.BoxLayout({ style_class: 'convergence-home-icon-button', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, style: `padding: ${pad}px;` });
        let miniSize = Math.round(20 * (this._iconSize / REF_HOME_ICON_SIZE));
        let gap = Math.round(4 * (this._iconSize / REF_HOME_ICON_SIZE));
        let offset = (this._folderGridSize - 2 * miniSize - gap) / 2;
        let grid = new St.Widget({ style_class: 'convergence-folder-icon-grid', width: this._folderGridSize, height: this._folderGridSize, x_align: Clutter.ActorAlign.CENTER });
        let appSystem = Shell.AppSystem.get_default();
        for (let i = 0; i < Math.min(4, folderItem.apps.length); i++) {
            let a = appSystem.lookup_app(folderItem.apps[i]);
            if (!a) continue;
            let mi = a.create_icon_texture(miniSize);
            mi.set_position(offset + (i % 2) * (miniSize + gap), offset + Math.floor(i / 2) * (miniSize + gap));
            grid.add_child(mi);
        }
        box.add_child(grid);
        let label = new St.Label({ text: folderItem.name || 'Folder', style_class: 'convergence-home-icon-label', x_expand: true, style: `height: ${this._labelMaxHeight}px; font-size: ${this._labelFontSize}px; margin-top: ${this._labelMarginTop}px;` });
        label.clutter_text.set({ ellipsize: 3, line_wrap: true, line_wrap_mode: 2, max_length: 0 });
        label.clutter_text.set_line_alignment(1);
        box.add_child(label);
        let button = new St.Button({ child: box, width: this._cellW, height: this._cellH, style: 'padding: 0; margin: 0;' });
        addClickCursor(button, this._runtimeDisposer);

        let lpFired = false;
        let lpController = createLongPressController(HOME_LONG_PRESS_MS, (x, y) => { lpFired = true; this._beginHomeDndReady(button, folderItem, null, x, y); });
        button.connect('button-press-event', (_a, event) => { box.add_style_pseudo_class('active'); let [x, y] = event.get_coords(); lpFired = false; lpController.start(x, y); return Clutter.EVENT_PROPAGATE; });
        button.connect('button-release-event', () => { box.remove_style_pseudo_class('active'); lpController.cancel(); return Clutter.EVENT_PROPAGATE; });

        let fTouchStartX = 0, fTouchStartY = 0, fTouchTracking = false;
        let fTouchCancelDistSq = Math.pow(Math.max(10, Math.round(12 * (this._scale ?? 1))), 2);
        button.connect('touch-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                box.add_style_pseudo_class('active');
                let [x, y] = event.get_coords();
                fTouchStartX = x; fTouchStartY = y; fTouchTracking = true;
                lpFired = false; lpController.start(x, y);
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (fTouchTracking && !lpFired && !this._homeDndActive && !this._homeDndReady) {
                    let [x, y] = event.get_coords();
                    let dx = x - fTouchStartX, dy = y - fTouchStartY;
                    if (dx * dx + dy * dy >= fTouchCancelDistSq) {
                        box.remove_style_pseudo_class('active');
                        lpController.cancel(); fTouchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                box.remove_style_pseudo_class('active');
                fTouchTracking = false; lpController.cancel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('clicked', () => { if (!lpFired) this._openHomeFolderPopup(folderItem, button); lpFired = false; });
        return button;
    }

    _openHomeFolderPopup(folderItem, anchorActor) {
        this._closeHomeFolderPopup(false);
        this._currentHomeFolder = folderItem;
    }

    _updatePagesClip() {
        let pc = this._homePagesContainer;
        if (!pc) return;
        let pw = this._homePageWidth || this._actor?.width || 0;
        if (pw <= 0) return;
        let clipBox = this._homeGridClip?.get_allocation_box?.();
        let clipH = clipBox ? (clipBox.y2 - clipBox.y1) : (pc.height || 400);
        let tx = pc.translation_x || 0;
        pc.set_clip(-tx, 0, pw, clipH);
    }

    _homeSnapToPage(pageIndex, animate = true, velocityX = 0) {
        let pageCount = this._homePages.length;
        if (pageCount === 0) return;
        let prevPage = this._homeCurrentPage;
        pageIndex = Math.max(0, Math.min(pageCount - 1, pageIndex));
        this._homeCurrentPage = pageIndex;
        let pw = this._homePageWidth || this._actor?.width || this._getHomeBounds().width;
        let targetX = snapToPixel(-(pageIndex * pw));
        if (animate) {
            let duration = Math.max(170, Math.min(340, this._getHomePageSnapDuration(280, velocityX)));
            this._homePagesContainer.ease({ translation_x: targetX, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        } else { this._homePagesContainer.translation_x = targetX; }
        this._updateHomePageDots();
        if (prevPage !== pageIndex) { this._emitHomeFeedback('page-snap'); this._saveHomeLayout(); }
    }

    _updateHomePageDots() {
        if (!this._homeDotsContainer) return;
        let pageCount = this._homePages.length;
        let dots = this._homeDotsContainer.get_children();
        while (dots.length < pageCount) { let d = new St.Widget({ style_class: 'convergence-page-dot' }); this._homeDotsContainer.add_child(d); dots.push(d); }
        while (dots.length > pageCount) { let d = dots.pop(); this._homeDotsContainer.remove_child(d); d.destroy(); }
        if (pageCount <= 1) {
            this._homeDotsContainer.hide();
            return;
        }
        this._homeDotsContainer.show();
        for (let p = 0; p < dots.length; p++)
            dots[p].style_class = p === this._homeCurrentPage ? 'convergence-page-dot convergence-page-dot-active' : 'convergence-page-dot';
    }

    _loadHomeLayout() {
        let loadKey = this._getMonitorLayoutKey();


        if (this._saveLayoutTimeoutId) {
            GLib.source_remove(this._saveLayoutTimeoutId);
            this._saveLayoutTimeoutId = 0;
            if (this._pendingSaveKey && this._pendingSaveItems) {

                this._flushHomeLayoutSaveWithData(this._pendingSaveKey,
                    this._pendingSaveItems, this._pendingSaveCols,
                    this._pendingSavePage);
            }
            this._pendingSaveKey = null;
            this._pendingSaveItems = null;
        }

        this._homeGridItems = [];
        if (!this._settings) return;
        let json = this._settings.get_string('home-screen-layout');
        if (!json)
            return;
        try {
            let root = JSON.parse(json);
            let data;
            let layoutMigrated = false;
            if (root?.__version === 2) {
                let key = this._getMonitorLayoutKey();
                data = root.monitors?.[key] ?? { items: [], cols: this._homeCols };
                // New orientation/monitor key — check if this is the same
                // physical monitor in a different orientation. If so, let
                // it fall through to the default layout (clock widget)
                // rather than duplicating the other orientation's layout.
                // Each orientation maintains an independent layout.
                if (!root.monitors?.[key] && Object.keys(root.monitors ?? {}).length > 0) {
                    let isSibling = this._findOrientationSibling(root.monitors) !== null;
                    if (isSibling) {
                        // New orientation — start fresh with defaults
                        data = { items: [], cols: this._homeCols };
                    } else {
                        // Genuinely new monitor — start empty
                        this._homeGridItems = [];
                        return;
                    }
                }
            } else if (root && Array.isArray(root.items)) { data = root; }
            if (!data || !Array.isArray(data.items) || data.items.length === 0) {
                this._homeGridItems = [];
                // Only save if this key already existed (avoid persisting
                // empty layouts for new orientation keys)
                if (root?.__version === 2 && root.monitors?.[this._getMonitorLayoutKey()])
                    this._saveHomeLayout();
                return;
            }
            let appSystem = Shell.AppSystem.get_default();
            let validItems = [];
            for (let item of data.items) {
                if (!item) continue;
                let col = Math.max(0, Math.min(this._homeCols - 1, item.col ?? 0));
                let row = Math.max(0, item.row ?? 0);
                let page = Math.max(0, item.page ?? 0);
                if (item.type === 'widget') {
                    let def = getWidgetDefinition(item.widgetType, { allowMissing: true });
                    let colSpan = item.colSpan || def.defaultColSpan;
                    let rowSpan = item.rowSpan || def.defaultRowSpan;
                    col = Math.min(col, this._homeCols - colSpan);
                    let w = { type: 'widget', widgetType: item.widgetType, col, row, page, colSpan, rowSpan };
                    if (item.instanceId)
                        w.instanceId = item.instanceId;
                    if (item.widgetData) w.widgetData = item.widgetData;
                    if (!item.instanceId)
                        layoutMigrated = true;
                    ensureWidgetInstanceId(w);
                    validItems.push(w);
                } else if (item.type === 'folder') {
                    let validApps = (item.apps || []).filter(id => appSystem.lookup_app(id) !== null);
                    if (validApps.length === 0) continue;
                    if (validApps.length === 1) validItems.push({ id: validApps[0], col, row, page });
                    else validItems.push({ type: 'folder', name: item.name || 'Folder', apps: validApps, col, row, page });
                } else if (item.type === 'file') {
                    if (!item.uri) continue;
                    validItems.push({ type: 'file', uri: item.uri, col, row, page });
                } else {
                    if (!item.id) continue;
                    if (!appSystem.lookup_app(item.id)) continue;
                    validItems.push({ id: item.id, col, row, page });
                }
            }

            // Migration: if no clock widget exists, insert one and shift items down
            let hasClockWidget = validItems.some(
                i => i.type === 'widget' && i.widgetType === 'clock');
            if (!hasClockWidget) {
                let clockDef = getWidgetDefinition('clock');
                if (clockDef) {
                    for (let it of validItems)
                        it.row += clockDef.defaultRowSpan;
                    validItems.unshift({
                        type: 'widget',
                        widgetType: 'clock',
                        col: 0, row: 0, page: 0,
                        instanceId: ensureWidgetInstanceId({ type: 'widget' }),
                        colSpan: clockDef.defaultColSpan,
                        rowSpan: clockDef.defaultRowSpan,
                    });
                    this._homeGridItems = validItems;
                    this._saveHomeLayout();
                    return;
                }
            }

            this._lastSavedHomeLayoutJson = json;
            if (typeof data.activePage === 'number') this._homeCurrentPage = data.activePage;
            this._homeGridItems = validItems;
            if (layoutMigrated)
                this._saveHomeLayout();
        } catch { this._homeGridItems = []; }
    }

    /**
    * Populate the home grid with default widgets for a fresh install.
     * Creates a centered clock widget and a weather widget in the top-right area.
     */
    _populateDefaultWidgets() {
        let clockDef = getWidgetDefinition('clock');
        let weatherDef = getWidgetDefinition('weather');
        let hwMonDef = getWidgetDefinition('hw_monitor');
        let stickyDef = getWidgetDefinition('sticky_note');
        let cols = this._homeCols;
        let isDesktop = cols > 6;
        let items = [];

        // Right column: ~25% of grid width (matches old extension's 4/16 ratio)
        let rightColSpan = isDesktop ? Math.max(3, Math.round(cols * 0.25)) : 2;
        let rightCol = Math.max(0, cols - rightColSpan);
        let rightRow = 0;

        // Weather widget: top-right, 2 rows
        if (weatherDef) {
            let weatherRowSpan = isDesktop ? 2 : weatherDef.defaultRowSpan;
            items.push({
                type: 'widget', widgetType: 'weather',
                instanceId: ensureWidgetInstanceId({ type: 'widget' }),
                col: rightCol, row: rightRow, page: 0,
                colSpan: rightColSpan, rowSpan: weatherRowSpan,
            });
            rightRow += weatherRowSpan;
        }

        // Clock widget: centered in the remaining space, offset down
        if (clockDef) {
            let clockColSpan = isDesktop ? rightColSpan : Math.min(clockDef.defaultColSpan, cols);
            let clockRowSpan = isDesktop ? 2 : clockDef.defaultRowSpan;
            // Center the clock in the area left of the right column
            let clockAreaCols = isDesktop ? rightCol : cols;
            let clockCol = Math.max(0, Math.floor((clockAreaCols - clockColSpan) / 2));
            let clockRow = isDesktop ? 2 : 0;
            items.push({
                type: 'widget', widgetType: 'clock',
                instanceId: ensureWidgetInstanceId({ type: 'widget' }),
                col: clockCol, row: clockRow, page: 0,
                colSpan: clockColSpan, rowSpan: clockRowSpan,
            });
        }

        // System monitor: below weather, same width
        if (isDesktop && hwMonDef) {
            items.push({
                type: 'widget', widgetType: 'hw_monitor',
                instanceId: ensureWidgetInstanceId({ type: 'widget' }),
                col: rightCol, row: rightRow, page: 0,
                colSpan: rightColSpan, rowSpan: 1,
                widgetData: { showCores: false },
            });
            rightRow += 1;
        }

        // Sticky note: below system monitor
        if (isDesktop && stickyDef) {
            let stickyColSpan = Math.min(rightColSpan, cols);
            let stickyRowSpan = 2;
            items.push({
                type: 'widget', widgetType: 'sticky_note',
                instanceId: ensureWidgetInstanceId({ type: 'widget' }),
                col: rightCol, row: rightRow, page: 0,
                colSpan: stickyColSpan, rowSpan: stickyRowSpan,
            });
        }

        this._homeGridItems = items;
        if (items.length > 0)
            this._saveHomeLayout();
    }

    _saveHomeLayout() {
        // Snapshot the key, items, cols, and page NOW so that if
        // rotation happens before the debounced flush, the save
        // goes to the correct orientation key.
        this._pendingSaveKey = this._getMonitorLayoutKey();
        this._pendingSaveCols = this._homeCols;
        this._pendingSavePage = this._homeCurrentPage ?? 0;
        this._pendingSaveItems = this._homeGridItems.map(i => {
            if (this._isWidget(i)) {
                ensureWidgetInstanceId(i);
                let w = { type: 'widget', widgetType: i.widgetType, instanceId: i.instanceId,
                    col: i.col, row: i.row, page: i.page ?? 0, colSpan: i.colSpan, rowSpan: i.rowSpan };
                if (i.widgetData) w.widgetData = i.widgetData;
                return w;
            }
            if (this._isFolder(i)) return { type: 'folder', name: i.name, apps: i.apps, col: i.col, row: i.row, page: i.page ?? 0 };
            if (this._isFile(i)) return { type: 'file', uri: i.uri, col: i.col, row: i.row, page: i.page ?? 0 };
            return { id: i.id, col: i.col, row: i.row, page: i.page ?? 0 };
        });

        this._runtimeDisposer.restartTimeout(this, '_saveLayoutTimeoutId', GLib.PRIORITY_DEFAULT, LAYOUT_SAVE_DEBOUNCE_MS, () => {
            if (this._pendingSaveKey && this._pendingSaveItems)
                this._flushHomeLayoutSaveWithData(this._pendingSaveKey,
                    this._pendingSaveItems, this._pendingSaveCols,
                    this._pendingSavePage);
            this._pendingSaveKey = null;
            this._pendingSaveItems = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushHomeLayoutSaveWithData(myKey, items, cols, activePage) {
        if (!this._settings) return;
        let myData = { cols, activePage, items };
        let root;
        try { let existing = this._settings.get_string('home-screen-layout'); root = existing ? JSON.parse(existing) : null; } catch { root = null; }
        if (!root || root.__version !== 2) root = { __version: 2, monitors: {} };
        root.monitors[myKey] = myData;
        let json = JSON.stringify(root);
        this._lastSavedHomeLayoutJson = json;
        this._settings.set_string('home-screen-layout', json);
    }

    _flushHomeLayoutSave() {
        if (!this._settings) return;
        let myKey = this._getMonitorLayoutKey();
        this._flushHomeLayoutSaveImpl(myKey);
    }

    _flushHomeLayoutSaveImpl(myKey) {
        let myData = {
            cols: this._homeCols, activePage: this._homeCurrentPage ?? 0,
            items: this._homeGridItems.map(i => {
                let page = i.page ?? 0;
                if (this._isWidget(i)) {
                    ensureWidgetInstanceId(i);
                    let w = { type: 'widget', widgetType: i.widgetType, instanceId: i.instanceId, col: i.col, row: i.row, page, colSpan: i.colSpan, rowSpan: i.rowSpan };
                    if (i.widgetData) w.widgetData = i.widgetData;
                    return w;
                }
                if (this._isFolder(i)) return { type: 'folder', name: i.name, apps: i.apps, col: i.col, row: i.row, page };
                if (this._isFile(i)) return { type: 'file', uri: i.uri, col: i.col, row: i.row, page };
                return { id: i.id, col: i.col, row: i.row, page };
            }),
        };
        let root;
        try { let existing = this._settings.get_string('home-screen-layout'); root = existing ? JSON.parse(existing) : null; } catch { root = null; }
        if (!root || root.__version !== 2) root = { __version: 2, monitors: {} };
        root.monitors[myKey] = myData;
        let json = JSON.stringify(root);
        this._lastSavedHomeLayoutJson = json;
        this._settings.set_string('home-screen-layout', json);
    }

    /**
     * Atomically save both source (this) and target monitor layouts in one
     * settings write, preventing the changed::home-screen-layout listener
     * on either side from reloading stale data.
     */
    _flushCrossMonitorSave(targetHS) {
        if (!this._settings) return;
        // Cancel any pending debounced saves on both sides
        if (this._saveLayoutTimeoutId) {
            GLib.source_remove(this._saveLayoutTimeoutId);
            this._saveLayoutTimeoutId = 0;
        }
        if (targetHS._saveLayoutTimeoutId) {
            GLib.source_remove(targetHS._saveLayoutTimeoutId);
            targetHS._saveLayoutTimeoutId = 0;
        }
        let root;
        try { let existing = this._settings.get_string('home-screen-layout'); root = existing ? JSON.parse(existing) : null; } catch { root = null; }
        if (!root || root.__version !== 2) root = { __version: 2, monitors: {} };

        let serializeItems = (hs) => hs._homeGridItems.map(i => {
            let page = i.page ?? 0;
            if (hs._isWidget(i)) {
                ensureWidgetInstanceId(i);
                let w = { type: 'widget', widgetType: i.widgetType, instanceId: i.instanceId, col: i.col, row: i.row, page, colSpan: i.colSpan, rowSpan: i.rowSpan };
                if (i.widgetData) w.widgetData = i.widgetData;
                return w;
            }
            if (hs._isFolder(i)) return { type: 'folder', name: i.name, apps: i.apps, col: i.col, row: i.row, page };
            if (hs._isFile(i)) return { type: 'file', uri: i.uri, col: i.col, row: i.row, page };
            return { id: i.id, col: i.col, row: i.row, page };
        });

        root.monitors[this._getMonitorLayoutKey()] = {
            cols: this._homeCols, activePage: this._homeCurrentPage ?? 0,
            items: serializeItems(this),
        };
        root.monitors[targetHS._getMonitorLayoutKey()] = {
            cols: targetHS._homeCols, activePage: targetHS._homeCurrentPage ?? 0,
            items: serializeItems(targetHS),
        };

        let json = JSON.stringify(root);
        this._lastSavedHomeLayoutJson = json;
        targetHS._lastSavedHomeLayoutJson = json;
        this._settings.set_string('home-screen-layout', json);
    }

    /** Show the home screen. */
    show() {
        if (!this._visible && this._actor) {
            this._placeBehindWindows();
            this._actor.reactive = true; this._actor.show();
            let duration = this._firstShow ? 500 : 200;
            this._firstShow = false;
            this._actor.ease({ opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            this._visible = true;
        }
    }

    /**
     * Show the home screen after a workspace switch with a delayed fade-in.
     * @param {number} delayMs - Delay before fade-in starts (default 200).
     */
    showAfterWorkspaceSwitch(delayMs = 200) {
        if (!this._actor) return;
        this._cancelWsFadeIn();
        this._placeBehindWindows();
        this._actor.remove_all_transitions();
        this._actor.opacity = 0;
        this._actor.show();
        this._actor.reactive = true;
        this._visible = true;
        this._runtimeDisposer.restartTimeout(
            this, '_wsFadeInId',
            GLib.PRIORITY_DEFAULT, delayMs,
            () => {
                if (this._actor && this._visible) {
                    this._actor.ease({
                        opacity: 255, duration: 250,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Cancel any pending workspace fade-in timeout. */
    _cancelWsFadeIn() {
        this._runtimeDisposer.clearTimeoutRef(this, '_wsFadeInId');
    }

    /** Hide the home screen. */
    hide() {
        this._cancelWsFadeIn();
        if (this._visible && this._actor) {
            this._pressed = false; this._claimed = false; this._cancelBgLongPress();
            if (this._homeDndReady) this._resetHomeDndReadyState();
            if (this._homeDndActive) this._cancelHomeDnd();
            this._actor.reactive = false; this._actor.remove_all_transitions();
            this._actor.opacity = 0; this._actor.hide();
            this._visible = false;
        }
    }

    /** Relayout after monitor or settings changes. */
    relayout() {
        if (!this._actor) return;
        this._endHomeDrawerReveal(false);
        this._placeBehindWindows();
        let bounds = this._getHomeBounds();
        this._actor.set_position(bounds.x, bounds.y);
        this._actor.set_size(bounds.width, bounds.height);
        if (this._widgetResizeActive) this._exitWidgetResizeMode();
        this._closeHomeFolderPopup(false);
        if (this._homeDndActive) this._cancelHomeDnd();
        else if (this._springLoaded) this.exitSpringLoaded();
        if (this._bottomSpacer) {
            let monIdx = this._getHomeMonitorIndex();
            this._bottomSpacer.height = (this._homeDockBottomInset ?? 0) > 0 ? 0 : this._getDockHeightForMonitor(monIdx);
        }
        if (this._topSpacer) this._topSpacer.height = this._getHomeContentInsetPx(this._getHomeMonitor());
        this._renderHomeGrid();
    }

    setMonitorIndex(monitorIndex = null) {
        this._fixedMonitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
    }

    refreshTopology(monitorIndex = null) {
        this.setMonitorIndex(monitorIndex);
        this._pressed = false;
        this._claimed = false;
        this._cancelBgLongPress();
        this._dismissHomeMenu(false);
        this._closeHomeFolderPopup(false);
        if (this._widgetResizeActive)
            this._exitWidgetResizeMode();
        if (this._homeDndReady)
            this._resetHomeDndReadyState();
        if (this._homeDndActive)
            this._cancelHomeDnd();
        else if (this._springLoaded)
            this.exitSpringLoaded();
    }

    /** Set extension settings and wire up listeners. */
    setSettings(settings) {
        this._settings = settings;
        this._logger?.destroy?.();
        this._logger = new Logger('HomeScreen', settings);
        const dockKeys = ['taskbar-thickness', 'taskbar-panel-mode'];
        for (let key of dockKeys) { try { this._runtimeDisposer.connect(settings, `changed::${key}`, () => this.relayout()); } catch (_e) {} }
        try {
            this._runtimeDisposer.connect(settings, 'changed::home-screen-layout', () => {
                let latest = settings.get_string('home-screen-layout');
                if (latest === this._lastSavedHomeLayoutJson)
                    return;
                this._lastSavedHomeLayoutJson = latest;
                this._loadHomeLayout();
                this._renderHomeGrid();
            });
        } catch (_e) {}
        this._loadHomeLayout();
        this._startDesktopFileMonitor();
        this._syncDesktopFiles();
        this._renderHomeGrid();
        this.relayout();
    }

    /** Destroy the home screen and clean up all resources. */
    destroy() {
        this._desktopFiles.destroy();
        for (let inst of this._widgetInstances.values()) inst.destroy();
        this._widgetInstances.clear();
        this._runtimeDisposer.dispose();
        this._logger?.destroy?.();
        if (this._actor) {
            if (this._actor.get_parent()) this._actor.get_parent().remove_child(this._actor);
            this._actor.destroy(); this._actor = null;
        }
    }
}
