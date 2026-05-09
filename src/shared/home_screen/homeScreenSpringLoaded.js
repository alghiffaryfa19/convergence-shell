// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Clutter from 'gi://Clutter';
import St from 'gi://St';

const SPRING_LOADED_TRANSITION = 150;
const REORDER_ANIM_DURATION = 150;
const ICON_DISPLACE_MAGNITUDE = 0.12;

/**
 * Spring-loaded folder opening, hover highlighting, and cell displacement
 * for the home screen drag-and-drop system.
 */
export class HomeScreenSpringLoaded {
    /**
     * @param {object} homeScreen - The HomeScreen instance.
     */
    constructor(homeScreen) {
        this._home = homeScreen;
    }

    /** Enter spring-loaded edit mode, showing empty cell outlines. */
    enterSpringLoaded() {
        let h = this._home;
        if (h._springLoaded) return;
        h._springLoaded = true;
        let isWidgetResizeMode = !!h._widgetResizeActive;

        h._homeGridRows = h._computeGridRows();
        let gridW = h._homeCols * h._cellW + (h._homeCols - 1) * h._colSpacing;
        let gridH = h._homeGridRows * h._cellH + (h._homeGridRows - 1) * h._rowSpacing;

        let innerGrid = h._homeInnerGrids[h._homeCurrentPage];
        if (innerGrid) {
            innerGrid.width = gridW;
            innerGrid.height = gridH;
        }

        if (isWidgetResizeMode)
            return;

        h._springOverlay = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            width: gridW, height: gridH, opacity: 0,
        });
        if (innerGrid)
            innerGrid.add_child(h._springOverlay);

        for (let row = 0; row < h._homeGridRows; row++) {
            for (let col = 0; col < h._homeCols; col++) {
                if (h._homeDndItem && h._isWidget(h._homeDndItem)) {
                    let di = h._homeDndItem;
                    if (col >= di.col && col < di.col + (di.colSpan || 1) &&
                        row >= di.row && row < di.row + (di.rowSpan || 1))
                        continue;
                } else if (h._homeDndItem &&
                    h._homeDndItem.col === col &&
                    h._homeDndItem.row === row) {
                    continue;
                }

                if (h._isCellOccupied(col, row))
                    continue;

                let outline = new St.Widget({
                    style_class: 'convergence-home-cell-outline',
                    width: h._cellW, height: h._cellH,
                });
                let x = col * (h._cellW + h._colSpacing);
                let y = row * (h._cellH + h._rowSpacing);
                outline.set_position(x, y);
                h._springOverlay.add_child(outline);
            }
        }

        h._springOverlay.ease({
            opacity: 255,
            duration: SPRING_LOADED_TRANSITION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /** Exit spring-loaded mode, clearing overlays and re-rendering. */
    exitSpringLoaded() {
        let h = this._home;
        if (!h._springLoaded) return;

        this.clearCellHighlight();

        if (h._springOverlay) {
            try {
                if (!h._springOverlay.is_destroyed?.() &&
                    h._springOverlay.get_parent())
                    h._springOverlay.get_parent().remove_child(h._springOverlay);
                if (!h._springOverlay.is_destroyed?.())
                    h._springOverlay.destroy();
            } catch (_e) {}
            h._springOverlay = null;
        }

        h._springLoaded = false;
        h._renderHomeGrid();
    }

    /**
     * Update the spring-loaded hover highlight based on cursor position.
     * @param {number} stageX
     * @param {number} stageY
     * @returns {{ col: number, row: number } | null}
     */
    updateSpringLoadedHover(stageX, stageY) {
        let h = this._home;
        let innerGrid = h._homeInnerGrids[h._homeCurrentPage];
        if (!h._springLoaded || !innerGrid)
            return null;

        let [gx, gy] = innerGrid.get_transformed_position();
        let gw = innerGrid.width;
        let gh = innerGrid.height;

        if (stageX < gx || stageX > gx + gw || stageY < gy || stageY > gy + gh) {
            this.clearCellHighlight();
            return null;
        }

        let localX = stageX - gx;
        let localY = stageY - gy;

        if (h._homeDndItem && h._isWidget(h._homeDndItem)) {
            let colSpan = h._homeDndItem.colSpan || 1;
            let rowSpan = h._homeDndItem.rowSpan || 1;
            localX -= (colSpan * h._cellW + (colSpan - 1) * h._colSpacing) / 2 - h._cellW / 2;
            localY -= (rowSpan * h._cellH + (rowSpan - 1) * h._rowSpacing) / 2 - h._cellH / 2;
        }

        let col = Math.min(h._homeCols - 1, Math.max(0,
            Math.floor(localX / (h._cellW + h._colSpacing))));
        let row = Math.min(h._homeGridRows - 1, Math.max(0,
            Math.floor(localY / (h._cellH + h._rowSpacing))));

        if (h._homeDndItem && h._isWidget(h._homeDndItem)) {
            let colSpan = h._homeDndItem.colSpan || 1;
            let rowSpan = h._homeDndItem.rowSpan || 1;
            col = Math.min(col, h._homeCols - colSpan);
            row = Math.min(row, h._homeGridRows - rowSpan);
        }

        let shouldHighlight = this._shouldHighlightSpringCell(col, row);
        if (!shouldHighlight) {
            if (h._cellHighlight) this.clearCellHighlight();
            return { col, row };
        }

        if (col !== h._cellHighlightCol || row !== h._cellHighlightRow)
            this._setCellHighlight(col, row);

        return { col, row };
    }

    _shouldHighlightSpringCell(col, row) {
        let h = this._home;
        if (h._homeDndItem && h._isWidget(h._homeDndItem)) {
            let colSpan = h._homeDndItem.colSpan || 1;
            let rowSpan = h._homeDndItem.rowSpan || 1;
            let page = h._homeCurrentPage;
            for (let r = row; r < row + rowSpan; r++) {
                for (let c = col; c < col + colSpan; c++) {
                    let occupant = h._getItemAtCell(c, r, page);
                    // Skip the dragged widget itself — it's being moved
                    if (occupant && occupant === h._homeDndItem)
                        continue;
                    if (occupant && h._isWidget(occupant))
                        return false;
                }
            }
            return true;
        }
        let occupant = h._getItemAtCell(col, row, h._homeCurrentPage);
        // Skip the dragged item itself for non-widget DnD too
        if (occupant && occupant === h._homeDndItem)
            return true;
        return !occupant;
    }

    _setCellHighlight(col, row) {
        let h = this._home;
        this.clearCellHighlight();

        h._cellHighlightCol = col;
        h._cellHighlightRow = row;

        let hlColSpan = 1;
        let hlRowSpan = 1;
        if (h._homeDndItem && h._isWidget(h._homeDndItem)) {
            hlColSpan = h._homeDndItem.colSpan || 1;
            hlRowSpan = h._homeDndItem.rowSpan || 1;
        }

        let x = col * (h._cellW + h._colSpacing);
        let y = row * (h._cellH + h._rowSpacing);
        let w = hlColSpan * h._cellW + (hlColSpan - 1) * h._colSpacing;
        let hh = hlRowSpan * h._cellH + (hlRowSpan - 1) * h._rowSpacing;

        h._cellHighlight = new St.Widget({
            style_class: 'convergence-home-cell-highlight',
            width: w, height: hh, opacity: 0,
        });
        h._cellHighlight.set_position(x, y);
        let currentInnerGrid = h._homeInnerGrids[h._homeCurrentPage];
        if (currentInnerGrid)
            currentInnerGrid.add_child(h._cellHighlight);

        h._cellHighlight.ease({
            opacity: 255, duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._displaceIcons(col, row, hlColSpan, hlRowSpan);
    }

    /** Clear the current cell highlight. */
    clearCellHighlight() {
        let h = this._home;
        if (h._cellHighlight) {
            if (h._cellHighlight.get_parent())
                h._cellHighlight.get_parent().remove_child(h._cellHighlight);
            h._cellHighlight.destroy();
            h._cellHighlight = null;
        }
        h._cellHighlightCol = -1;
        h._cellHighlightRow = -1;
        h._widgetDisplacedPositions.clear();

        for (let entry of h._homeGridButtons) {
            entry.btn.ease({
                translation_x: 0, translation_y: 0,
                duration: REORDER_ANIM_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _displaceIcons(hoverCol, hoverRow, hoverColSpan = 1, hoverRowSpan = 1) {
        let h = this._home;
        if (h._homeDndItem && h._isWidget(h._homeDndItem)) {
            this._reflowIconsForWidget(hoverCol, hoverRow, hoverColSpan, hoverRowSpan);
            return;
        }

        let hoverRight = hoverCol + hoverColSpan - 1;
        let hoverBottom = hoverRow + hoverRowSpan - 1;
        let currentPage = h._homeCurrentPage;

        for (let entry of h._homeGridButtons) {
            if ((entry.page ?? 0) !== currentPage) continue;
            let ic = entry.col;
            let ir = entry.row;

            let dc = ic < hoverCol ? ic - hoverCol :
                     ic > hoverRight ? ic - hoverRight : 0;
            let dr = ir < hoverRow ? ir - hoverRow :
                     ir > hoverBottom ? ir - hoverBottom : 0;
            let dist = Math.abs(dc) + Math.abs(dr);

            if (dist === 0) {
                let rectCenterC = hoverCol + (hoverColSpan - 1) / 2;
                let rectCenterR = hoverRow + (hoverRowSpan - 1) / 2;
                dc = ic - rectCenterC;
                dr = ir - rectCenterR;
                if (dc === 0 && dr === 0) dc = 1;
                dist = Math.abs(dc) + Math.abs(dr);
            }

            if (dist > 3) {
                entry.btn.ease({
                    translation_x: 0, translation_y: 0,
                    duration: REORDER_ANIM_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                continue;
            }

            let factor = ICON_DISPLACE_MAGNITUDE / dist;
            let dx = dc !== 0 ? Math.sign(dc) * factor * h._cellW : 0;
            let dy = dr !== 0 ? Math.sign(dr) * factor * h._cellH : 0;

            entry.btn.ease({
                translation_x: dx, translation_y: dy,
                duration: REORDER_ANIM_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _reflowIconsForWidget(hoverCol, hoverRow, colSpan, rowSpan) {
        let h = this._home;
        let hoverRight = hoverCol + colSpan;
        let hoverBottom = hoverRow + rowSpan;
        let currentPage = h._homeCurrentPage;

        let hoverCells = new Set();
        for (let r = hoverRow; r < hoverBottom; r++)
            for (let c = hoverCol; c < hoverRight; c++)
                hoverCells.add(`${c},${r}`);

        let displaced = [];
        let stationary = [];

        for (let entry of h._homeGridButtons) {
            if ((entry.page ?? 0) !== currentPage) continue;
            if (entry.item === h._homeDndItem) continue;
            if (entry.item === h._widgetResizeItem) continue;
            if (h._isWidget(entry.item)) {
                stationary.push(entry);
                continue;
            }
            if (hoverCells.has(`${entry.col},${entry.row}`))
                displaced.push(entry);
            else
                stationary.push(entry);
        }

        let occupied = new Set();
        for (let entry of stationary) {
            if (h._isWidget(entry.item)) {
                let cs = entry.item.colSpan || 1;
                let rs = entry.item.rowSpan || 1;
                for (let r = entry.item.row; r < entry.item.row + rs; r++)
                    for (let c = entry.item.col; c < entry.item.col + cs; c++)
                        occupied.add(`${c},${r}`);
            } else {
                occupied.add(`${entry.col},${entry.row}`);
            }
        }
        for (let key of hoverCells)
            occupied.add(key);

        displaced.sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
        h._widgetDisplacedPositions.clear();

        for (let entry of displaced) {
            let target = null;
            let bestScore = Infinity;

            for (let r = 0; r < h._homeGridRows; r++) {
                for (let c = 0; c < h._homeCols; c++) {
                    if (occupied.has(`${c},${r}`)) continue;
                    let dist = Math.abs(c - entry.col) + Math.abs(r - entry.row);
                    let score = r >= hoverRow ? dist + 1000 : dist;
                    if (score < bestScore) {
                        bestScore = score;
                        target = { col: c, row: r };
                    }
                }
            }

            if (target) {
                occupied.add(`${target.col},${target.row}`);
                h._widgetDisplacedPositions.set(entry.item, target);

                let origX = entry.col * (h._cellW + h._colSpacing);
                let origY = entry.row * (h._cellH + h._rowSpacing);
                let newX = target.col * (h._cellW + h._colSpacing);
                let newY = target.row * (h._cellH + h._rowSpacing);

                entry.btn.ease({
                    translation_x: newX - origX,
                    translation_y: newY - origY,
                    duration: REORDER_ANIM_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        }

        for (let entry of stationary) {
            entry.btn.ease({
                translation_x: 0, translation_y: 0,
                duration: REORDER_ANIM_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }
}
