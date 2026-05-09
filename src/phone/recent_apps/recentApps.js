// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getAdaptiveScale } from '../../shared/utilities/uiUtils.js';

const _CLIP_DECL = `
uniform vec4 bounds;
uniform float clipRadius;
uniform vec2 pixelStep;
float circleBounds(vec2 p, vec2 c, float cr) {
    vec2 d = p - c;
    float ds = dot(d, d);
    float outer = cr + 0.5;
    if (ds >= outer * outer) return 0.0;
    float inner = cr - 0.5;
    if (ds <= inner * inner) return 1.0;
    return outer - sqrt(ds);
}
`;

const _CLIP_CODE = `
vec2 p = cogl_tex_coord0_in.xy / pixelStep;
if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w) {
    cogl_color_out *= 0.0; return;
}
float cL = bounds.x + clipRadius, cR = bounds.z - clipRadius;
float cT = bounds.y + clipRadius, cB = bounds.w - clipRadius;
vec2 center;
if (p.x < cL) center.x = cL; else if (p.x > cR) center.x = cR; else return;
if (p.y < cT) center.y = cT; else if (p.y > cB) center.y = cB; else return;
cogl_color_out *= circleBounds(p, center, clipRadius);
`;

const CardClipEffect = GObject.registerClass(
class CardClipEffect extends Shell.GLSLEffect {
    _init(radius = 24) {
        super._init();
        this._radius = radius;
        this._boundsLoc = this.get_uniform_location('bounds');
        this._clipRadiusLoc = this.get_uniform_location('clipRadius');
        this._pixelStepLoc = this.get_uniform_location('pixelStep');
    }
    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, _CLIP_DECL, _CLIP_CODE, false);
    }
    vfunc_paint_target(node, paintContext) {
        let a = this.get_actor();
        let w = a.width, h = a.height;
        if (w <= 1 || h <= 1) { super.vfunc_paint_target(node, paintContext); return; }
        this.set_uniform_float(this._boundsLoc, 4, [1, 1, w, h]);
        this.set_uniform_float(this._clipRadiusLoc, 1, [this._radius]);
        this.set_uniform_float(this._pixelStepLoc, 2, [1 / w, 1 / h]);
        super.vfunc_paint_target(node, paintContext);
    }
});

const CARD_WIDTH_RATIO = 0.72;
const CARD_GAP = 28;
const CARD_BORDER_RADIUS = 44;
const SNAP_VELOCITY = 0.4;
const DISMISS_THRESHOLD = 0.30;
const HEADER_HEIGHT = 88;
const LONG_PRESS_MS = 500;
const LONG_PRESS_CANCEL_DIST = 30;
const SPLIT_RATIO_MIN = 0.3;
const SPLIT_RATIO_MAX = 0.7;
const SPLIT_DISMISS_THRESHOLD = 0.15;
const DIVIDER_HEIGHT = 14;
const SNAP_RATIOS = [0.3, 0.5, 0.7];
const SNAP_MAGNETISM = 0.03;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MAX_DIST = 15;
const CONTROL_TRAY_TIMEOUT_MS = 3000;

/**
 * RecentApps -- modular recent apps overlay (task switcher).
 *
 * Creates and manages a RoundUI-style horizontal carousel of
 * window thumbnails. Supports tap to switch, swipe-up to dismiss,
 * swipe-down to expand card to fullscreen, horizontal scroll with
 * momentum, and a "Clear all" button.
 *
 * Designed to be hookable from the gesture bar -- exposes show(), hide(),
 * prepare(), update(), commit(), and cancel() methods for progressive
 * gesture integration. Replaceable: swap this class for a custom UI
 * without changing any calling code.
 */
export class RecentApps {
    /**
     * @param {Object} controller - convergence controller instance
     * @param {Object} [opts]
     * @param {number} [opts.monitorIndex]
     */
    constructor(controller, opts = {}) {
        this._controller = controller;
        this._monitorIndex = Number.isInteger(opts.monitorIndex) ? opts.monitorIndex : null;
        this._overlay = null;
        this._backdrop = null;
        this._carousel = null;
        this._cardsStrip = null;
        this._clearBtn = null;
        this._emptyLabel = null;
        this._gesture = null;
        this._scrollX = 0;
        this._maxScroll = 0;
        this._cardW = 0;
        this._cardH = 0;
        this._cardGap = 0;
        this._headerH = 0;
        this._radius = 0;
        this._prepared = false;
        this._preparedFromHome = false;
        this._activeWindowCard = null;

        // Split-screen state
        this._splitDropActive = false;
        this._splitDropCard = null;
        this._splitDragClone = null;
        this._splitZoneOverlay = null;
        this._splitActiveZone = null;
        this._splitMonitorIndex = null;
        this._splitFirstWindow = null;
        this._splitFirstPosition = null;
        this._splitState = null;
        this._splitDivider = null;
        this._splitFocusWatchId = 0;
    }

    /** Whether the overlay is currently visible. */
    get isVisible() {
        return this._overlay !== null;
    }

    _getPhoneMonitorIndex() {
        return this._getBounds().monitorIndex;
    }

    // -- Public API --

    /**
     * Show the recent apps overlay with a fade-in animation.
     * If the overlay is already visible, this is a no-op.
     */
    show() {
        this._build();
        if (!this._overlay) return;

        this._hideHomeContent();
        let duration = this._getAnimDuration(350);

        let phoneStack = this._controller.phoneWindowStack;
        let activeWindow = phoneStack?.isActive
            ? phoneStack.getActiveWindow(this._getPhoneMonitorIndex())
            : global.display.get_focus_window();
        let activeCard = this._findCardForWindow(activeWindow);

        this._backdrop?.ease({ opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        if (this._clearBtn) {
            this._clearBtn.opacity = 0;
            this._clearBtn.ease({ opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        }

        if (activeCard) {
            let windowActor = activeWindow.get_compositor_private();
            if (windowActor) windowActor.hide();
            let ps = this._controller.phoneWindowStack;
            if (ps?.isActive) ps.goHome(this._getPhoneMonitorIndex());
            activeCard.opacity = 255;
            if (this._carousel) this._carousel.opacity = 255;
            if (this._clearBtn) this._clearBtn.opacity = 255;
            if (this._emptyLabel) this._emptyLabel.opacity = 255;
        } else {
            if (this._carousel) {
                this._carousel.opacity = 0;
                this._carousel.ease({ opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
            }
        }
        this._startMemoryUpdateTimer();
    }

    /**
     * Hide the recent apps overlay.
     * @param {boolean} instant - skip animation
     * @param {Object} opts - options (skipHomeRestore: boolean)
     */
    hide(instant = false, opts = {}) {
        this._stopMemoryUpdateTimer();
        if (!this._overlay) return;
        this._prepared = false;
        this._preparedFromHome = false;
        this._activeWindowCard = null;

        let overlay = this._overlay;
        this._overlay = null;
        this._backdrop = null;
        this._carousel = null;
        this._cardsStrip = null;
        this._clearBtn = null;
        this._emptyLabel = null;
        this._gesture = null;

        if (instant) {
            if (overlay.get_parent()) overlay.get_parent().remove_child(overlay);
            overlay.destroy();
        } else {
            let duration = this._getAnimDuration(200);
            overlay.ease({
                opacity: 0, duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    if (overlay.get_parent()) overlay.get_parent().remove_child(overlay);
                    overlay.destroy();
                },
            });
        }

        if (!opts?.skipHomeRestore)
            this._showHomeContent();
    }

    /**
     * Update the overlay with a new list of windows.
     * Rebuilds the carousel content.
     * @param {Meta.Window[]} windows
     */
    update(windows) {
        if (!this._cardsStrip) return;
        this._cardsStrip.destroy_all_children();
        for (let mw of windows) {
            let card = this._buildCard(mw, -1, this._cardW, this._cardH);
            this._cardsStrip.add_child(card);
        }
        this._recalcScroll();
    }

    // -- Progressive gesture: from app --

    /** Pre-build the overlay hidden for progressive reveal during swipe. */
    prepareFromApp() {
        if (this._overlay) return;
        this._build();
        if (!this._overlay) return;

        // Show backdrop and adjacent cards immediately so the user
        // can see neighbouring apps from the start of the gesture.
        if (this._backdrop) this._backdrop.opacity = 0;
        if (this._carousel) this._carousel.opacity = 255;
        if (this._clearBtn) this._clearBtn.opacity = 0;
        if (this._emptyLabel) this._emptyLabel.opacity = 0;

        let phoneStack = this._controller.phoneWindowStack;
        let activeWindow = phoneStack?.isActive
            ? phoneStack.getActiveWindow(this._getPhoneMonitorIndex())
            : global.display.get_focus_window();
        this._activeWindowCard = null;
        if (activeWindow && this._cardsStrip) {
            let children = this._cardsStrip.get_children();
            for (let i = 0; i < children.length; i++) {
                if (children[i]._metaWindow === activeWindow) {
                    this._activeWindowCard = children[i];
                    // Hide only the card body — the header will fade in
                    // progressively during the gesture.
                    let cardBody = children[i]._cardBody;
                    if (cardBody) cardBody.opacity = 0;
                    let header = children[i].get_first_child?.();
                    if (header && header !== cardBody)
                        header.opacity = 0;
                    // Anchor scroll so this card is centered
                    let step = this._cardW + this._cardGap;
                    this._scrollX = Math.max(0, Math.min(this._maxScroll, i * step));
                    this._cardsStrip.translation_x = -this._scrollX;
                    break;
                }
            }
        }
        this._prepared = true;
    }

    /**
     * Update overlay opacity based on swipe progress (0-1).
     * @param {number} progress
     */
    updateFromAppProgress(progress) {
        if (!this._prepared || !this._overlay) return;
        let fadeProgress = Math.min(1, Math.max(0, (progress - 0.15) / 0.50));
        let fadeOpacity = Math.round(255 * fadeProgress);
        // Backdrop and clear button fade in with progress
        if (this._backdrop) this._backdrop.opacity = fadeOpacity;
        if (this._clearBtn) this._clearBtn.opacity = fadeOpacity;
        if (this._emptyLabel) this._emptyLabel.opacity = fadeOpacity;
        // Active card body stays hidden (window actor covers it),
        // but its header fades in progressively.
        if (this._activeWindowCard) {
            let cardBody = this._activeWindowCard._cardBody;
            if (cardBody) cardBody.opacity = 0;
            let header = this._activeWindowCard.get_first_child?.();
            if (header && header !== cardBody)
                header.opacity = fadeOpacity;
        }
    }

    /**
     * Return the screen-space rect of the active window's card body.
     * Used by the home gesture to target the window animation.
     * @returns {{x: number, y: number, width: number, height: number}|null}
     */
    getActiveWindowCardRect() {
        let cardBody = this._activeWindowCard?._cardBody;
        if (!cardBody) return null;
        try {
            let [x, y] = cardBody.get_transformed_position();
            if (x === 0 && y === 0 && !cardBody.get_stage()) return null;
            return { x, y, width: cardBody.width, height: cardBody.height };
        } catch (_e) {
            return null;
        }
    }

    /**
     * Reveal the active window card (called by the home gesture
     * animation when the window actor reaches card position).
     */
    revealActiveCard() {
        if (this._activeWindowCard) {
            let cardBody = this._activeWindowCard._cardBody;
            if (cardBody) cardBody.opacity = 255;
            let header = this._activeWindowCard.get_first_child?.();
            if (header && header !== cardBody) header.opacity = 255;
        }
        this._activeWindowCard = null;
    }

    /**
     * Return the MetaWindow of the card closest to the scroll center,
     * or null if it's the same as the active window card.
     */
    getCenteredWindow() {
        if (!this._cardsStrip || this._cardW <= 0) return null;
        let step = this._cardW + this._cardGap;
        let idx = Math.round(this._scrollX / step);
        let children = this._cardsStrip.get_children();
        idx = Math.max(0, Math.min(idx, children.length - 1));
        let card = children[idx];
        if (!card || card === this._activeWindowCard) return null;
        return card._metaWindow ?? null;
    }

    /**
     * Return the screen-space rect of the card closest to scroll center.
     * @returns {{x,y,width,height}|null}
     */
    getCenteredCardRect() {
        if (!this._cardsStrip || this._cardW <= 0) return null;
        let step = this._cardW + this._cardGap;
        let idx = Math.round(this._scrollX / step);
        let children = this._cardsStrip.get_children();
        idx = Math.max(0, Math.min(idx, children.length - 1));
        let cardBody = children[idx]?._cardBody;
        if (!cardBody) return null;
        try {
            let [x, y] = cardBody.get_transformed_position();
            return { x, y, width: cardBody.width, height: cardBody.height };
        } catch (_e) {
            return null;
        }
    }

    /**
     * Scroll the carousel by a horizontal delta during the home gesture.
     * @param {number} dx - horizontal pixel offset (negative = scroll left)
     */
    scrollByDelta(dx) {
        if (!this._cardsStrip || !this._prepared) return;
        let newScroll = this._scrollX - dx;
        if (newScroll < 0) newScroll = newScroll * 0.3;
        else if (newScroll > this._maxScroll) newScroll = this._maxScroll + (newScroll - this._maxScroll) * 0.3;
        this._scrollX = newScroll;
        this._cardsStrip.translation_x = -newScroll;
    }

    /**
     * Snap carousel to the nearest card, with optional momentum.
     * @param {number} velocity - horizontal velocity (px/ms, positive = right)
     */
    snapScroll(velocity = 0) {
        if (!this._cardsStrip || this._cardW <= 0) return;
        let step = this._cardW + this._cardGap;
        // Project scroll position by momentum
        let projected = this._scrollX - velocity * 400;
        let target = Math.round(projected / step) * step;
        target = Math.max(0, Math.min(target, this._maxScroll));
        let dist = Math.abs(target - this._scrollX);
        let duration = Math.max(150, Math.min(400, Math.round(dist * 0.8)));
        this._scrollX = target;
        this._cardsStrip.ease({
            translation_x: -target, duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /** Commit to showing the overlay (snap to full visibility). */
    commitFromApp() {
        if (!this._overlay) return;
        this._hideHomeContent();
        this._prepared = false;
        let duration = this._getAnimDuration(200);

        let phoneStack = this._controller.phoneWindowStack;
        let activeWindow = phoneStack?.isActive
            ? phoneStack.getActiveWindow(this._getPhoneMonitorIndex())
            : global.display.get_focus_window();
        if (activeWindow) {
            let windowActor = activeWindow.get_compositor_private();
            if (windowActor) windowActor.hide();
        }
        if (phoneStack?.isActive) phoneStack.goHome(this._getPhoneMonitorIndex());

        let activeCard = this._activeWindowCard;
        this._activeWindowCard = null;
        if (activeCard) {
            let cardBody = activeCard._cardBody;
            if (cardBody) cardBody.opacity = 255;
            let header = activeCard.get_first_child?.();
            if (header && header !== cardBody) header.opacity = 255;
        }

        let ease = { duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC };
        if (this._backdrop) this._backdrop.ease({ opacity: 255, ...ease });
        if (this._clearBtn) this._clearBtn.ease({ opacity: 255, ...ease });
        if (this._emptyLabel) this._emptyLabel.ease({ opacity: 255, ...ease });
        this._startMemoryUpdateTimer();
    }

    /** Cancel the prepared overlay — smoothly fade out adjacent cards. */
    cancelFromApp() {
        this._stopMemoryUpdateTimer();
        if (!this._prepared && !this._overlay) return;
        this._prepared = false;
        // Restore active card visibility before fading out
        if (this._activeWindowCard) {
            let cardBody = this._activeWindowCard._cardBody;
            if (cardBody) cardBody.opacity = 255;
            let header = this._activeWindowCard.get_first_child?.();
            if (header && header !== cardBody) header.opacity = 255;
        }
        this._activeWindowCard = null;

        let overlay = this._overlay;
        if (!overlay) return;
        this._overlay = null;
        this._backdrop = null;
        this._carousel = null;
        this._cardsStrip = null;
        this._clearBtn = null;
        this._emptyLabel = null;
        this._gesture = null;

        overlay.ease({
            opacity: 0, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (overlay.get_parent()) overlay.get_parent().remove_child(overlay);
                overlay.destroy();
            },
        });
    }

    // -- Progressive gesture: from home screen --

    /** Pre-build overlay with slide-up entrance transforms. */
    prepareFromHome() {
        if (this._overlay) return;
        this._build();
        if (!this._overlay) return;

        if (this._backdrop) this._backdrop.opacity = 0;
        if (this._carousel) {
            this._carousel.opacity = 0;
            let bounds = this._getBounds();
            this._fromHomeSlide = Math.round(bounds.height * 0.35);
            this._carousel.translation_y = this._fromHomeSlide;
            this._carousel.set_scale(0.85, 0.85);
        }
        if (this._clearBtn) this._clearBtn.opacity = 0;
        if (this._emptyLabel) this._emptyLabel.opacity = 0;

        this._hideHomeContent();
        this._preparedFromHome = true;
    }

    /**
     * Update overlay as finger moves from home (progress 0-1).
     * @param {number} progress
     */
    updateFromHomeProgress(progress) {
        if (!this._preparedFromHome || !this._overlay) return;
        if (this._backdrop) this._backdrop.opacity = Math.round(255 * Math.min(1, progress));
        let fadeP = Math.min(1, Math.max(0, (progress - 0.08) / 0.77));
        if (this._carousel) {
            this._carousel.opacity = Math.round(255 * fadeP);
            let slide = this._fromHomeSlide || 0;
            this._carousel.translation_y = Math.round(slide * (1 - fadeP));
            let s = 0.85 + 0.15 * fadeP;
            this._carousel.set_scale(s, s);
        }
        let btnP = Math.min(1, Math.max(0, (progress - 0.30) / 0.50));
        let btnOpacity = Math.round(255 * btnP);
        if (this._clearBtn) this._clearBtn.opacity = btnOpacity;
        if (this._emptyLabel) this._emptyLabel.opacity = btnOpacity;
    }

    /** Commit to recent apps from home. */
    commitFromHome() {
        if (!this._overlay) return;
        this._preparedFromHome = false;
        let duration = this._getAnimDuration(200);
        let ease = { duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC };
        if (this._backdrop) this._backdrop.ease({ opacity: 255, ...ease });
        if (this._carousel)
            this._carousel.ease({ opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1, ...ease });
        if (this._clearBtn) this._clearBtn.ease({ opacity: 255, ...ease });
        if (this._emptyLabel) this._emptyLabel.ease({ opacity: 255, ...ease });
    }

    /** Cancel recent apps from home -- snap back. */
    cancelFromHome() {
        if (!this._preparedFromHome) return;
        this._preparedFromHome = false;
        this._showHomeContent();
        this.hide(true);
    }

    // -- Build --

    _build() {
        if (this._overlay) return;

        let uiScale = this._getUiScale();
        let bounds = this._getBounds();
        let screenW = bounds.width;
        let screenH = bounds.height;
        let panelH = this._controller?.getPhoneTopInset?.() ?? Main.panel?.height ?? 0;
        let bottomBarH = 20;
        let appSpaceH = screenH - panelH - bottomBarH;
        let gap = Math.round(CARD_GAP * uiScale);
        let cardW = Math.round(screenW * CARD_WIDTH_RATIO);
        let btnAreaH = Math.round(56 * uiScale);
        let headerH = Math.round(HEADER_HEIGHT * uiScale);
        let maxCardH = appSpaceH - headerH - btnAreaH;
        let windowAspect = appSpaceH / screenW;
        let cardH = Math.min(Math.round(cardW * windowAspect), maxCardH);
        let radius = Math.round(CARD_BORDER_RADIUS * uiScale);
        this._cardW = cardW;
        this._cardH = cardH;
        this._cardGap = gap;
        this._headerH = headerH;
        this._radius = radius;

        let cards = [];
        let phoneStack = this._controller.phoneWindowStack;
        if (phoneStack?.isActive) {
            for (let mw of phoneStack.getStack(this._getPhoneMonitorIndex()))
                cards.push(this._buildCard(mw, -1, cardW, cardH));
        } else {
            let wsManager = global.workspace_manager;
            for (let i = 1; i < wsManager.get_n_workspaces(); i++) {
                let ws = wsManager.get_workspace_by_index(i);
                let wins = ws.list_windows().filter(w => {
                    let t = w.get_window_type();
                    return (t === Meta.WindowType.NORMAL || t === Meta.WindowType.DIALOG)
                        && !w.is_skip_taskbar();
                });
                for (let mw of wins)
                    cards.push(this._buildCard(mw, i, cardW, cardH));
            }
        }

        this._overlay = new St.Widget({
            reactive: true,
            x: bounds.x, y: bounds.y,
            width: screenW, height: screenH,
        });

        this._backdrop = new St.Widget({
            reactive: true, x: 0, y: 0,
            width: screenW, height: screenH,
            clip_to_allocation: true, opacity: 0,
        });

        try {
            let bgGroup = Main.layoutManager._backgroundGroup;
            let bgActor = bgGroup?.get_child_at_index?.(bounds.monitorIndex ?? 0);
            if (bgActor) {
                let wallClone = new Clutter.Clone({ source: bgActor, x: 0, y: 0, width: screenW, height: screenH });
                this._backdrop.add_child(wallClone);
            }
        } catch (_) {}

        let tint = new St.Widget({ x: 0, y: 0, width: screenW, height: screenH });
        tint.add_style_class_name('recent-apps-backdrop');
        this._backdrop.add_child(tint);

        this._backdrop.connect('captured-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                this.hide();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._overlay.add_child(this._backdrop);

        let carouselY = panelH + Math.round((appSpaceH - cardH - headerH) / 2);
        let totalW = cards.length > 0 ? cards.length * cardW + (cards.length - 1) * gap : cardW;
        let centerOffset = Math.round((screenW - cardW) / 2);
        let maxScroll = Math.max(0, totalW - cardW);

        this._carousel = new St.Widget({
            reactive: cards.length > 0,
            x: 0, y: carouselY,
            width: screenW, height: cardH + headerH,
            clip_to_allocation: true,
        });
        this._carousel.set_pivot_point(0.5, 0.5);

        this._cardsStrip = new St.BoxLayout({
            vertical: false, style: `spacing: ${gap}px;`,
            x: centerOffset, y: 0,
        });
        for (let card of cards) this._cardsStrip.add_child(card);

        if (cards.length === 0) {
            let emptyContainer = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x: 0, y: 0, width: screenW, height: screenH,
            });
            emptyContainer.add_child(new St.Label({
                text: 'No recent apps',
                style_class: 'recent-apps-empty',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                x_expand: true, y_expand: true,
            }));
            this._emptyLabel = emptyContainer;
            this._overlay.add_child(emptyContainer);
        }

        this._scrollX = Math.min(maxScroll, Math.max(0, totalW - cardW));
        this._cardsStrip.translation_x = -this._scrollX;
        this._maxScroll = maxScroll;
        this._totalW = totalW;
        this._centerOffset = centerOffset;

        this._carousel.add_child(this._cardsStrip);
        this._overlay.add_child(this._carousel);

        if (cards.length > 0) {
            this._clearBtn = new St.Button({
                style_class: 'recent-apps-clear-all',
                child: new St.Label({ text: 'Clear all', style_class: 'recent-apps-clear-all-label' }),
            });
            let carouselBottom = carouselY + cardH + headerH;
            let gapBelow = screenH - bottomBarH - carouselBottom;
            let btnH = Math.round(48 * uiScale);
            let btnY = carouselBottom + Math.round((gapBelow - btnH) / 2);
            let btnContainer = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x: 0, y: btnY, width: screenW, height: btnH,
            });
            this._clearBtn.x_align = Clutter.ActorAlign.CENTER;
            this._clearBtn.y_align = Clutter.ActorAlign.CENTER;
            btnContainer.add_child(this._clearBtn);
            this._clearBtn.connect('clicked', () => {
                let ps = this._controller.phoneWindowStack;
                if (ps?.isActive)
                    for (let w of ps.getStack(this._getPhoneMonitorIndex())) w.delete(global.get_current_time());
                else {
                    let wm = global.workspace_manager;
                    for (let i = wm.get_n_workspaces() - 1; i > 0; i--) {
                        let ws = wm.get_workspace_by_index(i);
                        for (let w of ws.list_windows()) {
                            let t = w.get_window_type();
                            if ((t === Meta.WindowType.NORMAL || t === Meta.WindowType.DIALOG) && !w.is_skip_taskbar())
                                w.delete(global.get_current_time());
                        }
                    }
                }
                this.hide();
            });
            this._overlay.add_child(btnContainer);
        }

        this._gesture = {
            startX: 0, startY: 0, time: 0,
            direction: null, grab: null,
            lastX: 0, lastTime: 0, velocityX: 0,
            touchedCard: null, longPressTimer: 0,
        };
        this._carousel.connect('captured-event', (_a, event) => this._onGesture(event));

        Main.layoutManager.uiGroup.add_child(this._overlay);
        Main.layoutManager.uiGroup.set_child_below_sibling(
            this._overlay, Main.layoutManager.modalDialogGroup);
    }

    // -- Card builder --

    _buildCard(metaWindow, wsIndex, cardW, cardH) {
        let uiScale = this._getUiScale();
        let radius = this._radius || Math.round(CARD_BORDER_RADIUS * uiScale);
        let headerH = this._headerH || Math.round(HEADER_HEIGHT * uiScale);

        let wrapper = new St.BoxLayout({ vertical: true, width: cardW, reactive: true });

        let tracker = Shell.WindowTracker.get_default();
        let app = tracker.get_window_app(metaWindow);
        let appName = app?.get_name() || metaWindow.get_title() || 'Untitled';

        let showMemory = false;
        try { showMemory = this._controller?.settings?.get_boolean('debug-show-app-memory') ?? false; } catch (_e) {}
        let displayName = appName;
        if (showMemory) {
            let memStr = this._getWindowMemoryUsage(metaWindow);
            if (memStr) displayName = `${appName} - ${memStr}`;
        }

        let header = new St.BoxLayout({
            style_class: 'recent-apps-card-header',
            style: `spacing: ${Math.round(4 * uiScale)}px;`,
            height: headerH, x_align: Clutter.ActorAlign.CENTER,
        });
        if (app) {
            let icon = app.create_icon_texture(Math.round(24 * uiScale));
            icon.y_align = Clutter.ActorAlign.CENTER;
            header.add_child(icon);
        }
        let nameLabel = new St.Label({
            text: displayName, style_class: 'recent-apps-card-app-name',
            y_align: Clutter.ActorAlign.CENTER, x_expand: false,
        });
        header.add_child(nameLabel);
        wrapper.add_child(header);

        let card = new St.Widget({
            style_class: 'recent-apps-card',
            style: `border-radius: ${radius}px;`,
            width: cardW, height: cardH,
            reactive: true, clip_to_allocation: true,
        });

        let windowActor = metaWindow.get_compositor_private();
        if (windowActor) {
            let cloneContainer = new St.Widget({ clip_to_allocation: true });
            cloneContainer.add_constraint(new Clutter.BindConstraint({
                source: card, coordinate: Clutter.BindCoordinate.SIZE,
            }));
            let clone = new Clutter.Clone({ source: windowActor });
            cloneContainer.add_child(clone);
            clone.connect('notify::allocation', () => {
                let cw = cloneContainer.width, ch = cloneContainer.height;
                if (windowActor.width > 0 && windowActor.height > 0) {
                    let s = Math.min(cw / windowActor.width, ch / windowActor.height);
                    clone.set_scale(s, s);
                }
            });
            card.add_child(cloneContainer);
            try {
                let cornerRadius = 18;
                try {
                    cornerRadius = this._controller?.settings?.get_int('window-corner-radius') ?? 18;
                } catch (_e2) {}
                let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                card.add_effect(new CardClipEffect(Math.round(cornerRadius * scale)));
            } catch (_e) {}
        }

        wrapper.add_child(card);
        wrapper._metaWindow = metaWindow;
        wrapper._workspaceIndex = wsIndex;
        wrapper._cardBody = card;
        wrapper._nameLabel = nameLabel;
        wrapper._baseName = appName;
        wrapper._tapHandler = () => this._activateCard(wrapper);
        return wrapper;
    }

    // -- Gesture handling --

    _onGesture(event) {
        let type = event.type();
        let g = this._gesture;

        if (type === Clutter.EventType.TOUCH_BEGIN || type === Clutter.EventType.BUTTON_PRESS) {
            let [x, y] = event.get_coords();
            let now = GLib.get_monotonic_time();
            this._cardsStrip?.remove_all_transitions();

            let target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            let touchedCard = null;
            let actor = target;
            while (actor && actor !== this._carousel) {
                if (actor._metaWindow) { touchedCard = actor; break; }
                actor = actor.get_parent();
            }

            let lpTimer = 0;
            if (touchedCard) {
                lpTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                    if (this._gesture) this._gesture.longPressTimer = 0;
                    this._onLongPress(touchedCard);
                    return GLib.SOURCE_REMOVE;
                });
            }

            this._gesture = {
                startX: x, startY: y, time: now,
                direction: null,
                grab: global.stage.grab(this._carousel),
                lastX: x, lastTime: now, velocityX: 0,
                touchedCard, longPressTimer: lpTimer,
            };
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_UPDATE || type === Clutter.EventType.MOTION) {
            if (!g.grab) return Clutter.EVENT_PROPAGATE;
            let [x, y] = event.get_coords();
            let now = GLib.get_monotonic_time();
            let dt = Math.max(1, (now - g.lastTime) / 1000);
            let adx = Math.abs(x - g.startX);
            let ady = Math.abs(y - g.startY);

            // Cancel long-press if finger moved too far
            if (g.longPressTimer && Math.hypot(adx, ady) > LONG_PRESS_CANCEL_DIST) {
                GLib.source_remove(g.longPressTimer);
                g.longPressTimer = 0;
            }

            // Handle split-drop drag mode
            if (this._splitDropActive) {
                this._updateSplitDrag(x, y);
                return Clutter.EVENT_STOP;
            }

            if (!g.direction && Math.max(adx, ady) > 8)
                g.direction = adx > ady ? 'horizontal' : (y < g.startY ? 'card-dismiss' : 'card-open');

            if (g.direction === 'horizontal') {
                let dx = x - g.lastX;
                g.velocityX = dx / dt;
                let newScroll = this._scrollX - dx;
                if (newScroll < 0) newScroll = newScroll * 0.3;
                else if (newScroll > this._maxScroll) newScroll = this._maxScroll + (newScroll - this._maxScroll) * 0.3;
                this._scrollX = newScroll;
                this._cardsStrip.translation_x = -newScroll;
            }

            if (g.direction === 'card-dismiss' && g.touchedCard) {
                let dy = y - g.startY;
                dy = Math.min(0, dy);
                g.touchedCard.translation_y = dy;
                let progress = Math.abs(dy) / this._cardH;
                g.touchedCard.opacity = Math.round(255 * Math.max(0, 1 - progress * 1.5));
            }

            if (g.direction === 'card-open' && g.touchedCard) {
                let dy = Math.max(0, y - g.startY);
                let progress = Math.min(1, dy / (this._cardH * 0.5));
                let cardBody = g.touchedCard._cardBody;

                // Disable clipping and capture initial position
                if (!g.clippingDisabled) {
                    g.clippingDisabled = true;
                    if (this._carousel) this._carousel.clip_to_allocation = false;
                    if (cardBody) cardBody.clip_to_allocation = false;
                    let cloneContainer = cardBody?.get_first_child?.();
                    if (cloneContainer) cloneContainer.clip_to_allocation = false;
                    // Hide the header so only the window preview scales
                    let header = g.touchedCard.get_first_child?.();
                    if (header && header !== cardBody) {
                        g.savedHeader = header;
                        header.ease({ opacity: 0, duration: 100 });
                    }
                    // Capture the card body's screen position before any transforms
                    if (cardBody) {
                        let [cbX, cbY] = cardBody.get_transformed_position();
                        let monitorIndex = this._getBounds().monitorIndex;
                        let monitor = Main.layoutManager.monitors?.[monitorIndex]
                            ?? Main.layoutManager.primaryMonitor;
                        let panelH = this._controller?.getPhoneTopInset?.(monitorIndex) ?? 0;
                        let gestureBarH = this._controller.getPhoneGestureBarForMonitor?.(monitorIndex)?.height ?? 20;
                        // Target: usable area between status bar and gesture bar
                        let targetX = monitor.x;
                        let targetY = monitor.y + panelH;
                        let targetW = monitor.width;
                        let targetH = monitor.height - panelH - gestureBarH;
                        g.cardBodyScreenX = cbX;
                        g.cardBodyScreenY = cbY;
                        g.targetCenterX = targetX + targetW / 2;
                        g.targetCenterY = targetY + targetH / 2;
                        // Scale to cover the full target area on both axes
                        let sx = targetW / Math.max(1, this._cardW);
                        let sy = targetH / Math.max(1, this._cardH);
                        // Slight overshoot to eliminate sub-pixel gaps from rounding
                        let cover = Math.max(sx, sy) + 0.0025;
                        g.scaleTargetX = cover;
                        g.scaleTargetY = cover;
                    }
                }

                // Scale the card body toward full screen
                if (cardBody && g.scaleTargetX) {
                    let scaleX = 1 + (g.scaleTargetX - 1) * progress;
                    let scaleY = 1 + (g.scaleTargetY - 1) * progress;
                    cardBody.set_pivot_point(0.5, 0.5);
                    cardBody.set_scale(scaleX, scaleY);

                    // Translate so the scaled card aligns with the screen
                    let cardCenterX = g.cardBodyScreenX + this._cardW / 2;
                    let cardCenterY = g.cardBodyScreenY + this._cardH / 2;
                    cardBody.translation_x = (g.targetCenterX - cardCenterX) * progress;
                    cardBody.translation_y = (g.targetCenterY - cardCenterY) * progress;
                }
                // Fade out the rest of the overlay
                if (this._backdrop)
                    this._backdrop.opacity = Math.round(255 * (1 - progress));
                for (let c of (this._cardsStrip?.get_children() ?? [])) {
                    if (c !== g.touchedCard)
                        c.opacity = Math.round(255 * (1 - progress));
                }
                if (this._clearBtn) this._clearBtn.opacity = Math.round(255 * (1 - progress));
            }

            g.lastX = x;
            g.lastTime = now;
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL ||
            type === Clutter.EventType.BUTTON_RELEASE) {
            if (g.longPressTimer) { GLib.source_remove(g.longPressTimer); g.longPressTimer = 0; }
            if (g.grab) { g.grab.dismiss(); g.grab = null; }

            if (this._splitDropActive) {
                this._finishSplitDrop();
                return Clutter.EVENT_STOP;
            }

            if (g.direction === 'card-dismiss' && g.touchedCard) {
                let [, y] = event.get_coords();
                let dy = g.startY - y;
                if (dy > this._cardH * DISMISS_THRESHOLD)
                    this._dismissCard(g.touchedCard);
                else
                    g.touchedCard.ease({ translation_y: 0, opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
                return Clutter.EVENT_STOP;
            }

            if (g.direction === 'card-open' && g.touchedCard) {
                let [, y] = event.get_coords();
                let dy = y - g.startY;
                if (dy > this._cardH * DISMISS_THRESHOLD)
                    this._openCard(g.touchedCard);
                else
                    this._cancelOpenCard(g.touchedCard);
                return Clutter.EVENT_STOP;
            }

            if (g.direction === 'horizontal') {
                this._snapToNearestCard();
                return Clutter.EVENT_STOP;
            }

            if (!g.direction && g.touchedCard)
                g.touchedCard._tapHandler?.();

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // -- Card actions --

    /** Animate switching to a card's window. */
    _activateCard(card) {
        let metaWindow = card._metaWindow;
        if (!metaWindow) return;

        let windowActor = metaWindow.get_compositor_private();
        if (windowActor) windowActor.show();

        let ps = this._controller.phoneWindowStack;
        if (ps?.isActive && ps.hasWindow(metaWindow, this._getPhoneMonitorIndex()))
            ps.activateWindow(metaWindow, this._getPhoneMonitorIndex());
        else {
            let ws = global.workspace_manager.get_workspace_by_index(card._workspaceIndex);
            if (ws) ws.activate(global.get_current_time());
        }

        this.hide(false, { skipHomeRestore: true });
    }

    /** Dismiss a card (close window) with swipe-up animation. */
    _dismissCard(card) {
        let metaWindow = card._metaWindow;
        card.ease({
            translation_y: -this._cardH, opacity: 0,
            duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (metaWindow) metaWindow.delete(global.get_current_time());
                if (this._cardsStrip && card.get_parent() === this._cardsStrip)
                    this._cardsStrip.remove_child(card);
                card.destroy();
                this._recalcScroll();
                if (this._cardsStrip && this._cardsStrip.get_n_children() === 0)
                    this.hide();
            },
        });
    }

    _openCard(card) {
        let cardBody = card._cardBody;
        if (!cardBody) { this._activateCard(card); return; }
        let monitorIndex = this._getBounds().monitorIndex;
        let monitor = Main.layoutManager.monitors?.[monitorIndex]
            ?? Main.layoutManager.primaryMonitor;
        let panelH = this._controller?.getPhoneTopInset?.(monitorIndex) ?? 0;
        let gestureBarH = this._controller.getPhoneGestureBarForMonitor?.(monitorIndex)?.height ?? 20;
        let targetW = monitor.width;
        let targetH = monitor.height - panelH - gestureBarH;
        let sx = targetW / Math.max(1, this._cardW);
        let sy = targetH / Math.max(1, this._cardH);
        cardBody.ease({
            scale_x: Math.max(sx, sy), scale_y: Math.max(sx, sy),
            duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => this._activateCard(card),
        });
    }

    _cancelOpenCard(card) {
        let dur = 200;
        let ease = { duration: dur, mode: Clutter.AnimationMode.EASE_OUT_CUBIC };
        let cardBody = card._cardBody;
        if (cardBody)
            cardBody.ease({ scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, ...ease,
                onComplete: () => this._restoreClipping(card) });
        // Restore header
        let header = card.get_first_child?.();
        if (header && header !== cardBody)
            header.ease({ opacity: 255, ...ease });
        if (this._backdrop) this._backdrop.ease({ opacity: 255, ...ease });
        if (this._clearBtn) this._clearBtn.ease({ opacity: 255, ...ease });
        for (let c of (this._cardsStrip?.get_children() ?? [])) {
            if (c !== card) c.ease({ opacity: 255, ...ease });
        }
    }

    _restoreClipping(card) {
        if (this._carousel) this._carousel.clip_to_allocation = true;
        let cardBody = card?._cardBody;
        if (cardBody) {
            cardBody.clip_to_allocation = true;
            cardBody.set_scale(1, 1);
            cardBody.set_pivot_point(0, 0);
            cardBody.translation_x = 0;
            cardBody.translation_y = 0;
        }
        let cloneContainer = cardBody?.get_first_child?.();
        if (cloneContainer) cloneContainer.clip_to_allocation = true;
    }

    /** Snap the strip to the nearest card center after a scroll. */
    _snapToNearestCard() {
        if (!this._cardsStrip || this._cardW <= 0) return;
        let step = this._cardW + this._cardGap;
        let target = Math.round(this._scrollX / step) * step;
        target = Math.max(0, Math.min(target, this._maxScroll));
        let duration = this._getAnimDuration(200);
        this._scrollX = target;
        this._cardsStrip.ease({
            translation_x: -target, duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _recalcScroll() {
        if (!this._cardsStrip) return;
        let nCards = this._cardsStrip.get_n_children();
        let totalW = nCards > 0 ? nCards * this._cardW + (nCards - 1) * this._cardGap : this._cardW;
        this._maxScroll = Math.max(0, totalW - this._cardW);
        this._scrollX = Math.min(this._scrollX, this._maxScroll);
        this._cardsStrip.translation_x = -this._scrollX;
    }

    _startMemoryUpdateTimer() {
        this._stopMemoryUpdateTimer();
        let showMemory = false;
        try { showMemory = this._controller?.settings?.get_boolean('debug-show-app-memory') ?? false; } catch (_e) {}
        if (!showMemory) return;

        this._memoryTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (!this._cardsStrip) { this._memoryTimerId = 0; return GLib.SOURCE_REMOVE; }
            for (let card of this._cardsStrip.get_children()) {
                if (!card._nameLabel || !card._metaWindow) continue;
                let memStr = this._getWindowMemoryUsage(card._metaWindow);
                card._nameLabel.text = memStr
                    ? `${card._baseName} - ${memStr}`
                    : card._baseName;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopMemoryUpdateTimer() {
        if (this._memoryTimerId) {
            GLib.source_remove(this._memoryTimerId);
            this._memoryTimerId = 0;
        }
    }

    _getWindowMemoryUsage(metaWindow) {
        try {
            let pid = metaWindow.get_pid?.();
            if (!pid || pid <= 0) return null;
            let [ok, contents] = GLib.file_get_contents(`/proc/${pid}/statm`);
            if (!ok) return null;
            let parts = new TextDecoder().decode(contents).trim().split(/\s+/);
            let rssPages = parseInt(parts[1], 10);
            if (isNaN(rssPages)) return null;
            let pageSize = 4096;
            let bytes = rssPages * pageSize;
            if (bytes >= 1073741824)
                return `${(bytes / 1073741824).toFixed(2)}GB`;
            return `${Math.round(bytes / 1048576)}MB`;
        } catch (_e) {
            return null;
        }
    }

    // -- Utilities --

    _findCardForWindow(metaWindow) {
        if (!metaWindow || !this._cardsStrip) return null;
        for (let child of this._cardsStrip.get_children()) {
            if (child._metaWindow === metaWindow) return child;
        }
        return null;
    }

    _getUiScale() {
        return getAdaptiveScale({ profile: 'recent', referenceWidth: 640, min: 0.95, max: 1.2 });
    }

    _getBounds() {
        let monitorIndex = this._monitorIndex;
        if (!Number.isInteger(monitorIndex))
            monitorIndex = this._controller?.getPhoneMonitorIndex?.() ?? Main.layoutManager.primaryIndex;
        return this._controller?.getRecentAppsBounds?.(monitorIndex)
            ?? {
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
                monitorIndex,
            };
    }

    _getAnimDuration(baseMs) {
        let bounds = this._getBounds();
        let monitor = Main.layoutManager.monitors?.[bounds.monitorIndex] ?? Main.layoutManager.primaryMonitor;
        let scale = monitor?.geometry_scale ?? 1;
        let scaleMul = Math.max(0.92, Math.min(1.16, 1 + ((scale - 1) * 0.12)));
        return Math.round(baseMs * scaleMul);
    }

    _hideHomeContent() {
        this._controller.getPhoneHomeScreenForMonitor?.(this._getPhoneMonitorIndex())?.hide?.();
        this._controller.getPhoneAppDrawerForMonitor?.(this._getPhoneMonitorIndex())
            ?.hide?.();
    }

    _showHomeContent() {
        this._controller.getPhoneHomeScreenForMonitor?.(this._getPhoneMonitorIndex())?.show?.();
        this._controller.getPhoneAppDrawerForMonitor?.(this._getPhoneMonitorIndex())
            ?.show?.();
    }

    // ── Split-screen: long-press entry ─────────────────────────────

    _onLongPress(card) {
        if (!card?._metaWindow || this._splitDropActive) return;
        this._splitDropActive = true;
        this._splitDropCard = card;

        // Dim other cards, hide original
        for (let c of this._cardsStrip.get_children()) {
            if (c !== card)
                c.ease({ opacity: 60, duration: 150 });
        }
        card.ease({ opacity: 0, duration: 150 });

        // Build drop zones
        this._buildSplitDropZones();

        // Create drag clone from card body
        let body = card._cardBody;
        if (body) {
            this._splitDragClone = new Clutter.Clone({
                source: body,
                reactive: false,
                opacity: 220,
            });
            let scale = 0.65;
            this._splitDragClone.set_pivot_point(0.5, 0.5);
            this._splitDragClone.set_scale(scale, scale);
            this._overlay.add_child(this._splitDragClone);
            let [gx, gy] = body.get_transformed_position();
            this._splitDragClone.set_position(gx, gy);
            this._splitDragClone.ease({
                scale_x: scale, scale_y: scale, opacity: 230,
                duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _buildSplitDropZones() {
        let bounds = this._getSplitBounds();
        let landscape = this._isLandscape();
        let dividerThick = 2;
        let halfPrimary, halfSecondary;

        this._splitZoneOverlay = new St.Widget({
            x: bounds.x, y: bounds.y,
            width: bounds.width, height: bounds.height,
        });

        // Dimmed backdrop behind the zones
        let backdrop = new St.Widget({
            style_class: 'convergence-split-backdrop',
            x: 0, y: 0, width: bounds.width, height: bounds.height,
        });
        this._splitZoneOverlay.add_child(backdrop);

        if (landscape) {
            halfPrimary = Math.round((bounds.width - dividerThick) / 2);
            this._splitPrimaryZone = new St.Widget({
                style_class: 'convergence-split-zone',
                x: 0, y: 0, width: halfPrimary, height: bounds.height,
            });
            this._splitDividerPreview = new St.Widget({
                style_class: 'convergence-split-divider-preview',
                x: halfPrimary, y: 0, width: dividerThick, height: bounds.height,
            });
            this._splitSecondaryZone = new St.Widget({
                style_class: 'convergence-split-zone',
                x: halfPrimary + dividerThick, y: 0,
                width: bounds.width - halfPrimary - dividerThick, height: bounds.height,
            });
        } else {
            halfPrimary = Math.round((bounds.height - dividerThick) / 2);
            this._splitPrimaryZone = new St.Widget({
                style_class: 'convergence-split-zone',
                x: 0, y: 0, width: bounds.width, height: halfPrimary,
            });
            this._splitDividerPreview = new St.Widget({
                style_class: 'convergence-split-divider-preview',
                x: 0, y: halfPrimary, width: bounds.width, height: dividerThick,
            });
            this._splitSecondaryZone = new St.Widget({
                style_class: 'convergence-split-zone',
                x: 0, y: halfPrimary + dividerThick,
                width: bounds.width, height: bounds.height - halfPrimary - dividerThick,
            });
        }

        this._splitZoneOverlay.add_child(this._splitPrimaryZone);
        this._splitZoneOverlay.add_child(this._splitDividerPreview);
        this._splitZoneOverlay.add_child(this._splitSecondaryZone);
        this._splitZoneOverlay.opacity = 0;
        this._overlay.add_child(this._splitZoneOverlay);
        this._splitZoneOverlay.ease({ opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
    }

    _updateSplitDrag(x, y) {
        if (this._splitDragClone) {
            let hw = this._splitDragClone.width * 0.5 * 0.65;
            let hh = this._splitDragClone.height * 0.5 * 0.65;
            this._splitDragClone.set_position(x - hw, y - hh);
        }

        let bounds = this._getSplitBounds();
        let landscape = this._isLandscape();
        let zone = null;

        if (landscape) {
            let relX = x - bounds.x;
            zone = relX < bounds.width * 0.5 ? 'primary' : 'secondary';
        } else {
            let relY = y - bounds.y;
            zone = relY < bounds.height * 0.5 ? 'primary' : 'secondary';
        }

        if (zone !== this._splitActiveZone) {
            this._splitActiveZone = zone;
            this._splitPrimaryZone.style_class = zone === 'primary'
                ? 'convergence-split-zone convergence-split-zone-active'
                : 'convergence-split-zone';
            this._splitSecondaryZone.style_class = zone === 'secondary'
                ? 'convergence-split-zone convergence-split-zone-active'
                : 'convergence-split-zone';
        }
    }

    _finishSplitDrop() {
        let zone = this._splitActiveZone;
        let metaWindow = this._splitDropCard?._metaWindow;

        // Clean up the drag UI before starting split placement
        this._cleanupSplitDropUI();

        if (!zone || !metaWindow) {
            this._cancelSplitDrop();
            return;
        }

        // Hide the recent apps overlay first, then begin split
        this.hide(false, { skipHomeRestore: true });
        this._beginSplitScreen(metaWindow, zone);
    }

    _cancelSplitDrop() {
        this._splitDropActive = false;
        if (this._cardsStrip) {
            for (let c of this._cardsStrip.get_children())
                c.ease({ opacity: 255, duration: 150 });
        }
        this._cleanupSplitDropUI();
    }

    _cleanupSplitDropUI() {
        this._splitDropActive = false;
        this._splitActiveZone = null;
        if (this._splitDragClone) {
            this._splitDragClone.destroy();
            this._splitDragClone = null;
        }
        if (this._splitZoneOverlay) {
            this._splitZoneOverlay.destroy();
            this._splitZoneOverlay = null;
        }
        this._splitPrimaryZone = null;
        this._splitSecondaryZone = null;
        this._splitDividerPreview = null;
        this._splitDropCard = null;
    }

    // ── Split-screen: window placement ──────────────────────────────

    _getSplitBounds() {
        let monitorIndex = Number.isInteger(this._splitMonitorIndex)
            ? this._splitMonitorIndex
            : this._getBounds().monitorIndex;
        let monitor = Main.layoutManager.monitors?.[monitorIndex] ?? Main.layoutManager.primaryMonitor ?? Main.layoutManager.monitors?.[0];
        let panelH = this._controller?.getPhoneTopInset?.(monitorIndex) ?? Main.panel?.height ?? 0;
        let gestureBarH = this._controller.getPhoneGestureBarForMonitor?.(monitorIndex)?.height || 20;
        return {
            x: monitor?.x || 0,
            y: (monitor?.y || 0) + panelH,
            width: monitor?.width || global.stage.width,
            height: (monitor?.height || global.stage.height) - panelH - gestureBarH,
        };
    }

    _isLandscape() {
        let bounds = this._getSplitBounds();
        return bounds.width > bounds.height;
    }

    _getSplitOrientation() {
        return this._isLandscape() ? 'horizontal' : 'vertical';
    }

    _snapToRatio(ratio) {
        for (let anchor of SNAP_RATIOS) {
            if (Math.abs(ratio - anchor) < SNAP_MAGNETISM)
                return anchor;
        }
        return ratio;
    }

    _beginSplitScreen(metaWindow, position) {
        let ps = this._controller.phoneWindowStack;
        if (!ps) return;
        let phoneMonitorIndex = this._getPhoneMonitorIndex();
        this._splitMonitorIndex = phoneMonitorIndex;
        this._splitOrientation = this._getSplitOrientation();

        this._splitFirstWindow = metaWindow;
        this._splitFirstPosition = position === 'primary' || position === 'secondary'
            ? position : 'primary';

        // Go home first so the app drawer can show, then mark for split
        // and place the window. goHome() calls exitSplitMode() if
        // splitWindows is set, so it must run before markForSplit().
        ps.goHome(phoneMonitorIndex);
        ps.syncVisibility();

        ps.markForSplit(metaWindow, phoneMonitorIndex);
        this._placeWindowInHalf(metaWindow, position, 0.5);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex)
                ?.expand?.();
            return GLib.SOURCE_REMOVE;
        });

        // Watch for new window focus — accept any normal window on the
        // phone monitor, including newly launched apps not yet in the stack.
        this._splitFocusWatchId = global.display.connect('notify::focus-window', () => {
            let focusWin = global.display.get_focus_window();
            if (focusWin &&
                focusWin !== metaWindow &&
                focusWin.get_window_type() === Meta.WindowType.NORMAL) {
                this._completeSplitScreen(focusWin);
            }
        });
    }

    _placeWindowInHalf(metaWindow, position, ratio) {
        let bounds = this._getSplitBounds();
        let gap = Math.round(DIVIDER_HEIGHT / 2);
        let horiz = this._splitOrientation === 'horizontal';

        try {
            if (metaWindow.get_maximized?.() || metaWindow.is_maximized?.())
                metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
        } catch (_e) {
            try { metaWindow.unmaximize(Meta.MaximizeFlags.BOTH); } catch (_e2) {}
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            if (horiz) {
                let primaryW = Math.round(bounds.width * ratio) - gap;
                let secondaryW = bounds.width - primaryW - DIVIDER_HEIGHT;
                if (position === 'primary')
                    metaWindow.move_resize_frame(true, bounds.x, bounds.y, primaryW, bounds.height);
                else
                    metaWindow.move_resize_frame(true, bounds.x + primaryW + DIVIDER_HEIGHT, bounds.y, secondaryW, bounds.height);
            } else {
                let primaryH = Math.round(bounds.height * ratio) - gap;
                let secondaryH = bounds.height - primaryH - DIVIDER_HEIGHT;
                if (position === 'primary')
                    metaWindow.move_resize_frame(true, bounds.x, bounds.y, bounds.width, primaryH);
                else
                    metaWindow.move_resize_frame(true, bounds.x, bounds.y + primaryH + DIVIDER_HEIGHT, bounds.width, secondaryH);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _completeSplitScreen(secondWindow) {
        let phoneMonitorIndex = Number.isInteger(this._splitMonitorIndex)
            ? this._splitMonitorIndex
            : this._getPhoneMonitorIndex();
        if (this._splitFocusWatchId) {
            global.display.disconnect(this._splitFocusWatchId);
            this._splitFocusWatchId = 0;
        }

        let ps = this._controller.phoneWindowStack;
        if (!ps || !this._splitFirstWindow) return;

        let firstPos = this._splitFirstPosition || 'primary';
        let secondPos = firstPos === 'primary' ? 'secondary' : 'primary';

        // Ensure the window is tracked in the stack before marking for
        // split — newly launched apps may not be in the stack yet.
        if (!ps.hasWindow(secondWindow, phoneMonitorIndex))
            ps.pushWindow(secondWindow, phoneMonitorIndex);
        ps.markForSplit(secondWindow, phoneMonitorIndex);
        this._placeWindowInHalf(secondWindow, secondPos, 0.5);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            ps.enterSplitMode(this._splitFirstWindow, secondWindow, phoneMonitorIndex);
            this._controller.getPhoneAppDrawerForMonitor?.(phoneMonitorIndex)
                ?.collapse?.();

            this._splitState = {
                primaryWindow: firstPos === 'primary' ? this._splitFirstWindow : secondWindow,
                secondaryWindow: firstPos === 'primary' ? secondWindow : this._splitFirstWindow,
                ratio: 0.5,
                orientation: this._splitOrientation || 'vertical',
            };
            this._watchSplitWindowClose();
            this._buildSplitDivider();
            this._splitFirstWindow = null;
            this._splitFirstPosition = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Split-screen: window close watch ──────────────────────────────

    _watchSplitWindowClose() {
        this._unwatchSplitWindowClose();
        if (!this._splitState) return;

        let onClosed = (closedWindow) => {
            let remaining = closedWindow === this._splitState?.primaryWindow
                ? this._splitState?.secondaryWindow
                : this._splitState?.primaryWindow;
            this._exitSplitScreen(remaining);
        };

        let pw = this._splitState.primaryWindow;
        let sw = this._splitState.secondaryWindow;
        this._splitCloseSignals = [];

        if (pw) {
            let id = pw.connect('unmanaged', () => onClosed(pw));
            this._splitCloseSignals.push({ window: pw, id });
        }
        if (sw) {
            let id = sw.connect('unmanaged', () => onClosed(sw));
            this._splitCloseSignals.push({ window: sw, id });
        }
    }

    _unwatchSplitWindowClose() {
        if (this._splitCloseSignals) {
            for (let { window: w, id } of this._splitCloseSignals) {
                try { w.disconnect(id); } catch (_e) {}
            }
            this._splitCloseSignals = null;
        }
    }

    // ── Split-screen: divider ───────────────────────────────────────

    _buildSplitDivider() {
        this._destroySplitDivider();
        if (!this._splitState) return;

        let bounds = this._getSplitBounds();
        let gap = Math.round(DIVIDER_HEIGHT / 2);
        let horiz = this._splitState.orientation === 'horizontal';
        let divPos = horiz
            ? bounds.x + Math.round(bounds.width * this._splitState.ratio) - gap
            : bounds.y + Math.round(bounds.height * this._splitState.ratio) - gap;

        this._splitDivider = new St.Widget({
            style_class: 'convergence-split-divider',
            layout_manager: new Clutter.BinLayout(),
            x: horiz ? divPos : bounds.x,
            y: horiz ? bounds.y : divPos,
            width: horiz ? DIVIDER_HEIGHT : bounds.width,
            height: horiz ? bounds.height : DIVIDER_HEIGHT,
            reactive: true,
        });
        let handle = new St.Widget({
            style_class: horiz
                ? 'convergence-split-divider-handle-horizontal'
                : 'convergence-split-divider-handle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        this._splitDivider.add_child(handle);

        Main.layoutManager.addTopChrome(this._splitDivider, {
            affectsStruts: false, trackFullscreen: false,
        });

        let divGesture = null;
        let lastTapTime = 0;
        let singleTapTimer = 0;

        this._splitDivider.connect('captured-event', (_a, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN || type === Clutter.EventType.BUTTON_PRESS) {
                let [x, y] = event.get_coords();
                this._destroyControlTray();
                divGesture = {
                    startX: x, startY: y,
                    startRatio: this._splitState.ratio,
                    grab: global.stage.grab(this._splitDivider),
                    dragged: false,
                };
                return Clutter.EVENT_STOP;
            }
            if ((type === Clutter.EventType.TOUCH_UPDATE || type === Clutter.EventType.MOTION) && divGesture) {
                let [x, y] = event.get_coords();
                let delta = horiz
                    ? x - divGesture.startX
                    : y - divGesture.startY;
                let span = horiz ? bounds.width : bounds.height;
                if (Math.abs(delta) > 4) divGesture.dragged = true;
                let newRatio = Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX,
                    divGesture.startRatio + delta / span));
                newRatio = this._snapToRatio(newRatio);
                this._splitState.ratio = newRatio;
                this._resizeSplitWindows(newRatio, bounds);
                return Clutter.EVENT_STOP;
            }
            if ((type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL || type === Clutter.EventType.BUTTON_RELEASE) && divGesture) {
                if (divGesture.grab) { divGesture.grab.dismiss(); divGesture.grab = null; }
                let wasDrag = divGesture.dragged;
                divGesture = null;

                if (wasDrag) {
                    let ratio = this._splitState.ratio;
                    if (ratio <= SPLIT_DISMISS_THRESHOLD)
                        this._exitSplitScreen(this._splitState.secondaryWindow);
                    else if (ratio >= 1 - SPLIT_DISMISS_THRESHOLD)
                        this._exitSplitScreen(this._splitState.primaryWindow);
                    return Clutter.EVENT_STOP;
                }

                // Tap detected — check for double-tap
                let now = GLib.get_monotonic_time() / 1000;
                if (now - lastTapTime < DOUBLE_TAP_MS) {
                    // Double-tap: swap windows
                    if (singleTapTimer) { GLib.source_remove(singleTapTimer); singleTapTimer = 0; }
                    lastTapTime = 0;
                    this._swapSplitWindows();
                } else {
                    // Possible single tap — wait for double-tap window
                    lastTapTime = now;
                    if (singleTapTimer) GLib.source_remove(singleTapTimer);
                    singleTapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DOUBLE_TAP_MS, () => {
                        singleTapTimer = 0;
                        this._toggleControlTray();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _swapSplitWindows() {
        if (!this._splitState) return;
        let { primaryWindow, secondaryWindow, ratio } = this._splitState;
        this._splitState.primaryWindow = secondaryWindow;
        this._splitState.secondaryWindow = primaryWindow;
        this._splitState.ratio = 1 - ratio;
        let bounds = this._getSplitBounds();
        this._resizeSplitWindows(this._splitState.ratio, bounds);
    }

    _toggleControlTray() {
        if (this._splitControlTray) {
            this._destroyControlTray();
            return;
        }
        if (!this._splitState || !this._splitDivider) return;

        let bounds = this._getSplitBounds();
        let horiz = this._splitState.orientation === 'horizontal';

        this._splitControlTray = new St.BoxLayout({
            style_class: 'convergence-split-control-tray',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });

        let makeBtn = (iconName, callback) => {
            let btn = new St.Button({
                style_class: 'convergence-split-control-btn',
                child: new St.Icon({ icon_name: iconName, icon_size: 18 }),
            });
            btn.connect('clicked', () => { callback(); this._destroyControlTray(); });
            return btn;
        };

        this._splitControlTray.add_child(makeBtn(
            horiz ? 'object-flip-horizontal-symbolic' : 'object-flip-vertical-symbolic',
            () => this._swapSplitWindows()));
        this._splitControlTray.add_child(makeBtn(
            'window-close-symbolic',
            () => this._exitSplitScreen()));

        Main.layoutManager.addTopChrome(this._splitControlTray, {
            affectsStruts: false, trackFullscreen: false,
        });

        // Position centered on divider
        let trayW = this._splitControlTray.width || 100;
        let trayH = this._splitControlTray.height || 40;
        if (horiz) {
            this._splitControlTray.set_position(
                this._splitDivider.x - Math.round(trayW / 2) + Math.round(DIVIDER_HEIGHT / 2),
                bounds.y + Math.round(bounds.height / 2) - Math.round(trayH / 2));
        } else {
            this._splitControlTray.set_position(
                bounds.x + Math.round(bounds.width / 2) - Math.round(trayW / 2),
                this._splitDivider.y - trayH - 4);
        }

        // Reposition after allocation if size was unknown
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._splitControlTray || !this._splitDivider) return GLib.SOURCE_REMOVE;
            trayW = this._splitControlTray.width;
            trayH = this._splitControlTray.height;
            if (horiz) {
                this._splitControlTray.set_position(
                    this._splitDivider.x - Math.round(trayW / 2) + Math.round(DIVIDER_HEIGHT / 2),
                    bounds.y + Math.round(bounds.height / 2) - Math.round(trayH / 2));
            } else {
                this._splitControlTray.set_position(
                    bounds.x + Math.round(bounds.width / 2) - Math.round(trayW / 2),
                    this._splitDivider.y - trayH - 4);
            }
            return GLib.SOURCE_REMOVE;
        });

        this._splitControlTrayTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONTROL_TRAY_TIMEOUT_MS, () => {
            this._splitControlTrayTimeoutId = 0;
            this._destroyControlTray();
            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyControlTray() {
        if (this._splitControlTrayTimeoutId) {
            GLib.source_remove(this._splitControlTrayTimeoutId);
            this._splitControlTrayTimeoutId = 0;
        }
        if (this._splitControlTray) {
            Main.layoutManager.removeChrome(this._splitControlTray);
            this._splitControlTray.destroy();
            this._splitControlTray = null;
        }
    }

    _resizeSplitWindows(ratio, bounds) {
        let gap = Math.round(DIVIDER_HEIGHT / 2);
        let horiz = this._splitState?.orientation === 'horizontal';

        if (horiz) {
            let primaryW = Math.round(bounds.width * ratio) - gap;
            let secondaryW = bounds.width - primaryW - DIVIDER_HEIGHT;
            let dividerX = bounds.x + primaryW;

            if (this._splitState.primaryWindow)
                this._splitState.primaryWindow.move_resize_frame(true, bounds.x, bounds.y, primaryW, bounds.height);
            if (this._splitState.secondaryWindow)
                this._splitState.secondaryWindow.move_resize_frame(true, dividerX + DIVIDER_HEIGHT, bounds.y, secondaryW, bounds.height);
            if (this._splitDivider)
                this._splitDivider.x = dividerX;
        } else {
            let primaryH = Math.round(bounds.height * ratio) - gap;
            let secondaryH = bounds.height - primaryH - DIVIDER_HEIGHT;
            let dividerY = bounds.y + primaryH;

            if (this._splitState.primaryWindow)
                this._splitState.primaryWindow.move_resize_frame(true, bounds.x, bounds.y, bounds.width, primaryH);
            if (this._splitState.secondaryWindow)
                this._splitState.secondaryWindow.move_resize_frame(true, bounds.x, dividerY + DIVIDER_HEIGHT, bounds.width, secondaryH);
            if (this._splitDivider)
                this._splitDivider.y = dividerY;
        }
    }

    _exitSplitScreen(activateWindow = null) {
        let phoneMonitorIndex = Number.isInteger(this._splitMonitorIndex)
            ? this._splitMonitorIndex
            : this._getPhoneMonitorIndex();
        if (this._splitFocusWatchId) {
            global.display.disconnect(this._splitFocusWatchId);
            this._splitFocusWatchId = 0;
        }
        this._unwatchSplitWindowClose();
        this._destroyControlTray();
        this._destroySplitDivider();
        let ps = this._controller.phoneWindowStack;
        if (ps?.hasSplitWindows?.(phoneMonitorIndex))
            ps.exitSplitMode(phoneMonitorIndex);
        this._splitState = null;
        this._splitOrientation = null;
        this._splitMonitorIndex = null;
        this._splitFirstWindow = null;
        this._splitFirstPosition = null;
        if (activateWindow && ps)
            ps.activateWindow(activateWindow, phoneMonitorIndex);
    }

    _destroySplitDivider() {
        if (this._splitDivider) {
            Main.layoutManager.removeChrome(this._splitDivider);
            this._splitDivider.destroy();
            this._splitDivider = null;
        }
    }

    setMonitorIndex(monitorIndex = null) {
        this._monitorIndex = Number.isInteger(monitorIndex) ? monitorIndex : null;
        if (!this.isVisible)
            return;

        this.hide(true, { skipHomeRestore: true });
        this.show();
    }

    relayout() {
        if (!this.isVisible)
            return;

        let wasPreparedFromHome = this._preparedFromHome;
        let wasPrepared = this._prepared && !wasPreparedFromHome;
        this.hide(true, { skipHomeRestore: true });

        if (wasPreparedFromHome)
            this.prepareFromHome();
        else if (wasPrepared)
            this.prepareFromApp();
        else
            this.show();
    }

    refreshTopology(monitorIndex = null) {
        if (this._splitState) {
            this._rotateSplitScreen(monitorIndex);
        } else {
            this._exitSplitScreen();
        }
        this.setMonitorIndex(monitorIndex);
    }

    _rotateSplitScreen(monitorIndex = null) {
        let state = this._splitState;
        if (!state) return;

        // Verify both windows still exist
        let pw = state.primaryWindow;
        let sw = state.secondaryWindow;
        if (!pw?.get_compositor_private?.() || !sw?.get_compositor_private?.()) {
            this._exitSplitScreen();
            return;
        }

        this._destroyControlTray();
        this._destroySplitDivider();

        if (Number.isInteger(monitorIndex))
            this._splitMonitorIndex = monitorIndex;
        this._splitOrientation = this._getSplitOrientation();
        state.orientation = this._splitOrientation;

        let bounds = this._getSplitBounds();
        this._resizeSplitWindows(state.ratio, bounds);
        this._buildSplitDivider();
    }

    destroy() {
        this._stopMemoryUpdateTimer();
        this._exitSplitScreen();
        this.hide(true);
    }
}
