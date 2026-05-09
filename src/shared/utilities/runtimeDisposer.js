// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';

export class RuntimeDisposer {
    constructor() {
        this._connections = [];
        this._timeouts = new Set();
        this._grabs = new Set();
    }

    connect(object, signal, callback) {
        if (!object || typeof object.connect !== 'function')
            return 0;
        let id = object.connect(signal, callback);
        this._connections.push({ object, id });
        return id;
    }

    trackConnection(object, id) {
        if (!object || !id) return;
        this._connections.push({ object, id });
    }

    untrackConnection(object, id) {
        let idx = this._connections.findIndex(
            entry => entry.object === object && entry.id === id);
        if (idx >= 0)
            this._connections.splice(idx, 1);
    }

    clearConnectionRef(state, key, object = null) {
        let id = state?.[key] ?? 0;
        if (!id)
            return;
        let target = object ?? this._connections.find(entry => entry.id === id)?.object;
        this.untrackConnection(target, id);
        if (target && typeof target.disconnect === 'function') {
            try {
                target.disconnect(id);
            } catch (e) {
                // Object may already be disposed.
            }
        }
        state[key] = 0;
    }

    replaceConnection(state, key, object, signal, callback) {
        this.clearConnectionRef(state, key, object);
        let id = this.connect(object, signal, callback);
        state[key] = id;
        return id;
    }

    trackTimeout(id) {
        if (id)
            this._timeouts.add(id);
    }

    untrackTimeout(id) {
        if (id)
            this._timeouts.delete(id);
    }

    clearTimeoutRef(state, key) {
        let id = state?.[key] ?? 0;
        if (!id)
            return;
        this.untrackTimeout(id);
        try {
            GLib.source_remove(id);
        } catch (e) {
            // Source may already be removed.
        }
        state[key] = 0;
    }

    restartTimeout(state, key, priority, delayMs, callback) {
        this.clearTimeoutRef(state, key);
        if (!state._rtCb) state._rtCb = {};
        state._rtCb[key] = callback;
        if (!state._rtWrap) state._rtWrap = {};
        let wrapper = state._rtWrap[key];
        if (!wrapper) {
            wrapper = state._rtWrap[key] = () => {
                let currentId = state[key];
                let result = state._rtCb[key]();
                if (result !== GLib.SOURCE_CONTINUE) {
                    this.untrackTimeout(currentId);
                    if (state[key] === currentId)
                        state[key] = 0;
                }
                return result;
            };
        }
        let id = GLib.timeout_add(priority, delayMs, wrapper);
        state[key] = id;
        this.trackTimeout(id);
        return id;
    }

    trackGrab(grab) {
        if (grab)
            this._grabs.add(grab);
    }

    untrackGrab(grab) {
        if (grab)
            this._grabs.delete(grab);
    }

    disconnectAll() {
        for (let { object, id } of this._connections) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Object may already be disposed.
            }
        }
        this._connections = [];
    }

    removeAllTimeouts() {
        for (let id of this._timeouts) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Source may already be removed.
            }
        }
        this._timeouts.clear();
    }

    dismissAllGrabs() {
        for (let grab of this._grabs) {
            try {
                grab.dismiss();
            } catch (e) {
                // Grab may already be invalid.
            }
        }
        this._grabs.clear();
    }

    dispose() {
        this.dismissAllGrabs();
        this.removeAllTimeouts();
        this.disconnectAll();
    }
}
