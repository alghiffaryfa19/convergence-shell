// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import { RuntimeDisposer } from './runtimeDisposer.js';

const ORDER = Object.freeze({
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
});

function _normalizeLevel(value) {
    let level = `${value ?? ''}`.toLowerCase().trim();
    if (level in ORDER)
        return level;
    return 'warn';
}

function _shouldLog(minLevel, level) {
    return ORDER[level] <= ORDER[minLevel];
}

export class Logger {
    constructor(scope, settings = null) {
        this._scope = scope;
        this._settings = settings;
        this._envLevel = _normalizeLevel(GLib.getenv('CONVERGENCE_LOG_LEVEL'));
        this._cachedLevel = null;
        this._runtimeDisposer = new RuntimeDisposer();
        if (settings) {
            try {
                this._runtimeDisposer.connect(
                    settings,
                    'changed::debug-log-level', () => { this._cachedLevel = null; });
            } catch (_e) {}
        }
    }

    _minLevel() {
        if (this._cachedLevel !== null)
            return this._cachedLevel;

        let level = this._envLevel;
        if (this._settings) {
            try {
                level = _normalizeLevel(this._settings.get_string('debug-log-level'));
            } catch (_e) {}
        }
        this._cachedLevel = level;
        return level;
    }

    _emit(level, message) {
        if (!_shouldLog(this._minLevel(), level))
            return;
        log(`[ConvergenceDesktop ${this._scope}] ${message}`);
    }

    debug(message) {
        this._emit('debug', message);
    }

    info(message) {
        this._emit('info', message);
    }

    warn(message) {
        this._emit('warn', message);
    }

    error(message) {
        this._emit('error', message);
    }

    destroy() {
        this._runtimeDisposer?.dispose?.();
        this._runtimeDisposer = null;
        this._settings = null;
    }
}
