// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getAdaptiveScale, snapToPixel } from '../../shared/utilities/uiUtils.js';
import { REF_SCREEN_W, REF_COL_COUNT_PITCH } from '../../shared/utilities/layoutConstants.js';

const REF_DRAWER_COLS = 5;
const REF_DRAWER_CELL_W = 72;
const REF_DRAWER_CELL_H = 96;
const REF_DRAWER_ICON_SIZE = 48;
const REF_DRAWER_COL_SPACING = 4;
const REF_DRAWER_ROW_SPACING = 16;
// Halved from REF_SCREEN_W to match logical-width adaptive scaling.
const REF_DRAWER_SCREEN_W = REF_SCREEN_W / 2;
const REF_DRAWER_CELL_PITCH = REF_DRAWER_CELL_W + REF_DRAWER_COL_SPACING;

const GRID_H_MARGIN = 32;
const APP_LABEL_HEIGHT = 28;
const EXPANDED_CHROME = 180;

const MIN_DOCK_CONTENT_SCALE = 0.7;
const PHONE_DOCK_MAX_ICONS = 5;
const PHONE_ATTACHED_GRID_MAX_COLS = 5;

/**
 * Phone-specific grid layout calculator.
 *
 * Computes column/row counts, icon sizing, cell dimensions, page height,
 * and dock metrics based on the current screen geometry.  All values are
 * written directly onto the parent AppDrawer instance so the rest of the
 * drawer can read them as simple properties.
 */
export class DrawerGrid {
    /**
     * @param {import('./appDrawer.js').AppDrawer} drawer - Parent drawer instance.
     * @param {import('gi://Gio').Settings|null} settings - Extension GSettings.
     */
    constructor(drawer, settings) {
        this._drawer = drawer;
        this._settings = settings ?? null;
    }

    /**
     * Recalculate all grid metrics and write them onto the drawer.
     *
     * Must be called whenever screen size, orientation, or scale factor
     * changes.  The drawer reads `this._cols`, `this._rows`,
     * `this._iconSize`, etc. directly after this call.
     */
    updateDrawerMetrics() {
        let d = this._drawer;
        let monitor = d._getLayoutMonitor?.() ?? Main.layoutManager?.primaryMonitor ?? null;

        let stageW = monitor ? monitor.width : global.stage.width;
        let stageH = monitor ? monitor.height : global.stage.height;
        let panelH = d._getEffectivePanelHeight();
        let fullH = stageH - panelH;

        let minGridScale = 0.85;
        let maxGridScale = 1.45;
        let baseScale = getAdaptiveScale({
            profile: 'grid',
            monitor,
            logicalWidth: stageW,
            referenceWidth: REF_DRAWER_SCREEN_W,
            min: minGridScale,
            max: maxGridScale,
        });

        let homeUsableW = stageW - 24;
        let scaledPitch = REF_COL_COUNT_PITCH * baseScale;
        let dockCapCols = Math.max(4, Math.round(homeUsableW / scaledPitch));

        if (this._settings) {
            try {
                let capEnabled = this._settings.get_boolean('drawer-max-columns-enabled');
                if (capEnabled) {
                    let maxCols = this._settings.get_int('drawer-max-columns');
                    let cap = Math.max(4, maxCols);
                    dockCapCols = Math.min(dockCapCols, cap);
                }
            } catch (_e) { /* key may not exist yet */ }
        }

        d._cols = PHONE_ATTACHED_GRID_MAX_COLS;

        let fitScale = baseScale;
        let fitWidth = stageW - 32 - GRID_H_MARGIN;
        let refGridW = d._cols * REF_DRAWER_CELL_W +
            (d._cols - 1) * REF_DRAWER_COL_SPACING;
        if (refGridW > 0 && fitWidth > 0) {
            let colsScale = fitWidth / refGridW;
            fitScale = Math.min(baseScale, colsScale);
        }
        let scale = Math.max(MIN_DOCK_CONTENT_SCALE, fitScale);

        d._drawerColSpacing = Math.round(
            snapToPixel(REF_DRAWER_COL_SPACING * scale, monitor));
        d._drawerRowSpacing = Math.min(
            Math.round(snapToPixel(REF_DRAWER_ROW_SPACING * scale, monitor)),
            Math.round(snapToPixel(4, monitor)));
        d._iconSize = Math.round(
            snapToPixel(REF_DRAWER_ICON_SIZE * scale, monitor));

        let phoneScale = Math.max(0.9, Math.min(1.2, scale));
        d._dockIconSize = Math.round(48 * phoneScale);
        d._dockRowPadTop = Math.max(4, Math.round(8 * phoneScale));
        d._dockRowPadBottom = Math.max(4, Math.round(8 * phoneScale));
        d._dockRowPadSide = Math.max(8, Math.round(16 * phoneScale));
        d._dockSectionPadTop = Math.max(2, Math.round(3 * phoneScale));
        d._dockSectionPadBottom = Math.max(3, Math.round(5 * phoneScale));
        d._dockSectionPadSide = Math.max(8, Math.round(10 * phoneScale));
        d._dockSectionRadius = Math.max(18, Math.round(26 * phoneScale));

        d._labelFontSize = 14;
        d._labelMarginTop = Math.round(snapToPixel(4 * scale, monitor));
        d._labelPadH = Math.round(snapToPixel(2 * scale, monitor));
        d._labelH = Math.round(d._labelFontSize * 2.7);

        d._folderGridSize = Math.round(snapToPixel(52 * scale, monitor));
        d._folderMiniSize = Math.round(snapToPixel(20 * scale, monitor));

        d._iconCellW = Math.round(snapToPixel(REF_DRAWER_CELL_W * scale, monitor));
        d._dockCellW = d._iconCellW;
        d._iconSize = d._dockIconSize;

        let iconAreaH = Math.max(d._iconSize, d._folderGridSize);
        d._iconCellH = iconAreaH + d._labelMarginTop + d._labelH + 2 * d._labelPadH;

        let dockSidePad = d._dockRowPadSide ?? 16;
        let sideMargin = Math.max(GRID_H_MARGIN, dockSidePad * 2);
        let gridContentW = d._cols * d._iconCellW +
            (d._cols - 1) * d._drawerColSpacing;
        d._computedDrawerWidth = Math.min(gridContentW + sideMargin, stageW - 32);

        // If clamped, shrink dock cell width so icons fit within the drawer
        let availForIcons = d._computedDrawerWidth - sideMargin;
        if (availForIcons < gridContentW && d._cols > 1) {
            d._dockCellW = Math.floor(
                (availForIcons - (d._cols - 1) * d._drawerColSpacing) / d._cols);
            d._iconCellW = d._dockCellW;
            gridContentW = d._cols * d._iconCellW +
                (d._cols - 1) * d._drawerColSpacing;
        }

        let favHeight = d._dockIconSize + d._dockRowPadTop + d._dockRowPadBottom;
        let fixedChrome = EXPANDED_CHROME - (REF_DRAWER_ICON_SIZE + 24);
        d._expandedChrome = favHeight + fixedChrome;

        let availableH = fullH - d._expandedChrome;
        let rowPitch = d._iconCellH + d._drawerRowSpacing;
        let fittedRows = Math.floor((availableH + d._drawerRowSpacing) / rowPitch);
        d._rows = Math.max(3, Math.min(6, fittedRows));

        d._appsPerPage = d._cols * d._rows;
        d._gridHeight = d._rows * d._iconCellH +
            (d._rows - 1) * d._drawerRowSpacing;

        d._maxDockIcons = PHONE_DOCK_MAX_ICONS;

        let dockUiScale = phoneScale;
        let searchGap = Math.round(8 * dockUiScale);
        let searchPad = Math.round(8 * dockUiScale);
        d._dockHeight = d._dockIconSize +
            d._dockRowPadTop + d._dockRowPadBottom +
            searchGap + 1 + searchPad;
    }

    /**
     * Retrieve the primary monitor from the global layout manager.
     * @returns {object|null}
     */
    _getPrimaryMonitor() {
        return this._drawer?._getLayoutMonitor?.() ?? Main.layoutManager?.primaryMonitor ?? null;
    }

    /**
     * Compute grid dimensions for a given number of items.
     * @param {number} itemCount - Total number of grid items.
     * @returns {{ pages: number, lastPageItems: number }}
     */
    computePageCount(itemCount) {
        let d = this._drawer;
        let perPage = (d._cols || 5) * (d._rows || 4);
        if (perPage <= 0)
            return { pages: 1, lastPageItems: itemCount };
        let pages = Math.max(1, Math.ceil(itemCount / perPage));
        let lastPageItems = itemCount - (pages - 1) * perPage;
        return { pages, lastPageItems };
    }

    /**
     * Convert a flat item index into column/row within its page.
     * @param {number} index - Flat index in the grid items array.
     * @returns {{ page: number, col: number, row: number }}
     */
    indexToGridPosition(index) {
        let d = this._drawer;
        let cols = d._cols || 5;
        let rows = d._rows || 4;
        let perPage = cols * rows;
        let page = Math.floor(index / perPage);
        let local = index - page * perPage;
        return {
            page,
            col: local % cols,
            row: Math.floor(local / cols),
        };
    }

    /**
     * Get the pixel height of a single grid page.
     * @returns {number}
     */
    getPageHeight() {
        let d = this._drawer;
        return d._gridHeight || 0;
    }
}
