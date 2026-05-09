// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

let Clutter = null;
let St = null;

function _bindShellEnv(runtimeEnv) {
    Clutter = runtimeEnv?.Clutter ?? Clutter;
    St = runtimeEnv?.St ?? St;
    if (!Clutter || !St)
        throw new Error('Sticky note widget requires shell runtime env');
}

// ---------------------------------------------------------------------------
// Sticky Note Widget — multi-page editable notes with color themes
// ---------------------------------------------------------------------------

const STICKY_COLORS = [
    { bg: '#f9e97a', fg: '#5c4b00', name: 'Yellow' },
    { bg: '#a8e6a1', fg: '#1b4d1b', name: 'Green' },
    { bg: '#a8d8f0', fg: '#0d3b5c', name: 'Blue' },
    { bg: '#f0a8d0', fg: '#5c0d3b', name: 'Pink' },
    { bg: '#f0c8a8', fg: '#5c2e0d', name: 'Orange' },
    { bg: '#d0a8f0', fg: '#3b0d5c', name: 'Purple' },
    { bg: '#f0f0f0', fg: '#333333', name: 'White' },
];

export { STICKY_COLORS };

export class StickyNoteWidget {
    constructor(settings, item) {
        this._settings = settings ?? null;
        this._item = item;
        this._box = null;
        this._header = null;
        this._pagerClip = null;
        this._pager = null;
        this._entries = [];
        this._focusOutIds = [];
        this._dots = [];
        this._currentPage = 0;
        this._contentW = 0;
        this._saveCallback = null;
        this._menuCallback = null;
        this._swipeStartX = 0;
        this._swipeActive = false;
        this._swipeClaimed = false;
    }

    /** Darken a hex color by mixing toward black. */
    static _darken(hex, factor) {
        let r = parseInt(hex.slice(1, 3), 16);
        let g = parseInt(hex.slice(3, 5), 16);
        let b = parseInt(hex.slice(5, 7), 16);
        r = Math.round(r * (1 - factor));
        g = Math.round(g * (1 - factor));
        b = Math.round(b * (1 - factor));
        return `rgb(${r},${g},${b})`;
    }

    _getColor() {
        let idx = this._item?.widgetData?.colorIdx ?? 0;
        return STICKY_COLORS[idx % STICKY_COLORS.length];
    }

    _getPages() {
        let d = this._item?.widgetData;
        // Migrate single-text -> pages array
        if (d && !d.pages) {
            d.pages = [d.text ?? ''];
            delete d.text;
        }
        return d?.pages ?? [''];
    }

    buildContent(w, h, _colSpan, _rowSpan, monitor, gridMetrics, runtimeEnv = null) {
        _bindShellEnv(runtimeEnv);
        let color = this._getColor();
        let headerBg = StickyNoteWidget._darken(color.bg, 0.08);
        this._contentW = w;
        this._scale = gridMetrics?.scale ?? (monitor?.width ?? 540) / 432;
        this._placeholder = 'Add a note...';

        let s = this._scale;
        let rad = Math.round(12 * s);
        let btnSize = Math.round(32 * s / 2) * 2;   // even number for pixel-aligned icons
        let rawIcon = Math.round(18 * s);
        // Snap to standard icon sizes (16, 24, 32, 48) for crisp rendering
        let iconSize = rawIcon <= 20 ? 16 : rawIcon <= 28 ? 24 : rawIcon <= 40 ? 32 : 48;
        this._fontSize = Math.round(15 * s);
        this._headerFontSize = Math.round(12 * s);
        this._dotSize = Math.round(6 * s);
        this._headerPadV = Math.round(2 * s);
        this._headerPadH = Math.round(4 * s);
        this._headerSpacing = Math.round(2 * s);
        this._entryPadV = Math.round(8 * s);
        this._entryPadH = Math.round(10 * s);
        this._dotSpacing = Math.round(5 * s);
        this._borderRadius = rad;
        this._iconSize = iconSize;

        let btnStyle = () =>
            `min-width: ${btnSize}px; min-height: ${btnSize}px;`
            + ` border-radius: ${Math.round(btnSize / 2)}px;`
            + ' padding: 0;';

        this._box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            reactive: true,
            style: `background-color: ${color.bg}; border-radius: ${rad}px;`,
            clip_to_allocation: true,
        });

        // -- Header strip --
        this._header = new St.BoxLayout({
            x_expand: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${headerBg};`
                + ` border-radius: ${rad}px ${rad}px 0 0;`
                + ` padding: ${this._headerPadV}px ${this._headerPadH}px;`
                + ` spacing: ${this._headerSpacing}px;`,
        });
        this._box.add_child(this._header);

        // Previous page button
        this._prevBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'go-previous-symbolic',
                icon_size: iconSize,
                style: `color: ${color.fg};`,
            }),
            style: btnStyle(),
            reactive: true,
        });
        this._prevBtn.connect('clicked', () => {
            if (this._currentPage > 0) this._goToPage(this._currentPage - 1);
        });
        this._header.add_child(this._prevBtn);

        // Center: workspace-style page indicator (pill for active, dot for inactive)
        this._dotsBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: `spacing: ${this._dotSpacing}px;`,
        });
        // Spacers keep the center group centered and push menu button right
        this._headerSpacer = new St.Widget({ x_expand: true });
        this._header.add_child(this._headerSpacer);
        this._header.add_child(this._dotsBox);
        this._headerSpacerR = new St.Widget({ x_expand: true });
        this._header.add_child(this._headerSpacerR);

        // Next page button
        this._nextBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'go-next-symbolic',
                icon_size: iconSize,
                style: `color: ${color.fg};`,
            }),
            style: btnStyle(),
            reactive: true,
        });
        this._nextBtn.connect('clicked', () => {
            if (this._currentPage < this._entries.length - 1)
                this._goToPage(this._currentPage + 1);
        });
        this._header.add_child(this._nextBtn);

        // Hamburger menu button
        let menuIcon = new St.Icon({
            icon_name: 'open-menu-symbolic',
            icon_size: iconSize,
            style: `color: ${color.fg};`,
        });
        this._menuBtn = new St.Button({
            child: menuIcon,
            style: btnStyle(),
            reactive: true,
        });
        // Force pixel-grid alignment to avoid blurry middle line
        menuIcon.set_pivot_point(0, 0);
        this._menuBtn.connect('notify::allocation', () => {
            let child = this._menuBtn.get_first_child();
            if (!child) return;
            let [bw, bh] = [this._menuBtn.width, this._menuBtn.height];
            let [iw, ih] = [child.width, child.height];
            child.set_position(Math.round((bw - iw) / 2), Math.round((bh - ih) / 2));
        });
        this._menuBtn.connect('clicked', () => {
            this._menuJustOpened = true;
            if (this._menuCallback) this._menuCallback(this._menuBtn);
        });
        this._header.add_child(this._menuBtn);

        // -- Pager (horizontal strip of entries) --
        this._pagerClip = new St.Widget({
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            reactive: true,
        });
        this._box.add_child(this._pagerClip);

        this._pager = new St.BoxLayout({
            vertical: false,
            y_expand: true,
        });
        this._pagerClip.add_child(this._pager);

        // St.Widget uses FixedLayout which ignores y_expand on children,
        // so the pager only gets its natural (text-content) height.  Sync
        // the pager height to the clip's allocation so entries fill the
        // full widget height and receive mouse events everywhere.
        this._pagerClip.connect('notify::allocation', () => {
            let h = this._pagerClip.height;
            if (h > 0 && this._pager) this._pager.height = h;
        });

        // Build initial pages
        let pages = this._getPages();
        for (let text of pages)
            this._appendPageEntry(text);

        this._currentPage = Math.min(
            this._item?.widgetData?.currentPage ?? 0,
            this._entries.length - 1);
        this._snapToPage(false);
        this._updateIndicators();

        // Touch swipe on pager
        this._pagerClip.connect('captured-event', (_a, event) => {
            return this._onPagerEvent(event);
        });

        return this._box;
    }

    _appendPageEntry(text) {
        let color = this._getColor();
        let placeholder = this._placeholder;
        let isEmpty = !text;
        let pageIdx = this._entries.length;
        let entry = new St.Entry({
            text: isEmpty ? placeholder : text,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            width: this._contentW,
            style: isEmpty ? this._placeholderStyle(color, pageIdx) : this._entryStyle(color, pageIdx),
        });
        entry.clutter_text.set({
            single_line_mode: false,
            line_wrap: true,
            line_wrap_mode: 0,
            activatable: false,
            y_align: Clutter.ActorAlign.START,
        });
        entry._stickyPlaceholder = isEmpty;
        entry._stickyPageIdx = pageIdx;

        // Consume scroll events so they don't propagate to the home screen
        // and trigger page swipes while the user is scrolling the note.
        entry.connect('scroll-event', () => Clutter.EVENT_STOP);

        // Click anywhere in the entry area (including below text) to focus
        // and place the cursor at the end of the text content.
        entry.connect('button-press-event', () => {
            let ct = entry.clutter_text;
            if (ct && !ct.has_key_focus()) {
                ct.grab_key_focus();
                ct.set_cursor_position(-1);
                ct.set_selection_bound(-1);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Clear placeholder on focus, restore on blur if empty
        entry.clutter_text.connect('key-focus-in', () => {
            if (entry._stickyPlaceholder && entry.get_text() === placeholder) {
                entry.set_text('');
                entry.style = this._entryStyle(this._getColor(), entry._stickyPageIdx);
                entry._stickyPlaceholder = false;
            }
        });

        // Auto-formatting: bullets, checkboxes, numbered lists
        entry.clutter_text.connect('key-press-event', (_ct, event) => {
            let sym = event.get_key_symbol();
            let ct = entry.clutter_text;
            let currentText = ct.text ?? '';
            let cursor = ct.get_cursor_position();
            if (cursor < 0) cursor = currentText.length;
            let lineStart = currentText.lastIndexOf('\n', cursor - 1) + 1;
            let before = currentText.substring(lineStart, cursor);

            // Space triggers: convert markers at line start
            if (sym === Clutter.KEY_space) {
                // "* " or "- " -> bullet
                if (before === '*' || before === '-') {
                    this._suppressPersist = true;
                    ct.delete_text(lineStart, cursor);
                    ct.insert_text('\u2022 ', lineStart);
                    this._suppressPersist = false;
                    this._persistCurrentPage();
                    return Clutter.EVENT_STOP;
                }
                // "[] " -> unchecked checkbox
                if (before === '[]') {
                    this._suppressPersist = true;
                    ct.delete_text(lineStart, cursor);
                    ct.insert_text('\u2610 ', lineStart);
                    this._suppressPersist = false;
                    this._persistCurrentPage();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }

            // Enter: auto-continue or end lists
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                let lineEnd = currentText.indexOf('\n', cursor);
                if (lineEnd < 0) lineEnd = currentText.length;
                let lineText = currentText.substring(lineStart, lineEnd);

                // Bullet continuation
                if (lineText.startsWith('\u2022 ')) {
                    if (lineText.trim() === '\u2022') {
                        this._suppressPersist = true;
                        ct.delete_text(lineStart, lineEnd);
                        this._suppressPersist = false;
                        this._persistCurrentPage();
                        return Clutter.EVENT_PROPAGATE;
                    }
                    ct.insert_text('\n\u2022 ', cursor);
                    return Clutter.EVENT_STOP;
                }

                // Checkbox continuation
                if (lineText.startsWith('\u2610 ') || lineText.startsWith('\u2611 ')) {
                    let content = lineText.substring(2).trim();
                    if (!content) {
                        this._suppressPersist = true;
                        ct.delete_text(lineStart, lineEnd);
                        this._suppressPersist = false;
                        this._persistCurrentPage();
                        return Clutter.EVENT_PROPAGATE;
                    }
                    ct.insert_text('\n\u2610 ', cursor);
                    return Clutter.EVENT_STOP;
                }

                // Numbered list continuation
                let numMatch = lineText.match(/^(\d+)\.\s/);
                if (numMatch) {
                    let content = lineText.substring(numMatch[0].length).trim();
                    if (!content) {
                        this._suppressPersist = true;
                        ct.delete_text(lineStart, lineEnd);
                        this._suppressPersist = false;
                        this._persistCurrentPage();
                        return Clutter.EVENT_PROPAGATE;
                    }
                    let next = parseInt(numMatch[1], 10) + 1;
                    ct.insert_text(`\n${next}. `, cursor);
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Checkbox click toggle (capture phase on entry)
        entry.connect('captured-event', (_actor, event) => {
            let type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            if (type === Clutter.EventType.BUTTON_PRESS &&
                (event.get_button?.() ?? 0) !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            let ct = entry.clutter_text;
            let currentText = ct.text ?? '';
            let [ex, ey] = event.get_coords();
            let [ok, lx, ly] = ct.transform_stage_point(ex, ey);
            if (!ok) return Clutter.EVENT_PROPAGATE;
            let pos = ct.coords_to_position(lx, ly);
            if (pos < 0) return Clutter.EVENT_PROPAGATE;
            let lnStart = currentText.lastIndexOf('\n', pos - 1) + 1;
            let linePrefix = currentText.substring(lnStart, lnStart + 2);
            if (linePrefix !== '\u2610 ' && linePrefix !== '\u2611 ')
                return Clutter.EVENT_PROPAGATE;
            // X must be in the checkbox zone
            let checkboxW = Math.max(20, this._fontSize * 1.6);
            if (lx > checkboxW) return Clutter.EVENT_PROPAGATE;
            let replacement = linePrefix === '\u2610 ' ? '\u2611' : '\u2610';
            this._suppressPersist = true;
            ct.delete_text(lnStart, lnStart + 1);
            ct.insert_text(replacement, lnStart);
            this._suppressPersist = false;
            ct.set_cursor_position(lnStart + 2);
            ct.set_selection_bound(lnStart + 2);
            this._save();
            return Clutter.EVENT_STOP;
        });

        // Persist on every text change
        entry.clutter_text.connect('text-changed', () => {
            if (!entry._stickyPlaceholder && !this._suppressPersist)
                this._save();
        });
        let focusId = entry.clutter_text.connect('key-focus-out', () => {
            this._persistCurrentPage();
            this._save();
            if (!entry.get_text()) {
                entry.set_text(placeholder);
                entry.style = this._placeholderStyle(this._getColor(), entry._stickyPageIdx);
                entry._stickyPlaceholder = true;
            }
        });
        this._pager.add_child(entry);
        this._entries.push(entry);
        this._focusOutIds.push(focusId);
    }

    _getPageStyle(pageIdx) {
        let styles = this._item?.widgetData?.pageStyles;
        return styles?.[pageIdx] ?? {};
    }

    _setPageStyle(pageIdx, props) {
        if (!this._item) return;
        if (!this._item.widgetData) this._item.widgetData = {};
        if (!this._item.widgetData.pageStyles)
            this._item.widgetData.pageStyles = [];
        let arr = this._item.widgetData.pageStyles;
        while (arr.length <= pageIdx) arr.push({});
        Object.assign(arr[pageIdx], props);
    }

    _entryStyle(color, pageIdx) {
        let ps = pageIdx != null ? this._getPageStyle(pageIdx) : {};
        let fontSize = ps.fontSize ?? this._fontSize;
        let weight = ps.bold ? 'bold' : '400';
        let italic = ps.italic ? ' font-style: italic;' : '';
        return `color: ${color.fg}; font-size: ${fontSize}px; font-weight: ${weight};${italic}`
            + ` caret-color: ${color.fg};`
            + ` background-color: transparent; border: none;`
            + ` padding: ${this._entryPadV}px ${this._entryPadH}px;`
            + ' selection-background-color: rgba(0,0,0,0.15);';
    }

    _placeholderStyle(color, pageIdx) {
        let ps = pageIdx != null ? this._getPageStyle(pageIdx) : {};
        let fontSize = ps.fontSize ?? this._fontSize;
        let weight = ps.bold ? 'bold' : '400';
        return `color: ${color.fg}; font-size: ${fontSize}px;`
            + ` font-weight: ${weight}; font-style: italic; opacity: 128;`
            + ` caret-color: ${color.fg};`
            + ` background-color: transparent; border: none;`
            + ` padding: ${this._entryPadV}px ${this._entryPadH}px;`
            + ' selection-background-color: rgba(0,0,0,0.15);';
    }

    _updateIndicators() {
        let n = this._entries.length;
        let p = this._currentPage;
        if (this._dotsBox) {
            this._dotsBox.destroy_all_children();
            // Hide indicator when only one page
            this._dotsBox.visible = n > 1;
            let color = this._getColor();
            let ds = this._dotSize;
            let pillW = Math.round(ds * 2.5);
            let radius = Math.round(ds / 2);
            for (let i = 0; i < n; i++) {
                let active = i === p;
                let dot = new St.Widget({
                    width: active ? pillW : ds,
                    height: ds,
                    style: `border-radius: ${radius}px; background-color: ${color.fg};`
                        + (active ? ' opacity: 255;' : ' opacity: 80;'),
                });
                this._dotsBox.add_child(dot);
            }
        }
        if (this._prevBtn) {
            this._prevBtn.visible = n > 1;
            this._prevBtn.reactive = p > 0;
            if (this._prevBtn.get_first_child())
                this._prevBtn.get_first_child().opacity = p > 0 ? 255 : 80;
        }
        if (this._nextBtn) {
            this._nextBtn.visible = n > 1;
            this._nextBtn.reactive = p < n - 1;
            if (this._nextBtn.get_first_child())
                this._nextBtn.get_first_child().opacity = p < n - 1 ? 255 : 80;
        }
    }

    _snapToPage(animate) {
        if (!this._pager) return;
        let targetX = -(this._currentPage * this._contentW);
        let entry = this._entries[this._currentPage];
        if (animate) {
            this._pager.remove_all_transitions();
            this._pager.ease({
                translation_x: targetX,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    if (!this._pager?.get_parent()) return;
                    entry?.queue_relayout();
                    this._pagerClip?.queue_redraw();
                },
            });
        } else {
            this._pager.translation_x = targetX;
            entry?.queue_relayout();
            this._pagerClip?.queue_redraw();
        }
    }

    _goToPage(idx) {
        this._persistCurrentPage();
        this._currentPage = Math.max(0, Math.min(this._entries.length - 1, idx));
        this._snapToPage(true);
        this._updateIndicators();
        this._save();
    }

    _addPage() {
        this._persistCurrentPage();
        let pages = this._getPages();
        pages.push('');
        this._appendPageEntry('');
        this._goToPage(this._entries.length - 1);
    }

    _deletePage() {
        if (this._entries.length <= 1) return;
        this._persistCurrentPage();
        let pages = this._getPages();
        let idx = this._currentPage;

        // Remove entry
        let entry = this._entries[idx];
        let focusId = this._focusOutIds[idx];
        entry.clutter_text.disconnect(focusId);
        this._pager.remove_child(entry);
        entry.destroy();
        this._entries.splice(idx, 1);
        this._focusOutIds.splice(idx, 1);
        pages.splice(idx, 1);
        let ps = this._item?.widgetData?.pageStyles;
        if (ps) ps.splice(idx, 1);

        // Re-index remaining entries
        for (let i = 0; i < this._entries.length; i++)
            this._entries[i]._stickyPageIdx = i;

        this._currentPage = Math.min(idx, this._entries.length - 1);
        this._snapToPage(true);
        this._updateIndicators();
        this._save();
    }

    // -- Swipe gesture on pager --

    _onPagerEvent(event) {
        let type = event.type();
        // Page-swipe is touch-only; mouse users have the header buttons
        // and need unimpeded click-drag for text selection.
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            let [x] = event.get_coords();
            this._swipeStartX = x;
            this._swipeActive = true;
            this._swipeClaimed = false;
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.TOUCH_UPDATE) {
            if (!this._swipeActive) return Clutter.EVENT_PROPAGATE;
            let [x] = event.get_coords();
            let dx = x - this._swipeStartX;
            if (!this._swipeClaimed && Math.abs(dx) > Math.round(15 * this._scale)) {
                this._swipeClaimed = true;
                this._pager.remove_all_transitions();
            }
            if (this._swipeClaimed) {
                let baseX = -(this._currentPage * this._contentW);
                this._pager.translation_x = baseX + dx;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            if (!this._swipeActive) return Clutter.EVENT_PROPAGATE;
            this._swipeActive = false;
            if (!this._swipeClaimed) return Clutter.EVENT_PROPAGATE;
            let [x] = event.get_coords();
            let dx = x - this._swipeStartX;
            let threshold = this._contentW * 0.25;
            if (dx < -threshold && this._currentPage < this._entries.length - 1)
                this._goToPage(this._currentPage + 1);
            else if (dx > threshold && this._currentPage > 0)
                this._goToPage(this._currentPage - 1);
            else
                this._snapToPage(true);
            this._swipeClaimed = false;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // -- Public API --

    /** Return the current-page entry if (stageX, stageY) hits the pager area. */
    getEntryAt(stageX, stageY) {
        let entry = this._entries[this._currentPage];
        if (!entry) return null;
        let target = this._pagerClip ?? entry;
        let [ok, lx, ly] = target.transform_stage_point(stageX, stageY);
        if (!ok) return null;
        if (lx >= 0 && ly >= 0 && lx <= target.width && ly <= target.height)
            return entry;
        return null;
    }

    getCurrentPageStyle() {
        return this._getPageStyle(this._currentPage);
    }

    toggleBold() {
        let ps = this._getPageStyle(this._currentPage);
        let bold = !ps.bold;
        this._setPageStyle(this._currentPage, { bold });
        let entry = this._entries[this._currentPage];
        if (entry)
            entry.style = this._entryStyle(this._getColor(), this._currentPage);
        this._save();
    }

    toggleItalic() {
        let ps = this._getPageStyle(this._currentPage);
        let italic = !ps.italic;
        this._setPageStyle(this._currentPage, { italic });
        let entry = this._entries[this._currentPage];
        if (entry)
            entry.style = this._entryStyle(this._getColor(), this._currentPage);
        this._save();
    }

    focus() {
        let entry = this._entries[this._currentPage];
        if (entry) global.stage.set_key_focus(entry.clutter_text);
    }

    _persistCurrentPage() {
        if (!this._item) return;
        let entry = this._entries[this._currentPage];
        if (!entry) return;
        let pages = this._getPages();
        // Don't save placeholder text
        let text = entry.get_text();
        if (entry._stickyPlaceholder) text = '';
        pages[this._currentPage] = text;
        if (!this._item.widgetData) this._item.widgetData = {};
        this._item.widgetData.currentPage = this._currentPage;
    }

    _save() {
        this._persistCurrentPage();
        if (this._saveCallback) this._saveCallback();
    }

    onSave(cb) { this._saveCallback = cb; }
    onMenu(cb) { this._menuCallback = cb; }

    getText() {
        let entry = this._entries[this._currentPage];
        return entry?.get_text() ?? '';
    }

    setText(text) {
        let entry = this._entries[this._currentPage];
        if (entry) entry.set_text(text);
        this._persistCurrentPage();
    }

    getColorIdx() {
        return this._item?.widgetData?.colorIdx ?? 0;
    }

    setColorIdx(idx) {
        if (!this._item) return;
        if (!this._item.widgetData) this._item.widgetData = {};
        this._item.widgetData.colorIdx = idx;
        let color = STICKY_COLORS[idx % STICKY_COLORS.length];
        let headerBg = StickyNoteWidget._darken(color.bg, 0.08);

        let rad = this._borderRadius;
        if (this._box)
            this._box.style = `background-color: ${color.bg}; border-radius: ${rad}px;`;
        if (this._header)
            this._header.style = `background-color: ${headerBg};`
                + ` border-radius: ${rad}px ${rad}px 0 0;`
                + ` padding: ${this._headerPadV}px ${this._headerPadH}px;`
                + ` spacing: ${this._headerSpacing}px;`;
        for (let i = 0; i < this._entries.length; i++) {
            let entry = this._entries[i];
            entry.style = entry._stickyPlaceholder
                ? this._placeholderStyle(color, i)
                : this._entryStyle(color, i);
        }
        let iconStyle = `color: ${color.fg};`;
        for (let btn of [this._menuBtn, this._prevBtn, this._nextBtn]) {
            if (btn?.get_first_child())
                btn.get_first_child().style = iconStyle;
        }
        this._updateIndicators();
    }

    destroy() {
        this._persistCurrentPage();
        for (let i = 0; i < this._entries.length; i++) {
            try { this._entries[i].clutter_text.disconnect(this._focusOutIds[i]); } catch (_) {}
        }
        this._saveCallback = null;
        this._menuCallback = null;
        this._settings = null;
        this._item = null;
        this._entries = [];
        this._focusOutIds = [];
        this._box = null;
        this._header = null;
        this._pager = null;
        this._pagerClip = null;
        this._prevBtn = null;
        this._nextBtn = null;
        this._menuBtn = null;
        this._dotsBox = null;
    }
}

function _buildStickyNotePreview({ runtimeEnv }) {
    _bindShellEnv(runtimeEnv);
    let box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.style = 'background-color: #f9e97a; border-radius: 8px; padding: 8px;';
    let headerRow = new St.BoxLayout({ x_expand: true, style: 'spacing: 4px;' });
    box.add_child(headerRow);
    headerRow.add_child(new St.Widget({ x_expand: true }));
    headerRow.add_child(new St.Label({
        text: '\u2630',
        style: 'color: rgba(92, 75, 0, 0.5); font-size: 14px;',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(new St.Label({
        text: 'Add a note...',
        style: 'color: rgba(92, 75, 0, 0.45); font-size: 11px; font-style: italic;',
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
    }));
    return box;
}

function _showStickyTextMenu({ home, entry, x, y, instance, runtimeEnv }) {
    let ct = entry.clutter_text;
    home._showHomeNativeMenuAtPoint(x, y, menu => {
        let hasSel = ct.get_selection?.() !== '';
        if (hasSel) {
            home._addHomeNativeMenuItem(menu, 'Cut', () => {
                let sel = ct.get_selection();
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, sel);
                ct.delete_selection();
            });
            home._addHomeNativeMenuItem(menu, 'Copy', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ct.get_selection());
            });
        }
        home._addHomeNativeMenuItem(menu, 'Paste', () => {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clip, text) => {
                if (!text)
                    return;
                if (ct.get_selection?.() !== '')
                    ct.delete_selection();
                let pos = ct.get_cursor_position();
                if (pos < 0)
                    pos = ct.text?.length ?? 0;
                ct.insert_text(text, pos);
            });
        });
        home._addHomeNativeMenuItem(menu, 'Select All', () => {
            global.stage.set_key_focus(ct);
            ct.set_selection(0, ct.text?.length ?? 0);
        });

        if (instance) {
            menu.addMenuItem(new runtimeEnv.PopupMenu.PopupSeparatorMenuItem());
            let ps = instance.getCurrentPageStyle();
            home._addHomeNativeMenuItem(menu, ps.bold ? 'Bold  ✓' : 'Bold', () => {
                instance.toggleBold();
            });
            home._addHomeNativeMenuItem(menu, ps.italic ? 'Italic  ✓' : 'Italic', () => {
                instance.toggleItalic();
            });
        }
    });
}

function _showStickyHamburgerMenu({ home, instance, menuBtn, runtimeEnv }) {
    let [mx, my] = menuBtn.get_transformed_position();
    let mh = menuBtn.height;
    home._showHomeNativeMenuAtPoint(mx, my + mh, menu => {
        home._addHomeNativeMenuItem(menu, 'Add Page', () => {
            instance._addPage();
        });
        if (instance._entries.length > 1) {
            home._addHomeNativeMenuItem(menu, 'Delete Page', () => {
                instance._deletePage();
            });
        }

        menu.addMenuItem(new runtimeEnv.PopupMenu.PopupSeparatorMenuItem());
        let currentIdx = instance.getColorIdx();
        for (let i = 0; i < STICKY_COLORS.length; i++) {
            let c = STICKY_COLORS[i];
            let label = i === currentIdx ? `${c.name}  ✓` : c.name;
            let colorIdx = i;
            home._addHomeNativeMenuItem(menu, label, () => {
                instance.setColorIdx(colorIdx);
                instance._save();
            });
        }
    });
}

export const STICKY_NOTE_WIDGET_DEFINITION = {
    widgetType: 'sticky_note',
    label: 'Sticky Note',
    description: 'Quick note on the home screen',
    defaultColSpan: 2,
    defaultRowSpan: 2,
    minColSpan: 1,
    minRowSpan: 1,

    createInstance({ settings, widgetItem }) {
        return new StickyNoteWidget(settings, widgetItem);
    },

    buildPreview({ runtimeEnv }) {
        return _buildStickyNotePreview({ runtimeEnv });
    },

    bindActor({ home, instance, ops, runtimeEnv }) {
        instance?.onMenu?.(menuBtn => {
            ops.cancelLongPress();
            ops.markLongPressFired();
            _showStickyHamburgerMenu({ home, instance, menuBtn, runtimeEnv });
        });
    },

    handleCapturedEvent({ event, home, button, item, instance, ops, runtimeEnv }) {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;
        let btn = event.get_button ? event.get_button() : 0;
        if (btn !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        ops.cancelLongPress();
        ops.markLongPressFired();
        let [ex, ey] = event.get_coords();
        let entry = instance?.getEntryAt?.(ex, ey);
        if (entry) {
            _showStickyTextMenu({ home, entry, x: ex, y: ey, instance, runtimeEnv });
            return Clutter.EVENT_STOP;
        }
        ops.showDefaultWidgetMenu(button, item, ex, ey);
        return Clutter.EVENT_STOP;
    },

    handleSecondaryButtonPress({ event, home, instance, runtimeEnv }) {
        let [ex, ey] = event.get_coords();
        let entry = instance?.getEntryAt?.(ex, ey);
        if (!entry)
            return false;
        _showStickyTextMenu({ home, entry, x: ex, y: ey, instance, runtimeEnv });
        return true;
    },

    shouldBypassTouchLongPress({ event }) {
        let focus = global.stage.get_key_focus();
        let source = event.get_source?.() ?? null;
        return !!(focus && source &&
            (source === focus || focus.contains?.(source) || source.contains?.(focus)));
    },

    onActivate({ instance }) {
        if (!instance)
            return true;
        if (instance._menuJustOpened) {
            instance._menuJustOpened = false;
            return true;
        }
        instance.focus();
        return true;
    },
};
