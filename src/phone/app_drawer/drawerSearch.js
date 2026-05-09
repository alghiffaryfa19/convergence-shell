// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import { Logger } from '../../shared/utilities/logger.js';
import { RuntimeDisposer } from '../../shared/utilities/runtimeDisposer.js';

const SEARCH_DEBOUNCE_MS = 80;

const SETTINGS_PANELS = [
    { panel: 'wifi', label: 'Wi-Fi settings', keys: ['wifi', 'wi-fi', 'wireless', 'network'] },
    { panel: 'network', label: 'Network settings', keys: ['network', 'ethernet', 'vpn'] },
    { panel: 'bluetooth', label: 'Bluetooth settings', keys: ['bluetooth', 'bt'] },
    { panel: 'display', label: 'Display settings', keys: ['display', 'screen', 'resolution', 'monitor'] },
    { panel: 'sound', label: 'Sound settings', keys: ['sound', 'audio', 'volume', 'mic', 'speaker'] },
    { panel: 'power', label: 'Power settings', keys: ['power', 'battery'] },
    { panel: 'keyboard', label: 'Keyboard settings', keys: ['keyboard', 'layout', 'typing'] },
    { panel: 'mouse', label: 'Mouse & Touchpad settings', keys: ['mouse', 'touchpad', 'pointer'] },
    { panel: 'privacy', label: 'Privacy settings', keys: ['privacy', 'permissions', 'security'] },
    { panel: 'notifications', label: 'Notifications settings', keys: ['notifications', 'alerts', 'do not disturb'] },
    { panel: 'background', label: 'Background settings', keys: ['background', 'wallpaper'] },
];

const WHITESPACE_RE = /\s+/g;

/**
 * Phone drawer search handler.
 *
 * Provides debounced search-as-you-type filtering, ranked scoring of app
 * results, keyboard navigation (Enter to launch top result, Escape to
 * clear/collapse), inline math evaluation, and system-settings quick actions.
 */
export class DrawerSearch {
    /**
     * @param {import('./appDrawer.js').AppDrawer} drawer - Parent drawer.
     * @param {import('gi://Gio').Settings|null} settings - Extension GSettings.
     */
    constructor(drawer, settings) {
        this._drawer = drawer;
        this._settings = settings ?? null;
        this._logger = new Logger('DrawerSearch', this._settings);
        this._runtimeDisposer = new RuntimeDisposer();
        this._searchFieldCache = new Map();
    }

    // ── Search text change ────────────────────────────────────────────

    /** Called when the search entry text changes (debounced). */
    onSearchChanged() {
        let d = this._drawer;
        let text = d._searchEntry.get_text().trim();
        if (text.length > 0 && d._launchpadEditMode)
            d._setLaunchpadEditMode(false);
        this._runtimeDisposer.restartTimeout(
            d, '_searchDebounceId',
            GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS,
            () => {
                d._populateGrid(text);
                return GLib.SOURCE_REMOVE;
            });
    }

    // ── Keyboard interaction ──────────────────────────────────────────

    /**
     * Handle key-press events on the search entry.
     * @param {Clutter.Event} event
     * @returns {number}
     */
    onSearchKeyPress(event) {
        let d = this._drawer;
        let key = event.get_key_symbol();

        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            if (this._activateTopSearchResult())
                return Clutter.EVENT_STOP;
        } else if (key === Clutter.KEY_Escape) {
            let text = d._searchEntry?.get_text?.()?.trim() ?? '';
            if (text.length > 0) {
                d._searchEntry.set_text('');
                this.onSearchChanged();
            } else {
                d.collapse();
            }
            return Clutter.EVENT_STOP;
        } else if (key === Clutter.KEY_Down ||
                   key === Clutter.KEY_Up ||
                   key === Clutter.KEY_Left ||
                   key === Clutter.KEY_Right ||
                   key === Clutter.KEY_Tab) {
            let first = d._gridButtonMap?.[0]?.btn;
            if (first) {
                global.stage.set_key_focus(first);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ── Search scoring ────────────────────────────────────────────────

    /**
     * Score and filter apps against a search query.
     * @param {Array} allApps - Array of Shell.App objects.
     * @param {string} query - Normalized search query.
     * @returns {Array} Sorted array of matching apps (highest score first).
     */
    scoreAndFilter(allApps, query) {
        if (!query)
            return allApps;
        let normalized = this._normalizeSearchText(query);
        let terms = normalized.split(' ').filter(Boolean);
        if (terms.length === 0)
            return allApps;

        let scored = [];
        for (let app of allApps) {
            let score = this._scoreSearchApp(app, normalized, terms);
            if (score > 0)
                scored.push({ app, score });
        }
        scored.sort((a, b) => b.score - a.score);

        let d = this._drawer;
        if (scored.length > 0) {
            d._searchTopAppId = scored[0].app.get_id();
            d._searchTopItem = { type: 'app', id: d._searchTopAppId };
        } else {
            d._searchTopAppId = null;
            d._searchTopItem = null;
        }

        let actions = this._buildSearchActionItems(query, normalized);
        if (actions.length > 0 && (!d._searchTopItem || d._searchTopItem.type !== 'action'))
            d._searchTopItem = actions[0];

        return scored.map(s => s.app);
    }

    /**
     * Score an individual app against search terms.
     * @param {Shell.App} app
     * @param {string} query - Normalized full query.
     * @param {string[]} terms - Individual search terms.
     * @returns {number} Score (0 = no match).
     */
    _scoreSearchApp(app, query, terms) {
        if (!query)
            return 0;
        if (!terms) {
            terms = query.split(' ').filter(Boolean);
            if (terms.length === 0)
                return 0;
        }

        let { name, id, idBase, keywords, acronym } = this._extractSearchFields(app);
        let haystacks = [name, idBase, id, keywords];

        let score = 0;
        let exactHit = false;
        for (let term of terms) {
            let termMatched = false;
            for (let h of haystacks) {
                if (!h)
                    continue;
                if (h === term) {
                    score += 140;
                    termMatched = true;
                    exactHit = true;
                    break;
                }
                if (h.startsWith(term)) {
                    score += 95;
                    termMatched = true;
                    break;
                }
                let idx = h.indexOf(term);
                if (idx >= 0) {
                    score += Math.max(45, 72 - Math.min(idx, 24));
                    termMatched = true;
                    break;
                }
            }
            if (!termMatched)
                return 0;
        }

        if (name === query || idBase === query)
            score += 240;
        else if (name.startsWith(query))
            score += 140;
        else if (name.includes(query) || idBase.includes(query) ||
                 id.includes(query) || keywords.includes(query))
            score += 70;

        if (acronym.startsWith(query))
            score += 95;

        if (exactHit)
            score += 40;
        if (app.get_state?.() === Shell.AppState.RUNNING)
            score += 18;
        try {
            let pinnedApps = this._drawer?._dockPinnedApps;
            if (pinnedApps ? pinnedApps.isFavorite(app.get_id())
                           : AppFavorites.getAppFavorites().isFavorite(app.get_id()))
                score += 12;
        } catch (_e) {}

        return score;
    }

    /**
     * Extract and cache normalized search fields from an app.
     * @param {Shell.App} app
     * @returns {{ name: string, id: string, idBase: string, keywords: string, acronym: string }}
     */
    _extractSearchFields(app) {
        let appId = app.get_id?.() ?? '';
        let cached = this._searchFieldCache.get(appId);
        if (cached)
            return cached;

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
        if (appId)
            this._searchFieldCache.set(appId, fields);
        return fields;
    }

    /**
     * Normalize text for search comparison.
     * @param {string} text
     * @returns {string}
     */
    _normalizeSearchText(text) {
        return `${text ?? ''}`.toLowerCase().trim().replace(WHITESPACE_RE, ' ');
    }

    // ── Action items ──────────────────────────────────────────────────

    /**
     * Build inline action items for a search query (settings panels, calculator).
     * @param {string} rawQuery - Original query text.
     * @param {string} query - Normalized query.
     * @returns {Array}
     */
    _buildSearchActionItems(rawQuery, query) {
        if (!query)
            return [];
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
     * Execute an inline search action item.
     * @param {object} item
     * @returns {boolean} True if handled.
     */
    _executeSearchAction(item) {
        if (!item || item.type !== 'action')
            return false;
        try {
            if (item.action === 'settings-panel') {
                Gio.Subprocess.new(
                    ['gnome-control-center', item.payload ?? ''],
                    Gio.SubprocessFlags.NONE);
                this._drawer.collapse();
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

    /** @private */
    _isSimpleMathExpression(query) {
        return /^[\d\s+\-*/().,%]+$/.test(query);
    }

    /** @private */
    _evaluateMathExpression(query) {
        try {
            let normalized = `${query}`.replace(/,/g, '.').trim();
            if (!this._isSimpleMathExpression(normalized))
                return null;
            // eslint-disable-next-line no-new-func
            let fn = Function(`"use strict"; return (${normalized});`);
            let val = fn();
            if (!Number.isFinite(val))
                return null;
            return `${val}`;
        } catch (_e) {
            return null;
        }
    }

    // ── Top result activation ─────────────────────────────────────────

    /**
     * Activate the top search result (Enter key handler).
     * @returns {boolean}
     */
    _activateTopSearchResult() {
        let d = this._drawer;
        if (!d._searchTopItem)
            return false;
        if (d._searchTopItem.type === 'action')
            return this._executeSearchAction(d._searchTopItem);

        let appId = d._searchTopItem.id ?? d._searchTopAppId;
        let app = Shell.AppSystem.get_default().lookup_app(appId);
        if (!app)
            return false;

        if (d._controller?.activateApp)
            d._controller.activateApp(app, d._getLayoutMonitorIndex?.());
        else
            app.activate();
        d.collapse();
        return true;
    }

    /** Release cached search field data. */
    destroy() {
        this._searchFieldCache.clear();
        this._runtimeDisposer.dispose();
        this._logger?.destroy?.();
    }
}
