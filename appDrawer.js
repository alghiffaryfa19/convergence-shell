// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import { Logger } from '../../shared/utilities/logger.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';
import { snapToPixel, addClickCursor, createLongPressController } from '../../shared/utilities/uiUtils.js';
import { REF_SCREEN_W, REF_COL_COUNT_PITCH } from '../../shared/utilities/layoutConstants.js';
import {
    SCROLL_MULTIPLIER,
    SCROLL_END_TIMEOUT,
    TOUCH_LONG_PRESS_CANCEL_DIST,
    DND_EDGE_ZONE_WIDTH,
    DND_EDGE_SCROLL_DELAY,
} from '../../shared/utilities/gestureConstants.js';

import { DrawerGrid } from './drawerGrid.js';
import { DrawerGestures } from './drawerGestures.js';
import { DrawerSearch } from './drawerSearch.js';
import { DrawerIcons } from './drawerIcons.js';
import { DrawerUninstall } from './drawerUninstall.js';

/**
 * Drawer visual states.
 * DOCK: favorites bar visible at screen bottom.
 * EXPANDED: full-screen app grid overlay.
 */
export const DrawerState = {
    DOCK: 0,
    EXPANDED: 1,
};

export const DND_ENABLED = true;
const FOLDERS_ENABLED = true;

export const DOCK_HEIGHT = 100;
export const ANIMATION_DURATION = 280;
export const LAUNCHPAD_OPEN_MS = 320;
export const LAUNCHPAD_CLOSE_MS = 260;
export const LAUNCHPAD_PAGE_SNAP_MS = 300;
const GRID_NOTIFICATION_POLL_MS = 5000;
export const DRAG_CLAIM_THRESHOLD = 10;
export { TOUCH_LONG_PRESS_CANCEL_DIST };

const DND_MERGE_DWELL_TIME = 500;
const DND_MERGE_HOTSPOT_RATIO = 0.42;
const DND_REORDER_HYSTERESIS_RATIO = 0.18;

export const KINETIC_DECEL = 0.997;
export const KINETIC_MIN_VELOCITY = 0.03;
export const RUBBER_BAND_FACTOR = 0.3;

const LAYOUT_SAVE_DEBOUNCE_MS = 120;
const GRID_BUILD_CHUNK = 18;
const BLUR_SIGMA_IDLE = 24;
const BLUR_SIGMA_ACTIVE = 16;
export const DOCK_LAUNCH_BOUNCE_MS = 130;

const PHONE_DOCK_MAX_ICONS = 5;
const PHONE_ATTACHED_GRID_MAX_COLS = 5;

/**
 * Phone-specific full-screen app drawer.
 *
 * Provides a dock (favorites row at the bottom of the screen) that slides up
 * into a full app grid when swiped.  Supports paginated grids, folder popups,
 * search, drag-and-drop reordering, and uninstall via drag-to-remove zone.
 */
export class AppDrawer {
    /**
     * @param {object} controller - The phone shell controller.
     * @param {Gio.Settings|null} settings - Extension GSettings instance.
     */
    constructor(controller, settings) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._logger = new Logger('AppDrawer', this._settings);
        this._state = DrawerState.DOCK;
        this._runtimeDisposer = new RuntimeDisposer();
        this._pages = [];
        this._currentPage = 0;
        this._grab = null;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragStartTranslation = 0;
        this._dragStartPageX = 0;
        this._dragClaimed = false;
        this._dragDirection = null;
        this._pressed = false;
        this._pageWidth = 0;
        this._emergencyDisableId = 0;

        this._scrollGestureActive = false;
        this._scrollAccumX = 0;
        this._scrollAccumY = 0;
        this._scrollTimeoutId = 0;

        this._contextMenu = null;
        this._contextMenuIsPopup = false;
        this._contextMenuManager = null;

        this._activeLpCancel = null;

        this._dndActive = false;
        this._dndEndedMs = 0;
        this._dndApp = null;
        this._dndGridItem = null;
        this._dndGhost = null;
        this._dndSourceBtn = null;
        this._dndGrab = null;
        this._dndSafetyTimerId = 0;
        this._dndStartX = 0;
        this._dndStartY = 0;
        this._dndPreviewIndex = -1;
        this._dndInHomeZone = false;
        this._dndHomeTarget = null;
        this._dndWasExpanded = false;
        this._dndEdgeScrollTimerId = 0;
        this._dndEdgeScrollDir = 0;
        this._dndMergeDwellTimerId = 0;
        this._dndMergeDwellItem = null;
        this._dndMergeReady = false;
        this._dndMergeTargetBtn = null;
        this._dndFromDock = false;
        this._suppressFavChanged = false;
        this._dndDockPreviewPos = -1;
        this._dndDockSourceIndex = -1;
        this._dndRemoveZone = null;
        this._dndOverRemoveZone = false;

        this._folderPopup = null;
        this._folderCaptureId = 0;
        this._currentFolder = null;
        this._drawerFolderPages = [];
        this._drawerFolderPagesContainer = null;
        this._drawerFolderDotsContainer = null;
        this._drawerFolderGridClip = null;
        this._drawerFolderCurrentPage = 0;
        this._drawerFolderPageWidth = 0;
        this._drawerFolderSwipePressed = false;
        this._drawerFolderSwipeClaimed = false;
        this._drawerFolderFingerMoved = false;
        this._drawerFolderSwipeStartX = 0;
        this._drawerFolderSwipeStartY = 0;
        this._drawerFolderSwipeStartPageX = 0;
        this._drawerFolderSwipeTimestamp = 0;

        this._gridItems = [];
        this._gridButtonMap = [];
        this._lastPopulateFilter = null;

        this._saveLayoutTimeoutId = 0;
        this._searchDebounceId = 0;
        this._populateGridIdleId = 0;
        this._populateGridBuildToken = 0;

        this._searchTopAppId = null;
        this._searchTopItem = null;
        this._launchpadEditMode = false;
        this._launchpadEditModeSticky = false;
        this._launchpadJiggleTimerId = 0;
        this._launchpadJiggleFlip = false;
        this._preferredStoreCache = null;
        this._uninstallCapabilityCache = new Map();
        this._deleteConfirmDialog = null;
        this._deleteConfirmGrab = null;
        this._deleteConfirmCaptureId = 0;
        this._gridNotifByApp = new Map();
        this._gridNotificationPollId = 0;
        this._gridNotifSignalConnected = false;
        this._gridNotifTrackedSources = new Set();
        this._pageViewportH = 0;
        this._appCategoryCache = new Map();
        this._dockDndPlaceholder = null;
        this._externalHomeRevealActive = false;
        this._firstShow = true;

        this._grid = new DrawerGrid(this, settings);
        this._gestures = new DrawerGestures(this, settings);
        this._search = new DrawerSearch(this, settings);
        this._icons = new DrawerIcons(this, settings);
        this._uninstall = new DrawerUninstall(this, settings);

        this._build();
        this._populateApps();
        this._connectSignals();

        // Calculate geometry and show the dock (collapsed state) at startup
        this._updateGeometry();
        this._showDock();
    }

    /** Show the drawer in collapsed dock state at the bottom of the screen. */
    _showDock() {
        if (!this._actor) return;
        this._state = DrawerState.DOCK;
        this._actor.show();
        this._actor.translation_y = this._dockTranslation ?? 0;
        this._backdrop.visible = false;
        this._backdrop.opacity = 0;
        if (this._expandedContent)
            this._expandedContent.visible = false;

    }

    /** Whether the drawer is in the expanded (full grid) state. */
    get isExpanded() {
        return this._state === DrawerState.EXPANDED;
    }

    // ── Layout persistence ────────────────────────────────────────────

    /**
     * Load persisted grid layout from GSettings.
     * @returns {Array|null}
     */
    _loadLayout() {
        if (!this._settings)
            return null;
        let json = this._settings.get_string('app-grid-layout');
        if (!json)
            return null;
        try {
            let arr = JSON.parse(json);
            return Array.isArray(arr) ? arr : null;
        } catch {
            return null;
        }
    }

    /** Debounced save of the current grid layout to GSettings. */
    _saveCurrentLayout() {
        this._runtimeDisposer.restartTimeout(
            this, '_saveLayoutTimeoutId',
            GLib.PRIORITY_DEFAULT, LAYOUT_SAVE_DEBOUNCE_MS,
            () => {
                this._flushCurrentLayoutSave();
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Immediately persist the grid layout. */
    _flushCurrentLayoutSave() {
        if (!this._settings)
            return;
        let json = this._gridItems.map(item => {
            if (item.type === 'folder')
                return { name: item.name, apps: [...item.apps] };
            else
                return item.id;
        });
        this._settings.set_string('app-grid-layout', JSON.stringify(json));
    }

    _setGestureBlurActive(active) {
        if (!this._blurEffect)
            return;
        this._blurEffect.sigma = active ? BLUR_SIGMA_ACTIVE : BLUR_SIGMA_IDLE;
    }

    _getEffectivePanelHeight() {
        return Main.panel?.height || 0;
    }

    _scheduleGridRealign() {
        this._runtimeDisposer.restartTimeout(
            this, '_gridRealignId',
            GLib.PRIORITY_DEFAULT_IDLE, 0,
            () => {
                this._realignGridPages();
                return GLib.SOURCE_REMOVE;
            });
    }

    _getDrawerAnimationDuration(baseMs, velocity = null) {
        let monitor = Main.layoutManager.primaryMonitor;
        let scale = monitor?.geometry_scale ?? 1;
        let scaleMul = Math.max(0.92, Math.min(1.16, 1 + ((scale - 1) * 0.12)));
        let velocityMul = 1;
        if (Number.isFinite(velocity)) {
            let speed = Math.abs(velocity);
            velocityMul = Math.max(0.78, Math.min(1.08, 1 - (speed * 0.08)));
        }
        return Math.round(baseMs * scaleMul * velocityMul);
    }

    // ── Expand / collapse ─────────────────────────────────────────────

    /**
     * Check whether the phone is currently showing the home screen.
     * @returns {boolean}
     */
    _isOnPhoneHomeScreen() {
        let phoneStack = this._controller?.phoneWindowStack;
        if (phoneStack?.isActive)
            return phoneStack.getActiveWindow() === null;
        let activeWs = global.workspace_manager?.get_active_workspace_index?.() ?? 0;
        return activeWs === 0;
    }

    _getTargetTranslation(state) {
        return state === DrawerState.EXPANDED
            ? this._expandedTranslation
            : this._dockTranslation;
    }

    /**
     * Animate the drawer to a target state.
     * @param {number} state - DrawerState.DOCK or DrawerState.EXPANDED.
     */
    _animateTo(state) {
        if (state === DrawerState.DOCK) {
            if (!this._isOnPhoneHomeScreen()) {
                this.hide();
                return;
            }
        }

        this._state = state;
        let animDuration = Math.max(180, Math.min(420,
            this._getDrawerAnimationDuration(ANIMATION_DURATION)));
        let targetT = this._getTargetTranslation(state);

        if (state === DrawerState.EXPANDED) {
            this._controller?.onDrawerExpanding?.(animDuration);
            this._backdrop.show();
            this._backdrop.ease({
                opacity: 180,
                duration: animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            this._expandedContent.visible = true;
            this._expandedContent.opacity = 0;
            let fadeDuration = Math.round(animDuration * 0.3);
            this._expandedContent.ease({
                opacity: 255,
                duration: fadeDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._setLaunchpadEditMode(false);
            this._dismissDeleteConfirmDialog();
            if (this._searchEntry) {
                this._searchEntry.set_text('');
                global.stage.set_key_focus(null);
            }
            this._controller?.onDrawerCollapsing?.(animDuration);
            this._backdrop.ease({
                opacity: 0,
                duration: animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._backdrop.hide(),
            });
            let fadeDuration = Math.round(animDuration * 0.3);
            this._expandedContent.ease({
                opacity: 0,
                duration: fadeDuration,
                delay: animDuration - fadeDuration,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    if (this._state === DrawerState.DOCK && this._expandedContent)
                        this._expandedContent.visible = false;
                },
            });
        }

        this._actor.ease({
            translation_y: targetT,
            duration: animDuration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /**
     * Get the total travel distance for home-reveal gesture integration.
     * @returns {number}
     */
    getRevealTravelRange() {
        return Math.max(0,
            (this._dockTranslation ?? 0) - (this._expandedTranslation ?? 0));
    }

    /** Prepare the drawer for an external home-reveal gesture. */
    startHomeRevealGesture() {
        if (!this._actor)
            return;
        this._externalHomeRevealActive = true;
        this._actor.remove_all_transitions?.();
        this._backdrop.remove_all_transitions?.();
        this._expandedContent.remove_all_transitions?.();
        this._expandedContent.visible = true;
        this._actor.show();
        this._backdrop.show();
    }

    /**
     * Update the drawer position during an external home-reveal gesture.
     * @param {number} progress - 0 (dock) to 1 (expanded).
     */
    updateHomeRevealGesture(progress) {
        if (!this._externalHomeRevealActive || !this._actor)
            return;
        let p = Math.max(0, Math.min(1, progress));
        let range = this._dockTranslation - this._expandedTranslation;
        let ty = this._dockTranslation - (range * p);
        this._actor.translation_y = ty;
        this._backdrop.opacity = Math.round(180 * p);
        this._expandedContent.opacity = Math.round(255 * Math.min(1, p / 0.1));
        if (p <= 0) {
            this._backdrop.hide();
            this._expandedContent.opacity = 0;
        } else if (!this._backdrop.visible) {
            this._backdrop.show();
        }
    }

    /**
     * Finish the external home-reveal gesture.
     * @param {boolean} commit - True to expand, false to collapse.
     */
    endHomeRevealGesture(commit) {
        if (!this._externalHomeRevealActive)
            return;
        this._externalHomeRevealActive = false;
        if (commit)
            this._animateTo(DrawerState.EXPANDED);
        else
            this._animateTo(DrawerState.DOCK);
    }

    /** Expand the drawer to full-screen grid. */
    expand() {
        this._externalHomeRevealActive = false;
        this._updateGeometry();
        this._animateTo(DrawerState.EXPANDED);
    }

    /** Collapse back to the dock (favorites bar). */
    collapse() {
        this._externalHomeRevealActive = false;
        this._closeFolderPopup();
        this._dismissContextMenu();
        this._dismissDeleteConfirmDialog();
        this._setLaunchpadEditMode(false);
        this._animateTo(DrawerState.DOCK);
    }

    /** Hide the drawer entirely (when leaving the home workspace). */
    hide() {
        this._externalHomeRevealActive = false;
        if (this._state === DrawerState.EXPANDED)
            this._state = DrawerState.DOCK;
        this._setLaunchpadEditMode(false);

        this._closeFolderPopup();
        this._dismissContextMenu();
        this._dismissDeleteConfirmDialog();

        if (this._searchEntry) {
            this._searchEntry.set_text('');
            global.stage.set_key_focus(null);
        }

        this._backdrop.hide();
        this._backdrop.opacity = 0;
        this._expandedContent.visible = false;
        this._expandedContent.opacity = 0;

        this._actor.remove_all_transitions?.();
        this._actor.ease({
            translation_y: this._fullHeight,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (this._actor) {
                    this._actor.hide();
                    this._actor.translation_y = this._dockTranslation;
                }
            },
        });

        this._runtimeDisposer.restartTimeout(
            this, '_hideGuardTimerId',
            GLib.PRIORITY_DEFAULT, 260,
            () => {
                if (this._actor && this._actor.visible &&
                    this._state === DrawerState.DOCK &&
                    !this._externalHomeRevealActive) {
                    if (!this._isOnPhoneHomeScreen()) {
                        this._actor.hide();
                        this._actor.translation_y = this._dockTranslation;
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Show the drawer in dock state (returning to home workspace). */
    show() {
        if (!this._isOnPhoneHomeScreen()) {
            this.hide();
            return;
        }

        this._runtimeDisposer.clearTimeoutRef(this, '_hideGuardTimerId');

        this._expandedContent.visible = false;
        this._expandedContent.opacity = 0;

        let settledTY = Math.abs((this._actor.translation_y ?? 0) - this._dockTranslation) <= 1;
        let alreadyVisibleDock =
            this._state === DrawerState.DOCK &&
            !this._firstShow &&
            this._actor.visible &&
            settledTY;

        if (alreadyVisibleDock) {
            this._actor.opacity = 255;
            return;
        }

        this._actor.translation_y = this._fullHeight;
        this._actor.show();

        if (this._firstShow) {
            this._firstShow = false;
            this._actor.opacity = 0;
            this._actor.ease({
                translation_y: this._dockTranslation,
                opacity: 255,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._actor.ease({
                translation_y: this._dockTranslation,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    /**
     * Snap the grid to a specific page.
     * @param {number} pageIndex
     * @param {boolean} [animate=true]
     */
    snapToPage(pageIndex, animate = true) {
        if (pageIndex < 0 || pageIndex >= this._pages.length)
            return;

        this._currentPage = pageIndex;
        let pageSpan = this._pageWidth || this._drawerWidth || 1;
        let target = snapToPixel(-(pageIndex * pageSpan));

        if (animate) {
            let duration = Math.max(180, Math.min(420,
                this._getDrawerAnimationDuration(250)));
            this._pagesContainer.ease({
                translation_x: target,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._pagesContainer.remove_all_transitions();
            this._pagesContainer.translation_x = target;
        }

        let dots = this._dotsContainer.get_children();
        for (let i = 0; i < dots.length; i++) {
            dots[i].style_class = i === pageIndex
                ? 'convergence-page-dot convergence-page-dot-active'
                : 'convergence-page-dot';
            dots[i].remove_all_transitions?.();
            dots[i].set_pivot_point?.(0.5, 0.5);
            dots[i].ease?.({
                scale_x: i === pageIndex ? 1.18 : 1,
                scale_y: i === pageIndex ? 1.18 : 1,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _cancelEmergencyDisable() {
        if (this._emergencyDisableId) {
            GLib.source_remove(this._emergencyDisableId);
            this._emergencyDisableId = 0;
        }
    }

    // ── Edit mode ─────────────────────────────────────────────────────

    _setLaunchpadEditMode(active) {
        if (this._launchpadEditMode === active)
            return;
        this._launchpadEditMode = active;
        this._syncLaunchpadEditModeVisuals();
    }

    _syncLaunchpadEditModeVisuals() {
        // Stub: jiggle animation and delete badges are managed externally
    }

    _closeFolderPopup() {
        if (this._folderPopup) {
            this._folderPopup.destroy();
            this._folderPopup = null;
        }
        this._currentFolder = null;
    }

    _dismissContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.close?.();
            this._contextMenu = null;
        }
    }

    _dismissDeleteConfirmDialog() {
        this._uninstall.dismissDeleteConfirmDialog();
    }

    // ── Grid helpers ──────────────────────────────────────────────────

    _getScrollBounds() {
        let totalH = 0;
        for (let page of this._pages)
            totalH += page.height || 0;
        let viewportH = this._pageViewportH || this._gridClip?.height || 400;
        let maxScroll = Math.max(0, totalH - viewportH);
        return { maxScroll, viewportH, totalH };
    }

    _isInGridMergeHotspot(button, stageX, stageY) {
        if (!button)
            return false;
        let [bx, by] = button.get_transformed_position();
        let bw = button.get_width();
        let bh = button.get_height();
        if (bw <= 0 || bh <= 0)
            return false;
        let cx = bx + bw / 2;
        let cy = by + bh / 2;
        let hotspotW = bw * DND_MERGE_HOTSPOT_RATIO;
        let hotspotH = bh * DND_MERGE_HOTSPOT_RATIO;
        return Math.abs(stageX - cx) <= hotspotW / 2 &&
            Math.abs(stageY - cy) <= hotspotH / 2;
    }

    _getPrimaryDockIndexForAppId(appId) {
        if (!this._favoritesRow || !appId)
            return -1;
        let children = this._favoritesRow.get_children();
        for (let i = 0; i < children.length; i++) {
            let childApp = children[i]._convergenceApp;
            if (childApp?.get_id?.() === appId)
                return i;
        }
        return -1;
    }

    // ── Build UI ──────────────────────────────────────────────────────

    _build() {
        let panelHeight = this._getEffectivePanelHeight();

        this._backdrop = new St.Widget({
            style_class: 'convergence-drawer-backdrop',
            reactive: true,
            opacity: 0,
            visible: false,
        });
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._backdrop.connect('button-release-event', () => {
            this.collapse();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_END) {
                this.collapse();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        });

        this._actor = new St.Widget({
            style_class: 'convergence-drawer',
            reactive: true,
            visible: false,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._glassBlur = new St.Widget({
            x_expand: true,
            y_expand: true,
            style_class: 'convergence-drawer-glass',
        });
        try {
            this._blurEffect = new Shell.BlurEffect({
                sigma: BLUR_SIGMA_IDLE,
                brightness: 0.6,
                mode: Shell.BlurMode.BACKGROUND,
            });
            this._glassBlur.add_effect(this._blurEffect);
        } catch (e) {
            this._blurEffect = null;
        }
        this._actor.add_child(this._glassBlur);

        this._glassTint = new St.Widget({
            x_expand: true,
            y_expand: true,
            style_class: 'convergence-drawer-tint',
        });
        this._actor.add_child(this._glassTint);

        this._updateGeometry();

        let layout = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._mainLayout = layout;
        this._actor.add_child(layout);

        this._favoritesRow = new St.BoxLayout({
            style_class: 'convergence-drawer-favorites',
            x_align: Clutter.ActorAlign.CENTER,
        });
        layout.add_child(this._favoritesRow);

        this._expandedContent = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            opacity: 0,
        });
        layout.add_child(this._expandedContent);

        this._searchShell = new St.BoxLayout({
            style_class: 'convergence-drawer-search-shell',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._searchEntry = new St.Entry({
            hint_text: 'Search apps...',
            style_class: 'convergence-drawer-search',
            x_expand: true,
            can_focus: true,
        });
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._search.onSearchChanged();
        });
        this._searchEntry.clutter_text.connect('key-press-event', (_ct, event) => {
            return this._search.onSearchKeyPress(event);
        });
        this._searchEntry.clutter_text.connect('key-focus-in', () => {
            this._searchEntry.add_style_class_name('convergence-search-focused');
            this._searchEntry.remove_all_transitions?.();
            this._searchEntry.ease({
                scale_x: 1.01,
                scale_y: 1.01,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            if ((this._searchEntry.get_text()?.trim() ?? '') === '' &&
                this._lastPopulateFilter !== '')
                this._populateGrid('');
        });
        this._searchEntry.clutter_text.connect('key-focus-out', () => {
            this._searchEntry.remove_style_class_name('convergence-search-focused');
            this._searchEntry.remove_all_transitions?.();
            this._searchEntry.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            if ((this._searchEntry.get_text()?.trim() ?? '') === '' &&
                this._lastPopulateFilter !== '')
                this._populateGrid('');
        });
        this._searchEntry.connect('button-release-event', () => {
            global.stage.set_key_focus(this._searchEntry);
            return Clutter.EVENT_STOP;
        });
        this._searchEntry.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_END) {
                global.stage.set_key_focus(this._searchEntry);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._searchShell.add_child(this._searchEntry);
        this._expandedContent.add_child(this._searchShell);

        this._gridClip = new St.Widget({
            x_expand: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
            height: this._gridHeight,
            style: 'margin: 0 16px;',
        });

        this._pagesContainer = new St.BoxLayout({
            vertical: false,
        });
        this._gridClip.add_child(this._pagesContainer);

        this._expandedContent.add_child(this._gridClip);

        this._gridClip.connect('notify::allocation', () => {
            let box = this._gridClip.get_allocation_box();
            let w = box.x2 - box.x1;
            let h = box.y2 - box.y1;
            if (w > 0 && (w !== this._pageWidth || h !== this._pageViewportH))
                this._scheduleGridRealign();
        });

        this._dotsContainer = new St.BoxLayout({
            style_class: 'convergence-page-dots',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._expandedContent.add_child(this._dotsContainer);

        this._bottomSpacer = new St.Widget({ y_expand: true });
        layout.add_child(this._bottomSpacer);

        this._actor.connect('captured-event', (_actor, event) => {
            return this._gestures.onDrawerCapturedEvent(event);
        });

        Main.layoutManager.uiGroup.insert_child_below(
            this._backdrop, Main.layoutManager.modalDialogGroup);
        Main.layoutManager.uiGroup.insert_child_below(
            this._actor, Main.layoutManager.modalDialogGroup);
    }

    _updateGeometry() {
        this._grid.updateDrawerMetrics();

        let monitor = Main.layoutManager.primaryMonitor;
        let stageW = monitor ? monitor.width : global.stage.width;
        let stageH = monitor ? monitor.height : global.stage.height;
        let panelHeight = this._getEffectivePanelHeight();
        let baseY = monitor ? monitor.y : 0;

        // Full screen width — horizontal padding comes from grid clip margins
        this._actor.width = stageW;
        this._actor.x = 0;
        this._actor.y = snapToPixel(baseY + panelHeight, monitor);

        this._fullHeight = Math.max(1, snapToPixel(stageH - panelHeight, monitor));
        this._actor.height = this._fullHeight;

        let expandedContentHeight = this._expandedChrome + this._gridHeight;
        this._dockVisualHeight = this._dockHeight;

        this._expandedTranslation = Math.max(0,
            this._fullHeight - expandedContentHeight);

        let gestureBarInset = 0;
        let scale = monitor?.geometry_scale ?? 1;
        gestureBarInset = Math.round(8 * scale);

        this._dockTranslation = Math.max(0,
            this._fullHeight - this._dockVisualHeight - gestureBarInset);

        this._actor.translation_y = snapToPixel(
            this._state === DrawerState.EXPANDED
                ? this._expandedTranslation
                : this._dockTranslation,
            monitor);

        if (this._gridClip) {
            let clipHeight = this._gridHeight;
            if (this._gridClip.height !== clipHeight) {
                this._gridClip.height = clipHeight;
                this._scheduleGridRealign();
            }
        }
    }

    // ── Populate apps ─────────────────────────────────────────────────

    /** Rebuild the dock favorites and full grid from the app system. */
    _populateApps() {
        this._populateFavorites();
        this._populateGrid('');
    }

    /** Rebuild the favorites dock row. */
    _populateFavorites() {
        let favorites = AppFavorites.getAppFavorites().getFavorites();
        this._favoritesRow.destroy_all_children();

        // Apply dynamic inline style matching old extension's _getDockRowStyle
        let colSpacing = this._drawerColSpacing ?? 4;
        let padTop = this._dockRowPadTop ?? 16;
        let padBottom = this._dockRowPadBottom ?? 8;
        let padSide = this._dockRowPadSide ?? 16;
        this._favoritesRow.set_style(
            `spacing: ${colSpacing}px; ` +
            `padding: ${padTop}px ${padSide}px ${padBottom}px ${padSide}px;`);

        // Make the row expand to fill width and distribute icons evenly
        this._favoritesRow.x_expand = true;
        this._favoritesRow.x_align = Clutter.ActorAlign.CENTER;

        let max = PHONE_DOCK_MAX_ICONS;
        let shown = favorites.slice(0, max);
        for (let app of shown) {
            let btn = this._icons.createDockIcon(app, true);
            this._favoritesRow.add_child(btn);
        }
    }

    /**
     * Populate the grid with all installed apps, filtered by query.
     * @param {string} query - Search filter (empty string for all apps).
     */
    _populateGrid(query) {
        if (query === this._lastPopulateFilter)
            return;
        this._lastPopulateFilter = query;

        let appSystem = Shell.AppSystem.get_default();
        let allApps = appSystem.get_installed().filter(
            a => a.should_show());

        let favorites = AppFavorites.getAppFavorites().getFavorites();
        let pinnedIds = new Set(favorites.map(a => a.get_id()));

        let items;
        if (query) {
            let scored = this._search.scoreAndFilter(allApps, query);
            items = scored.map(a => ({ type: 'app', id: a.get_id() }));
        } else {
            let saved = this._loadLayout();
            if (saved) {
                items = this._reconcileLayout(saved, allApps, pinnedIds);
            } else {
                items = allApps
                    .filter(a => !pinnedIds.has(a.get_id()))
                    .sort((a, b) => {
                        let na = (a.get_display_name?.() || a.get_name?.() || '').toLowerCase();
                        let nb = (b.get_display_name?.() || b.get_name?.() || '').toLowerCase();
                        return na < nb ? -1 : na > nb ? 1 : 0;
                    })
                    .map(a => ({ type: 'app', id: a.get_id() }));
            }
        }

        this._gridItems = items;
        this._buildGridPages(items, appSystem);
    }

    _reconcileLayout(saved, allApps, pinnedIds) {
        let knownIds = new Set(allApps.map(a => a.get_id()));
        let placedIds = new Set();
        let items = [];
        for (let entry of saved) {
            if (typeof entry === 'string') {
                if (knownIds.has(entry) && !placedIds.has(entry)) {
                    items.push({ type: 'app', id: entry });
                    placedIds.add(entry);
                }
            } else if (entry && entry.name && Array.isArray(entry.apps)) {
                let validApps = entry.apps.filter(id =>
                    knownIds.has(id) && !placedIds.has(id));
                if (validApps.length > 0) {
                    items.push({ type: 'folder', name: entry.name, apps: validApps });
                    validApps.forEach(id => placedIds.add(id));
                }
            }
        }
        for (let app of allApps) {
            let id = app.get_id();
            if (!placedIds.has(id) && !pinnedIds.has(id)) {
                items.push({ type: 'app', id });
                placedIds.add(id);
            }
        }
        return items;
    }

    _buildGridPages(items, appSystem) {
        this._pagesContainer.destroy_all_children();
        this._pages = [];
        this._gridButtonMap = [];

        let cols = this._cols || PHONE_ATTACHED_GRID_MAX_COLS;
        let rows = this._rows || 4;
        let perPage = cols * rows;

        let pageItems = [];
        for (let i = 0; i < items.length; i++) {
            pageItems.push(items[i]);
            if (pageItems.length === perPage || i === items.length - 1) {
                let page = this._buildGridPage(pageItems, cols, appSystem);
                this._pagesContainer.add_child(page);
                this._pages.push(page);
                pageItems = [];
            }
        }

        this._dotsContainer.destroy_all_children();
        for (let i = 0; i < this._pages.length; i++) {
            let dot = new St.Widget({
                style_class: i === 0
                    ? 'convergence-page-dot convergence-page-dot-active'
                    : 'convergence-page-dot',
            });
            this._dotsContainer.add_child(dot);
        }

        this._currentPage = 0;
        this._pagesContainer.translation_x = 0;
    }

    _buildGridPage(items, cols, appSystem) {
        // Page width matches the grid clip's available width (actor width minus margins)
        let clipW = (this._actor?.width || global.stage.width) - 32; // minus grid clip margins (16px each side)
        let gridContentW = cols * (this._iconCellW || 72) +
            (cols - 1) * (this._drawerColSpacing || 4);
        let padX = Math.max(0, Math.floor((clipW - gridContentW) / 2));

        let pageWidget = new St.Widget({
            width: clipW,
            height: this._gridHeight || 400,
            layout_manager: new Clutter.FixedLayout(),
        });

        let grid = new St.Widget({
            layout_manager: new Clutter.GridLayout(),
            width: gridContentW,
        });
        grid.set_position(padX, 0);
        pageWidget.add_child(grid);
        let gridLayout = grid.layout_manager;
        gridLayout.orientation = Clutter.Orientation.HORIZONTAL;

        let col = 0;
        let row = 0;
        for (let item of items) {
            let btn = null;
            if (item.type === 'app') {
                let app = appSystem.lookup_app(item.id);
                if (!app)
                    continue;
                btn = this._icons.createGridIcon(app, item);
            } else if (item.type === 'folder') {
                btn = this._icons.createFolderIcon(item, appSystem);
            }
            if (!btn)
                continue;
            gridLayout.attach(btn, col, row, 1, 1);
            this._gridButtonMap.push({ btn, item });
            col++;
            if (col >= cols) {
                col = 0;
                row++;
            }
        }
        return pageWidget;
    }

    _realignGridPages() {
        let box = this._gridClip?.get_allocation_box();
        if (!box)
            return;
        let w = box.x2 - box.x1;
        this._pageWidth = w;
        this._pageViewportH = box.y2 - box.y1;
        let gridContentW = (this._cols || 5) * (this._iconCellW || 72) +
            ((this._cols || 5) - 1) * (this._drawerColSpacing || 4);
        let padX = Math.max(0, Math.floor((w - gridContentW) / 2));
        for (let page of this._pages) {
            page.width = w;
            // Re-center the grid host within the page
            let gridHost = page.get_first_child?.();
            if (gridHost)
                gridHost.set_position(padX, 0);
        }
        this.snapToPage(this._currentPage, false);
    }

    // ── Signals ───────────────────────────────────────────────────────

    _connectSignals() {
        this._runtimeDisposer.connect(
            AppFavorites.getAppFavorites(), 'changed',
            () => {
                if (!this._suppressFavChanged)
                    this._populateFavorites();
            });

        this._runtimeDisposer.connect(
            Shell.AppSystem.get_default(), 'installed-changed',
            () => this._populateApps());

        this._runtimeDisposer.connect(
            global.display, 'notify::focus-window',
            () => {
                if (this._state === DrawerState.EXPANDED &&
                    !this._isOnPhoneHomeScreen())
                    this.collapse();
            });

        if (this._settings) {
            this._runtimeDisposer.connect(
                this._settings, 'changed::app-grid-layout',
                () => this._populateGrid(''));
        }
    }

    // ── Destroy ───────────────────────────────────────────────────────

    /** Clean up all resources. */
    destroy() {
        this._cancelEmergencyDisable();
        this._closeFolderPopup();
        this._dismissContextMenu();
        this._uninstall.dismissDeleteConfirmDialog();
        this._runtimeDisposer.dispose();

        if (this._backdrop?.get_parent())
            this._backdrop.get_parent().remove_child(this._backdrop);
        this._backdrop?.destroy();

        if (this._actor?.get_parent())
            this._actor.get_parent().remove_child(this._actor);
        this._actor?.destroy();

        this._grid = null;
        this._gestures = null;
        this._search = null;
        this._icons = null;
        this._uninstall = null;
    }
}
