// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford
//
// Convergence Keyboard — patches the built-in GNOME OSK to provide a
// Futo-style phone keyboard experience while preserving native input
// privileges (modal dialogs, GDM, polkit, WiFi passwords).
//
// All CSS px values auto-scale with St.ThemeContext.scale_factor.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Futo dark theme palette
const C = {
    bg:          '#121316',
    key:         '#252830',
    keyFunc:     '#17181C',
    keyPress:    '#3C3F47',
    text:        '#E6E6EE',
    textDim:     'rgba(230, 230, 238, 0.7)',
    textHint:    'rgba(230, 230, 238, 0.5)',
    accent:      '#8AB4F8',
    accentText:  '#202124',
    spaceBg:     '#17181C',
    spaceText:   'rgba(230, 230, 238, 0.5)',
    suggest:     '#121316',
    dismissBg:   '#0D0D0F',
};

const SUGGEST_HEIGHT = 40;
const DISMISS_HEIGHT = 64;
// Futo 5-row — tuned to 424px on OP6 (1140px screen = 37.2%).
// Use a fixed screen ratio so the keyboard takes the same visual
// proportion on all phones.
const KB_SCREEN_RATIO = 0.372;

export class ConvergenceKeyboard {
    constructor(controller, settings, extensionPath) {
        this._controller = controller;
        this._settings = settings ?? null;
        this._extensionPath = extensionPath;
        this._patched = false;
        this._origStyles = new Map();
        this._hiddenKeys = [];
        this._hintLabels = [];
        this._deferTimerId = 0;
        this._customResource = null;

        this._registerCustomLayout();
        try { this._patchTouchMode(); } catch (_e) {}
        try { this._setupInputMethodBridge(); } catch (_e) {}
        this._apply();
    }

    // ── Touch-mode override ─────────────────────────────────────────
    //
    // On phones the touchscreen is always the primary input device.
    // GNOME Shell's KeyboardManager only auto-shows the OSK when
    // _lastDeviceIsTouchscreen() returns true, but hardware buttons
    // (power, volume) register as 'kbd' and can reset this flag.
    // Override it to always return true so the OSK reliably appears.

    _patchTouchMode() {
        let kbManager = Main.keyboard;
        if (!kbManager) return;

        this._origLastDeviceIsTouchscreen =
            kbManager._lastDeviceIsTouchscreen?.bind(kbManager);
        if (this._origLastDeviceIsTouchscreen)
            kbManager._lastDeviceIsTouchscreen = () => true;

        try { kbManager._syncEnabled?.(); } catch (_e) {}
    }

    _restoreTouchMode() {
        if (this._origLastDeviceIsTouchscreen) {
            let kbManager = Main.keyboard;
            if (kbManager)
                kbManager._lastDeviceIsTouchscreen = this._origLastDeviceIsTouchscreen;
            this._origLastDeviceIsTouchscreen = null;
        }
    }

    // ── Wayland text-input-v3 → OSK bridge ──────────────────────────
    //
    // Chromium/Electron apps send zwp_text_input_v3.enable() when a
    // text field is focused, but GNOME Shell's _onKeyFocusChanged only
    // opens the OSK for Clutter.Text actors (internal widgets).
    // Wayland text-input focus goes through ClutterInputMethod instead.
    //
    // We bridge this gap by watching Main.inputMethod for focus changes
    // and calling Main.keyboard.open() when a Wayland client activates
    // text-input. This makes the OSK appear for Brave, Chrome, Electron
    // and any other app using the Wayland text-input protocol.

    _setupInputMethodBridge() {
        this._imSignals = [];

        let im = Main.inputMethod;
        if (!im) return;

        // cursor-location-changed fires when a Wayland client sends
        // set_cursor_rectangle after enable+commit.
        try {
            let id1 = im.connect('cursor-location-changed', () => {
                try {
                    Main.keyboard?.open(Main.layoutManager.focusIndex);
                } catch (_e) {}
            });
            this._imSignals.push({ obj: im, id: id1 });
        } catch (_e) {}

        // surrounding-text-set fires when a Wayland client sends
        // set_surrounding_text.
        try {
            let id2 = im.connect('surrounding-text-set', () => {
                try {
                    Main.keyboard?.open(Main.layoutManager.focusIndex);
                } catch (_e) {}
            });
            this._imSignals.push({ obj: im, id: id2 });
        } catch (_e) {}
    }

    _teardownInputMethodBridge() {
        if (!this._imSignals) return;
        for (let entry of this._imSignals) {
            try {
                entry.obj?.disconnect(entry.id);
            } catch (_e) {}
        }
        this._imSignals = [];
    }

    // ── Custom layout GResource ──────────────────────────────────────

    _registerCustomLayout() {
        try {
            let resPath = GLib.build_filenamev([
                this._extensionPath,
                'src', 'phone', 'keyboard',
                'convergence-osk-layouts.gresource',
            ]);
            this._customResource = Gio.Resource.load(resPath);
            Gio.resources_register(this._customResource);
            console.log(`[Convergence:Keyboard] custom GResource registered from ${resPath}`);
        } catch (e) {
            console.log(`[Convergence:Keyboard] custom layout not loaded: ${e.message}`);
        }

        // On gnome-shell-mobile 48 the built-in layouts compiled into the
        // binary take priority over our registered GResource.  Fall back to
        // loading our JSON layouts directly from the extension directory.
        this._layoutOverrides = new Map();
        try {
            let layoutDir = GLib.build_filenamev([
                this._extensionPath, 'src', 'phone', 'keyboard',
            ]);
            let dir = Gio.File.new_for_path(layoutDir);
            let enumerator = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                // Match files like us-mobileOSK.json → overrides "us"
                let m = name.match(/^(.+)-mobile\.json$/);
                if (!m) continue;
                let layoutName = m[1];
                let [ok, contents] = GLib.file_get_contents(
                    GLib.build_filenamev([layoutDir, name]));
                if (ok && contents) {
                    this._layoutOverrides.set(layoutName,
                        JSON.parse(new TextDecoder().decode(contents)));
                }
            }
            enumerator.close(null);
            if (this._layoutOverrides.size > 0)
                console.log(`[Convergence:Keyboard] layout overrides loaded: ${[...this._layoutOverrides.keys()].join(', ')}`);
        } catch (_e) {}
    }

    // ── Lazy patching ────────────────────────────────────────────────

    _apply() {
        if (this._patched) return;

        // Install the open() wrapper immediately so the first real OSK
        // launch gets patched in the same call path instead of rendering
        // one frame of GNOME's stock keyboard first.
        let kbManager = Main.keyboard;
        if (kbManager?.open && !this._origManagerOpen) {
            this._origManagerOpen = kbManager.open.bind(kbManager);
            kbManager.open = (...args) => {
                // Pin to phone monitor before GNOME opens/positions
                this._repositionKeyboardToPhone();
                this._origManagerOpen(...args);
                // Re-pin after GNOME's positioning logic runs
                this._repositionKeyboardToPhone();
                let k = kbManager._keyboard;
                if (k && !this._patched)
                    this._patchKeyboard(k);
            };
        }

        // Apply the CSS class as early as possible so that keys created
        // by GNOME inherit our stylesheet rules before we even patch.
        this._deferTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            let k = Main.keyboard?._keyboard;
            if (k) {
                // Add CSS class immediately — keys created after this
                // point will pick up our stylesheet rules automatically.
                if (!k.has_style_class_name('convergence-osk'))
                    k.add_style_class_name('convergence-osk');

                if (!this._patched) {
                    this._patchKeyboard(k);
                    this._deferTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ── Core patching ────────────────────────────────────────────────

    _patchKeyboard(kb) {
        if (this._patched) return;
        this._patched = true;
        this._kb = kb;
        this._keyboardBox = Main.layoutManager?.keyboardBox;

        // Pin OSK to the phone's built-in monitor so it never appears
        // on an external desktop display.
        this._pinKeyboardToPhoneMonitor();

        // Capture GNOME's default height before we change anything
        this._gnomeDefaultH = kb.height; // typically 285

        this._discoverStructure(kb);

        console.log(`[Convergence:Keyboard] patching: gnomeDefaultH=${this._gnomeDefaultH} ` +
            `keyContainers=${this._keyContainers.length} rows=${kb.get_n_children()}`);

        // Hide gnome-shell-mobile's bottom panel bar injected inside the keyboard
        if (kb._bottomPanelBox) {
            kb._bottomPanelBox.visible = false;
            kb._bottomPanelBox.height = 0;
        }

        // Override keyboard layout models with our custom mobileOSK layouts
        this._applyLayoutOverrides(kb);

        this._setupHeightEnforcement(kb);
        this._applyKeyboardStyle(kb);
        this._applyAllKeyStyles(kb);

        // Hook GNOME's _setActiveLevel to apply visual styles synchronously
        // right after a layout rebuild, before the keyboard is painted.
        // This only applies CSS — the full setup (haptics, spacebar swipe,
        // hints, etc.) is handled by the poll below.
        if (kb._setActiveLevel && !this._origSetActiveLevel) {
            this._origSetActiveLevel = kb._setActiveLevel.bind(kb);
            kb._setActiveLevel = (...args) => {
                this._origSetActiveLevel(...args);
                try {
                    this._discoverStructure(kb);
                    if (this._keyContainers.length > 0)
                        this._applyKeyStyles();
                } catch (_e) {}
            };
        }

        // Poll handles the full setup (haptics, spacebar swipe, hints,
        // dismiss bar) which is too heavy for the synchronous hook.
        // Also catches any edge cases the hook misses.
        this._keyStylePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (!this._kb) {
                this._keyStylePollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (!kb.visible)
                return GLib.SOURCE_CONTINUE;
            try {
                this._discoverStructure(kb);
                if (this._keyContainers.length === 0)
                    return GLib.SOURCE_CONTINUE;
                if (this._needsRestyle())
                    this._applyAllKeyStyles(kb);
            } catch (_e) {}
            return GLib.SOURCE_CONTINUE;
        });
        this._keyStyleCheckIds = [];
    }

    _needsRestyle() {
        // Stale spacebar reference means GNOME rebuilt the keys
        if (this._spacebarKey && !this._spacebarKey.get_stage?.())
            return true;

        let firstKc = this._keyContainers[this._keyContainers.length - 1];
        if (!firstKc) return false;
        let firstKey = firstKc.get_child_at_index(0);
        if (!firstKey) return false;
        for (let j = 0; j < (firstKey.get_n_children?.() ?? 0); j++) {
            let child = firstKey.get_child_at_index(j);
            if (child?.style_class?.includes('keyboard-key'))
                return !(child.get_style() || '').includes(C.key);
        }
        return false;
    }

    /**
     * Hook GNOME's layout loading so our custom mobileOSK layouts are used
     * instead of the built-in ones.  On gnome-shell-mobile 48 the
     * GResource override doesn't take priority over built-in resources,
     * so we intercept _createLayersForGroup to inject our JSON.
     */
    /**
     * Hook layout loading so custom mobileOSK layouts take priority.
     * On upstream GNOME 49/50 the GResource override works directly.
     * On gnome-shell-mobile 48 the keyboard API differs (_groups and
     * _createLayersForGroup don't exist) — the custom GResource must
     * be installed on disk instead (see deployment notes).
     */
    _applyLayoutOverrides(kb) {
        if (!this._layoutOverrides?.size) return;
        if (!kb._createLayersForGroup || !kb._groups) return;
        if (this._origCreateLayersForGroup) return;

        this._origCreateLayersForGroup = kb._createLayersForGroup.bind(kb);
        let overrides = this._layoutOverrides;

        kb._createLayersForGroup = (groupName) => {
            let override = overrides.get(groupName)
                ?? overrides.get(groupName.replace(/\+.*/, ''));
            if (override) {
                let origLookup = Gio.resources_lookup_data;
                Gio.resources_lookup_data = (path, flags) => {
                    if (path.includes('/osk-layouts/')) {
                        let name = path.split('/').pop().replace('.json', '');
                        let match = overrides.get(name)
                            ?? overrides.get(name.replace(/\+.*/, ''));
                        if (match) {
                            let json = JSON.stringify(match);
                            return new GLib.Bytes(new TextEncoder().encode(json));
                        }
                    }
                    return origLookup(path, flags);
                };
                try {
                    delete kb._groups[groupName];
                    return this._origCreateLayersForGroup(groupName);
                } finally {
                    Gio.resources_lookup_data = origLookup;
                }
            }
            return this._origCreateLayersForGroup(groupName);
        };

        // Force rebuild with overridden layouts
        try { kb._onKeyboardGroupsChanged(); } catch (_e) {}
    }

    _discoverStructure(kb) {
        this._suggestions = null;
        this._aspectContainer = null;
        this._keyContainers = [];

        for (let i = 0; i < kb.get_n_children(); i++) {
            let child = kb.get_child_at_index(i);
            let sc = child.style_class || '';
            let name = child.constructor?.name || '';
            if (sc.includes('word-suggestions') || name === 'Suggestions')
                this._suggestions = child;
            if (name === 'AspectContainer')
                this._aspectContainer = child;
        }

        if (this._aspectContainer) {
            for (let i = 0; i < this._aspectContainer.get_n_children(); i++) {
                let child = this._aspectContainer.get_child_at_index(i);
                for (let j = 0; j < (child.get_n_children?.() ?? 0); j++) {
                    let kc = child.get_child_at_index(j);
                    if (kc?.constructor?.name === 'KeyContainer')
                        this._keyContainers.push(kc);
                }
            }
        }
    }

    // ── Height enforcement ───────────────────────────────────────────
    //
    // Tested approach: kb.set_height(targetH) works — the keyboardBox
    // follows automatically. We shift kbBox up with translation_y.
    // Must re-apply on every show since GNOME resets kb.height.

    _setupHeightEnforcement(kb) {
        let phoneIdx = this._controller?.getPhoneMonitorIndex?.();
        let phoneMon = Number.isInteger(phoneIdx) && phoneIdx >= 0
            ? global.display.get_monitor_geometry(phoneIdx) : null;
        let screenH = phoneMon?.height ?? global.stage.height;
        let screenW = phoneMon?.width ?? global.stage.width;
        this._targetKbH = Math.round(screenH * KB_SCREEN_RATIO);
        let targetH = this._targetKbH;

        // Hook _relayout — upstream GNOME sets this.height to
        // monitor.height/4 (portrait) or /3 (landscape). We override
        // it immediately after so _animateShow() sees our height.
        if (kb._relayout && !this._origRelayout) {
            this._origRelayout = kb._relayout.bind(kb);
            kb._relayout = (...args) => {
                this._origRelayout(...args);
                let h = this._suggestionsVisible === false
                    ? targetH - SUGGEST_HEIGHT : targetH;
                kb.set_height(h);
            };
        }

        // gnome-shell-mobile 48: _relayout is a stub and height is
        // controlled by vfunc_allocate.  Override vfunc_allocate to
        // enforce our target height.
        if (!this._origVfuncAllocate) {
            let origAllocate = kb.vfunc_allocate?.bind(kb);
            if (origAllocate) {
                this._origVfuncAllocate = origAllocate;
                kb.vfunc_allocate = (box) => {
                    let h = this._suggestionsVisible === false
                        ? targetH - SUGGEST_HEIGHT : targetH;
                    box.y1 = box.y2 - h;
                    // Force full screen width so AspectContainer doesn't
                    // narrow the keyboard when we increase the height
                    box.x1 = 0;
                    box.x2 = screenW;
                    origAllocate(box);
                };
            }
        }
    }

    // ── Phone-monitor pinning ───────────────────────────────────────
    //
    // GNOME places the OSK on whichever monitor has the focused window.
    // In convergence mode that means the keyboard can appear on the
    // external desktop display.  Override _keyboardIndex so the OSK
    // always renders on the phone's built-in monitor.

    _pinKeyboardToPhoneMonitor() {
        let lm = Main.layoutManager;
        if (!lm)
            return;

        // Strategy 1: override _updateKeyboardBox if it exists
        // (standard GNOME Shell)
        if (lm._updateKeyboardBox && !this._origUpdateKeyboardBox) {
            this._origUpdateKeyboardBox = lm._updateKeyboardBox.bind(lm);
            lm._updateKeyboardBox = () => {
                let phoneIdx = this._controller?.getPhoneMonitorIndex?.();
                if (Number.isInteger(phoneIdx) && phoneIdx >= 0)
                    lm._keyboardIndex = phoneIdx;
                this._origUpdateKeyboardBox();
            };
        }

        // Strategy 2: forcibly reposition keyboardBox to the phone
        // monitor whenever it becomes visible (works even if
        // _updateKeyboardBox is missing or compiled differently in
        // gnome-shell-mobile).
        let kbBox = lm.keyboardBox;
        if (kbBox && !this._kbBoxVisibleId) {
            this._kbBoxVisibleId = kbBox.connect('notify::visible', () => {
                if (kbBox.visible)
                    this._repositionKeyboardToPhone();
            });
        }

        // Also hook the keyboard actor's show signal as a fallback
        if (this._kb && !this._kbShowId) {
            this._kbShowId = this._kb.connect('show', () => {
                this._repositionKeyboardToPhone();
            });
        }
    }

    _repositionKeyboardToPhone() {
        let phoneIdx = this._controller?.getPhoneMonitorIndex?.();
        if (!Number.isInteger(phoneIdx) || phoneIdx < 0)
            return;

        let lm = Main.layoutManager;
        let kbBox = lm?.keyboardBox;
        if (!kbBox)
            return;

        // Force the internal index so GNOME's own repositioning
        // logic targets the phone monitor on subsequent calls.
        if ('_keyboardIndex' in lm)
            lm._keyboardIndex = phoneIdx;

        let phoneMon = lm.monitors?.[phoneIdx];
        if (!phoneMon)
            return;

        // Position keyboardBox at the bottom of the phone monitor
        kbBox.set_position(phoneMon.x, phoneMon.y + phoneMon.height);
        kbBox.set_size(phoneMon.width, -1);
    }

    _unpinKeyboardFromPhoneMonitor() {
        if (this._origUpdateKeyboardBox) {
            let lm = Main.layoutManager;
            if (lm)
                lm._updateKeyboardBox = this._origUpdateKeyboardBox;
            this._origUpdateKeyboardBox = null;
        }
        if (this._kbBoxVisibleId) {
            Main.layoutManager?.keyboardBox?.disconnect(this._kbBoxVisibleId);
            this._kbBoxVisibleId = 0;
        }
        if (this._kbShowId && this._kb) {
            this._kb.disconnect(this._kbShowId);
            this._kbShowId = 0;
        }
    }

    // ── Keyboard-level styling ───────────────────────────────────────

    _applyKeyboardStyle(kb) {
        this._origStyles.set(kb, kb.get_style() || '');
        kb.add_style_class_name('convergence-osk');
        kb.set_style(`background-color: ${C.bg}; padding: 4px 2px 0 2px;`);

        // Force AspectContainer to fill expanded height
        if (this._aspectContainer) {
            if (this._aspectContainer.get_style) {
                this._origStyles.set(this._aspectContainer,
                    this._aspectContainer.get_style() || '');
                this._aspectContainer.set_style('background-color: transparent;');
            }
            this._aspectContainer.y_expand = true;
            this._aspectContainer.x_expand = true;

            for (let i = 0; i < this._aspectContainer.get_n_children(); i++) {
                let child = this._aspectContainer.get_child_at_index(i);
                if (child?.constructor?.name !== 'EmojiSelection' && child?.set_style) {
                    this._origStyles.set(child, child.get_style?.() || '');
                    child.set_style('background-color: transparent;');
                }
                if (child) {
                    child.y_expand = true;
                    child.x_expand = true;
                }
            }
        }
    }

    _applyAllKeyStyles(kb) {
        // Clean up previous styling before re-applying
        // (needed when GNOME rebuilds key containers)
        for (let label of (this._hintLabels ?? []))
            label.destroy();
        this._hintLabels = [];

        if (this._hapticEventId && this._kb) {
            this._kb.disconnect(this._hapticEventId);
            this._hapticEventId = 0;
        }
        if (this._previewEventId && this._kb) {
            this._kb.disconnect(this._previewEventId);
            this._previewEventId = 0;
        }
        if (this._previewPopup) {
            Main.layoutManager.removeChrome(this._previewPopup);
            this._previewPopup.destroy();
            this._previewPopup = null;
        }
        if (this._suggestEventId && this._kb) {
            this._kb.disconnect(this._suggestEventId);
            this._suggestEventId = 0;
        }
        if (this._spaceSwipeId && this._kb) {
            this._kb.disconnect(this._spaceSwipeId);
            this._spaceSwipeId = 0;
            this._spacebarKey = null;
        }
        // Restore original commit
        if (this._origCommit && this._kb?._keyboardController)
            this._kb._keyboardController.commit = this._origCommit;
        this._origCommit = null;
        this._ctrlActive = false;
        this._ctrlBtn = null;
        if (this._dismissBar) {
            this._dismissBar.destroy();
            this._dismissBar = null;
        }

        for (let key of (this._hiddenKeys ?? []))
            key.show();
        this._hiddenKeys = [];

        this._origStyles.clear();

        // Re-apply everything
        this._applyKeyStyles();
        this._addKeyHints();
        this._connectHaptics();
        this._setupKeyPreview();
        this._setupSpacebarSwipe();
        this._setupSuggestionEngine();
        this._enhanceSuggestions();
        this._addDismissBar(kb);
    }

    // ── Key styling ──────────────────────────────────────────────────

    _applyKeyStyles() {
        // All sizes tuned at 424px reference height (OP6).
        // Scale proportionally to the actual keyboard height.
        this._ks = (this._targetKbH || 424) / 424;
        let ks = this._ks;
        let hGap = Math.max(1, Math.round(3 * ks));
        let vGap = Math.max(1, Math.round(2 * ks));

        let letterFontSize = Math.round(23 * ks);
        let labelFontSize = Math.round(11 * ks);
        let numRowFontSize = Math.round(21 * ks);
        let borderRadius = Math.round(8 * ks);

        const baseStyle = (bg, color, fontSize, radius = borderRadius) =>
            `background-color: ${bg}; ` +
            `border-radius: ${radius}px; ` +
            `border: none; ` +
            `color: ${color}; ` +
            `font-size: ${fontSize}px; ` +
            `font-weight: 400; ` +
            `margin: ${vGap}px ${hGap}px;`;

        const letterStyle   = baseStyle(C.key, C.text, letterFontSize);
        const numRowStyle   = baseStyle(C.key, C.text, numRowFontSize);
        const specialStyle  = baseStyle(C.keyFunc, C.textDim, labelFontSize);
        const shiftActiveStyle = baseStyle(C.accent, C.accentText, labelFontSize) +
            'font-weight: 500;';
        this._shiftBtns = [];
        this._specialStyle = specialStyle;
        this._shiftActiveStyle = shiftActiveStyle;
        const enterStyle    = baseStyle(C.accent, C.accentText, letterFontSize) +
            'font-weight: 500;';
        const spaceStyle    = baseStyle(C.spaceBg, C.spaceText, labelFontSize, 9);
        const keyContainerStyle =
            'background-color: transparent; border: none; padding: 0; margin: 0;';

        for (let kc of this._keyContainers) {
            if (kc.set_style) {
                this._origStyles.set(kc, kc.get_style?.() || '');
                kc.set_style('background-color: transparent; padding: 2px 0;');
            }

            for (let i = 0; i < kc.get_n_children(); i++) {
                let key = kc.get_child_at_index(i);
                if (!key) continue;

                if (key.get_style) {
                    this._origStyles.set(key, key.get_style() || '');
                    key.set_style(keyContainerStyle);
                }

                let btn = null;
                let iconName = null;
                let isSpace = false;
                let keyLabel = null;

                // Check commit string for space — reliable even before
                // layout allocation (unlike width/height ratio checks).
                let commitStr = key._strings?.[0] ?? key._key?.strings?.[0] ?? null;
                if (commitStr === ' ')
                    isSpace = true;

                for (let j = 0; j < (key.get_n_children?.() ?? 0); j++) {
                    let child = key.get_child_at_index(j);
                    if (child?.style_class?.includes('keyboard-key')) {
                        btn = child;
                        for (let k = 0; k < (child.get_n_children?.() ?? 0); k++) {
                            let inner = child.get_child_at_index(k);
                            if (inner?.icon_name) iconName = inner.icon_name;
                            if (inner?.text) keyLabel = inner.text;
                            if (inner?.text === ' ') isSpace = true;
                        }
                    }
                }

                if (iconName === 'osk-hide-symbolic') {
                    this._hiddenKeys.push(key);
                    key.hide();
                    continue;
                }

                if (!btn) continue;
                this._origStyles.set(btn, btn.get_style() || '');

                let isNumRow = keyLabel && /^[0-9]$/.test(keyLabel);
                let isShift = iconName === 'osk-shift-symbolic';
                if (isShift) this._shiftBtns.push(btn);

                if (iconName === 'osk-enter-symbolic') {
                    btn.add_style_class_name('convergence-osk-enter');
                    btn.set_style(enterStyle);
                } else if (isSpace) {
                    btn.add_style_class_name('convergence-osk-space');
                    btn.set_style(spaceStyle);
                } else if (iconName) {
                    btn.add_style_class_name('convergence-osk-func');
                    btn.set_style(specialStyle);
                }
                else if (isNumRow)
                    btn.set_style(numRowStyle);
                else
                    btn.set_style(letterStyle);
            }
        }
    }

    // ── Key hints ────────────────────────────────────────────────────

    _addKeyHints() {
        for (let kc of this._keyContainers) {
            for (let i = 0; i < kc.get_n_children(); i++) {
                let key = kc.get_child_at_index(i);
                if (!key) continue;

                let strings = key._strings ?? key._key?.strings ?? null;
                if (!strings) {
                    for (let prop of ['_keys', 'keyStrings', '_commitStrings']) {
                        if (key[prop]?.length > 1) { strings = key[prop]; break; }
                    }
                }
                if (!strings || strings.length < 2) continue;

                let hint = strings[1];
                if (!hint || hint.length > 2) continue;

                let hintLabel = new St.Label({
                    text: hint,
                    style_class: 'convergence-osk-hint',
                    reactive: false,
                });
                hintLabel.set_style(
                    `color: ${C.textHint}; font-size: ${Math.round(8 * ks)}px; font-weight: 400; padding: ${Math.round(1 * ks)}px ${Math.round(3 * ks)}px 0 0;`);
                key.add_child(hintLabel);
                hintLabel.set_position(key.width - hintLabel.width - 3, 2);
                this._hintLabels.push(hintLabel);
            }
        }
    }

    // ── Haptic feedback ──────────────────────────────────────────────

    _connectHaptics() {
        // Haptics are triggered from the combined preview+haptics handler
        // below to avoid a duplicate get_actor_at_pos call per keypress.
        this._hapticEventId = 0;
    }

    // ── Key press preview popup + haptics ────────────────────────────

    _setupKeyPreview() {
        let ks = this._ks ?? 1;
        this._previewPopup = new St.Label({
            style_class: 'convergence-osk-preview',
            visible: false,
        });
        this._previewPopup.set_style(
            `background-color: ${C.keyPress}; color: ${C.text}; ` +
            `font-size: ${Math.round(22 * ks)}px; font-weight: 400; border-radius: ${Math.round(9 * ks)}px; ` +
            `padding: ${Math.round(8 * ks)}px ${Math.round(14 * ks)}px; text-align: center; min-width: ${Math.round(40 * ks)}px; min-height: ${Math.round(36 * ks)}px;`);
        Main.layoutManager.addTopChrome(this._previewPopup);

        let haptics = this._controller?.haptics;

        this._previewEventId = this._kb.connect('captured-event', (_actor, event) => {
            let type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN ||
                type === Clutter.EventType.BUTTON_PRESS) {
                let [x, y] = event.get_coords();
                let source = global.stage.get_actor_at_pos(
                    Clutter.PickMode.REACTIVE, x, y);
                let btn = source;
                while (btn && !btn.style_class?.includes('keyboard-key'))
                    btn = btn.get_parent();
                if (btn) {
                    // Haptic buzz for actual key presses only
                    haptics?.keypressBuzz();

                    let label = null;
                    for (let i = 0; i < (btn.get_n_children?.() ?? 0); i++) {
                        let c = btn.get_child_at_index(i);
                        if (c?.text && c.text.trim().length === 1) label = c.text;
                    }
                    if (label) {
                        this._previewPopup.text = label;
                        let [bx, by] = btn.get_transformed_position();
                        let bw = btn.width;
                        let pw = this._previewPopup.width || 40;
                        this._previewPopup.set_position(
                            Math.round(bx + bw / 2 - pw / 2),
                            Math.round(by - 50));
                        this._previewPopup.show();
                    }
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.BUTTON_RELEASE) {
                this._previewPopup.hide();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ── Spacebar swipe cursor movement ─────────────────────────────

    /**
     * Detect horizontal swipes on the spacebar and move the cursor
     * left/right, replicating Android OSK behavior.
     */
    _setupSpacebarSwipe() {
        this._spaceSwipeActive = false;
        this._spaceSwipeStartX = 0;
        this._spaceSwipeStartY = 0;
        this._spaceSwipeLastX = 0;
        this._spaceSwipeLastY = 0;
        this._spaceSwipeMovedX = 0;
        this._spaceSwipeMovedY = 0;
        this._spaceSwipeOnSpace = false;

        const SWIPE_THRESHOLD = 15;
        const PX_PER_STEP_H = 20;
        const PX_PER_STEP_V = 30; // vertical needs more travel (fewer lines)

        // Find the spacebar by looking for the key that commits a space
        this._spacebarKey = null;
        for (let kc of this._keyContainers) {
            for (let i = 0; i < kc.get_n_children(); i++) {
                let key = kc.get_child_at_index(i);
                if (!key) continue;
                // Check if this key's button has a space label or
                // if the key's strings contain a space
                let hasSpace = key._strings?.[0] === ' ' ||
                    key._key?.strings?.[0] === ' ';
                if (!hasSpace) {
                    for (let j = 0; j < (key.get_n_children?.() ?? 0); j++) {
                        let child = key.get_child_at_index(j);
                        if (child?.style_class?.includes('keyboard-key')) {
                            for (let k = 0; k < (child.get_n_children?.() ?? 0); k++) {
                                let inner = child.get_child_at_index(k);
                                if (inner?.text === ' ') hasSpace = true;
                            }
                        }
                    }
                }
                if (hasSpace) {
                    this._spacebarKey = key;
                    break;
                }
            }
            if (this._spacebarKey) break;
        }

        if (!this._spacebarKey) {
            console.log('[Convergence:Keyboard] spacebar not found!');
            return;
        }
        console.log(`[Convergence:Keyboard] spacebar found: ${this._spacebarKey.width}x${this._spacebarKey.height}`);

        // Use captured-event on the keyboard itself to get all
        // touch events including TOUCH_UPDATE which individual
        // buttons may not receive
        this._spaceSwipeId = this._kb.connect('captured-event', (_actor, event) => {
            let type = event.type();

            if (type === Clutter.EventType.TOUCH_BEGIN ||
                type === Clutter.EventType.BUTTON_PRESS) {
                // Check if touch started on the spacebar
                if (!this._spacebarKey?.get_stage?.()) {
                    this._spaceSwipeOnSpace = false;
                    return Clutter.EVENT_PROPAGATE;
                }
                let [x, y] = event.get_coords();
                let [sx, sy] = this._spacebarKey.get_transformed_position();
                let sw = this._spacebarKey.width;
                let sh = this._spacebarKey.height;

                if (sw <= 0 || sh <= 0 || !isFinite(sw) || !isFinite(sh)) {
                    this._spaceSwipeOnSpace = false;
                    return Clutter.EVENT_PROPAGATE;
                }

                if (x >= sx && x <= sx + sw && y >= sy && y <= sy + sh) {
                    this._spaceSwipeOnSpace = true;
                    this._spaceSwipeStartX = x;
                    this._spaceSwipeStartY = y;
                    this._spaceSwipeLastX = x;
                    this._spaceSwipeLastY = y;
                    this._spaceSwipeMovedX = 0;
                    this._spaceSwipeMovedY = 0;
                    this._spaceSwipeActive = false;
                } else {
                    this._spaceSwipeOnSpace = false;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (!this._spaceSwipeOnSpace)
                return Clutter.EVENT_PROPAGATE;

            if (type === Clutter.EventType.TOUCH_UPDATE ||
                type === Clutter.EventType.MOTION) {
                let [x, y] = event.get_coords();
                let totalDx = x - this._spaceSwipeStartX;
                let totalDy = y - this._spaceSwipeStartY;

                if (!this._spaceSwipeActive) {
                    if (Math.abs(totalDx) > SWIPE_THRESHOLD ||
                        Math.abs(totalDy) > SWIPE_THRESHOLD)
                        this._spaceSwipeActive = true;
                    else
                        return Clutter.EVENT_PROPAGATE;
                }

                let dx = x - this._spaceSwipeLastX;
                let dy = y - this._spaceSwipeLastY;
                this._spaceSwipeMovedX += dx;
                this._spaceSwipeMovedY += dy;

                let kbCtrl = this._kb?._keyboardController;
                if (kbCtrl) {
                    // Horizontal: Left/Right
                    while (this._spaceSwipeMovedX >= PX_PER_STEP_H) {
                        kbCtrl.keyvalPress(0xff53); // XK_Right
                        kbCtrl.keyvalRelease(0xff53);
                        this._spaceSwipeMovedX -= PX_PER_STEP_H;
                        this._controller?.haptics?.keypressBuzz();
                    }
                    while (this._spaceSwipeMovedX <= -PX_PER_STEP_H) {
                        kbCtrl.keyvalPress(0xff51); // XK_Left
                        kbCtrl.keyvalRelease(0xff51);
                        this._spaceSwipeMovedX += PX_PER_STEP_H;
                        this._controller?.haptics?.keypressBuzz();
                    }
                    // Vertical: Up/Down
                    while (this._spaceSwipeMovedY >= PX_PER_STEP_V) {
                        kbCtrl.keyvalPress(0xff54); // XK_Down
                        kbCtrl.keyvalRelease(0xff54);
                        this._spaceSwipeMovedY -= PX_PER_STEP_V;
                        this._controller?.haptics?.keypressBuzz();
                    }
                    while (this._spaceSwipeMovedY <= -PX_PER_STEP_V) {
                        kbCtrl.keyvalPress(0xff52); // XK_Up
                        kbCtrl.keyvalRelease(0xff52);
                        this._spaceSwipeMovedY += PX_PER_STEP_V;
                        this._controller?.haptics?.keypressBuzz();
                    }
                }

                this._spaceSwipeLastX = x;
                this._spaceSwipeLastY = y;
                return Clutter.EVENT_STOP;
            }

            if (type === Clutter.EventType.TOUCH_END ||
                type === Clutter.EventType.BUTTON_RELEASE) {
                let wasSwipe = this._spaceSwipeActive;
                this._spaceSwipeActive = false;
                this._spaceSwipeOnSpace = false;
                this._spaceSwipeStartX = 0;
                if (wasSwipe)
                    return Clutter.EVENT_STOP;
                return Clutter.EVENT_PROPAGATE;
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ── Emoji pager swipe ──────────────────────────────────────────

    _setupEmojiSwipe() {
        if (this._emojiSwipeId && this._emojiSwipeTarget) {
            this._emojiSwipeTarget.disconnect(this._emojiSwipeId);
            this._emojiSwipeId = 0;
            this._emojiSwipeTarget = null;
        }

        // Find the EmojiPager in the keyboard hierarchy
        this._emojiPager = null;
        let findPager = (actor, depth) => {
            if (depth > 6) return;
            if (actor.constructor?.name === 'EmojiPager') {
                this._emojiPager = actor;
                return;
            }
            for (let i = 0; i < (actor.get_n_children?.() ?? 0); i++)
                findPager(actor.get_child_at_index(i), depth + 1);
        };
        findPager(this._kb, 0);

        if (!this._emojiPager) return;

        let tracking = false;
        let startX = 0;
        let handled = false;
        const SWIPE_DIST = 50;

        // Passively observe touch events to detect horizontal swipes.
        // We never manipulate the pager's delta property (which causes
        // SEGV crashes from rapid panel create/destroy cycles) — just
        // call setCurrentPage on swipe completion for a safe instant
        // page switch.
        this._emojiSwipeTarget = global.stage;
        this._emojiSwipeId = global.stage.connect('captured-event', (_actor, event) => {
            let type = event.type();

            if (!this._emojiPager?.visible)
                return Clutter.EVENT_PROPAGATE;

            if (type === Clutter.EventType.TOUCH_BEGIN ||
                type === Clutter.EventType.BUTTON_PRESS) {
                let [x, y] = event.get_coords();
                let [px, py] = this._emojiPager.get_transformed_position();
                let pw = this._emojiPager.width;
                let ph = this._emojiPager.height;

                tracking = (x >= px && x <= px + pw && y >= py && y <= py + ph);
                startX = x;
                handled = false;
                return Clutter.EVENT_PROPAGATE;
            }

            if (!tracking || handled)
                return Clutter.EVENT_PROPAGATE;

            if (type === Clutter.EventType.TOUCH_UPDATE ||
                type === Clutter.EventType.MOTION) {
                let [x] = event.get_coords();
                let dx = x - startX;

                if (Math.abs(dx) > SWIPE_DIST) {
                    handled = true;
                    let nPages = this._emojiPager._pages?.length ?? 1;
                    let cur = this._emojiPager._curPage ?? 0;
                    let targetPage = dx < 0
                        ? (cur + 1) % nPages
                        : (cur + nPages - 1) % nPages;
                    this._emojiPager.setCurrentPage(targetPage);
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (type === Clutter.EventType.TOUCH_END ||
                type === Clutter.EventType.BUTTON_RELEASE) {
                tracking = false;
                handled = false;
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ── Dictionary suggestion engine ─────────────────────────────────

    /**
     * Load the hunspell dictionary and set up keystroke tracking
     * to provide word suggestions as the user types.
     */
    _setupSuggestionEngine() {
        this._composingWord = '';

        // Only load dictionary once
        if (this._dictWords?.length > 0) return;
        this._dictWords = [];

        // Load dictionary asynchronously to avoid blocking the main thread
        this._dictPrefixMap = new Map();
        try {
            let dictPath = '/usr/share/hunspell/en_US.dic';
            let file = Gio.File.new_for_path(dictPath);
            file.load_contents_async(null, (f, res) => {
                try {
                    let [ok, contents] = f.load_contents_finish(res);
                    if (!ok) return;
                    let text = new TextDecoder().decode(contents);
                    let lines = text.split('\n');
                    let words = [];
                    for (let i = 1; i < lines.length; i++) {
                        let word = lines[i].split('/')[0].trim();
                        if (word.length > 1)
                            words.push(word.toLowerCase());
                    }
                    words.sort((a, b) => a.length - b.length);
                    // Build prefix map for O(1) lookup
                    for (let w of words) {
                        for (let len = 2; len <= Math.min(w.length, 8); len++) {
                            let prefix = w.substring(0, len);
                            let list = this._dictPrefixMap.get(prefix);
                            if (!list) {
                                list = [];
                                this._dictPrefixMap.set(prefix, list);
                            }
                            if (list.length < 5)
                                list.push(w);
                        }
                    }
                    this._dictWords = words;
                    console.log(`[Convergence:Keyboard] dictionary loaded: ${words.length} words, ${this._dictPrefixMap.size} prefixes`);
                } catch (e) {
                    console.log(`[Convergence:Keyboard] dictionary parse error: ${e.message}`);
                }
            });
        } catch (e) {
            console.log(`[Convergence:Keyboard] dictionary load error: ${e.message}`);
        }

        // Track keystrokes via captured-event on the keyboard
        this._suggestEventId = this._kb.connect('captured-event', (_actor, event) => {
            let type = event.type();
            if (type !== Clutter.EventType.TOUCH_BEGIN &&
                type !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;

            // Find which key was pressed
            let [x, y] = event.get_coords();
            let source = global.stage.get_actor_at_pos(
                Clutter.PickMode.REACTIVE, x, y);
            let btn = source;
            while (btn && !btn.style_class?.includes('keyboard-key'))
                btn = btn.get_parent();
            if (!btn) return Clutter.EVENT_PROPAGATE;

            // Find the character or action
            let char = null;
            let iconName = null;
            for (let i = 0; i < (btn.get_n_children?.() ?? 0); i++) {
                let c = btn.get_child_at_index(i);
                if (c?.text && c.text.length === 1) char = c.text;
                if (c?.icon_name) iconName = c.icon_name;
            }

            if (iconName === 'osk-delete-symbolic') {
                // Backspace — remove last char
                this._composingWord = this._composingWord.slice(0, -1);
                this._updateSuggestions();
            } else if (iconName === 'osk-enter-symbolic' || char === ' ') {
                // Space or enter — commit word and reset
                this._composingWord = '';
                this._updateSuggestions();
            } else if (char && /^[a-zA-Z']$/.test(char)) {
                // Letter — append to composing word
                this._composingWord += char.toLowerCase();
                this._updateSuggestions();
            } else if (char && /^[0-9.,!?;:\-]$/.test(char)) {
                // Punctuation/number — reset composing
                this._composingWord = '';
                this._updateSuggestions();
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    _updateSuggestions() {
        if (!this._suggestionSlots) return;

        let word = this._composingWord;
        let matches = [];

        if (word.length >= 2 && this._dictPrefixMap) {
            let key = word.substring(0, Math.min(word.length, 8));
            let candidates = this._dictPrefixMap.get(key) ?? [];
            for (let w of candidates) {
                if (w.startsWith(word) && w !== word) {
                    matches.push(w);
                    if (matches.length >= 3) break;
                }
            }
        }

        // Clear all slots
        for (let slot of this._suggestionSlots) {
            slot.label.set_text('');
            slot.word = null;
        }

        // Populate slots
        for (let i = 0; i < matches.length && i < 3; i++) {
            this._suggestionSlots[i].label.set_text(matches[i]);
            this._suggestionSlots[i].word = matches[i];
        }

        // Show/hide suggestion bar and adjust keyboard height
        this._setSuggestionsVisible(matches.length > 0);
    }

    _setSuggestionsVisible(visible) {
        if (!this._suggestions || !this._kb) return;
        if (this._suggestionsVisible === visible) return;
        this._suggestionsVisible = visible;

        let targetH = this._targetKbH || 424;
        let collapsedH = targetH - SUGGEST_HEIGHT;

        if (visible) {
            this._suggestions.show();
            this._kb.set_height(targetH);
            this._kb.translation_y = -targetH;
        } else {
            this._suggestions.hide();
            this._kb.set_height(collapsedH);
            this._kb.translation_y = -collapsedH;
        }
    }

    _commitSuggestion(slotIndex) {
        let slot = this._suggestionSlots?.[slotIndex];
        if (!slot?.word) return;

        let suggestion = slot.word;
        let word = this._composingWord;

        try {
            let kbCtrl = this._kb._keyboardController;
            if (kbCtrl) {
                for (let i = 0; i < word.length; i++)
                    kbCtrl.toggleDelete(true);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    for (let i = 0; i < word.length; i++)
                        kbCtrl.toggleDelete(false);
                    kbCtrl.commit(suggestion, 0);
                    this._composingWord = '';
                    this._updateSuggestions();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (_e) {}
    }

    // ── Suggestions ──────────────────────────────────────────────────

    _enhanceSuggestions() {
        if (!this._suggestions) return;

        // Hide GNOME's built-in suggestion buttons
        this._origStyles.set(this._suggestions,
            this._suggestions.get_style() || '');
        this._suggestions.set_style(
            `min-height: ${SUGGEST_HEIGHT}px; padding: 0; ` +
            `background-color: ${C.suggest};`);
        this._suggestions.remove_all_children();

        // Create a 3-zone fixed layout
        let suggestBar = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            style: `background-color: ${C.suggest}; min-height: ${SUGGEST_HEIGHT}px;`,
        });

        let ks = (this._targetKbH || 424) / 424;
        const dividerStyle =
            `width: 1px; background-color: rgba(255,255,255,0.12); ` +
            `margin: ${Math.round(6 * ks)}px 0;`;
        const slotStyle =
            `color: ${C.text}; font-size: ${Math.round(16 * ks)}px; font-weight: 400; ` +
            'background-color: transparent; border: none; border-radius: 0; ' +
            `min-height: ${SUGGEST_HEIGHT}px; padding: 0;`;

        this._suggestionSlots = [];

        for (let i = 0; i < 3; i++) {
            if (i > 0) {
                let divider = new St.Widget({ style: dividerStyle });
                suggestBar.add_child(divider);
            }

            let label = new St.Label({
                text: '',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${C.text}; font-size: ${Math.round(16 * ks)}px; font-weight: 400;`,
            });

            let btn = new St.Button({
                child: label,
                x_expand: true,
                y_expand: true,
                style: slotStyle,
            });

            let idx = i;
            btn.connect('clicked', () => this._commitSuggestion(idx));

            suggestBar.add_child(btn);
            this._suggestionSlots.push({ btn, label, word: null });
        }

        this._suggestions.add_child(suggestBar);
        this._customSuggestBar = suggestBar;

        // Start hidden — no suggestions until the user starts typing
        this._suggestionsVisible = false;
        this._suggestions.hide();
    }

    // ── Dismiss bar ──────────────────────────────────────────────────

    _addDismissBar(kb) {
        this._ctrlActive = false;

        this._dismissBar = new St.BoxLayout({
            style_class: 'convergence-osk-dismiss-bar',
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            width: kb.width || global.stage.width,
        });
        this._dismissBar.set_style(
            `background-color: ${C.bg}; min-height: ${DISMISS_HEIGHT}px; padding: 0;`);

        // Ctrl sticky button — aligned under ?123
        // Find the ?123 key to match its exact position and width
        let qKey = null;
        for (let kc of this._keyContainers) {
            for (let i = 0; i < kc.get_n_children(); i++) {
                let key = kc.get_child_at_index(i);
                if (!key) continue;
                for (let j = 0; j < (key.get_n_children?.() ?? 0); j++) {
                    let child = key.get_child_at_index(j);
                    if (child?.style_class?.includes('keyboard-key')) {
                        let lbl = '';
                        for (let k = 0; k < (child.get_n_children?.() ?? 0); k++) {
                            let inner = child.get_child_at_index(k);
                            if (inner?.text === '?123') { qKey = key; break; }
                        }
                    }
                    if (qKey) break;
                }
                if (qKey) break;
            }
            if (qKey) break;
        }

        // Calculate dimensions to match ?123 key proportionally.
        // Layout: 10 base columns, ?123 is 1.5 units, keyboard has
        // 4px LR padding, keys have 3px hGap and 2px vGap margins.
        let kbW = this._targetKbH ? (kb.width || 540) : 540;
        let kbH = this._targetKbH || 424;
        let dks = kbH / 424;
        let hGap = Math.max(1, Math.round(3 * dks));
        let vGap = Math.max(1, Math.round(2 * dks));
        let padLR = Math.round(2 * dks);
        let usableW = kbW - padLR * 2;
        let suggestH = 40;
        let keyAreaH = kbH - suggestH;
        let rowH = Math.round(keyAreaH / 5);
        let ctrlWidth = Math.round(usableW * 1.5 / 10) - hGap * 2;
        let ctrlHeight = rowH - vGap * 2;
        let ctrlMarginLeft = padLR + hGap;

        const ctrlBase =
            `width: ${ctrlWidth}px; height: ${ctrlHeight}px; ` +
            `padding: 0; border-radius: ${Math.round(8 * dks)}px; ` +
            `font-size: ${Math.round(13 * dks)}px; font-weight: 500; ` +
            `margin-left: ${ctrlMarginLeft}px; ` +
            `margin-top: ${vGap}px; margin-bottom: ${vGap}px; ` +
            `margin-right: ${hGap}px;`;
        const ctrlOffStyle =
            `color: ${C.textDim}; background-color: ${C.keyFunc}; ${ctrlBase}`;
        const ctrlOnStyle =
            `color: ${C.accentText}; background-color: ${C.accent}; ${ctrlBase}`;

        this._ctrlBtn = new St.Button({
            label: 'Ctrl',
            style_class: 'convergence-osk-ctrl-btn',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._ctrlBtn.set_style(ctrlOffStyle);
        this._ctrlBtn.connect('clicked', () => {
            this._controller?.haptics?.keypressBuzz();
            this._ctrlActive = !this._ctrlActive;
            this._ctrlBtn.set_style(this._ctrlActive ? ctrlOnStyle : ctrlOffStyle);
        });
        this._dismissBar.add_child(this._ctrlBtn);

        let spacerLeft = new St.Widget({ x_expand: true, y_expand: true });
        this._dismissBar.add_child(spacerLeft);

        // Emoji page navigation buttons — centered in dismiss bar,
        // visible only when emoji panel is active
        let findPager = (actor, depth) => {
            if (depth > 6) return null;
            if (actor.constructor?.name === 'EmojiPager') return actor;
            for (let i = 0; i < (actor.get_n_children?.() ?? 0); i++) {
                let r = findPager(actor.get_child_at_index(i), depth + 1);
                if (r) return r;
            }
            return null;
        };
        let emojiPager = findPager(kb, 0);

        const navBtnStyle =
            `color: ${C.textDim}; min-width: 44px; min-height: 44px; ` +
            'padding: 0 8px; border-radius: 22px; background-color: transparent;';
        let prevBtn = new St.Button({
            style_class: 'convergence-osk-dismiss-btn',
            child: new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: 18 }),
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            visible: false,
        });
        prevBtn.set_style(navBtnStyle);
        prevBtn.connect('clicked', () => {
            if (!emojiPager?.visible) return;
            this._controller?.haptics?.keypressBuzz();
            let nPages = emojiPager._pages?.length ?? 1;
            let cur = emojiPager._curPage ?? 0;
            emojiPager.setCurrentPage((cur + nPages - 1) % nPages);
        });
        this._dismissBar.add_child(prevBtn);

        let nextBtn = new St.Button({
            style_class: 'convergence-osk-dismiss-btn',
            child: new St.Icon({ icon_name: 'go-next-symbolic', icon_size: 18 }),
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            visible: false,
        });
        nextBtn.set_style(navBtnStyle);
        nextBtn.connect('clicked', () => {
            if (!emojiPager?.visible) return;
            this._controller?.haptics?.keypressBuzz();
            let nPages = emojiPager._pages?.length ?? 1;
            let cur = emojiPager._curPage ?? 0;
            emojiPager.setCurrentPage((cur + 1) % nPages);
        });
        this._dismissBar.add_child(nextBtn);

        let spacerRight = new St.Widget({ x_expand: true, y_expand: true });
        this._dismissBar.add_child(spacerRight);

        // Show/hide nav buttons based on emoji panel visibility
        this._emojiNavBtns = [prevBtn, nextBtn];
        if (emojiPager) {
            let emojiSelection = emojiPager.get_parent()?.get_parent();
            let updateNavVisibility = () => {
                let show = emojiSelection?.visible ?? false;
                prevBtn.visible = show;
                nextBtn.visible = show;
            };
            if (emojiSelection) {
                this._emojiNavVisId = emojiSelection.connect('notify::visible', updateNavVisibility);
                this._emojiNavVisTarget = emojiSelection;
                updateNavVisibility();
            }
        }

        // Hide keyboard button (right side)
        let hideBtn = new St.Button({
            style_class: 'convergence-osk-dismiss-btn',
            child: new St.Icon({ icon_name: 'go-down-symbolic', icon_size: 20 }),
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        hideBtn.set_style(
            `color: ${C.textDim}; min-width: 48px; min-height: 48px; ` +
            'padding: 0 12px; border-radius: 24px; background-color: transparent;');
        hideBtn.connect('clicked', () => {
            this._controller?.haptics?.keypressBuzz();
            let kb = Main.keyboard?._keyboard;
            if (kb?.close)
                kb.close(true);
            else
                Main.keyboard.close();
        });
        this._dismissBar.add_child(hideBtn);

        kb.add_child(this._dismissBar);

        // Monkey-patch the keyboard controller's commit() to intercept
        // character input when Ctrl is active. Instead of committing
        // the character, send Ctrl+key via keyvalPress/Release.
        let kbCtrl = this._kb?._keyboardController;
        if (kbCtrl) {
            this._origCommit = kbCtrl.commit.bind(kbCtrl);
            kbCtrl.commit = (str, modifiers) => {
                if (this._ctrlActive && str && str.length === 1) {
                    // Convert character to keyval (a=0x61, etc.)
                    let keyval = str.toLowerCase().charCodeAt(0);
                    kbCtrl.keyvalPress(0xffe3); // Ctrl down
                    kbCtrl.keyvalPress(keyval);
                    kbCtrl.keyvalRelease(keyval);
                    kbCtrl.keyvalRelease(0xffe3); // Ctrl up

                    // Auto-release Ctrl sticky
                    this._ctrlActive = false;
                    this._ctrlBtn?.set_style(ctrlOffStyle);
                    return Promise.resolve();
                }
                return this._origCommit(str, modifiers);
            };
        }

    }

    // ── Remote control (file-based, for SSH testing) ───────────────
    // Disabled for performance — uncomment _setupRemoteControl() call
    // in _patchKeyboard() to re-enable during development.

    _setupRemoteControl() {
        this._rcTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            try {
                let cmdFile = Gio.File.new_for_path('/tmp/convergence-kb-cmd');
                if (!cmdFile.query_exists(null)) return GLib.SOURCE_CONTINUE;

                let [, contents] = cmdFile.load_contents(null);
                let cmd = new TextDecoder().decode(contents).trim();
                cmdFile.delete(null);

                if (!cmd) return GLib.SOURCE_CONTINUE;
                console.log(`[Convergence:Keyboard:RC] cmd: ${cmd}`);

                let parts = cmd.split(/\s+/);
                switch (parts[0]) {
                    case 'height': {
                        let h = parseInt(parts[1]);
                        if (h > 0 && this._kb) {
                            this._kb.set_height(h);
                            console.log(`[Convergence:Keyboard:RC] set kb height=${h}, actual=${this._kb.height}`);
                        }
                        break;
                    }
                    case 'translate': {
                        let ty = parseInt(parts[1]);
                        if (this._keyboardBox) {
                            this._keyboardBox.translation_y = ty;
                            console.log(`[Convergence:Keyboard:RC] set ty=${ty}`);
                        }
                        break;
                    }
                    case 'setheight': {
                        // Combined: set kb height + kb translation_y
                        let h = parseInt(parts[1]);
                        if (h > 0 && this._kb) {
                            this._adjustingTy = true;
                            this._kb.set_height(h);
                            this._kb.translation_y = -h;
                            this._adjustingTy = false;
                            console.log(`[Convergence:Keyboard:RC] setheight=${h} kb.ty=${-h} actual_kb=${this._kb.height}`);
                        }
                        break;
                    }
                    case 'kbty': {
                        let ty = parseFloat(parts[1]);
                        if (this._kb) {
                            this._adjustingTy = true;
                            this._kb.translation_y = ty;
                            this._adjustingTy = false;
                            console.log(`[Convergence:Keyboard:RC] kb.ty set to ${ty}, actual=${this._kb.translation_y}`);
                        }
                        break;
                    }
                    case 'screenshot': {
                        try {
                            let ss = new Shell.Screenshot();
                            let f = Gio.File.new_for_path('/tmp/convergence-osk-rc.png');
                            let s = f.replace(null, false, Gio.FileCreateFlags.NONE, null);
                            ss.screenshot(false, s)
                                .then(() => { s.close(null); console.log('[Convergence:Keyboard:RC] screenshot saved'); })
                                .catch(() => s.close(null));
                        } catch (_e) {}
                        break;
                    }
                    case 'log': {
                        let kb = this._kb;
                        let kbBox = this._keyboardBox;
                        let ac = this._aspectContainer;
                        let [kbTx, kbTy] = kb?.get_transformed_position?.() ?? [0, 0];
                        let [boxTx, boxTy] = kbBox?.get_transformed_position?.() ?? [0, 0];
                        console.log(`[Convergence:Keyboard:RC] kb=${kb?.width}x${kb?.height} kb.y=${kb?.y} kb.ty=${kb?.translation_y} kbTransY=${Math.round(kbTy)} ` +
                            `kbBox=${kbBox?.width}x${kbBox?.height} kbBox.y=${kbBox?.y} kbBox.ty=${kbBox?.translation_y} boxTransY=${Math.round(boxTy)} ` +
                            `ac=${ac?.width}x${ac?.height} screen=${global.stage.width}x${global.stage.height}`);
                        break;
                    }
                    case 'suggest': {
                        let sug = this._suggestions;
                        let kbCtrl = this._kb?._keyboardController;
                        let completion = kbCtrl?._oskCompletionEnabled;
                        let oskComp = kbCtrl?._oskCompletion;
                        console.log(`[Convergence:Keyboard:RC] suggest: children=${sug?.get_n_children?.()} completion=${completion} oskComp=${oskComp}`);
                        // Check if _setupKeyboard broke things
                        console.log(`[Convergence:Keyboard:RC] suggest: kb._keyboardController exists=${!!this._kb?._keyboardController}`);
                        // Try manually adding a test suggestion
                        if (parts[1] === 'test') {
                            try {
                                this._kb.resetSuggestions?.();
                                this._kb.addSuggestion?.('hello', () => {});
                                this._kb.addSuggestion?.('help', () => {});
                                this._kb.addSuggestion?.('world', () => {});
                                console.log('[Convergence:Keyboard:RC] test suggestions added');
                            } catch(e) {
                                console.log(`[Convergence:Keyboard:RC] test error: ${e.message}`);
                            }
                        }
                        // Try to force enable completion
                        if (parts[1] === 'enable' && kbCtrl?.setOskCompletion) {
                            kbCtrl.setOskCompletion(true).then(
                                () => console.log('[Convergence:Keyboard:RC] completion enabled')
                            ).catch(
                                e => console.log(`[Convergence:Keyboard:RC] completion error: ${e.message}`)
                            );
                        }
                        break;
                    }
                    case 'dismiss': {
                        // dismiss <height> [iconSize]
                        let dh = parseInt(parts[1]) || 48;
                        let iconSz = parseInt(parts[2]) || 20;
                        if (this._dismissBar) {
                            this._dismissBar.set_style(
                                `background-color: ${C.dismissBg}; min-height: ${dh}px; padding: 0 12px;`);
                            // Update the button inside
                            let btn = this._dismissBar.get_last_child();
                            if (btn?.set_style) {
                                btn.set_style(
                                    `color: ${C.textDim}; min-width: ${dh}px; min-height: ${dh}px; ` +
                                    'padding: 0; border-radius: 24px; background-color: transparent;');
                                let icon = btn.get_child();
                                if (icon?.set_icon_size) icon.set_icon_size(iconSz);
                            }
                            console.log(`[Convergence:Keyboard:RC] dismiss height=${dh} icon=${iconSz}`);
                        }
                        break;
                    }
                    case 'reset': {
                        if (this._kb) this._kb.set_height(-1);
                        if (this._keyboardBox) this._keyboardBox.translation_y = 0;
                        console.log('[Convergence:Keyboard:RC] reset to defaults');
                        break;
                    }
                    case 'style': {
                        // style <letterFontPx> <numFontPx> <labelFontPx> <keyBg> <hGap> <vGap> <radius>
                        // e.g.: style 22 18 12 #1E2024 4 3 9
                        let letterFs = parseInt(parts[1]) || 16;
                        let numFs = parseInt(parts[2]) || 14;
                        let labelFs = parseInt(parts[3]) || 10;
                        let keyBg = parts[4] || C.key;
                        let hG = parseInt(parts[5]) || 4;
                        let vG = parseInt(parts[6]) || 3;
                        let rad = parseInt(parts[7]) || 9;

                        let mkStyle = (bg, color, fs, r) =>
                            `background-color: ${bg}; border-radius: ${r}px; border: none; ` +
                            `color: ${color}; font-size: ${fs}px; font-weight: 400; ` +
                            `margin: ${vG}px ${hG}px;`;

                        for (let kc of this._keyContainers) {
                            for (let i = 0; i < kc.get_n_children(); i++) {
                                let key = kc.get_child_at_index(i);
                                if (!key) continue;
                                let btn = null, iconName = null, keyLabel = null, isSpace = false;
                                for (let j = 0; j < (key.get_n_children?.() ?? 0); j++) {
                                    let child = key.get_child_at_index(j);
                                    if (child?.style_class?.includes('keyboard-key')) {
                                        btn = child;
                                        if (key.width > key.height * 3) isSpace = true;
                                        for (let k = 0; k < (child.get_n_children?.() ?? 0); k++) {
                                            let inner = child.get_child_at_index(k);
                                            if (inner?.icon_name) iconName = inner.icon_name;
                                            if (inner?.text) keyLabel = inner.text;
                                        }
                                    }
                                }
                                if (!btn) continue;
                                let isNum = keyLabel && /^[0-9]$/.test(keyLabel);
                                if (iconName === 'osk-enter-symbolic')
                                    btn.set_style(mkStyle(C.accent, C.accentText, letterFs, 128) + 'font-weight: 500;');
                                else if (isSpace)
                                    btn.set_style(mkStyle(C.spaceBg, C.spaceText, labelFs, rad));
                                else if (iconName)
                                    btn.set_style(mkStyle(C.keyFunc, C.textDim, labelFs, rad));
                                else if (isNum)
                                    btn.set_style(mkStyle(keyBg, C.text, numFs, rad));
                                else
                                    btn.set_style(mkStyle(keyBg, C.text, letterFs, rad));
                            }
                        }
                        console.log(`[Convergence:Keyboard:RC] style applied: letter=${letterFs} num=${numFs} label=${labelFs} bg=${keyBg} gap=${hG}/${vG} rad=${rad}`);
                        break;
                    }
                }
            } catch (_e) {}
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ── Cleanup ──────────────────────────────────────────────────────

    destroy() {
        if (this._deferTimerId) {
            GLib.source_remove(this._deferTimerId);
            this._deferTimerId = 0;
        }

        if (this._rcTimerId) {
            GLib.source_remove(this._rcTimerId);
            this._rcTimerId = 0;
        }
        if (this._heightTimerId) {
            GLib.source_remove(this._heightTimerId);
            this._heightTimerId = 0;
        }
        if (this._keyStylePollId) {
            GLib.source_remove(this._keyStylePollId);
            this._keyStylePollId = 0;
        }
        for (let entry of this._keyStyleCheckIds ?? []) {
            try { entry.actor.disconnect(entry.id); } catch (_e) {}
        }
        this._keyStyleCheckIds = [];
        // Restore _setActiveLevel hook
        if (this._origSetActiveLevel && this._kb) {
            this._kb._setActiveLevel = this._origSetActiveLevel;
            this._origSetActiveLevel = null;
        }
        // Restore _relayout hook
        if (this._origRelayout && this._kb) {
            this._kb._relayout = this._origRelayout;
            this._origRelayout = null;
        }
        // Restore keyboard height
        if (this._kb)
            this._kb.set_height(-1);

        if (this._hapticEventId && this._kb) {
            this._kb.disconnect(this._hapticEventId);
            this._hapticEventId = 0;
        }
        if (this._emojiSwipeId && this._emojiSwipeTarget) {
            this._emojiSwipeTarget.disconnect(this._emojiSwipeId);
            this._emojiSwipeId = 0;
        }
        this._emojiSwipeTarget = null;
        this._emojiPager = null;
        if (this._suggestEventId && this._kb) {
            this._kb.disconnect(this._suggestEventId);
            this._suggestEventId = 0;
        }
        this._dictWords = null;
        this._composingWord = '';

        if (this._previewEventId && this._kb) {
            this._kb.disconnect(this._previewEventId);
            this._previewEventId = 0;
        }
        if (this._previewPopup) {
            Main.layoutManager.removeChrome(this._previewPopup);
            this._previewPopup.destroy();
            this._previewPopup = null;
        }

        if (this._emojiNavVisId && this._emojiNavVisTarget) {
            this._emojiNavVisTarget.disconnect(this._emojiNavVisId);
            this._emojiNavVisId = 0;
            this._emojiNavVisTarget = null;
        }
        this._emojiNavBtns = null;

        // Restore touch-mode and input method bridge
        this._restoreTouchMode();
        this._teardownInputMethodBridge();

        // Restore AspectContainer

        if (this._origManagerOpen) {
            Main.keyboard.open = this._origManagerOpen;
            this._origManagerOpen = null;
        }
        if (this._heightPollId) {
            GLib.source_remove(this._heightPollId);
            this._heightPollId = 0;
        }
        this._dictPrefixMap = null;
        this._keyboardBox = null;

        if (this._kb) {
            this._kb.set_height(-1); // reset to natural height
            this._kb.remove_style_class_name('convergence-osk');
            this._kb.set_style('');
        }

        if (this._customSuggestBar) {
            this._customSuggestBar.destroy();
            this._customSuggestBar = null;
        }
        this._suggestionSlots = null;

        if (this._suggestions) {
            this._suggestions.remove_style_class_name('convergence-osk-suggestions');
            this._suggestions.set_style('');
        }

        for (let label of this._hintLabels)
            label.destroy();
        this._hintLabels = [];

        for (let key of this._hiddenKeys)
            key.show();
        this._hiddenKeys = [];

        if (this._dismissBar) {
            this._dismissBar.destroy();
            this._dismissBar = null;
        }

        for (let [actor, origStyle] of this._origStyles)
            actor.set_style(origStyle);
        this._origStyles.clear();

        if (this._customResource) {
            Gio.resources_unregister(this._customResource);
            this._customResource = null;
        }
        // Re-register stock osk-layouts if we unregistered it
        if (this._stockOskResource) {
            try { Gio.resources_register(this._stockOskResource); } catch (_e) {}
            this._stockOskResource = null;
        }

        this._unpinKeyboardFromPhoneMonitor();

        this._patched = false;
        this._kb = null;
        this._suggestions = null;
        this._keyContainers = [];
        this._aspectContainer = null;
        this._controller = null;
        this._settings = null;
    }
}
