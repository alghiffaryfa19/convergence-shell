// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { addClickCursor, getAdaptiveScale, snapToPixel } from '../../shared/utilities/uiUtils.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { Logger } from '../../shared/utilities/logger.js';

const SEARCH_DEBOUNCE_MS = 80;
const PANEL_OPEN_MS = 200;
const PANEL_CLOSE_MS = 180;

// Grid sizing reference values (scaled by monitor DPI)
const REF_ICON_SIZE = 48;
const REF_CELL_W = 72;
const REF_CELL_H = 96;
const REF_COL_SPACING = 4;
const REF_ROW_SPACING = 16;
const REF_LABEL_FONT_SIZE = 14;
const REF_LABEL_MAX_LINES = 2;
const REF_LABEL_MARGIN_TOP = 4;

// Panel sizing
const DETACHED_GRID_MIN_MARGIN = 28;
const PANEL_GAP = 8;
const PANEL_BOTTOM_OFFSET = 8;
const PANEL_MIN_TOP_MARGIN = 16;
const GRID_SIDE_MARGIN = 16;
const PANEL_CONTENT_PAD = 8;
const PANEL_MAX_W_FRAC = 0.50;
const PANEL_MAX_H_FRAC = 0.50;
const PANEL_2K_REF_W = 2560;
const PANEL_2K_REF_H = 1440;
const GRID_CONTENT_PAD_Y = 8;

// Scroll indicator
const SCROLL_INDICATOR_HIDE_MS = 800;

// DnD and context menu
const DND_LONG_PRESS_MS = 500;
const DND_TOUCH_CANCEL_DIST = 12;
const DND_MIN_DRAG_DIST = 20;
const DND_COOLDOWN_MS = 300;

const DETACHED_CATEGORY_DEFS = [
    { key: 'all', label: 'All' },
    { key: 'productivity', label: 'Productivity' },
    { key: 'developer', label: 'Developer' },
    { key: 'utilities', label: 'Utilities' },
    { key: 'media', label: 'Media' },
    { key: 'communication', label: 'Communication' },
    { key: 'games', label: 'Games' },
    { key: 'system', label: 'System' },
    { key: 'other', label: 'Other' },
];

const APP_CATEGORY_TOKEN_MAP = new Map([
    ['Office', 'productivity'], ['Calendar', 'productivity'],
    ['Education', 'productivity'], ['Science', 'productivity'],
    ['Development', 'developer'], ['IDE', 'developer'],
    ['GUIDesigner', 'developer'], ['Debugger', 'developer'],
    ['RevisionControl', 'developer'],
    ['Utility', 'utilities'], ['FileManager', 'utilities'],
    ['Archiving', 'utilities'], ['Calculator', 'utilities'],
    ['Settings', 'system'], ['System', 'system'],
    ['Core', 'system'], ['Monitor', 'system'],
    ['Network', 'communication'], ['Email', 'communication'],
    ['Chat', 'communication'], ['InstantMessaging', 'communication'],
    ['AudioVideo', 'media'], ['Audio', 'media'],
    ['Video', 'media'], ['Graphics', 'media'],
    ['Photography', 'media'],
    ['Game', 'games'], ['Amusement', 'games'],
]);

const APP_CATEGORY_HINTS = [
    [/browser|mail|chat|discord|slack|telegram|signal|teams|zoom|skype|thunderbird|web/i, 'communication'],
    [/video|music|photo|image|media|player|vlc|obs|kdenlive|gimp|inkscape|krita|blender/i, 'media'],
    [/code|studio|ide|dev|git|docker|kube|terminal|console|debug/i, 'developer'],
    [/office|writer|calc|sheet|docs|notion|calendar|todo|task|journal/i, 'productivity'],
    [/settings|tweak|monitor|system|kernel|firmware|package|update|driver|control/i, 'system'],
    [/game|steam|heroic|lutris|retro|play/i, 'games'],
    [/files|archive|compress|extract|calculator|utility|tool/i, 'utilities'],
];

const SETTINGS_PANELS = [
    { panel: 'wifi', label: 'Wi-Fi settings', keys: ['wifi', 'wi-fi', 'wireless', 'network'] },
    { panel: 'network', label: 'Network settings', keys: ['network', 'ethernet', 'vpn'] },
    { panel: 'bluetooth', label: 'Bluetooth settings', keys: ['bluetooth', 'bt'] },
    { panel: 'display', label: 'Display settings', keys: ['display', 'screen', 'resolution', 'monitor'] },
    { panel: 'sound', label: 'Sound settings', keys: ['sound', 'audio', 'volume'] },
    { panel: 'power', label: 'Power settings', keys: ['power', 'battery'] },
    { panel: 'keyboard', label: 'Keyboard settings', keys: ['keyboard', 'layout', 'typing'] },
    { panel: 'mouse', label: 'Mouse & Touchpad settings', keys: ['mouse', 'touchpad', 'pointer'] },
    { panel: 'privacy', label: 'Privacy settings', keys: ['privacy', 'permissions', 'security'] },
    { panel: 'notifications', label: 'Notifications settings', keys: ['notifications', 'alerts'] },
    { panel: 'background', label: 'Background settings', keys: ['background', 'wallpaper'] },
];

/**
 * Desktop floating app grid (start-menu-style). Shown when the user
 * clicks Show Apps or presses Super. Displays all installed apps in a
 * searchable, categorised grid panel positioned adjacent to the left taskbar.
 */
export class AppMenu {
    /**
     * @param {Object} controller - Extension controller
     * @param {Object} settings - GSettings instance
     */
    constructor(controller, settings) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._logger = new Logger('AppMenu', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();

        // UI actors
        this._backdrop = null;
        this._panel = null;
        this._panelBlur = null;
        this._panelDim = null;
        this._panelGlass = null;
        this._panelTint = null;
        this._panelSpecular = null;
        this._panelBlurEffect = null;
        this._searchEntry = null;
        this._searchRow = null;
        this._categoryBar = null;
        this._categoryBarScroll = null;
        this._gridClip = null;
        this._gridScrollView = null;
        this._gridContainer = null;
        this._topFade = null;
        this._bottomFade = null;
        this._scrollIndicator = null;
        this._scrollFadeEffect = null;
        this._scrollFadeH = undefined;
        this._scrollFadeKey = null;
        this._scrollIndicatorHideId = 0;

        // State
        this._visible = false;
        this._expandedMonitorIndex = -1;
        this._searchDebounceId = 0;
        this._appCategoryCache = new Map();
        this._searchFieldCache = null;
        this._currentCategoryKey = 'all';
        this._categorySig = '';
        this._gridButtonMap = [];

        // DnD state
        this._dndActive = false;
        this._dndGhost = null;
        this._dndApp = null;
        this._dndSourceBtn = null;
        this._dndGrab = null;
        this._dndStartX = 0;
        this._dndStartY = 0;
        this._dndEndedMs = 0;
        this._dndSafetyTimerId = 0;

        // Context menu state
        this._contextMenu = null;
        this._contextMenuManager = null;

        // App grid item cache — avoids recreating widgets on every open
        this._cachedGridItems = new Map(); // appId → St.Button
        this._cachedMetricsKey = '';       // invalidate cache when metrics change
        this._preBuildIdleId = 0;

        // Grid metrics (computed on expand)
        this._cols = 5;
        this._iconSize = REF_ICON_SIZE;
        this._cellW = REF_CELL_W;
        this._cellH = REF_CELL_H;
        this._colSpacing = REF_COL_SPACING;
        this._rowSpacing = REF_ROW_SPACING;
        this._labelFontSize = REF_LABEL_FONT_SIZE;
        this._labelMarginTop = REF_LABEL_MARGIN_TOP;
        this._labelPadH = 2;
        this._labelH = Math.round(REF_LABEL_FONT_SIZE * 2.7);
        this._folderGridSize = 52;
        this._scale = 1;

        // Scroll state for continuous vertical scroll
        this._continuousTotalH = 0;

        this._build();

        // Pre-build app grid items on idle so first open is instant
        this._preBuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._preBuildIdleId = 0;
            this._preBuildGridItems();
            return GLib.SOURCE_REMOVE;
        });

        // Invalidate cache when apps are installed/removed
        this._appInstalledId = Shell.AppSystem.get_default().connect(
            'installed-changed', () => this._invalidateGridCache());
    }

    /**
     * Whether the app menu is currently visible/expanded.
     * @returns {boolean}
     */
    get isExpanded() {
        return this._visible;
    }

    // ── Build ────────────────────────────────────────────────────────

    /**
     * Build the floating app menu UI: backdrop + panel with search,
     * categories, grid, and page dots.
     * @private
     */
    _build() {
        // Backdrop: semi-transparent overlay covering the screen
        this._backdrop = new St.Widget({
            name: 'convergence-app-menu-backdrop',
            style_class: 'convergence-app-menu-backdrop',
            reactive: true,
            visible: false,
            opacity: 0,
            x: 0, y: 0,
        });
        this._backdrop.connect('button-press-event', () => {
            this.collapse();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                this.collapse();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        Main.layoutManager.uiGroup.add_child(this._backdrop);

        // Floating panel
        this._panel = new St.Widget({
            name: 'convergence-app-menu',
            style_class: 'convergence-app-menu-panel',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            visible: false,
            opacity: 0,
        });

        this._panelGlass = new St.Widget({
            style_class: 'convergence-app-menu-panel-glass convergence-app-menu-panel-glass-solid',
            x_expand: true,
            y_expand: true,
        });
        this._panel.add_child(this._panelGlass);

        this._panelTint = new St.Widget({
            style_class: 'convergence-app-menu-panel-tint convergence-app-menu-panel-tint-solid',
            x_expand: true,
            y_expand: true,
        });
        this._panel.add_child(this._panelTint);

        this._panelSpecular = new St.Widget({
            style_class: 'convergence-app-menu-panel-specular',
            x_expand: true,
            y_expand: true,
        });
        this._panel.add_child(this._panelSpecular);
        this._syncPanelBlurMode();
        this._syncPanelShadow();
        this._syncBackdropBlur();

        // Capture scroll events on the panel for grid scrolling
        this._panel.connect('scroll-event', (_actor, event) => {
            return this._onScrollEvent(event);
        });

        let mainLayout = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._panel.add_child(mainLayout);

        // Search bar with icon
        this._searchRow = new St.BoxLayout({
            style_class: 'convergence-drawer-search-shell-detached',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let searchIcon = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'convergence-drawer-search-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._searchRow.add_child(searchIcon);
        this._searchEntry = new St.Entry({
            style_class: 'convergence-app-menu-search convergence-drawer-search-entry-detached',
            hint_text: 'Search apps\u2026',
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.clutter_text.connect('text-changed',
            () => this._onSearchChanged());
        this._searchEntry.clutter_text.connect('key-press-event',
            (_actor, event) => this._onSearchKeyPress(event));
        this._searchRow.add_child(this._searchEntry);
        mainLayout.add_child(this._searchRow);

        // Divider below search
        this._searchDivider = new St.Widget({
            style_class: 'convergence-app-menu-search-divider',
            x_expand: true,
        });
        mainLayout.add_child(this._searchDivider);

        // Category chips (horizontal scroll)
        this._categoryBarScroll = new St.ScrollView({
            style_class: 'convergence-app-menu-category-scroll convergence-drawer-category-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            visible: true,
        });
        this._categoryBar = new St.BoxLayout({
            style_class: 'convergence-app-menu-category-bar convergence-drawer-category-bar',
        });
        this._categoryBarScroll.set_child(this._categoryBar);
        mainLayout.add_child(this._categoryBarScroll);

        // Grid area — FixedLayout clip container (same technique as old extension)
        // FixedLayout doesn't expand to fit children, so clip_to_allocation works
        this._gridClip = new St.Widget({
            style_class: 'convergence-app-menu-grid-clip',
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        mainLayout.add_child(this._gridClip);
        this._gridClip.connect('notify::allocation', () => {
            let box = this._gridClip.get_allocation_box();
            let clipW = Math.max(1, box.x2 - box.x1);
            let clipH = Math.max(1, box.y2 - box.y1);
            let fadeH = Math.max(1, Math.round(this._scrollFadeH ?? 16));
            if (this._topFade) {
                this._topFade.set_position(0, 0);
                this._topFade.set_size(clipW, Math.min(fadeH, clipH));
            }
            if (this._bottomFade) {
                let h = Math.min(fadeH, clipH);
                this._bottomFade.set_position(0, Math.max(0, clipH - h));
                this._bottomFade.set_size(clipW, h);
            }
            if (clipH === this._clipViewportH)
                return;
            this._clipViewportH = clipH;
            this._syncScrollFade();
            this._syncScrollIndicator();
        });

        // The grid container sits inside the clip and scrolls via translation_y
        this._gridContainer = new St.Widget({
            style_class: 'convergence-app-menu-grid-container convergence-app-grid',
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
        });
        this._gridClip.add_child(this._gridContainer);
        this._gridContainer.connect('notify::translation-y', () => {
            this._syncScrollIndicator();
            this._syncScrollFade();
        });

        this._topFade = new St.Widget({
            style_class: 'convergence-app-menu-scroll-fade-top',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._gridClip.add_child(this._topFade);

        this._bottomFade = new St.Widget({
            style_class: 'convergence-app-menu-scroll-fade-bottom',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._gridClip.add_child(this._bottomFade);

        // Scroll indicator (auto-hiding thumb)
        this._scrollIndicator = new St.Widget({
            style_class: 'convergence-app-menu-scroll-indicator',
            visible: false,
            opacity: 0,
        });
        this._gridClip.add_child(this._scrollIndicator);

        // Scroll event on grid clip
        this._gridClip.reactive = true;
        this._gridClip.connect('scroll-event', (_actor, event) => {
            let dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [, dy] = event.get_scroll_delta();
                this._applyScroll(dy * 40);
            } else if (dir === Clutter.ScrollDirection.DOWN)
                this._applyScroll(this._cellH);
            else if (dir === Clutter.ScrollDirection.UP)
                this._applyScroll(-this._cellH);
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.uiGroup.add_child(this._panel);

        if (this._settings) {
            this._runtimeDisposer.connect(this._settings, 'changed::drawer-blur-enabled', () => {
                this._syncPanelBlurMode();
                this._syncBackdropBlur();
            });
            this._runtimeDisposer.connect(this._settings, 'changed::drawer-shadow-enabled', () => {
                this._syncPanelShadow();
            });
        }
    }

    // ── Show / Hide ──────────────────────────────────────────────────

    /**
     * Show the app menu on the specified monitor.
     * @param {number} monitorIndex
     */
    expand(monitorIndex = -1) {
        if (this._visible) return;
        this._visible = true;
        this._expandedMonitorIndex = monitorIndex >= 0
            ? monitorIndex
            : Main.layoutManager.primaryIndex;
        this._scrollFadeH = undefined;
        this._scrollFadeKey = null;
        this._syncPanelBlurMode();
        this._syncPanelShadow();
        this._syncBackdropBlur();

        this._computeGridMetrics();
        // Invalidate cached items if metrics changed (e.g., different monitor DPI)
        let metricsKey = `${this._iconSize}_${this._cellW}_${this._cellH}_${this._labelFontSize}_${this._labelH}_${this._labelMarginTop}_${this._labelPadH}`;
        if (metricsKey !== this._cachedMetricsKey)
            this._invalidateGridCache();
        this._positionPanel();
        this._populateGrid('');

        // Show backdrop
        this._backdrop.show();
        this._backdrop.opacity = 0;
        this._backdrop.ease({
            opacity: 255,
            duration: PANEL_OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Show panel with slide-up + fade
        this._panel.show();
        this._panel.opacity = 0;
        this._panel.translation_y = 24;
        this._panel.set_pivot_point(0.5, 1.0);
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: PANEL_OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Reset scroll position
        if (this._gridContainer)
            this._gridContainer.translation_y = 0;

        if (this._searchEntry) {
            this._searchEntry.set_text('');
            global.stage.set_key_focus(this._searchEntry);
        }
    }

    /**
     * Toggle the app menu visibility.
     * @param {number} monitorIndex
     */
    toggle(monitorIndex = -1) {
        if (this._visible)
            this.collapse();
        else
            this.expand(monitorIndex);
    }

    /**
     * Hide the app menu with an animation.
     */
    collapse() {
        if (!this._visible) return;
        this._visible = false;
        this._syncBackdropBlur();

        this._panel.ease({
            opacity: 0,
            translation_y: 16,
            duration: PANEL_CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._panel.hide();
                this._panel.translation_y = 0;
            },
        });

        this._backdrop.ease({
            opacity: 0,
            duration: PANEL_CLOSE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._backdrop.hide();
            },
        });
    }

    // ── Layout / Positioning ─────────────────────────────────────────

    /**
     * Compute adaptive grid metrics based on monitor DPI scaling.
     * @private
     */
    _computeGridMetrics() {
        let monitor = this._getMonitor();
        if (!monitor) return;

        let screenW = monitor.width || global.stage.width;
        let stageH = monitor.height || global.stage.height;
        let aspect = screenW / Math.max(1, stageH);
        let maxScale = aspect >= 2.0 ? 1.55 : 1.45;
        let scale = getAdaptiveScale({
            profile: 'grid', monitor,
            logicalWidth: screenW,
            referenceWidth: 216,
            min: 0.8, max: maxScale,
        });
        this._scale = scale;

        this._iconSize = Math.round(REF_ICON_SIZE * scale);
        this._cellW = Math.round(REF_CELL_W * scale);
        this._colSpacing = Math.round(REF_COL_SPACING * scale);
        this._rowSpacing = 4;
        this._labelFontSize = REF_LABEL_FONT_SIZE;
        this._labelMarginTop = Math.round(REF_LABEL_MARGIN_TOP * scale);
        this._labelPadH = Math.round(2 * scale);
        this._labelH = Math.round(this._labelFontSize * 2.7);
        this._folderGridSize = Math.round(52 * scale);
        let iconAreaH = Math.max(this._iconSize, this._folderGridSize);
        this._cellH = iconAreaH + this._labelMarginTop + this._labelH + 2 * this._labelPadH;
    }

    /**
     * Position the floating panel adjacent to the left taskbar.
     * @private
     */
    _positionPanel() {
        let monitor = this._getMonitor();
        if (!monitor) return;

        let monitorIndex = this._expandedMonitorIndex >= 0
            ? this._expandedMonitorIndex
            : Main.layoutManager.primaryIndex;
        let stageW = monitor.width || global.stage.width;
        let stageH = monitor.height || global.stage.height;
        let scale = this._scale || 1;

        // Resolve the taskbar lane on the target monitor, not the whole stage.
        let taskbarThickness = 0;
        let topInset = monitorIndex === Main.layoutManager.primaryIndex
            ? (Main.panel?.height || 0)
            : 0;
        let taskbar = this._controller?.taskbar;
        if (taskbar?.getTaskbarRectForMonitor) {
            let rect = taskbar.getTaskbarRectForMonitor(monitorIndex);
            if (rect) {
                taskbarThickness = rect.width || 0;
                topInset = Math.max(0, rect.y - monitor.y);
            }
        } else if (taskbar?.getTaskbarRect) {
            let rect = taskbar.getTaskbarRect();
            if (rect) {
                let overlapW = Math.max(0,
                    Math.min(rect.x + rect.width, monitor.x + monitor.width) -
                    Math.max(rect.x, monitor.x));
                let overlapH = Math.max(0,
                    Math.min(rect.y + rect.height, monitor.y + monitor.height) -
                    Math.max(rect.y, monitor.y));
                if (overlapW > 0 && overlapH > 0) {
                    taskbarThickness = rect.width || 0;
                    topInset = Math.max(0, rect.y - monitor.y);
                }
            }
        }

        let fullH = Math.max(1, stageH - topInset);
        let outerGap = Math.max(10, Math.round(16 * scale));
        let maxPanelW = Math.max(320,
            stageW - taskbarThickness - PANEL_GAP - outerGap - DETACHED_GRID_MIN_MARGIN);
        let monitorCapW = Math.round(Math.min(stageW * PANEL_MAX_W_FRAC, PANEL_2K_REF_W * PANEL_MAX_W_FRAC));
        let monitorCapH = Math.round(Math.min(stageH * PANEL_MAX_H_FRAC, PANEL_2K_REF_H * PANEL_MAX_H_FRAC));

        // ── Panel dimensions ──
        // Width/height are monitor-local, capped similarly to the old detached grid.
        let panelW = Math.min(
            Math.round(stageW * PANEL_MAX_W_FRAC),
            stageW - DETACHED_GRID_MIN_MARGIN * 2,
            monitorCapW,
            maxPanelW);
        panelW = Math.max(400, panelW);

        let panelH = Math.max(320, Math.min(
            fullH - outerGap * 2,
            monitorCapH));

        // ── Content insets (side padding between panel edge and grid) ──
        // Reduced to fit 8 columns — the grid clip CSS margin provides 16px each side
        let contentInset = Math.round(panelW * 0.02);
        let gridHMargin = 32; // GRID_H_MARGIN: 16px grid clip margin each side

        // ── Column calculation ──
        let innerW = Math.max(320, panelW - contentInset * 2 - gridHMargin);
        let colPitch = this._cellW + this._colSpacing;
        this._cols = Math.max(3, Math.min(10, Math.floor((innerW + this._colSpacing) / colPitch)));

        // Continuous scroll: expand cell width to fill available width evenly
        this._effectiveCellW = Math.floor((innerW - (this._cols - 1) * this._colSpacing) / this._cols);
        this._effectiveColSpacing = this._colSpacing;
        let gridContentW = this._cols * this._effectiveCellW + (this._cols - 1) * this._effectiveColSpacing;

        // Final panel width: grid content + grid margin
        let computedW = Math.min(gridContentW + gridHMargin, maxPanelW);
        // Use the larger of computed and raw panel width for generous side padding
        panelW = Math.min(maxPanelW, Math.max(computedW, panelW));

        // ── X position: taskbar edge + gap ──
        let x = monitor.x + taskbarThickness + PANEL_GAP;
        let maxX = monitor.x + monitor.width - panelW - outerGap;
        x = Math.min(x, maxX);
        x = Math.max(monitor.x + outerGap, x);

        // ── Y position: anchored to bottom ──
        let panelHt = Math.max(240, Math.min(panelH, fullH - outerGap * 2));
        let y = monitor.y + topInset + fullH - panelHt - PANEL_BOTTOM_OFFSET;
        y = Math.max(monitor.y + topInset + PANEL_MIN_TOP_MARGIN, y);

        this._panel.set_position(x, y);
        this._panel.set_size(panelW, panelHt);

        // Store computed grid metrics for _populateGrid
        this._gridContentW = gridContentW;
        this._gridPadX = Math.max(0, Math.floor(
            (panelW - gridHMargin - gridContentW) / 2));

        let chromeH = this._measurePanelChromeHeight(panelW);
        let clipH = Math.max(1, panelHt - chromeH);
        if (this._gridClip)
            this._gridClip.height = clipH;
        this._clipViewportH = clipH;

        // Backdrop covers entire screen
        this._backdrop.set_position(0, 0);
        this._backdrop.set_size(global.stage.width, global.stage.height);

        this._logger.debug(
            `panel layout monitor=${monitorIndex} monitorRect=${monitor.x},${monitor.y},${stageW}x${stageH} ` +
            `topInset=${topInset} taskbarThickness=${taskbarThickness} ` +
            `panel=${Math.round(panelW)}x${Math.round(panelHt)} at ${Math.round(x)},${Math.round(y)} ` +
            `gridContentW=${Math.round(gridContentW)} cols=${this._cols} cell=${this._effectiveCellW}x${this._cellH} ` +
            `chromeH=${Math.round(chromeH)} clipH=${Math.round(clipH)}`);
    }

    _measurePanelChromeHeight(forWidth = -1) {
        let total = 0;
        let measure = actor => {
            if (!actor)
                return 0;
            try {
                let [, nat] = actor.get_preferred_height(forWidth);
                return Math.max(0, nat || 0);
            } catch (_e) {
                return 0;
            }
        };

        total += measure(this._searchRow);
        total += measure(this._searchDivider);
        total += measure(this._categoryBarScroll);
        return total;
    }

    /**
     * Get the monitor for the current expand context.
     * @returns {Object|null}
     * @private
     */
    _getMonitor() {
        let monitors = Main.layoutManager.monitors;
        let idx = this._expandedMonitorIndex;
        return monitors[idx] ?? Main.layoutManager.primaryMonitor ?? null;
    }

    _isBlurEnabled() {
        if (!this._settings)
            return false;
        try {
            return this._settings.get_boolean('drawer-blur-enabled');
        } catch (_e) {
            return false;
        }
    }

    _isShadowEnabled() {
        if (!this._settings)
            return false;
        try {
            return this._settings.get_boolean('drawer-shadow-enabled');
        } catch (_e) {
            return false;
        }
    }

    _syncBackdropBlur() {
        if (!this._backdrop)
            return;

        if (this._visible && this._isBlurEnabled()) {
            if (!this._backdrop.get_effect?.('app-menu-backdrop-blur')) {
                try {
                    this._backdrop.add_effect_with_name('app-menu-backdrop-blur',
                        new Shell.BlurEffect({
                            sigma: 16,
                            brightness: 0.55,
                            mode: Shell.BlurMode.BACKGROUND,
                        }));
                } catch (_e) {}
            }
            this._backdrop.set_style('background-color: rgba(0, 0, 0, 0.32);');
        } else {
            this._backdrop.remove_effect_by_name?.('app-menu-backdrop-blur');
            this._backdrop.set_style('');
        }
    }

    _syncPanelBlurMode() {
        if (!this._panel || !this._panelGlass || !this._panelTint)
            return;

        let blurOn = this._isBlurEnabled();

        if (this._panelBlur) {
            this._panel.remove_child(this._panelBlur);
            this._panelBlur.destroy();
            this._panelBlur = null;
            this._panelBlurEffect = null;
        }
        if (this._panelDim) {
            this._panel.remove_child(this._panelDim);
            this._panelDim.destroy();
            this._panelDim = null;
        }

        if (blurOn) {
            try {
                this._panelBlur = new St.Widget({
                    style_class: 'convergence-app-menu-panel-blur',
                    x_expand: true,
                    y_expand: true,
                });
                let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                this._panelBlurEffect = new Shell.BlurEffect({
                    radius: 10 * scale,
                    brightness: 0.6,
                    mode: Shell.BlurMode.BACKGROUND,
                });
                this._panelBlur.add_effect(this._panelBlurEffect);
                this._panel.insert_child_below(this._panelBlur, this._panelGlass);
            } catch (_e) {
                this._panelBlur = null;
                this._panelBlurEffect = null;
            }

            this._panelDim = new St.Widget({
                style_class: 'convergence-app-menu-panel-dim',
                x_expand: true,
                y_expand: true,
            });
            this._panel.insert_child_below(this._panelDim, this._panelGlass);
        }

        if (blurOn) {
            this._panelGlass.remove_style_class_name('convergence-app-menu-panel-glass-solid');
            this._panelTint.remove_style_class_name('convergence-app-menu-panel-tint-solid');
        } else {
            this._panelGlass.add_style_class_name('convergence-app-menu-panel-glass-solid');
            this._panelTint.add_style_class_name('convergence-app-menu-panel-tint-solid');
        }
    }

    _syncPanelShadow() {
        if (!this._panel)
            return;
        if (this._isShadowEnabled())
            this._panel.add_style_class_name('convergence-app-menu-panel-shadow');
        else
            this._panel.remove_style_class_name('convergence-app-menu-panel-shadow');
    }

    // ── Scroll Handling ──────────────────────────────────────────────

    /**
     * Handle scroll events on the panel to scroll the grid.
     * @param {Clutter.Event} event
     * @returns {number}
     * @private
     */
    _onScrollEvent(event) {
        let direction = event.get_scroll_direction();
        let delta = 0;

        if (direction === Clutter.ScrollDirection.UP) {
            delta = -this._cellH;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            delta = this._cellH;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            let [, dy] = event.get_scroll_delta();
            delta = dy * 40;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }

        this._applyScroll(delta);
        return Clutter.EVENT_STOP;
    }

    /**
     * Apply a vertical scroll delta to the grid container.
     * @param {number} deltaY
     * @private
     */
    _applyScroll(deltaY) {
        let maxScroll = Math.max(0, this._continuousTotalH - (this._clipViewportH || 1));
        let currentY = -(this._gridContainer.translation_y || 0);
        let newY = Math.max(0, Math.min(maxScroll, currentY + deltaY));
        this._gridContainer.translation_y = -newY;
        this._syncScrollFade();
        this._syncScrollIndicator();
    }

    /**
     * Set up the Clutter fragment shader for top/bottom scroll fade.
     * @private
     */
    _setupScrollFade() {
        if (this._scrollFadeEffect)
            return;
        try {
            let shaderArgs = {};
            if (Clutter.ShaderType?.FRAGMENT_SHADER !== undefined)
                shaderArgs.shader_type = Clutter.ShaderType.FRAGMENT_SHADER;
            this._scrollFadeEffect = new Clutter.ShaderEffect(shaderArgs);
            this._scrollFadeEffect.set_shader_source(
                'uniform sampler2D tex;\n' +
                'uniform float fade_top;\n' +
                'uniform float fade_bottom;\n' +
                'void main() {\n' +
                '  vec2 uv = cogl_tex_coord_in[0].st;\n' +
                '  vec4 color = texture2D(tex, uv);\n' +
                '  float a = 1.0;\n' +
                '  if (fade_top > 0.0)\n' +
                '    a *= smoothstep(0.0, fade_top, uv.y);\n' +
                '  if (fade_bottom < 1.0)\n' +
                '    a *= smoothstep(1.0, fade_bottom, uv.y);\n' +
                '  cogl_color_out = color * a;\n' +
                '}\n'
            );
            this._scrollFadeEffect.set_uniform_value('tex', 0);
        } catch (error) {
            this._scrollFadeEffect = null;
            this._logger.debug(`scroll fade setup failed: ${error}`);
        }
    }

    /**
     * Sync the scroll fade shader uniforms based on current scroll position.
     * @private
     */
    _syncScrollFade() {
        if (!this._gridClip)
            return;

        let needFade = false;
        let fadeTopNorm = 0;
        let fadeBottomNorm = 1.0;
        let showTop = false;
        let showBottom = false;

        let viewportH = this._clipViewportH || this._gridClip.height || 1;
        let contentH = this._continuousTotalH || 0;
        let maxScroll = Math.max(0, contentH - viewportH);
        if (contentH > viewportH && maxScroll > 0) {
            let clipH = this._gridClip.height || viewportH;
            if (clipH > 0) {
                let fadeH = this._scrollFadeH;
                if (fadeH === undefined) {
                    let monitor = this._getMonitor();
                    fadeH = snapToPixel(16, monitor);
                    this._scrollFadeH = fadeH;
                }
                let scrollY = Math.max(0, Math.min(maxScroll, -(this._gridContainer?.translation_y || 0)));
                showTop = scrollY > 1;
                showBottom = scrollY < maxScroll - 1;

                if (showTop || showBottom) {
                    needFade = true;
                    fadeTopNorm = showTop ? fadeH / clipH : 0;
                    fadeBottomNorm = showBottom ? 1.0 - fadeH / clipH : 1.0;
                }
            }
        }

        let fadeKey = needFade ? `${fadeTopNorm.toFixed(4)}:${fadeBottomNorm.toFixed(4)}` : 'off';
        let fadeUnchanged = fadeKey === this._scrollFadeKey;
        if (this._topFade) {
            this._topFade.visible = showTop;
            this._topFade.opacity = showTop ? 255 : 0;
        }
        if (this._bottomFade) {
            this._bottomFade.visible = showBottom;
            this._bottomFade.opacity = showBottom ? 255 : 0;
        }
        if (fadeUnchanged)
            return;
        this._scrollFadeKey = fadeKey;

        if (needFade) {
            this._setupScrollFade();
            if (this._scrollFadeEffect && !this._gridClip.get_effect('scroll-fade'))
                this._gridClip.add_effect_with_name('scroll-fade', this._scrollFadeEffect);
            if (this._scrollFadeEffect) {
                this._scrollFadeEffect.set_uniform_value('fade_top', fadeTopNorm);
                this._scrollFadeEffect.set_uniform_value('fade_bottom', fadeBottomNorm);
            }
        } else if (this._gridClip.get_effect('scroll-fade')) {
            this._gridClip.remove_effect_by_name('scroll-fade');
        }

        this._logger.debug(
            `scroll fade monitor=${this._expandedMonitorIndex} viewportH=${Math.round(viewportH)} ` +
            `contentH=${Math.round(contentH)} scrollY=${Math.round(-(this._gridContainer?.translation_y || 0))} ` +
            `maxScroll=${Math.round(maxScroll)} showTop=${showTop} showBottom=${showBottom} ` +
            `shader=${this._scrollFadeEffect ? 'yes' : 'no'} effect=${this._gridClip.get_effect('scroll-fade') ? 'on' : 'off'}`);
    }

    /**
     * Sync the scroll indicator thumb position and visibility.
     * @private
     */
    _syncScrollIndicator() {
        if (!this._scrollIndicator || !this._gridClip) return;

        let viewportH = this._clipViewportH || 1;
        let contentH = this._continuousTotalH;

        if (contentH <= viewportH) {
            this._scrollIndicator.visible = false;
            return;
        }

        let clipW = this._gridClip.width || 1;
        let trackMargin = 4;
        let trackH = viewportH - trackMargin * 2;
        let thumbH = Math.max(24, Math.round((viewportH / contentH) * trackH));
        let maxScroll = Math.max(1, contentH - viewportH);
        let scrollY = Math.max(0, Math.min(maxScroll, -(this._gridContainer?.translation_y || 0)));
        let fraction = scrollY / maxScroll;
        let thumbY = trackMargin + fraction * (trackH - thumbH);

        this._scrollIndicator.set_position(clipW - 6, thumbY);
        this._scrollIndicator.set_size(3, thumbH);
        this._scrollIndicator.visible = true;
        this._scrollIndicator.ease({
            opacity: 255,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Auto-hide after delay
        this._runtimeDisposer.restartTimeout(
            this, '_scrollIndicatorHideId',
            GLib.PRIORITY_DEFAULT, SCROLL_INDICATOR_HIDE_MS,
            () => {
                if (this._scrollIndicator) {
                    this._scrollIndicator.ease({
                        opacity: 0,
                        duration: 300,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            if (this._scrollIndicator)
                                this._scrollIndicator.visible = false;
                        },
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    // ── Search ───────────────────────────────────────────────────────

    /**
     * Handle search text changes with debouncing.
     * @private
     */
    _onSearchChanged() {
        let text = this._searchEntry.get_text().trim();
        this._runtimeDisposer.restartTimeout(
            this, '_searchDebounceId',
            GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS,
            () => {
                this._populateGrid(text);
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Handle keyboard events in the search entry.
     * @param {Clutter.Event} event
     * @returns {number}
     * @private
     */
    _onSearchKeyPress(event) {
        let key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            if (this._activateTopSearchResult())
                return Clutter.EVENT_STOP;
        } else if (key === Clutter.KEY_Escape) {
            let text = this._searchEntry?.get_text?.()?.trim() ?? '';
            if (text.length > 0) {
                this._searchEntry.set_text('');
                this._onSearchChanged();
            } else {
                this.collapse();
            }
            return Clutter.EVENT_STOP;
        } else if (key === Clutter.KEY_Down || key === Clutter.KEY_Tab) {
            let first = this._gridButtonMap?.[0]?.btn;
            if (first) {
                global.stage.set_key_focus(first);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ── Grid Population ──────────────────────────────────────────────

    /**
     * Populate the app grid with all installed apps, filtered by query.
     * Lays out icons in a fixed-position grid with columns.
     * @param {string} query
     * @private
     */
    /**
     * Pre-build grid items for all apps on idle, populating the cache.
     */
    _preBuildGridItems() {
        if (!this._gridContainer) return;
        this._computeGridMetrics();
        let metricsKey = `${this._iconSize}_${this._cellW}_${this._cellH}_${this._labelFontSize}_${this._labelH}_${this._labelMarginTop}_${this._labelPadH}`;
        if (metricsKey === this._cachedMetricsKey && this._cachedGridItems.size > 0)
            return; // Already cached with same metrics

        this._cachedGridItems.clear();
        this._cachedMetricsKey = metricsKey;

        let appSystem = Shell.AppSystem.get_default();
        let installed = appSystem.get_installed().filter(a => a.should_show());
        let appMap = new Map();
        for (let info of installed) {
            let id = info.get_id();
            if (!appMap.has(id)) appMap.set(id, info);
        }
        for (let [id] of appMap) {
            let app = appSystem.lookup_app(id);
            if (!app) continue;
            let btn = this._createAppGridItem(app);
            this._cachedGridItems.set(id, btn);
        }
    }

    /**
     * Invalidate the grid item cache (e.g., after app install/uninstall).
     */
    _invalidateGridCache() {
        for (let [, btn] of this._cachedGridItems) {
            if (btn.get_parent()) btn.get_parent().remove_child(btn);
            btn.destroy();
        }
        this._cachedGridItems.clear();
        this._cachedMetricsKey = '';
        // Re-populate the cache on idle
        if (this._preBuildIdleId) GLib.source_remove(this._preBuildIdleId);
        this._preBuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._preBuildIdleId = 0;
            this._preBuildGridItems();
            return GLib.SOURCE_REMOVE;
        });
        // Also pre-populate search/category caches
        this._appCategoryCache.clear();
        this._searchFieldCache = null;
    }

    /**
     * Get or create a cached grid item for an app.
     */
    _getOrCreateAppGridItem(app) {
        let id = app.get_id();
        let cached = this._cachedGridItems.get(id);
        if (cached) return cached;
        let btn = this._createAppGridItem(app);
        this._cachedGridItems.set(id, btn);
        return btn;
    }

    _populateGrid(query = '') {
        // Detach all cached items from the grid (don't destroy them)
        for (let child of [...this._gridContainer.get_children()])
            this._gridContainer.remove_child(child);
        this._gridButtonMap = [];
        this._gridContainer.translation_y = 0;

        let appSystem = Shell.AppSystem.get_default();
        let installed = appSystem.get_installed().filter(a => a.should_show());
        // Deduplicate
        let appMap = new Map();
        for (let info of installed) {
            let id = info.get_id();
            if (!appMap.has(id)) appMap.set(id, info);
        }
        let allApps = [...appMap.values()]
            .map(info => appSystem.lookup_app(info.get_id()))
            .filter(a => a != null);

        let favorites = AppFavorites.getAppFavorites().getFavorites();
        let pinnedIds = new Set(favorites.map(a => a.get_id()));

        let normalizedQuery = this._normalizeSearchText(query);
        let items = [];

        if (normalizedQuery) {
            let scored = [];
            for (let app of allApps) {
                let score = this._scoreSearchApp(app, normalizedQuery);
                if (score > 0)
                    scored.push({ app, score });
            }
            scored.sort((a, b) => b.score - a.score);

            let actionItems = this._buildSearchActionItems(query, normalizedQuery);
            for (let action of actionItems)
                items.push(action);
            for (let { app } of scored)
                items.push({ type: 'app', id: app.get_id(), app });
        } else {
            let categoryKey = this._currentCategoryKey;
            for (let app of allApps) {
                let id = app.get_id();
                if (pinnedIds.has(id)) continue;
                if (categoryKey !== 'all') {
                    let cat = this._getAppCategoryKey(app);
                    if (cat !== categoryKey) continue;
                }
                items.push({ type: 'app', id, app });
            }
            items.sort((a, b) =>
                (a.app?.get_name?.() ?? '').localeCompare(b.app?.get_name?.() ?? ''));
        }

        this._syncCategoryBar(allApps, pinnedIds, normalizedQuery);

        // Layout items into a fixed-position grid
        let cols = this._cols;
        let cellW = this._effectiveCellW || this._cellW;
        let cellH = this._cellH;
        let colSpacing = this._effectiveColSpacing || this._colSpacing;
        let rowSpacing = this._rowSpacing;

        // Use consistent grid dimensions from _positionPanel
        let gridContentW = cols * cellW + (cols - 1) * colSpacing;
        let clipW = this._gridContentW || gridContentW;
        let padX = this._gridPadX || 0;
        let padY = GRID_CONTENT_PAD_Y;

        let idx = 0;
        for (let item of items) {
            let col = idx % cols;
            let row = Math.floor(idx / cols);
            let xPos = padX + col * (cellW + colSpacing);
            let yPos = padY + row * (cellH + rowSpacing);

            let btn;
            if (item.type === 'action') {
                btn = this._createActionGridItem(item);
            } else if (item.type === 'app') {
                let app = item.app ?? appSystem.lookup_app(item.id);
                if (!app) continue;
                btn = this._getOrCreateAppGridItem(app);
                this._gridButtonMap.push({ btn, app });
            }
            if (!btn) continue;

            btn.set_size(cellW, cellH);
            btn.set_position(xPos, yPos);
            this._gridContainer.add_child(btn);
            idx++;
        }

        // Set grid container height for scrolling
        let totalRows = Math.ceil(idx / cols);
        let contentH = totalRows * cellH + Math.max(0, totalRows - 1) * rowSpacing;
        let totalH = contentH + (padY * 2);
        this._gridContainer.set_size(clipW, totalH);
        this._continuousTotalH = totalH;

        // Set up scroll fade shader and sync initial state
        this._setupScrollFade();
        this._syncScrollFade();
        this._syncScrollIndicator();
    }

    /**
     * Create a grid cell for an app with icon + label.
     * @param {Object} app
     * @returns {St.Button}
     * @private
     */
    _createAppGridItem(app) {
        let pad = this._labelPadH;
        let box = new St.BoxLayout({
            style_class: 'convergence-app-menu-grid-item-content convergence-app-icon-button',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: false,
            style: `padding: 0 ${pad}px;`,
        });

        let icon = app.create_icon_texture(this._iconSize);
        icon.set({
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);

        let label = new St.Label({
            text: app.get_name(),
            style_class: 'convergence-app-menu-grid-label convergence-app-label',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: `min-height: ${this._labelH}px; height: ${this._labelH}px; font-size: ${this._labelFontSize}px; margin-top: ${this._labelMarginTop}px;`,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: 2, // WORD_CHAR
            ellipsize: 3, // END
            max_length: 0,
        });
        label.clutter_text.set_line_alignment(1);
        box.add_child(label);

        let overlay = new St.Widget({
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        overlay.add_child(box);

        let button = new St.Button({
            child: overlay,
            style_class: 'convergence-app-menu-grid-item',
            style: 'padding: 0; margin: 0;',
            can_focus: true,
        });
        addClickCursor(button, this._runtimeDisposer);

        // Long-press / DnD / context menu state for this button
        let lpTimerId = 0;
        let lpFired = false;
        let touchTracking = false;
        let touchStartX = 0, touchStartY = 0;
        let cancelDistSq = DND_TOUCH_CANCEL_DIST * DND_TOUCH_CANCEL_DIST;

        let startLp = () => {
            lpFired = false;
            lpTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DND_LONG_PRESS_MS, () => {
                lpTimerId = 0;
                lpFired = true;
                this._startDnd(button, app);
                return GLib.SOURCE_REMOVE;
            });
        };
        let cancelLp = () => {
            if (lpTimerId) { GLib.source_remove(lpTimerId); lpTimerId = 0; }
        };

        button.connect('notify::hover', () => {
            if (button.hover)
                box.add_style_pseudo_class('hover');
            else
                box.remove_style_pseudo_class('hover');
        });

        // Mouse button events
        button.connect('button-press-event', (_b, event) => {
            let btn = event.get_button?.();
            if (btn === 3) {
                // Right-click → context menu
                this._showAppContextMenu(button, app);
                return Clutter.EVENT_STOP;
            }
            box.add_style_pseudo_class('active');
            startLp();
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            box.remove_style_pseudo_class('active');
            cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });

        // Touch events (long-press with cancel on movement)
        button.connect('touch-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                box.add_style_pseudo_class('active');
                [touchStartX, touchStartY] = event.get_coords();
                touchTracking = true;
                startLp();
            } else if (type === Clutter.EventType.TOUCH_UPDATE) {
                if (touchTracking && !lpFired && !this._dndActive) {
                    let [x, y] = event.get_coords();
                    let dx = x - touchStartX, dy = y - touchStartY;
                    if (dx * dx + dy * dy >= cancelDistSq) {
                        box.remove_style_pseudo_class('active');
                        cancelLp();
                        touchTracking = false;
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                box.remove_style_pseudo_class('active');
                box.remove_style_pseudo_class('hover');
                touchTracking = false;
                cancelLp();
                if (type === Clutter.EventType.TOUCH_CANCEL) lpFired = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('leave-event', () => {
            box.remove_style_pseudo_class('active');
            box.remove_style_pseudo_class('hover');
            if (!this._dndActive) cancelLp();
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('clicked', () => {
            let dndCooldown = (GLib.get_monotonic_time() / 1000) - this._dndEndedMs < DND_COOLDOWN_MS;
            if (!lpFired && !this._dndActive && !dndCooldown) {
                if (this._controller.activateApp)
                    this._controller.activateApp(app);
                else
                    app.activate();
                this.collapse();
            }
            lpFired = false;
        });

        return button;
    }

    /**
     * Create a grid cell for a search action item.
     * @param {Object} item
     * @returns {St.Button}
     * @private
     */
    // ── Context Menu ──────────────────────────────────────────────

    _showAppContextMenu(anchor, app) {
        this._dismissContextMenu();

        if (!this._contextMenuManager)
            this._contextMenuManager = new PopupMenu.PopupMenuManager(Main.layoutManager.uiGroup);

        let menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.TOP);
        menu.blockSourceEvents = true;
        menu.actor.add_style_class_name('popup-menu');
        Main.layoutManager.uiGroup.add_child(menu.actor);
        menu.actor.hide();

        // New Window
        this._addMenuItem(menu, 'New Window', () => {
            app.open_new_window(-1);
            this.collapse();
        });

        // App-specific actions from .desktop file
        let addedAction = false;
        try {
            let info = app.get_app_info?.();
            let actions = info?.list_actions?.() ?? [];
            for (let action of actions.slice(0, 6)) {
                let actionLabel = info.get_action_name?.(action) ?? action;
                this._addMenuItem(menu, actionLabel, () => {
                    info.launch_action?.(action, null);
                    this.collapse();
                });
                addedAction = true;
            }
        } catch (_e) {}
        if (addedAction)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Quit (if running)
        if (app.get_state?.() === Shell.AppState.RUNNING) {
            this._addMenuItem(menu, 'Quit', () => {
                try { app.request_quit?.(); } catch (_e) {}
            });
        }

        // Pin / Unpin from taskbar (favorites)
        let favorites = AppFavorites.getAppFavorites();
        if (favorites.isFavorite(app.get_id())) {
            this._addMenuItem(menu, 'Unpin from Taskbar', () =>
                favorites.removeFavorite(app.get_id()));
        } else {
            this._addMenuItem(menu, 'Pin to Taskbar', () =>
                favorites.addFavorite(app.get_id()));
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // App Info
        this._addMenuItem(menu, 'App Info', () => {
            let appId = app.get_id();
            try {
                GLib.spawn_command_line_async(
                    `gnome-software --details ${GLib.shell_quote(appId)}`);
            } catch (_e) {
                try {
                    Gio.app_info_launch_default_for_uri(
                        `appstream://${appId}`, null);
                } catch (_e2) {}
            }
            this.collapse();
        });

        this._contextMenu = menu;
        menu.connect('menu-closed', () => {
            if (this._contextMenu === menu)
                this._dismissContextMenu(true);
        });
        this._contextMenuManager.addMenu(menu);
        menu.open();
    }

    _addMenuItem(menu, label, callback) {
        let item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
            try { callback?.(); } catch (_e) {}
            this._dismissContextMenu();
        });
        menu.addMenuItem(item);
    }

    _dismissContextMenu(fromNativeClose = false) {
        if (!this._contextMenu) return;
        let menu = this._contextMenu;
        this._contextMenu = null;
        if (!fromNativeClose) {
            try { menu.close(); } catch (_e) {}
        }
        try { this._contextMenuManager?.removeMenu?.(menu); } catch (_e) {}
        try {
            if (menu.actor?.get_parent())
                menu.actor.get_parent().remove_child(menu.actor);
            menu.destroy?.();
        } catch (_e) {}
    }

    // ── Drag and Drop ───────────────────────────────────────────

    _startDnd(sourceBtn, app) {
        this._dndActive = true;
        this._dndApp = app;
        this._dndSourceBtn = sourceBtn;
        let [sx, sy] = sourceBtn.get_transformed_position();
        this._dndStartX = sx;
        this._dndStartY = sy;

        // Create ghost
        let ghost = new St.Widget({
            style_class: 'convergence-app-menu-dnd-ghost',
            width: this._cellW,
            height: this._cellW,
            opacity: 240,
        });
        let ghostIcon = app.create_icon_texture(this._iconSize);
        ghostIcon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        ghost.add_child(ghostIcon);
        this._dndGhost = ghost;
        Main.layoutManager.uiGroup.add_child(ghost);

        ghost.set_position(sx, sy);
        ghost.set_pivot_point(0.5, 0.5);
        ghost.ease({
            scale_x: 1.1, scale_y: 1.1,
            duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        sourceBtn.opacity = 60;

        ghost.reactive = true;

        // Create an invisible full-screen overlay and grab it so ALL
        // pointer/touch events route to it — even though the original
        // button-press happened on a different actor before the overlay existed.
        this._dndOverlay = new St.Widget({
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
            opacity: 0,
        });
        Main.layoutManager.uiGroup.add_child(this._dndOverlay);
        Main.layoutManager.uiGroup.set_child_above_sibling(ghost, this._dndOverlay);

        // Grab the overlay so it receives all events regardless of
        // where the original press started
        this._dndGrab = global.stage.grab(this._dndOverlay);

        this._dndInHomeZone = false;
        this._dndInTaskbarZone = false;

        this._dndOverlay.connect('event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.MOTION ||
                type === Clutter.EventType.TOUCH_UPDATE) {
                let [x, y] = event.get_coords();
                if (this._dndGhost)
                    this._dndGhost.set_position(
                        x - this._dndGhost.width / 2,
                        y - this._dndGhost.height / 2);
                this._updateDndZones(x, y);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE ||
                type === Clutter.EventType.TOUCH_END) {
                let [x, y] = event.get_coords();
                this._finishDnd(x, y);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.TOUCH_CANCEL) {
                this._cancelDnd();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Safety timer — cancel after 5s
        this._dndSafetyTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            this._dndSafetyTimerId = 0;
            if (this._dndActive) this._cancelDnd();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateDndZones(x, y) {
        let homeScreen = this._controller?.getHomeScreenForCoords?.(x, y)
            ?? this._controller?.desktopHomeScreen
            ?? this._controller?.homeScreen;
        let taskbar = this._controller?.taskbar;

        // Check if over the panel (app menu) — not in any drop zone
        if (this._panel?.visible) {
            let [px, py] = this._panel.get_transformed_position();
            let pw = this._panel.width, ph = this._panel.height;
            if (x >= px && x <= px + pw && y >= py && y <= py + ph) {
                if (this._dndInHomeZone) {
                    this._dndInHomeZone = false;
                    homeScreen?.cancelExternalDndHover?.();
                }
                if (this._dndInTaskbarZone) {
                    this._dndInTaskbarZone = false;
                    this._controller?.taskbarIcons?.cancelExternalDndHover?.();
                }
                return;
            }
        }

        // Check if over taskbar
        let taskbarIcons = this._controller?.taskbarIcons;
        if (taskbar) {
            let tbRect = taskbar.getTaskbarRect?.();
            if (tbRect && x >= tbRect.x && x <= tbRect.x + tbRect.width &&
                y >= tbRect.y && y <= tbRect.y + tbRect.height) {
                if (this._dndInHomeZone) {
                    this._dndInHomeZone = false;
                    homeScreen?.cancelExternalDndHover?.();
                }
                if (!this._dndInTaskbarZone) this._dndInTaskbarZone = true;
                taskbarIcons?.showExternalDndHover?.(this._dndApp, x, y);
                return;
            }
        }

        // Left taskbar zone — cancel taskbar hover
        if (this._dndInTaskbarZone) {
            this._dndInTaskbarZone = false;
            taskbarIcons?.cancelExternalDndHover?.();
        }

        // Over the home screen area — show hover feedback
        if (homeScreen) {
            if (!this._dndInHomeZone) {
                this._dndInHomeZone = true;
            }
            this._dndHomeScreen = homeScreen;
            homeScreen.showExternalDndHover?.(x, y);
        }
    }

    _finishDnd(x, y) {
        if (!this._dndActive || !this._dndApp) {
            this._cancelDnd();
            return;
        }

        let dx = x - this._dndStartX;
        let dy = y - this._dndStartY;
        if (Math.sqrt(dx * dx + dy * dy) <= DND_MIN_DRAG_DIST) {
            this._cancelDnd();
            return;
        }

        // Check if dropped on the taskbar area → pin at indicated position
        let taskbarIcons = this._controller?.taskbarIcons;
        if (this._dndInTaskbarZone && taskbarIcons) {
            taskbarIcons.acceptExternalDrop(this._dndApp.get_id());
            this._cancelDnd();
            return;
        }

        // Check if dropped on home screen → add app shortcut
        let homeScreen = this._dndHomeScreen
            ?? this._controller?.desktopHomeScreen
            ?? this._controller?.homeScreen;
        if (this._dndInHomeZone && homeScreen) {
            homeScreen.acceptExternalDrop?.(this._dndApp.get_id(), x, y);
            this._cancelDnd();
            return;
        }

        // Dropped elsewhere — no action
        this._cancelDnd();
    }

    _cancelDnd() {
        if (this._dndSafetyTimerId) {
            GLib.source_remove(this._dndSafetyTimerId);
            this._dndSafetyTimerId = 0;
        }
        if (this._dndInHomeZone) {
            this._dndInHomeZone = false;
            this._dndHomeScreen?.cancelExternalDndHover?.();
        }
        this._dndHomeScreen = null;
        if (this._dndInTaskbarZone) {
            this._dndInTaskbarZone = false;
            this._controller?.taskbarIcons?.cancelExternalDndHover?.();
        }
        if (this._dndGrab) {
            this._dndGrab.dismiss();
            this._dndGrab = null;
        }
        if (this._dndOverlay) {
            let parent = this._dndOverlay.get_parent();
            if (parent) parent.remove_child(this._dndOverlay);
            this._dndOverlay.destroy();
            this._dndOverlay = null;
        }
        if (this._dndGhost) {
            let parent = this._dndGhost.get_parent();
            if (parent) parent.remove_child(this._dndGhost);
            this._dndGhost.destroy();
            this._dndGhost = null;
        }
        if (this._dndSourceBtn) {
            this._dndSourceBtn.opacity = 255;
            this._dndSourceBtn = null;
        }
        this._dndActive = false;
        this._dndApp = null;
        this._dndEndedMs = GLib.get_monotonic_time() / 1000;
    }

    _createActionGridItem(item) {
        let pad = this._labelPadH;
        let box = new St.BoxLayout({
            style_class: 'convergence-app-menu-action-content convergence-app-icon-button convergence-app-menu-action-item',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: false,
            style: `padding: 0 ${pad}px;`,
        });

        let icon = new St.Icon({
            icon_name: item.icon ?? 'system-search-symbolic',
            icon_size: this._iconSize,
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(icon);

        let label = new St.Label({
            text: item.label,
            style_class: 'convergence-app-menu-grid-label convergence-app-label',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: `min-height: ${this._labelH}px; height: ${this._labelH}px; font-size: ${this._labelFontSize}px; margin-top: ${this._labelMarginTop}px;`,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: 2,
            ellipsize: 3,
            max_length: 0,
        });
        label.clutter_text.set_line_alignment(1);
        box.add_child(label);

        if (item.subtitle) {
            let sub = new St.Label({
                text: item.subtitle,
                style_class: 'convergence-app-menu-action-subtitle',
                style: `font-size: ${Math.round(this._labelFontSize * 0.85)}px;`,
                x_align: Clutter.ActorAlign.CENTER,
            });
            sub.clutter_text.set({ ellipsize: 3 });
            box.add_child(sub);
        }

        let button = new St.Button({
            child: box,
            style_class: 'convergence-app-menu-grid-item',
            style: 'padding: 0; margin: 0;',
            can_focus: true,
        });
        addClickCursor(button, this._runtimeDisposer);
        button.connect('notify::hover', () => {
            if (button.hover)
                box.add_style_pseudo_class('hover');
            else
                box.remove_style_pseudo_class('hover');
        });
        button.connect('button-press-event', () => {
            box.add_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            box.remove_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('leave-event', () => {
            box.remove_style_pseudo_class('active');
            box.remove_style_pseudo_class('hover');
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('clicked', () => {
            this._executeSearchAction(item);
        });

        return button;
    }

    // ── Category Bar ─────────────────────────────────────────────────

    /**
     * Sync the category filter bar with current app counts.
     * @param {Object[]} allApps
     * @param {Set} pinnedIds
     * @param {string} query
     * @private
     */
    _syncCategoryBar(allApps, pinnedIds, query = '') {
        let bar = this._categoryBar;
        let scroll = this._categoryBarScroll;
        if (!bar || !scroll) return;

        let show = !query;
        scroll.visible = show;
        if (!show) return;

        let counts = new Map();
        for (let app of allApps) {
            let appId = app?.get_id?.();
            if (!appId || pinnedIds.has(appId)) continue;
            let key = this._getAppCategoryKey(app);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        if (this._currentCategoryKey !== 'all' &&
            !(counts.get(this._currentCategoryKey) > 0))
            this._currentCategoryKey = 'all';

        let visibleDefs = DETACHED_CATEGORY_DEFS.filter(
            def => def.key === 'all' || (counts.get(def.key) ?? 0) > 0);
        let sig = [
            this._currentCategoryKey,
            ...visibleDefs.map(d => `${d.key}:${counts.get(d.key) ?? 0}`),
        ].join('|');
        if (sig === this._categorySig) return;
        this._categorySig = sig;

        bar.destroy_all_children();
        for (let def of visibleDefs) {
            let active = def.key === this._currentCategoryKey;
            let count = counts.get(def.key) ?? 0;
            let label = def.key === 'all' ? def.label : `${def.label} ${count}`;
            let chipLabel = new St.Label({ text: label });
            chipLabel.clutter_text.set({ ellipsize: 0 }); // NONE
            let chip = new St.Button({
                style_class: active
                    ? 'convergence-app-menu-category-chip convergence-app-menu-category-chip-active convergence-drawer-category-chip convergence-drawer-category-chip-active'
                    : 'convergence-app-menu-category-chip convergence-drawer-category-chip',
                child: chipLabel,
                can_focus: true,
            });
            addClickCursor(chip, this._runtimeDisposer);
            chip.connect('clicked', () => {
                if (this._currentCategoryKey === def.key) return;
                this._currentCategoryKey = def.key;
                this._categorySig = '';
                this._populateGrid(this._searchEntry?.get_text?.()?.trim() ?? '');
            });
            bar.add_child(chip);
        }
    }

    // ── Category Classification ──────────────────────────────────────

    /**
     * Get the category key for an app.
     * @param {Object} app
     * @returns {string}
     * @private
     */
    _getAppCategoryKey(app) {
        let appId = app?.get_id?.();
        if (appId && this._appCategoryCache.has(appId))
            return this._appCategoryCache.get(appId);

        let tokens = this._getAppCategoryTokens(app);
        let key = 'other';
        for (let token of tokens) {
            let mapped = APP_CATEGORY_TOKEN_MAP.get(token);
            if (mapped) { key = mapped; break; }
            for (let [re, hinted] of APP_CATEGORY_HINTS) {
                if (re.test(token)) { key = hinted; break; }
            }
            if (key !== 'other') break;
        }
        if (appId) this._appCategoryCache.set(appId, key);
        return key;
    }

    /**
     * Extract category/keyword tokens from an app.
     * @param {Object} app
     * @returns {string[]}
     * @private
     */
    _getAppCategoryTokens(app) {
        let tokens = [];
        try {
            let raw = app?.get_app_info?.()?.get_categories?.();
            if (raw && typeof raw === 'string')
                tokens.push(...raw.split(';'));
        } catch (_e) {}
        try {
            let keywords = app?.get_app_info?.()?.get_keywords?.();
            if (Array.isArray(keywords)) tokens.push(...keywords);
        } catch (_e) {}
        try {
            let name = app?.get_name?.();
            if (name) tokens.push(name);
        } catch (_e) {}
        return tokens.map(s => `${s}`.trim()).filter(Boolean);
    }

    // ── Search Scoring ───────────────────────────────────────────────

    /**
     * Score an app against a search query.
     * @param {Object} app
     * @param {string} query
     * @returns {number}
     * @private
     */
    _scoreSearchApp(app, query) {
        if (!query) return 0;
        let terms = query.split(' ').filter(Boolean);
        if (terms.length === 0) return 0;

        let fields = this._extractSearchFields(app);
        let haystacks = [fields.name, fields.idBase, fields.id, fields.keywords];

        let score = 0;
        for (let term of terms) {
            let termScore = 0;
            for (let haystack of haystacks) {
                if (!haystack) continue;
                if (haystack === term) termScore = Math.max(termScore, 100);
                else if (haystack.startsWith(term)) termScore = Math.max(termScore, 80);
                else if (haystack.includes(term)) termScore = Math.max(termScore, 50);
            }
            if (fields.acronym && fields.acronym.startsWith(term))
                termScore = Math.max(termScore, 70);
            if (termScore === 0) return 0;
            score += termScore;
        }
        return score;
    }

    /**
     * Extract and cache search fields from an app.
     * @param {Object} app
     * @returns {Object}
     * @private
     */
    _extractSearchFields(app) {
        let appId = app.get_id?.() ?? '';
        if (!this._searchFieldCache)
            this._searchFieldCache = new Map();
        let cached = this._searchFieldCache.get(appId);
        if (cached) return cached;

        let name = this._normalizeSearchText(
            app.get_display_name?.() || app.get_name?.() || '');
        let id = this._normalizeSearchText(appId);
        let idBase = id.replace(/\.desktop$/, '').split('.').pop() ?? id;
        let keywords = '';
        try {
            let info = app.get_app_info?.();
            let keys = info?.get_keywords?.() ?? [];
            keywords = this._normalizeSearchText(keys.join(' '));
        } catch (_e) {}
        let acronym = name
            .split(/[\s._-]+/)
            .filter(Boolean)
            .map(w => w[0])
            .join('');
        let fields = { name, id, idBase, keywords, acronym };
        if (appId) this._searchFieldCache.set(appId, fields);
        return fields;
    }

    // ── Search Actions ───────────────────────────────────────────────

    /**
     * Build search action items (settings panels, calculator).
     * @param {string} rawQuery
     * @param {string} query
     * @returns {Object[]}
     * @private
     */
    _buildSearchActionItems(rawQuery, query) {
        if (!query) return [];
        let actions = [];

        for (let entry of SETTINGS_PANELS) {
            if (entry.keys.some(k => query.includes(k))) {
                actions.push({
                    type: 'action',
                    id: `action:settings:${entry.panel}`,
                    label: entry.label,
                    subtitle: 'Open GNOME Control Center',
                    icon: 'preferences-system-symbolic',
                    action: 'settings-panel',
                    payload: entry.panel,
                });
            }
        }

        let calc = this._evaluateMathExpression(rawQuery);
        if (calc !== null) {
            actions.push({
                type: 'action',
                id: `action:calc:${query}`,
                label: `Calculate: ${rawQuery}`,
                subtitle: `Result: ${calc}`,
                icon: 'accessories-calculator-symbolic',
                action: 'copy-text',
                payload: calc,
            });
        }

        return actions.slice(0, 5);
    }

    /**
     * Activate the top search result.
     * @returns {boolean}
     * @private
     */
    _activateTopSearchResult() {
        let first = this._gridButtonMap?.[0];
        if (first?.app) {
            if (this._controller.activateApp)
                this._controller.activateApp(first.app);
            else
                first.app.activate();
            this.collapse();
            return true;
        }
        return false;
    }

    /**
     * Execute a search action item.
     * @param {Object} item
     * @returns {boolean}
     * @private
     */
    _executeSearchAction(item) {
        if (!item || item.type !== 'action') return false;
        try {
            if (item.action === 'settings-panel') {
                Gio.Subprocess.new(
                    ['gnome-control-center', item.payload ?? ''],
                    Gio.SubprocessFlags.NONE);
                this.collapse();
                return true;
            }
            if (item.action === 'copy-text') {
                St.Clipboard.get_default().set_text(
                    St.ClipboardType.CLIPBOARD, `${item.payload ?? ''}`);
                return true;
            }
        } catch (_e) {
            return false;
        }
        return false;
    }

    // ── Utilities ────────────────────────────────────────────────────

    /**
     * Evaluate a simple math expression.
     * @param {string} query
     * @returns {string|null}
     * @private
     */
    _evaluateMathExpression(query) {
        try {
            let normalized = `${query}`.replace(/,/g, '.').trim();
            if (!/^[\d\s+\-*/().,%]+$/.test(normalized)) return null;
            let fn = Function(`"use strict"; return (${normalized});`);
            let val = fn();
            if (!Number.isFinite(val)) return null;
            return `${val}`;
        } catch (_e) {
            return null;
        }
    }

    /**
     * Normalize text for search comparison.
     * @param {string} text
     * @returns {string}
     * @private
     */
    _normalizeSearchText(text) {
        return `${text ?? ''}`.toLowerCase().trim().replace(/\s+/g, ' ');
    }

    // ── Cleanup ──────────────────────────────────────────────────────

    /**
     * Clean up all resources.
     */
    destroy() {
        this.collapse();
        this._cancelDnd();
        this._dismissContextMenu();

        if (this._preBuildIdleId) {
            GLib.source_remove(this._preBuildIdleId);
            this._preBuildIdleId = 0;
        }
        if (this._appInstalledId) {
            Shell.AppSystem.get_default().disconnect(this._appInstalledId);
            this._appInstalledId = 0;
        }

        // Disconnect signals while actors still exist to avoid
        // "already disposed" warnings during panel.destroy().
        this._runtimeDisposer.dispose();
        this._logger?.destroy?.();

        // Destroy cached items not currently in the grid
        for (let [, btn] of this._cachedGridItems) {
            if (!btn.get_parent()) btn.destroy();
        }
        this._cachedGridItems.clear();

        if (this._panel) {
            this._backdrop?.remove_effect_by_name?.('app-menu-backdrop-blur');
            let parent = this._panel.get_parent();
            if (parent) {
                try { parent.remove_child(this._panel); } catch (_e) {}
            }
            this._panel.destroy();
            this._panel = null;
        }

        if (this._backdrop) {
            let parent = this._backdrop.get_parent();
            if (parent) {
                try { parent.remove_child(this._backdrop); } catch (_e) {}
            }
            this._backdrop.destroy();
            this._backdrop = null;
        }
    }
}
