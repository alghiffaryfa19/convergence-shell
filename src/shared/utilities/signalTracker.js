// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

export class SignalTracker {
    constructor() {
        this._connections = [];
    }

    connect(object, signal, callback) {
        if (!object || typeof object.connect !== 'function')
            return 0;

        let id = object.connect(signal, callback);
        this._connections.push({ object, id });
        return id;
    }

    disconnectAll() {
        for (let { object, id } of this._connections) {
            try {
                object.disconnect(id);
            } catch (e) {
                // Actor/object may already be gone.
            }
        }
        this._connections = [];
    }
}
