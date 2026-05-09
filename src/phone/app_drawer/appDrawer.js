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
 * Independent pinned-apps store for the phone dock, backed by the
 * extension's `dock-pinned-apps` GSettings key.  On first run (empty
 * key), copies the current global favourite-apps as a seed.
 */
class DockPinnedApps {
    constructor(settings) {
        this._settings = settings;
        this._key = 'dock-pinned-apps';
        this._ids = this._settings.get_strv(this._key);
        this._changedId = this._settings.connect(`changed::${this._key}`, () => {
            this._ids = this._settings.get_strv(this._key);
            this.emit('changed');
        });

        // Seed from global favourites on first run.
        if (this._ids.length === 0) {
            let globalFavs = AppFavorites.getAppFavorites().getFavoriteMap();
            this._ids = Object.keys(globalFavs);
            this._save();
        }
    }

    /** Return array of Shell.App for pinned IDs (skipping uninstalled). */
    getFavorites() {
        let appSys = Shell.AppSystem.get_default();
        return this._ids.map(id => appSys.lookup_app(id)).filter(a => a != null);
    }

    isFavorite(appId) {
        return this._ids.includes(appId);
    }

    addFavorite(appId) {
        if (this.isFavorite(appId))
            return;
        this._ids.push(appId);
        this._save();
    }

    addFavoriteAtPos(appId, pos) {
        if (this.isFavorite(appId))
            return;
        this._ids.splice(pos, 0, appId);
        this._save();
    }

    removeFavorite(appId) {
        let idx = this._ids.indexOf(appId);
        if (idx < 0)
            return;
        this._ids.splice(idx, 1);
        this._save();
    }

    _save() {
        this._settings.set_strv(this._key, this._ids);
    }

    destroy() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
    }

    // Minimal GObject signal emitter for the 'changed' signal.
    connect(signal, callback) {
        if (!this._handlers)
            this._handlers = [];
        let id = this._handlers.length + 1;
        this._handlers.push({ id, signal, callback });
        return id;
    }

    disconnect(id) {
        if (!this._handlers)
            return;
        this._handlers = this._handlers.filter(h => h.id !== id);
    }

    emit(signal) {
        for (let h of this._handlers ?? []) {
            if (h.signal === signal)
                try { h.callback(); } catch (_e) {}
        }
    }
}

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
     * @param {Object} [opts]
     * @param {number} [opts.monitorIndex]
     */
    constructor(controller, settings, opts = {}) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._monitorIndex = Number.isInteger(opts.monitorIndex) ? opts.monitorIndex : null;
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
        this._dockPinnedApps = new DockPinnedApps(this._settings);
        this._dndDockPreviewPos = -1;
        this._dndDockSourceIndex = -1;
        this._dndDockIndicator = null;
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
        this._urgentApps = new Set();

        this._grid = new DrawerGrid(this, settings);
        this._gestures = new DrawerGestures(this, settings);
        this._search = new DrawerSearch(this, settings);
        this._icons = new DrawerIcons(this, settings);
        this._uninstall = new DrawerUninstall(this, settings);

        this._build();
        this._connectSignals();

        // Calculate geometry first so metrics are available for icon sizing
        this._updateGeometry();
        this._populateApps();
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
        return this._controller?.getPhoneTopInset?.(this._getLayoutMonitorIndex()) ?? Main.panel?.height ?? 0;
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
        let monitor = this._getLayoutMonitor();
        let scale = monitor?.geometry_scale ?? 1;
        let scaleMul = Math.max(0.92, Math.min(1.16, 1 + ((scale - 1) * 0.12)));
        let velocityMul = 1;
        if (Number.isFinite(velocity)) {
            let speed = Math.abs(velocity);
            velocityMul = Math.max(0.78, Math.min(1.08, 1 - (speed * 0.08)));
        }
        return Math.round(baseMs * scaleMul * velocityMul);
    }

    _getLayoutMonitorIndex() {
        let monitors = Main.layoutManager.monitors ?? [];
        let preferredIndex = this._monitorIndex;
        if (!Number.isInteger(preferredIndex))
            preferredIndex = this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex;
        if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < monitors.length)
            return preferredIndex;
        return Main.layoutManager.primaryIndex;
    }

    _getLayoutMonitor() {
        return Main.layoutManager.monitors?.[this._getLayoutMonitorIndex()]
            ?? Main.layoutManager.primaryMonitor
            ?? Main.layoutManager.monitors?.[0]
            ?? null;
    }

    // ── Expand / collapse ─────────────────────────────────────────────

    /**
     * Check whether the phone is currently showing the home screen.
     * @returns {boolean}
     */
    _isOnPhoneHomeScreen() {
        let phoneStack = this._controller?.phoneWindowStack;
        if (phoneStack?.isActive)
            return phoneStack.getActiveWindow(this._getLayoutMonitorIndex()) === null;
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
            this._controller?.onDrawerExpanding?.(animDuration, this._getLayoutMonitorIndex());
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
            this._controller?.onDrawerCollapsing?.(animDuration, this._getLayoutMonitorIndex());
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
        this._controller?.onDrawerDragProgress?.(p, this._getLayoutMonitorIndex?.());
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

    // ── Drag and Drop ─────────────────────────────────────────────────

    _startDnd(sourceBtn, app, gridItem) {
        this._pressed = false;
        this._dragClaimed = false;
        this._dragDirection = null;
        if (this._grab) { this._grab.dismiss(); this._grab = null; }

        this._dndActive = true;
        this._dndApp = app;
        this._dndGridItem = gridItem;
        this._dndSourceBtn = sourceBtn;
        this._dndPreviewIndex = -1;
        this._dndStartX = this._dragStartX;
        this._dndStartY = this._dragStartY;
        this._dndOverRemoveZone = false;

        // Create ghost icon
        let iconSize = this._iconSize || 48;
        let cellW = this._iconCellW || iconSize + 16;
        let ghost = new St.Widget({
            style_class: 'convergence-drawer-dnd-ghost',
            width: cellW,
            height: cellW,
            opacity: 220,
        });
        let ghostIcon = app.create_icon_texture(iconSize);
        ghostIcon.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        ghost.add_child(ghostIcon);
        this._dndGhost = ghost;
        Main.layoutManager.uiGroup.add_child(ghost);

        let [sx, sy] = sourceBtn.get_transformed_position();
        ghost.set_position(sx, sy);
        ghost.set_pivot_point(0.5, 0.5);
        ghost.ease({
            scale_x: 1.15, scale_y: 1.15,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        sourceBtn.opacity = 60;

        // Show remove zone and dock highlight
        this._showDndRemoveZone();
        if (!this._dndFromDock)
            this._highlightDockForDrop(true);

        this._dndGrab = global.stage.grab(this._actor);

        this._dndSafetyTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            this._dndSafetyTimerId = 0;
            if (this._dndActive) this._cancelDnd();
            return GLib.SOURCE_REMOVE;
        });
    }

    _finishDnd(x, y) {
        if (!this._dndActive) return;

        if (this._dndSafetyTimerId) {
            GLib.source_remove(this._dndSafetyTimerId);
            this._dndSafetyTimerId = 0;
        }
        this._cancelEdgeScroll();
        this._cancelMergeDwell();

        let dx = x - this._dndStartX;
        let dy = y - this._dndStartY;
        let dist = Math.sqrt(dx * dx + dy * dy);
        let barelyMoved = dist < 15;

        let sourceBtn = this._dndSourceBtn;
        let app = this._dndApp;
        let gridItem = this._dndGridItem;

        // Determine and execute drop action (wrapped in try-catch
        // so errors don't prevent DnD cleanup)
        let action = 'none';
        try {
            if (barelyMoved) {
                action = 'context-menu';
            } else if (this._dndOverRemoveZone) {
                action = 'remove';
            } else if (this._hitTestDock(x, y)) {
                action = 'dock';
            } else if (this._dndWasExpanded) {
                // Dropped on home screen after dragging above drawer
                action = 'home-screen';
            } else {
                let cellIdx = this._cellIndexFromStageCoords(x, y);
                if (cellIdx >= 0 && cellIdx < this._gridItems.length) {
                    if (this._dndMergeReady) {
                        let targetItem = this._gridItems[cellIdx];
                        if (targetItem?.type === 'folder')
                            action = 'merge-folder';
                        else if (targetItem?.type === 'app' && gridItem?.type === 'app')
                            action = 'create-folder';
                        else
                            action = 'reorder';
                    } else {
                        action = 'reorder';
                    }
                } else if (cellIdx >= this._gridItems.length || cellIdx === -1) {
                    // Dropped on empty space — reorder to end of current
                    // page's items (Samsung-style)
                    action = 'reorder-end';
                }
            }

            console.log(`[Convergence:Drawer] finishDnd: action=${action} dist=${Math.round(dist)} overRemove=${this._dndOverRemoveZone} hitDock=${this._hitTestDock(x, y)} cellIdx=${this._cellIndexFromStageCoords(x, y)} gridItems=${this._gridItems.length} gridBtnMap=${this._gridButtonMap.length}`);

            if (action === 'remove' && this._dndFromDock) {
                // Unpin from dock (not uninstall)
                let id = app?.get_id?.();
                if (id) this._dockPinnedApps?.removeFavorite(id);
            } else if (action === 'remove')
                this._uninstall?._uninstallApp(app);
            else if (action === 'home-screen' && app) {
                // Dropped on home screen — place icon at drop location
                let hs = this._controller?.getPhoneHomeScreenForMonitor?.(this._getLayoutMonitorIndex());
                if (hs?.acceptExternalDrop)
                    hs.acceptExternalDrop(app.get_id(), x, y);
                else {
                    let favs = this._dockPinnedApps;
                    let id = app.get_id();
                    if (!favs.isFavorite(id)) favs.addFavorite(id);
                }
            } else if (action === 'dock' && app && !this._dndFromDock) {
                let favs = this._dockPinnedApps;
                let id = app.get_id();
                let dropPos = this._dndDockPreviewPos;
                if (dropPos >= 0 && !favs.isFavorite(id))
                    favs.addFavoriteAtPos(id, dropPos);
                else if (!favs.isFavorite(id))
                    favs.addFavorite(id);
            } else if (action === 'reorder' && gridItem) {
                let cellIdx = this._cellIndexFromStageCoords(x, y);
                if (cellIdx >= 0) this._reorderItem(gridItem, cellIdx);
            } else if (action === 'reorder-end' && gridItem) {
                // Drop on empty space: move to end of current page's items
                let cols = this._cols || 5;
                let rows = this._rows || 4;
                let perPage = cols * rows;
                let pageEndIdx = Math.min(
                    (this._currentPage + 1) * perPage,
                    this._gridItems.length);
                this._reorderItem(gridItem, pageEndIdx);
            } else if (action === 'create-folder' && gridItem) {
                let cellIdx = this._cellIndexFromStageCoords(x, y);
                if (cellIdx >= 0 && cellIdx < this._gridItems.length)
                    this._createFolderFromApps(gridItem, this._gridItems[cellIdx], cellIdx);
            } else if (action === 'merge-folder' && gridItem) {
                let cellIdx = this._cellIndexFromStageCoords(x, y);
                if (cellIdx >= 0 && cellIdx < this._gridItems.length)
                    this._addAppToFolder(gridItem, this._gridItems[cellIdx]);
            }
        } catch (e) {
            console.log(`[Convergence:Drawer] DnD drop error: ${e.message}`);
        }

        // Clean up visuals (always runs even if drop action fails)
        try {
            this._controller?.getPhoneHomeScreenForMonitor?.(this._getLayoutMonitorIndex())
                ?.cancelExternalDndHover?.();
        } catch (_e) {}
        try { this._hideDndRemoveZone(); } catch (_e) {}
        try { this._highlightDockForDrop(false); } catch (_e) {}
        try { this._clearDockDropIndicator(); } catch (_e) {}
        try { this._clearDndPreview(); } catch (_e) {}

        if (sourceBtn) sourceBtn.opacity = 255;
        if (this._dndGhost) {
            this._dndGhost.ease({
                opacity: 0, scale_x: 0.8, scale_y: 0.8,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    this._dndGhost?.destroy();
                    this._dndGhost = null;
                },
            });
        }
        if (this._dndGrab) {
            this._dndGrab.dismiss();
            this._dndGrab = null;
        }

        this._dndActive = false;
        this._dndFromDock = false;
        this._dndWasExpanded = false;
        this._dndEndedMs = GLib.get_monotonic_time() / 1000;
        let savedApp = this._dndApp;
        this._dndApp = null;
        this._dndGridItem = null;
        this._dndSourceBtn = null;

        if (action === 'context-menu' && sourceBtn && savedApp)
            this._icons?._showAppContextMenu(sourceBtn, savedApp);
    }

    _cancelDnd() {
        if (!this._dndActive) return;

        if (this._dndSafetyTimerId) {
            GLib.source_remove(this._dndSafetyTimerId);
            this._dndSafetyTimerId = 0;
        }
        this._cancelEdgeScroll();
        this._cancelMergeDwell();
        this._hideDndRemoveZone();
        this._highlightDockForDrop(false);
        this._clearDockDropIndicator();
        this._clearDndPreview();

        if (this._dndSourceBtn) this._dndSourceBtn.opacity = 255;
        if (this._dndGhost) { this._dndGhost.destroy(); this._dndGhost = null; }
        if (this._dndGrab) { this._dndGrab.dismiss(); this._dndGrab = null; }

        this._dndActive = false;
        this._dndFromDock = false;
        this._dndWasExpanded = false;
        this._dndEndedMs = GLib.get_monotonic_time() / 1000;
        this._dndApp = null;
        this._dndGridItem = null;
        this._dndSourceBtn = null;
    }

    // ── DnD: Remove zone ────────────────────────────────────────────

    _showDndRemoveZone() {
        if (this._dndRemoveZone) return;
        let zone = new St.BoxLayout({
            style_class: 'convergence-drawer-remove-zone',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            vertical: false,
            reactive: false,
        });
        zone.set_style(
            'background-color: rgba(200, 50, 50, 0.85); ' +
            'border-radius: 24px; padding: 10px 24px; ' +
            'margin-top: 40px;');
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic',
            icon_size: 20,
            style: 'color: white; margin-right: 8px;',
        });
        let label = new St.Label({
            text: 'Remove',
            style: 'color: white; font-size: 14px; font-weight: 500;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        zone.add_child(icon);
        zone.add_child(label);
        zone.opacity = 0;
        Main.layoutManager.uiGroup.add_child(zone);
        // Center horizontally at top of screen
        let screenW = global.stage.width;
        zone.set_position(Math.round((screenW - 160) / 2), 0);
        zone.ease({ opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        this._dndRemoveZone = zone;
    }

    _hideDndRemoveZone() {
        if (!this._dndRemoveZone) return;
        let zone = this._dndRemoveZone;
        this._dndRemoveZone = null;
        zone.ease({
            opacity: 0, duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => zone.destroy(),
        });
    }

    _hitTestRemoveZone(x, y) {
        if (!this._dndRemoveZone) return false;
        let [zx, zy] = this._dndRemoveZone.get_transformed_position();
        let zw = this._dndRemoveZone.width;
        let zh = this._dndRemoveZone.height;
        let pad = 20;
        return x >= zx - pad && x <= zx + zw + pad &&
               y >= zy - pad && y <= zy + zh + pad;
    }

    _updateRemoveZoneHover(x, y) {
        let over = this._hitTestRemoveZone(x, y);
        if (over !== this._dndOverRemoveZone) {
            this._dndOverRemoveZone = over;
            if (this._dndRemoveZone) {
                this._dndRemoveZone.set_style(over
                    ? 'background-color: rgba(220, 60, 60, 1.0); border-radius: 24px; padding: 10px 24px; margin-top: 40px; box-shadow: 0 0 12px rgba(220,60,60,0.5);'
                    : 'background-color: rgba(200, 50, 50, 0.85); border-radius: 24px; padding: 10px 24px; margin-top: 40px;');
            }
            if (this._dndGhost) {
                this._dndGhost.ease({
                    scale_x: over ? 0.8 : 1.15,
                    scale_y: over ? 0.8 : 1.15,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
            if (over)
                this._controller?.haptics?.vibrate(10);
        }
    }

    // ── DnD: Dock drop ──────────────────────────────────────────────

    _hitTestDock(x, y) {
        if (!this._favoritesRow) return false;
        let [dx, dy] = this._favoritesRow.get_transformed_position();
        let dw = this._favoritesRow.width;
        let dh = this._favoritesRow.height;
        return x >= dx && x <= dx + dw && y >= dy && y <= dy + dh + 20;
    }

    _highlightDockForDrop(active) {
        if (!this._favoritesRow) return;
        if (active)
            this._favoritesRow.add_style_class_name('convergence-drawer-dock-drop-highlight');
        else
            this._favoritesRow.remove_style_class_name('convergence-drawer-dock-drop-highlight');
    }

    /**
     * Determine the insertion index in the favorites row for a drop at (x, y).
     * Returns the index the dragged app should be inserted at (0 = before first icon).
     */
    _getDockDropIndex(x, _y) {
        if (!this._favoritesRow) return -1;
        let children = this._favoritesRow.get_children()
            .filter(c => c !== this._dndDockIndicator);
        if (children.length === 0) return 0;
        for (let i = 0; i < children.length; i++) {
            let [cx] = children[i].get_transformed_position();
            let cw = children[i].width;
            let midX = cx + cw / 2;
            if (x < midX) return i;
        }
        return children.length;
    }

    /**
     * Show a visual insertion indicator between dock icons during drag.
     */
    _updateDockDropIndicator(x, y) {
        if (!this._hitTestDock(x, y)) {
            this._clearDockDropIndicator();
            return;
        }
        let pos = this._getDockDropIndex(x, y);
        if (pos === this._dndDockPreviewPos) return;
        this._clearDockDropIndicator();
        this._dndDockPreviewPos = pos;

        let children = this._favoritesRow.get_children()
            .filter(c => c !== this._dndDockIndicator);
        let s = this._dockScale ?? 1;
        let indicator = new St.Widget({
            style_class: 'convergence-dock-drop-indicator',
            width: Math.round(3 * s),
            height: Math.round(36 * s),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dndDockIndicator = indicator;

        if (pos < children.length)
            this._favoritesRow.insert_child_below(indicator, children[pos]);
        else
            this._favoritesRow.add_child(indicator);
    }

    _clearDockDropIndicator() {
        this._dndDockPreviewPos = -1;
        if (this._dndDockIndicator) {
            if (this._dndDockIndicator.get_parent())
                this._dndDockIndicator.get_parent().remove_child(this._dndDockIndicator);
            this._dndDockIndicator.destroy();
            this._dndDockIndicator = null;
        }
    }

    // ── DnD: Grid cell hit testing ──────────────────────────────────

    /**
     * Convert stage coordinates to a grid cell index.
     * Returns the index even for empty cells on partially-filled pages
     * (index may be >= _gridItems.length for empty space).
     * Returns -1 only if coordinates are completely outside the grid.
     */
    _cellIndexFromStageCoords(x, y) {
        if (!this._gridClip) return -1;
        let [gx, gy] = this._gridClip.get_transformed_position();
        let gw = this._gridClip.width;
        let gh = this._gridClip.height;
        if (x < gx || x > gx + gw || y < gy || y > gy + gh)
            return -1;
        let cols = this._cols || 5;
        let cellW = this._iconCellW || gw / cols;
        let cellH = this._iconCellH || cellW * 1.3;
        let col = Math.floor((x - gx) / cellW);
        let row = Math.floor((y - gy) / cellH);
        if (col < 0 || col >= cols) return -1;
        let rowsPerPage = this._rows || 4;
        if (row < 0 || row >= rowsPerPage) return -1;
        let idx = this._currentPage * (cols * rowsPerPage) + row * cols + col;
        return idx;
    }

    // ── DnD: Preview & reorder ──────────────────────────────────────

    /**
     * Get the actual St.Button actor from a gridButtonMap entry.
     * Entries are { btn, item } objects.
     */
    _getBtnActor(entry) {
        if (!entry) return null;
        return entry.btn ?? entry;
    }

    _updateDndPreview(x, y) {
        let cellIdx = this._cellIndexFromStageCoords(x, y);
        if (cellIdx === this._dndPreviewIndex) return;
        if (cellIdx < 0 || cellIdx >= this._gridButtonMap.length) {
            this._clearDndPreview();
            return;
        }

        // Find source index
        let sourceIdx = -1;
        for (let i = 0; i < this._gridButtonMap.length; i++) {
            if (this._getBtnActor(this._gridButtonMap[i]) === this._dndSourceBtn) {
                sourceIdx = i;
                break;
            }
        }
        if (cellIdx === sourceIdx) {
            this._clearDndPreview();
            return;
        }

        this._clearDndPreview();
        this._dndPreviewIndex = cellIdx;

        // Samsung-style: icons between source and target shift by one cell
        let cols = this._cols || 5;
        let cellW = this._iconCellW || 80;
        let cellH = this._iconCellH || 100;

        let lo = Math.min(sourceIdx, cellIdx);
        let hi = Math.max(sourceIdx, cellIdx);
        let shiftDir = sourceIdx < cellIdx ? -1 : 1;

        for (let i = 0; i < this._gridButtonMap.length; i++) {
            let actor = this._getBtnActor(this._gridButtonMap[i]);
            if (!actor || actor === this._dndSourceBtn) continue;

            if (i >= lo && i <= hi && i !== sourceIdx) {
                let targetCol = (i % cols) + shiftDir;
                let tx = 0, ty = 0;

                if (targetCol >= 0 && targetCol < cols) {
                    tx = shiftDir * cellW;
                } else {
                    // Wrap to prev/next row
                    tx = shiftDir > 0 ? -(cols - 1) * cellW : (cols - 1) * cellW;
                    ty = shiftDir > 0 ? -cellH : cellH;
                }

                actor.remove_all_transitions();
                actor.ease({
                    translation_x: tx,
                    translation_y: ty,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                actor.remove_all_transitions();
                actor.ease({
                    translation_x: 0,
                    translation_y: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        }

        // Highlight the target position
        let targetActor = this._getBtnActor(this._gridButtonMap[cellIdx]);
        if (targetActor) {
            let content = targetActor._convergenceContent ?? targetActor;
            if (content.add_style_class_name)
                content.add_style_class_name('convergence-drawer-drop-target');
        }
    }

    _clearDndPreview() {
        // Remove highlight
        if (this._dndPreviewIndex >= 0 &&
            this._dndPreviewIndex < this._gridButtonMap.length) {
            let actor = this._getBtnActor(this._gridButtonMap[this._dndPreviewIndex]);
            let content = actor?._convergenceContent ?? actor;
            if (content?.remove_style_class_name)
                content.remove_style_class_name('convergence-drawer-drop-target');
        }
        this._dndPreviewIndex = -1;

        // Animate all icons back to original positions
        for (let entry of this._gridButtonMap) {
            let actor = this._getBtnActor(entry);
            if (!actor) continue;
            actor.remove_all_transitions();
            actor.ease({
                translation_x: 0,
                translation_y: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _reorderItem(item, newIndex) {
        // Find by reference first, then by ID
        let oldIndex = this._gridItems.indexOf(item);
        if (oldIndex < 0 && item?.id) {
            oldIndex = this._gridItems.findIndex(gi => gi?.id === item.id);
        }
        console.log(`[Convergence:Drawer] _reorderItem: oldIndex=${oldIndex} newIndex=${newIndex} id=${item?.id}`);
        if (oldIndex < 0 || oldIndex === newIndex) {
            console.log(`[Convergence:Drawer] _reorderItem: skipped (old=${oldIndex} new=${newIndex})`);
            return;
        }
        newIndex = Math.min(newIndex, this._gridItems.length - 1);
        let movedItem = this._gridItems[oldIndex];
        this._gridItems.splice(oldIndex, 1);
        if (newIndex > oldIndex) newIndex--;
        newIndex = Math.max(0, newIndex);
        this._gridItems.splice(newIndex, 0, movedItem);
        console.log(`[Convergence:Drawer] _reorderItem: moved ${movedItem?.id} to index ${newIndex}, calling saveAndRepopulate`);
        this._saveAndRepopulateGrid();
    }

    _createFolderFromApps(draggedItem, targetItem, targetIndex) {
        if (!draggedItem?.id || !targetItem?.id) return;
        let folder = {
            type: 'folder',
            name: 'Folder',
            apps: [targetItem.id, draggedItem.id],
        };
        // Remove dragged item
        let dragIdx = this._gridItems.indexOf(draggedItem);
        if (dragIdx >= 0) this._gridItems.splice(dragIdx, 1);
        // Replace target with folder
        let tgtIdx = this._gridItems.indexOf(targetItem);
        if (tgtIdx >= 0) this._gridItems[tgtIdx] = folder;
        this._saveAndRepopulateGrid();
    }

    _addAppToFolder(appItem, folderItem) {
        if (!appItem?.id || !folderItem?.apps) return;
        if (!folderItem.apps.includes(appItem.id))
            folderItem.apps.push(appItem.id);
        let appIdx = this._gridItems.indexOf(appItem);
        if (appIdx >= 0) this._gridItems.splice(appIdx, 1);
        this._saveAndRepopulateGrid();
    }

    _saveAndRepopulateGrid() {
        this._saveCurrentLayout();
        let page = this._currentPage;
        // Force rebuild: reset filter guard and rebuild pages
        // directly from the in-memory _gridItems (which we already
        // reordered) without re-reading from GSettings.
        this._lastPopulateFilter = null;
        let appSystem = Shell.AppSystem.get_default();
        this._buildGridPages(this._gridItems, appSystem);
        if (page !== undefined)
            this.snapToPage(page, false);
    }

    // ── DnD: Edge scroll ────────────────────────────────────────────

    _startEdgeScroll(direction) {
        if (this._dndEdgeScrollTimerId) return;
        this._dndEdgeScrollDir = direction;
        this._dndEdgeScrollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            let target = this._currentPage + this._dndEdgeScrollDir;
            let maxPage = Math.ceil(this._gridItems.length / (this._cols * this._rows)) - 1;
            if (target >= 0 && target <= maxPage)
                this.snapToPage(target, true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelEdgeScroll() {
        if (this._dndEdgeScrollTimerId) {
            GLib.source_remove(this._dndEdgeScrollTimerId);
            this._dndEdgeScrollTimerId = 0;
        }
        this._dndEdgeScrollDir = 0;
    }

    // ── DnD: Merge dwell ────────────────────────────────────────────

    _cancelMergeDwell() {
        if (this._dndMergeDwellTimerId) {
            GLib.source_remove(this._dndMergeDwellTimerId);
            this._dndMergeDwellTimerId = 0;
        }
        this._dndMergeDwellItem = null;
        this._dndMergeReady = false;
    }

    // ── Folder popup (Samsung-style) with caching ─────────────────

    /**
     * Ensure the folder popup shell (scrim + card + glass) exists.
     * Created once on first use, reused on subsequent opens.
     */
    _ensureFolderShell() {
        if (this._folderShellCached) return;

        let screenW = global.stage.width;
        let screenH = global.stage.height;
        this._folderPopupW = Math.round(screenW * 0.88);
        this._folderCols = 4;
        this._folderMaxRows = 4;

        // Scrim
        this._folderScrimCached = new St.Widget({
            style: 'background-color: rgba(0, 0, 0, 0.5);',
            reactive: true,
            x: 0, y: 0,
            width: screenW,
            height: screenH,
            visible: false,
        });
        this._folderScrimCached.connect('button-press-event', () => {
            this._closeFolderPopup();
            return Clutter.EVENT_STOP;
        });
        this._folderScrimCached.connect('touch-event', (_a, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this._closeFolderPopup();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.uiGroup.add_child(this._folderScrimCached);

        // Popup container
        let popupW = this._folderPopupW;
        this._folderPopupContent = new St.BoxLayout({
            style_class: 'convergence-folder-popup',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            width: popupW,
            reactive: true,
        });

        // Name entry
        this._folderNameEntry = new St.Entry({
            style_class: 'convergence-folder-name-entry',
            text: 'Folder',
            x_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._folderNameEntry.clutter_text.set({
            editable: true,
            single_line_mode: true,
            activatable: true,
        });
        this._folderNameEntry.clutter_text.connect('activate', () => {
            let newName = this._folderNameEntry.get_text().trim();
            if (newName && this._currentFolder)
                this._currentFolder.name = newName;
            this._folderNameEntry.get_stage()?.set_key_focus(null);
            this._saveCurrentLayout();
        });
        this._folderNameEntry.clutter_text.connect('key-focus-out', () => {
            let newName = this._folderNameEntry.get_text().trim();
            if (newName && this._currentFolder)
                this._currentFolder.name = newName;
            this._saveCurrentLayout();
        });

        // Grid area
        this._folderGridClipCached = new St.Widget({
            clip_to_allocation: true,
            x_expand: true,
        });
        this._folderPagesBoxCached = new St.BoxLayout({
            vertical: false, x_expand: false,
        });
        this._folderGridClipCached.add_child(this._folderPagesBoxCached);

        this._folderPopupContent.add_child(this._folderNameEntry);
        this._folderPopupContent.add_child(this._folderGridClipCached);

        // Stack: glass → tint → content
        let glass = new St.Widget({
            style_class: 'convergence-folder-popup-glass',
            x_expand: true, y_expand: true,
        });
        let tint = new St.Widget({
            style_class: 'convergence-folder-popup-tint',
            x_expand: true, y_expand: true,
        });
        this._folderStackCached = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: popupW,
            visible: false,
        });
        this._folderStackCached.set_pivot_point(0.5, 0.5);
        this._folderStackCached.add_child(glass);
        this._folderStackCached.add_child(tint);
        this._folderStackCached.add_child(this._folderPopupContent);
        Main.layoutManager.uiGroup.add_child(this._folderStackCached);

        // App lookup cache
        this._appCache = new Map();

        this._folderShellCached = true;
    }

    /**
     * Cached app lookup — avoids repeated AppSystem.lookup_app().
     */
    _getCachedApp(appId) {
        if (this._appCache?.has(appId))
            return this._appCache.get(appId);
        let app = Shell.AppSystem.get_default().lookup_app(appId);
        if (app) this._appCache?.set(appId, app);
        return app;
    }

    /**
     * Open a folder popup — uses cached shell, only rebuilds grid contents.
     */
    _openFolderPopup(folderItem, sourceBtn) {
        if (this._folderPopup) {
            this._closeFolderPopup();
        }

        this._ensureFolderShell();
        this._currentFolder = folderItem;
        this._currentFolderSourceBtn = sourceBtn;

        let popupW = this._folderPopupW;
        let cols = this._folderCols;
        let maxRows = this._folderMaxRows;
        let iconSize = this._iconSize || 48;
        let cellW = Math.round(popupW / cols);
        let cellH = cellW + 24;
        let appCount = folderItem.apps?.length ?? 0;
        let rows = Math.ceil(appCount / cols) || 1;
        let gridH = Math.min(rows, maxRows) * cellH;
        let popupH = gridH + 70;

        // Update name
        this._folderNameEntry.set_text(folderItem.name || 'Folder');

        // Update grid height
        this._folderGridClipCached.height = gridH;

        // Clear old grid pages
        this._folderPagesBoxCached.destroy_all_children();
        this._drawerFolderPages = [];
        this._drawerFolderCurrentPage = 0;
        this._drawerFolderPageWidth = popupW;

        // Remove old dots
        if (this._drawerFolderDotsContainer) {
            this._drawerFolderDotsContainer.destroy();
            this._drawerFolderDotsContainer = null;
        }

        // Position
        let screenW = global.stage.width;
        let screenH = global.stage.height;
        this._folderStackCached.set_position(
            Math.round((screenW - popupW) / 2),
            Math.round((screenH - popupH) / 2));

        // Show with animation
        let scrim = this._folderScrimCached;
        let stack = this._folderStackCached;
        scrim.visible = true;
        stack.visible = true;
        scrim.opacity = 0;
        stack.opacity = 0;
        stack.scale_x = 0.85;
        stack.scale_y = 0.85;
        scrim.ease({ opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        stack.ease({
            opacity: 255, scale_x: 1.0, scale_y: 1.0,
            duration: 150, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._folderPopup = stack;
        this._folderScrim = scrim;
        this._folderGridClip = this._folderGridClipCached;
        this._folderPagesBox = this._folderPagesBoxCached;

        // Populate grid in idle (contents appear within 1-2 frames)
        GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            if (!this._folderPopup) return GLib.SOURCE_REMOVE;

            let apps = (folderItem.apps || [])
                .map(id => this._getCachedApp(id)).filter(a => a);
            let pages = Math.ceil(apps.length / (cols * maxRows)) || 1;
            let appsPerPage = cols * maxRows;

            for (let p = 0; p < pages; p++) {
                let page = new Clutter.Actor({
                    layout_manager: new Clutter.GridLayout(),
                    width: popupW,
                });
                let pageApps = apps.slice(p * appsPerPage, (p + 1) * appsPerPage);
                for (let i = 0; i < pageApps.length; i++) {
                    let cell = this._createFolderAppCell(
                        pageApps[i], folderItem, iconSize, cellW, cellH);
                    page.layout_manager.attach(
                        cell, i % cols, Math.floor(i / cols), 1, 1);
                }
                this._folderPagesBoxCached.add_child(page);
                this._drawerFolderPages.push(page);
            }

            if (pages > 1) {
                let dotsBox = new St.BoxLayout({
                    style_class: 'convergence-page-dots',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                for (let p = 0; p < pages; p++) {
                    dotsBox.add_child(new St.Widget({
                        style_class: p === 0
                            ? 'convergence-page-dot convergence-page-dot-active'
                            : 'convergence-page-dot',
                    }));
                }
                this._folderPopupContent.add_child(dotsBox);
                this._drawerFolderDotsContainer = dotsBox;
                this._setupFolderSwipe(
                    this._folderGridClipCached, this._folderPagesBoxCached, pages);
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Create a single app cell inside a folder popup.
     */
    _createFolderAppCell(app, folderItem, iconSize, cellW, cellH) {
        let icon = app.create_icon_texture(iconSize);
        icon.set_pivot_point(0.5, 0.5);
        let label = new St.Label({
            text: app.get_name() || '',
            style: 'color: white; font-size: 12px; text-align: center;',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set({
            ellipsize: imports.gi.Pango.EllipsizeMode.END,
            line_wrap: false,
        });

        let btn = new St.Button({
            child: new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            width: cellW,
            height: cellH,
            reactive: true,
        });
        btn.child.add_child(icon);
        btn.child.add_child(label);

        let lpTimer = 0;
        let lpFired = false;

        btn.connect('touch-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                lpFired = false;
                icon.ease({ scale_x: 0.93, scale_y: 0.93, duration: 100,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                // Long-press: haptic + context menu for remove
                lpTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    lpTimer = 0;
                    lpFired = true;
                    this._controller?.haptics?.vibrate(15);
                    icon.ease({ scale_x: 1.12, scale_y: 1.12, duration: 180,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                    return GLib.SOURCE_REMOVE;
                });
            } else if (type === Clutter.EventType.TOUCH_END) {
                if (lpTimer) { GLib.source_remove(lpTimer); lpTimer = 0; }
                icon.ease({ scale_x: 1.0, scale_y: 1.0, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK });
                if (lpFired) {
                    // Long-press release: show remove option
                    lpFired = false;
                    this._showFolderAppMenu(btn, app, folderItem);
                } else {
                    // Normal tap: launch app
                    app.activate();
                    this._closeFolderPopup();
                    this.collapse();
                }
            } else if (type === Clutter.EventType.TOUCH_CANCEL) {
                if (lpTimer) { GLib.source_remove(lpTimer); lpTimer = 0; }
                icon.ease({ scale_x: 1.0, scale_y: 1.0, duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK });
                lpFired = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Mouse fallback
        btn.connect('clicked', () => {
            if (!lpFired) {
                app.activate();
                this._closeFolderPopup();
                this.collapse();
            }
            lpFired = false;
        });

        return btn;
    }

    /**
     * Show a simple context menu for an app inside a folder.
     */
    _showFolderAppMenu(anchor, app, folderItem) {
        // Simple popup with "Remove from folder" option
        let menu = new St.BoxLayout({
            style: 'background-color: rgba(40, 42, 48, 0.95); ' +
                'border-radius: 12px; padding: 8px 0; ' +
                'box-shadow: 0 4px 16px rgba(0,0,0,0.4);',
            vertical: true,
            reactive: true,
        });
        let doRemove = () => {
            console.log(`[Convergence:Drawer] folder menu: removing ${app.get_id()}`);
            if (!menuDestroyed) {
                menuDestroyed = true;
                menuScrim.destroy();
                menu.destroy();
            }
            this._removeAppFromFolder(app, folderItem);
        };
        let menuDestroyed = false;

        let removeBtn = new St.Button({
            label: 'Remove from folder',
            style: 'color: white; font-size: 14px; padding: 12px 24px; ' +
                'text-align: left; border-radius: 8px;',
            reactive: true,
        });
        removeBtn.connect('clicked', doRemove);
        removeBtn.connect('touch-event', (_a, event) => {
            if (event.type() === Clutter.EventType.TOUCH_END)
                doRemove();
            return Clutter.EVENT_STOP;
        });
        menu.add_child(removeBtn);

        // Scrim to dismiss (must be added BEFORE menu for z-order)
        let menuScrim = new St.Widget({
            style: 'background-color: rgba(0, 0, 0, 0.2);',
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        menuScrim.connect('button-press-event', () => {
            if (!menuDestroyed) { menuDestroyed = true; menuScrim.destroy(); menu.destroy(); }
            return Clutter.EVENT_STOP;
        });
        menuScrim.connect('touch-event', (_a, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN && !menuDestroyed) {
                menuDestroyed = true;
                menuScrim.destroy();
                menu.destroy();
            }
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.uiGroup.add_child(menuScrim);

        // Position menu centered on screen, above the folder popup
        let screenW = global.stage.width;
        let screenH = global.stage.height;
        let menuW = Math.round(screenW * 0.6);
        menu.set_style(menu.get_style() + ` width: ${menuW}px;`);
        let menuX = Math.round((screenW - menuW) / 2);
        let menuY = Math.round(screenH * 0.4);
        menu.set_position(menuX, menuY);
        Main.layoutManager.uiGroup.add_child(menu);
    }

    /**
     * Remove an app from a folder. If < 2 apps remain, dissolve the folder.
     */
    /**
     * Audit all folders — dissolve any with < 2 apps.
     * Samsung auto-dissolves folders when apps are uninstalled,
     * dragged out, or disabled. Call this after any operation
     * that might leave folders with insufficient apps.
     * @returns {boolean} true if any folders were dissolved
     */
    /**
     * Audit all folders — dissolve any with < 2 valid apps.
     * Samsung auto-dissolves folders when apps are uninstalled,
     * dragged out, or disabled.
     * @returns {boolean} true if any folders were dissolved
     */
    _auditFolders() {
        if (this._auditing) return false;
        this._auditing = true;

        let appSystem = Shell.AppSystem.get_default();
        let dissolved = false;
        for (let i = this._gridItems.length - 1; i >= 0; i--) {
            let item = this._gridItems[i];
            if (item?.type !== 'folder') continue;

            // Remove IDs for uninstalled/disabled apps
            if (item.apps) {
                item.apps = item.apps.filter(id => {
                    let app = appSystem.lookup_app(id);
                    return app && app.should_show?.() !== false;
                });
            }

            // Dissolve if < 2 apps remain
            if (!item.apps || item.apps.length <= 1) {
                let remainingId = item.apps?.[0];
                if (remainingId)
                    this._gridItems[i] = { type: 'app', id: remainingId };
                else
                    this._gridItems.splice(i, 1);
                dissolved = true;
            }
        }

        if (dissolved) {
            this._closeFolderPopup();
            this._saveCurrentLayout();
        }

        this._auditing = false;
        return dissolved;
    }

    _removeAppFromFolder(app, folderItem) {
        let appId = app.get_id();
        console.log(`[Convergence:Drawer] removeAppFromFolder: ${appId} from "${folderItem?.name}" (${folderItem?.apps?.length} apps)`);

        let idx = folderItem.apps?.indexOf(appId);
        if (idx >= 0) folderItem.apps.splice(idx, 1);
        else {
            console.log(`[Convergence:Drawer] removeAppFromFolder: ${appId} not found in folder`);
            return;
        }

        console.log(`[Convergence:Drawer] removeAppFromFolder: after remove, ${folderItem.apps.length} apps remain`);

        // Close folder popup first
        this._closeFolderPopup();

        // Dissolve if < 2 apps remain
        if (folderItem.apps.length <= 1) {
            let remainingId = folderItem.apps[0] ?? null;
            let folderIdx = this._gridItems.indexOf(folderItem);
            if (folderIdx < 0) {
                // Try finding by reference match on apps array
                for (let i = 0; i < this._gridItems.length; i++) {
                    let gi = this._gridItems[i];
                    if (gi?.type === 'folder' && gi === folderItem) {
                        folderIdx = i;
                        break;
                    }
                }
            }
            console.log(`[Convergence:Drawer] dissolving folder at idx=${folderIdx}, remaining=${remainingId}`);
            if (folderIdx >= 0) {
                if (remainingId)
                    this._gridItems[folderIdx] = { type: 'app', id: remainingId };
                else
                    this._gridItems.splice(folderIdx, 1);
            }
        }

        // Always rebuild grid and save
        this._saveCurrentLayout();
        this._flushCurrentLayoutSave();
        this._lastPopulateFilter = null;
        let appSystem = Shell.AppSystem.get_default();
        this._buildGridPages(this._gridItems, appSystem);
        this._populateFavorites();
        console.log(`[Convergence:Drawer] removeAppFromFolder: grid rebuilt, ${this._gridItems.length} items`);
    }

    /**
     * Setup swipe gestures for folder page navigation.
     */
    _setupFolderSwipe(gridClip, pagesBox, totalPages) {
        if (totalPages <= 1) return;

        let startX = 0;
        let startPageX = 0;
        let tracking = false;
        let pageW = this._drawerFolderPageWidth;

        gridClip.connect('captured-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN ||
                type === Clutter.EventType.BUTTON_PRESS) {
                [startX] = event.get_coords();
                startPageX = pagesBox.translation_x;
                tracking = true;
                return Clutter.EVENT_PROPAGATE;
            }
            if (!tracking) return Clutter.EVENT_PROPAGATE;

            if (type === Clutter.EventType.TOUCH_UPDATE ||
                type === Clutter.EventType.MOTION) {
                let [x] = event.get_coords();
                let dx = x - startX;
                pagesBox.translation_x = startPageX + dx;
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.TOUCH_END ||
                type === Clutter.EventType.BUTTON_RELEASE) {
                tracking = false;
                let [x] = event.get_coords();
                let dx = x - startX;
                let threshold = pageW * 0.3;
                let curPage = this._drawerFolderCurrentPage;
                if (dx < -threshold && curPage < totalPages - 1)
                    curPage++;
                else if (dx > threshold && curPage > 0)
                    curPage--;
                this._drawerFolderCurrentPage = curPage;
                pagesBox.ease({
                    translation_x: -curPage * pageW,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                // Update dots
                if (this._drawerFolderDotsContainer) {
                    let dots = this._drawerFolderDotsContainer.get_children();
                    for (let i = 0; i < dots.length; i++) {
                        dots[i].style_class = i === curPage
                            ? 'convergence-page-dot convergence-page-dot-active'
                            : 'convergence-page-dot';
                    }
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _closeFolderPopup() {
        this._folderPopup = null; // null immediately for state checks

        if (this._folderScrimCached)
            this._folderScrimCached.visible = false;
        this._folderScrim = null;

        if (this._folderStackCached) {
            this._folderStackCached.ease({
                opacity: 0, scale_x: 0.85, scale_y: 0.85,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    if (this._folderStackCached)
                        this._folderStackCached.visible = false;
                },
            });
        }

        this._currentFolder = null;
        this._currentFolderSourceBtn = null;
        this._drawerFolderPages = [];
        if (this._drawerFolderDotsContainer) {
            this._drawerFolderDotsContainer.destroy();
            this._drawerFolderDotsContainer = null;
        }
        this._folderGridClip = null;
        this._folderPagesBox = null;
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

        let monitor = this._getLayoutMonitor();
        let stageW = monitor ? monitor.width : global.stage.width;
        let stageH = monitor ? monitor.height : global.stage.height;
        let panelHeight = this._getEffectivePanelHeight();
        let baseY = monitor ? monitor.y : 0;

        // Use computed drawer width (based on grid columns + margins),
        // clamped to stageW - 32.  Center horizontally.
        let drawerW = this._computedDrawerWidth || stageW;
        drawerW = Math.min(drawerW, stageW);
        let drawerX = (monitor?.x ?? 0) + Math.round((stageW - drawerW) / 2);
        this._actor.width = drawerW;
        this._actor.x = drawerX;
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

    relayout() {
        this._updateGeometry();
    }

    setMonitorIndex(monitorIndex = null) {
        this._monitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        this._updateGeometry();
    }

    refreshTopology(monitorIndex = null) {
        this._externalHomeRevealActive = false;
        this._closeFolderPopup();
        this._dismissContextMenu();
        this._dismissDeleteConfirmDialog();
        this._setLaunchpadEditMode(false);
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
        this.setMonitorIndex(monitorIndex);
    }

    // ── Populate apps ─────────────────────────────────────────────────

    /** Rebuild the dock favorites and full grid from the app system. */
    /** Set up an inotify watch on a directory. Zero-cost when idle. */
    _watchDir(path, callback) {
        try {
            let dir = Gio.File.new_for_path(path);
            if (!dir.query_exists(null)) return;
            let monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', callback);
            this._appDirMonitors.push(monitor);
        } catch (_e) {}
    }

    /**
     * Coalescing refresh scheduler.  Multiple rapid-fire inotify events
     * (e.g. Waydroid installing 10 apps) collapse into one rebuild.
     * @param {number} [delayMs=1000] - coalesce window in ms
     */
    _scheduleAppRefresh(delayMs = 1000) {
        // If a refresh is already pending, restart the coalesce timer
        // so batch installs collapse into one rebuild.
        if (this._appRefreshId) {
            GLib.source_remove(this._appRefreshId);
            this._appRefreshId = 0;
        }
        this._appRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._appRefreshId = 0;
            // Poke the desktop database so GAppInfoMonitor and
            // Shell.AppSystem pick up the change.
            try {
                let userAppDir = GLib.build_filenamev([
                    GLib.get_home_dir(), '.local', 'share', 'applications']);
                GLib.spawn_command_line_async(
                    `update-desktop-database ${userAppDir}`);
            } catch (_e) {}
            // Give AppSystem a moment to process, then rebuild
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._populateApps();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _populateApps() {
        // Audit folders first — dissolve any with uninstalled/disabled apps
        this._auditFolders();
        this._populateFavorites();

        // Snapshot old app IDs for diff
        let oldIds = new Set((this._gridItems ?? [])
            .filter(i => i.type === 'app').map(i => i.id));

        // Invalidate the filter cache so _populateGrid rebuilds even
        // when the query hasn't changed (app list itself changed).
        this._lastPopulateFilter = null;
        this._populateGrid('');

        // Pre-warm icon textures for any newly added apps so they
        // render instantly without a flash of missing icon.
        let appSystem = Shell.AppSystem.get_default();
        for (let item of (this._gridItems ?? [])) {
            if (item.type !== 'app' || oldIds.has(item.id)) continue;
            try {
                let app = appSystem.lookup_app(item.id);
                if (app) app.get_app_info()?.get_icon?.();
            } catch (_e) {}
        }
    }

    /** Rebuild the favorites dock row. */
    _populateFavorites() {
        let favorites = this._dockPinnedApps.getFavorites();
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
        this._syncDockButtonStates();
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

        let favorites = this._dockPinnedApps.getFavorites();
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
            layout_manager: new Clutter.GridLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                column_homogeneous: false,
                row_homogeneous: false,
                column_spacing: this._drawerColSpacing || 4,
                row_spacing: this._drawerRowSpacing || 4,
            }),
            width: gridContentW,
            height: this._gridHeight || 400,
        });
        grid.set_position(padX, 0);
        pageWidget.add_child(grid);
        let gridLayout = grid.layout_manager;

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

    _syncDockButtonStates() {
        // Phone dock does not show running/focused highlights or
        // instance-count indicator dots — those are desktop-only features
        // handled by TaskbarIcons.  Keep the phone dock clean.
    }

    // ── Signals ───────────────────────────────────────────────────────

    _connectSignals() {
        this._dockPinnedApps.connect('changed', () => {
            if (!this._suppressFavChanged)
                this._populateFavorites();
        });

        // Fast path: when Shell.AppSystem fires its own signal, rebuild
        // immediately without the inotify → database → delay chain.
        this._runtimeDisposer.connect(
            Shell.AppSystem.get_default(), 'installed-changed',
            () => this._populateApps());

        // Direct inotify monitors on .desktop directories and package
        // databases for immediate refresh.  All use kernel inotify — zero
        // CPU when idle, negligible battery impact.
        this._appDirMonitors = [];
        let userAppDir = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'share', 'applications']);
        let appDirs = [
            userAppDir,
            '/usr/share/applications',
            '/usr/local/share/applications',
            '/var/lib/flatpak/exports/share/applications',
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share',
                'flatpak', 'exports', 'share', 'applications']),
        ];
        for (let path of appDirs) {
            this._watchDir(path, (_m, file) => {
                let name = file?.get_basename?.() ?? '';
                if (!name.endsWith('.desktop')) return;
                this._scheduleAppRefresh();
            });
        }
        // Package manager database — catches system app installs/removes
        for (let path of ['/var/lib/apk', '/var/lib/dpkg', '/var/lib/pacman/local']) {
            this._watchDir(path, () => this._scheduleAppRefresh(5000));
        }

        this._runtimeDisposer.connect(
            global.display, 'window-created',
            (_display, window) => {
                this._trackWindowUrgency(window);
                this._syncDockButtonStates();
            });

        this._runtimeDisposer.connect(
            global.display, 'notify::focus-window',
            () => {
                this._syncDockButtonStates();
                if (this._state === DrawerState.EXPANDED &&
                    !this._isOnPhoneHomeScreen())
                    this.collapse();
            });

        this._runtimeDisposer.connect(
            global.display, 'window-demands-attention',
            (_display, window) => {
                this._trackWindowUrgency(window, true);
                this._syncDockButtonStates();
            });

        this._runtimeDisposer.connect(
            global.display, 'window-marked-urgent',
            (_display, window) => {
                this._trackWindowUrgency(window, true);
                this._syncDockButtonStates();
            });

        if (this._settings) {
            this._runtimeDisposer.connect(
                this._settings, 'changed::app-grid-layout',
                () => this._populateGrid(''));
        }
    }

    _trackWindowUrgency(window, urgent = false) {
        if (!window)
            return;
        let app = Shell.WindowTracker.get_default()?.get_window_app(window);
        let appId = app?.get_id?.();
        if (!appId)
            return;

        if (urgent || window.demands_attention || window.urgent)
            this._urgentApps.add(appId);
        else
            this._urgentApps.delete(appId);

        if (global.display?.focus_window === window)
            this._urgentApps.delete(appId);
    }

    // ── Destroy ───────────────────────────────────────────────────────

    /** Clean up all resources. */
    destroy() {
        if (this._appRefreshId) {
            GLib.source_remove(this._appRefreshId);
            this._appRefreshId = 0;
        }
        if (this._appDirMonitors) {
            for (let m of this._appDirMonitors)
                m.cancel();
            this._appDirMonitors = null;
        }
        this._cancelEmergencyDisable();
        this._closeFolderPopup();
        // Destroy cached folder shell
        if (this._folderScrimCached) {
            this._folderScrimCached.destroy();
            this._folderScrimCached = null;
        }
        if (this._folderStackCached) {
            this._folderStackCached.destroy();
            this._folderStackCached = null;
        }
        this._folderShellCached = false;
        this._appCache = null;
        this._dismissContextMenu();
        this._uninstall.dismissDeleteConfirmDialog();
        this._runtimeDisposer.dispose();
        this._gestures?.destroy?.();
        this._search?.destroy?.();
        this._icons?.destroy?.();
        this._uninstall?.destroy?.();

        if (this._backdrop?.get_parent())
            this._backdrop.get_parent().remove_child(this._backdrop);
        this._backdrop?.destroy();

        if (this._actor?.get_parent())
            this._actor.get_parent().remove_child(this._actor);
        this._actor?.destroy();

        this._dockPinnedApps?.destroy?.();
        this._dockPinnedApps = null;
        this._grid = null;
        this._gestures = null;
        this._search = null;
        this._icons = null;
        this._uninstall = null;
        this._logger?.destroy?.();
    }
}
