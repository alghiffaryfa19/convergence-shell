// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {
    buildWidgetPreview as _buildWidgetPreview,
    getWidgetCatalog,
    getWidgetSizeLimits as _getWidgetSizeLimits,
} from './widgetFramework.js';

export const WIDGET_CATALOG = getWidgetCatalog();

export function getWidgetSizeLimits(widgetType, maxCols) {
    return _getWidgetSizeLimits(widgetType, maxCols);
}

export function buildWidgetPreview(widgetType, settings) {
    return _buildWidgetPreview(widgetType, settings, {
        GLib,
        Clutter,
        St,
    });
}
