// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import { RuntimeDisposer } from '../../utilities/runtimeDisposer.js';
import { getWidgetPreference } from './widgetInstanceStore.js';

let Clutter = null;
let St = null;

function _bindShellEnv(runtimeEnv) {
    Clutter = runtimeEnv?.Clutter ?? Clutter;
    St = runtimeEnv?.St ?? St;
    if (!Clutter || !St)
        throw new Error('Weather widget requires shell runtime env');
}

const _utf8Decoder = new TextDecoder('utf-8');
const _utf8Encoder = new TextEncoder();
const FADE_DURATION = 400;

function fadeLabel(label, newText) {
    if (!label) return;
    if (label.text === newText) return;
    label.remove_all_transitions();
    label.ease({
        opacity: 0, duration: FADE_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
            if (!label.get_parent()) return;
            label.set_text(newText);
            label.ease({
                opacity: 255, duration: FADE_DURATION,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
        },
    });
}

const CACHE_FILE = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'convergence-weather-cache.json',
]);

function loadDiskCache() {
    try {
        let [ok, data] = GLib.file_get_contents(CACHE_FILE);
        if (ok && data) {
            let obj = JSON.parse(_utf8Decoder.decode(data));
            if (obj && obj.weatherData && obj.location) {
                if (!obj.timestamp && obj.wallTime)
                    obj.timestamp = obj.wallTime;
                return obj;
            }
        }
    } catch (_e) {}
    return null;
}

function saveDiskCache(cache) {
    try {
        let json = JSON.stringify({
            location: cache.location,
            geoName: cache.geoName,
            geoLat: cache.geoLat,
            geoLon: cache.geoLon,
            timestamp: cache.timestamp,
            weatherData: cache.weatherData,
        });
        let file = Gio.File.new_for_path(CACHE_FILE);
        file.replace_contents(
            _utf8Encoder.encode(json),
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (_e) {}
}

let _sharedSession = null;
function getSession() {
    if (!_sharedSession)
        _sharedSession = new Soup.Session();
    return _sharedSession;
}

let _fetchInFlight = false;
let _diskCacheLoaded = false;
let _refreshTimerId = 0;
let _retryTimerId = 0;
let _interpolateTimerId = 0;
let _requestSerial = 0;
let _subscribers = new Set();

const RETRY_DELAY_SECONDS = 30;
const INTERPOLATE_SECONDS = 10 * 60;
const WEATHER_REFRESH_SECONDS = 60 * 60;

export const WMO_CODES = {
    0:  { desc: 'Clear',          icon: '\u2600',  iconName: 'weather-clear-symbolic' },
    1:  { desc: 'Mostly Clear',   icon: '\u{1F324}', iconName: 'weather-few-clouds-symbolic' },
    2:  { desc: 'Partly Cloudy',  icon: '\u26C5',  iconName: 'weather-few-clouds-symbolic' },
    3:  { desc: 'Overcast',       icon: '\u2601',  iconName: 'weather-overcast-symbolic' },
    45: { desc: 'Foggy',          icon: '\u{1F32B}', iconName: 'weather-fog-symbolic' },
    48: { desc: 'Rime Fog',       icon: '\u{1F32B}', iconName: 'weather-fog-symbolic' },
    51: { desc: 'Light Drizzle',  icon: '\u{1F326}', iconName: 'weather-showers-scattered-symbolic' },
    53: { desc: 'Drizzle',        icon: '\u{1F326}', iconName: 'weather-showers-scattered-symbolic' },
    55: { desc: 'Heavy Drizzle',  icon: '\u{1F327}', iconName: 'weather-showers-symbolic' },
    61: { desc: 'Light Rain',     icon: '\u{1F326}', iconName: 'weather-showers-scattered-symbolic' },
    63: { desc: 'Rain',           icon: '\u{1F327}', iconName: 'weather-showers-symbolic' },
    65: { desc: 'Heavy Rain',     icon: '\u{1F327}', iconName: 'weather-showers-symbolic' },
    71: { desc: 'Light Snow',     icon: '\u{1F328}', iconName: 'weather-snow-symbolic' },
    73: { desc: 'Snow',           icon: '\u{1F328}', iconName: 'weather-snow-symbolic' },
    75: { desc: 'Heavy Snow',     icon: '\u{1F328}', iconName: 'weather-snow-symbolic' },
    80: { desc: 'Rain Showers',   icon: '\u{1F327}', iconName: 'weather-showers-symbolic' },
    81: { desc: 'Heavy Showers',  icon: '\u{1F327}', iconName: 'weather-showers-symbolic' },
    82: { desc: 'Violent Showers', icon: '\u{1F327}', iconName: 'weather-showers-symbolic' },
    95: { desc: 'Thunderstorm',   icon: '\u26C8',  iconName: 'weather-storm-symbolic' },
    96: { desc: 'Hail Storm',     icon: '\u26C8',  iconName: 'weather-storm-symbolic' },
    99: { desc: 'Heavy Hail',     icon: '\u26C8',  iconName: 'weather-storm-symbolic' },
};

export const weatherCache = {
    location: null,
    timestamp: 0,
    geoName: null,
    weatherData: null,
    geoLat: null,
    geoLon: null,
};

function nowWallSeconds() { return Math.floor(Date.now() / 1000); }
function applyCacheUpdate(update) { Object.assign(weatherCache, update); }

function broadcastWeather(displayName, wxData) {
    for (let w of _subscribers) {
        if (!w._destroyed) w._applyWeatherData(displayName, wxData);
    }
    ensureInterpolateTimer(true);
}

function broadcastError(message) {
    for (let w of _subscribers) {
        if (!w._destroyed) w._showWeatherError(message);
    }
}

function ensureRefreshTimer(reset = false) {
    if (_subscribers.size === 0) return;
    if (reset) clearRefreshTimer();
    else if (_refreshTimerId) return;
    _refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
        WEATHER_REFRESH_SECONDS, () => {
            _refreshTimerId = 0;
            if (_subscribers.size === 0) return GLib.SOURCE_REMOVE;
            let w = [..._subscribers].find(w => !w._destroyed);
            if (w) w._fetchWeather();
            return GLib.SOURCE_REMOVE;
        });
}

function clearRefreshTimer() {
    if (_refreshTimerId) { GLib.source_remove(_refreshTimerId); _refreshTimerId = 0; }
}

function scheduleSharedRetry() {
    if (_retryTimerId || _subscribers.size === 0) return;
    _retryTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
        RETRY_DELAY_SECONDS, () => {
            _retryTimerId = 0;
            if (_subscribers.size === 0) return GLib.SOURCE_REMOVE;
            let w = [..._subscribers].find(w => !w._destroyed);
            if (w) w._fetchWeather();
            return GLib.SOURCE_REMOVE;
        });
}

function clearSharedRetry() {
    if (_retryTimerId) { GLib.source_remove(_retryTimerId); _retryTimerId = 0; }
}

function interpolateFromCache() {
    let wxData = weatherCache.weatherData;
    if (!wxData?.hourly) return;
    let hourly = wxData.hourly;
    let times = hourly.time;
    if (!times || times.length < 2) return;
    let nowMs = Date.now();
    let prevIdx = -1;
    for (let i = 0; i < times.length; i++) {
        if (new Date(times[i]).getTime() > nowMs) {
            prevIdx = Math.max(0, i - 1);
            break;
        }
    }
    if (prevIdx < 0) prevIdx = times.length - 2;
    let nextIdx = Math.min(prevIdx + 1, times.length - 1);
    let t0 = new Date(times[prevIdx]).getTime();
    let t1 = new Date(times[nextIdx]).getTime();
    let frac = t1 > t0 ? Math.max(0, Math.min(1, (nowMs - t0) / (t1 - t0))) : 0;
    let temp = Math.round(hourly.temperature_2m[prevIdx] +
        (hourly.temperature_2m[nextIdx] - hourly.temperature_2m[prevIdx]) * frac);
    let code = frac < 0.5 ? hourly.weather_code[prevIdx] : hourly.weather_code[nextIdx];
    let info = WMO_CODES[code] || { desc: 'Unknown', icon: '\u2601', iconName: 'weather-overcast-symbolic' };
    for (let w of _subscribers) {
        if (w._destroyed) continue;
        fadeLabel(w._tempLabel, `${temp}\u00B0`);
        fadeLabel(w._conditionLabel, info.desc);
        fadeLabel(w._iconLabel, info.icon || '\u2601');
        w._populateForecasts(hourly);
    }
}

function ensureInterpolateTimer(reset = false) {
    if (_subscribers.size === 0) return;
    if (reset) clearInterpolateTimer();
    else if (_interpolateTimerId) return;
    _interpolateTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
        INTERPOLATE_SECONDS, () => {
            _interpolateTimerId = 0;
            if (_subscribers.size === 0) return GLib.SOURCE_REMOVE;
            interpolateFromCache();
            ensureInterpolateTimer();
            return GLib.SOURCE_REMOVE;
        });
}

function clearInterpolateTimer() {
    if (_interpolateTimerId) { GLib.source_remove(_interpolateTimerId); _interpolateTimerId = 0; }
}

function subscribeWidget(widget) {
    _subscribers.add(widget);
    ensureRefreshTimer();
    ensureInterpolateTimer();
}

function unsubscribeWidget(widget) {
    _subscribers.delete(widget);
    if (_subscribers.size === 0) {
        clearRefreshTimer();
        clearSharedRetry();
        clearInterpolateTimer();
        if (_sharedSession) { _sharedSession.abort(); _sharedSession = null; }
        _diskCacheLoaded = false;
    }
}

/**
 * Weather widget displaying current conditions and hourly forecasts
 * using Open-Meteo API data.
 */
export class WeatherWidget {
    constructor(settings, item = null) {
        this._settings = settings;
        this._item = item ?? null;
        this._tempLabel = null;
        this._conditionLabel = null;
        this._locationLabel = null;
        this._iconLabel = null;
        this._highLowLabel = null;
        this._detailsLabel = null;
        this._forecastContainer = null;
        this._forecastSection = null;
        this._refreshButton = null;
        this._updatedLabel = null;
        this._colSpan = 2;
        this._rowSpan = 1;
        this._pixelW = 0;
        this._pixelH = 0;
        this._scale = 1;
        this._destroyed = false;
        this._runtimeDisposer = new RuntimeDisposer();
    }

    /**
     * Build the weather widget content.
     * @param {number} w - Available width.
     * @param {number} h - Available height.
     * @param {number} colSpan
     * @param {number} rowSpan
     * @returns {St.Widget}
     */
    buildContent(w, h, colSpan, rowSpan, _monitor, _gridMetrics, runtimeEnv = null) {
        _bindShellEnv(runtimeEnv);
        this._colSpan = colSpan || 2;
        this._rowSpan = rowSpan || 1;
        this._pixelW = w;
        this._pixelH = h;

        let isWide = this._colSpan >= 3;
        let isTall = this._rowSpan >= 2;
        let refH = isTall ? (isWide ? 178 : 160) : 108;
        this._scale = Math.max(0.85, Math.min(1.6, Math.min(h / refH, w / 180)));
        let s = this._scale;
        let borderR = Math.round(12 * s);

        let wrapper = new St.Widget({
            x_expand: true, y_expand: true,
            layout_manager: new Clutter.BinLayout(),
            style: `border-radius: ${borderR}px;`,
            clip_to_allocation: true,
        });
        wrapper.add_child(new St.Widget({
            x_expand: true, y_expand: true,
            style: `background-color: rgba(0, 0, 0, 0.45); border-radius: ${borderR}px;`,
        }));

        let box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'convergence-widget-weather-content',
            style: `padding: ${Math.round(12 * s)}px ${Math.round(16 * s)}px;`,
            clip_to_allocation: true,
        });
        wrapper.add_child(box);

        if (isWide && !isTall) this._buildWideLayout(box);
        else if (isTall) this._buildTallLayout(box, isWide);
        else this._buildCompactLayout(box);

        if (this._settings) {
            let onLocationChange = () => {
                if (this._destroyed) return;
                applyCacheUpdate({ location: null, timestamp: 0, geoName: null, weatherData: null, geoLat: null, geoLon: null });
                this._locationLabel.set_text(this._getLocation());
                this._fetchWeather();
            };
            this._runtimeDisposer.connect(this._settings, 'changed::widget-weather-location', onLocationChange);
            this._runtimeDisposer.connect(this._settings, 'changed::demo-mode', onLocationChange);
        }

        subscribeWidget(this);
        this._fetchWeather();
        return wrapper;
    }

    _buildCurrentWeatherGroup() {
        let s = this._scale;
        let group = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER });

        let topRow = new St.BoxLayout({ vertical: false, x_expand: true, x_align: Clutter.ActorAlign.FILL });
        group.add_child(topRow);

        let leftCol = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        topRow.add_child(leftCol);

        this._tempLabel = new St.Label({
            text: '--\u00B0',
            style_class: 'convergence-widget-weather-temp',
            style: `font-size: ${Math.round(32 * s)}px;`,
        });
        leftCol.add_child(this._tempLabel);

        this._conditionLabel = new St.Label({
            text: 'Loading\u2026',
            style_class: 'convergence-widget-weather-condition',
            style: `font-size: ${Math.round(11 * s)}px;`,
        });
        leftCol.add_child(this._conditionLabel);

        this._iconLabel = new St.Label({
            text: '\u2601',
            style_class: 'convergence-widget-weather-icon',
            style: `font-size: ${Math.round(28 * s)}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(this._iconLabel);

        let locationRow = new St.BoxLayout({ vertical: false, x_expand: true, x_align: Clutter.ActorAlign.FILL });
        group.add_child(locationRow);

        this._locationLabel = new St.Label({
            text: this._getLocation(),
            style_class: 'convergence-widget-weather-location',
            style: `font-size: ${Math.round(10 * s)}px;`,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        locationRow.add_child(this._locationLabel);

        if (this._colSpan >= 3 || this._rowSpan >= 2) {
            this._updatedLabel = new St.Label({
                text: '',
                style: `font-size: ${Math.round(8 * s)}px; color: rgba(255,255,255,0.45); margin-right: ${Math.round(4 * s)}px;`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            locationRow.add_child(this._updatedLabel);
        }

        this._refreshButton = new St.Button({
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: Math.max(12, Math.round(12 * s)),
                style: 'color: rgba(255,255,255,0.6);',
            }),
            style_class: 'convergence-widget-weather-refresh',
            style: `padding: ${Math.round(2 * s)}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._refreshButton.connect('clicked', () => {
            applyCacheUpdate({ timestamp: 0, weatherData: null });
            this._conditionLabel?.set_text('Refreshing\u2026');
            if (this._updatedLabel) this._updatedLabel.set_text('');
            this._fetchWeather();
        });
        locationRow.add_child(this._refreshButton);

        return group;
    }

    _buildCompactLayout(box) { box.add_child(this._buildCurrentWeatherGroup()); }

    _buildWideLayout(box) {
        let s = this._scale;
        let mainRow = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.FILL });
        box.add_child(mainRow);
        mainRow.add_child(this._buildCurrentWeatherGroup());

        this._forecastSection = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: true, visible: false });
        mainRow.add_child(this._forecastSection);
        this._forecastSection.add_child(new St.Widget({
            style_class: 'convergence-widget-weather-separator-v',
            style: `margin: ${Math.round(4 * s)}px ${Math.round(8 * s)}px;`,
            y_expand: true,
        }));
        this._forecastContainer = new St.BoxLayout({
            vertical: false, x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'convergence-widget-weather-forecast-row',
            style: `spacing: ${Math.round(2 * s)}px;`,
            clip_to_allocation: true,
        });
        this._forecastSection.add_child(this._forecastContainer);
    }

    _buildTallLayout(box, isWide) {
        let s = this._scale;
        box.add_child(this._buildCurrentWeatherGroup());

        if (isWide) {
            let detailRow = new St.BoxLayout({
                vertical: false, x_expand: true,
                style_class: 'convergence-widget-weather-detail-row',
                style: `margin-top: ${Math.round(2 * s)}px; spacing: ${Math.round(8 * s)}px;`,
            });
            box.add_child(detailRow);
            this._highLowLabel = new St.Label({ text: '', style_class: 'convergence-widget-weather-detail-text', style: `font-size: ${Math.round(10 * s)}px;`, x_expand: true });
            detailRow.add_child(this._highLowLabel);
            this._detailsLabel = new St.Label({ text: '', style_class: 'convergence-widget-weather-detail-text', style: `font-size: ${Math.round(10 * s)}px;` });
            detailRow.add_child(this._detailsLabel);
        }

        this._forecastSection = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, visible: false });
        box.add_child(this._forecastSection);
        this._forecastSection.add_child(new St.Widget({
            style_class: 'convergence-widget-weather-separator-h',
            style: `margin: ${Math.round(4 * s)}px 0;`, x_expand: true,
        }));
        this._forecastContainer = new St.BoxLayout({
            vertical: false, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START,
            style_class: 'convergence-widget-weather-forecast-row',
            style: `spacing: ${Math.round(2 * s)}px;`,
            clip_to_allocation: true,
        });
        this._forecastSection.add_child(this._forecastContainer);
    }

    _getMaxForecastSlots() {
        let isWide = this._colSpan >= 3;
        let isTall = this._rowSpan >= 2;
        let s = this._scale;
        let slotWidth = Math.round(44 * s);
        let contentPad = Math.round(16 * s) * 2;
        let innerW = this._pixelW - contentPad;
        if (isWide && !isTall) {
            let available = innerW - Math.round(110 * s) - Math.round(17 * s);
            return Math.max(1, Math.floor(available / slotWidth));
        } else if (isTall) {
            return Math.max(2, Math.floor(innerW / slotWidth));
        }
        return 0;
    }

    _populateForecasts(hourlyData) {
        if (!this._forecastContainer || this._destroyed) return;
        let fc = this._forecastContainer;
        fc.remove_all_transitions();
        let needsFade = fc.get_n_children() > 0;
        if (needsFade) {
            fc.ease({
                opacity: 0, duration: FADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._destroyed || !fc.get_parent()) return;
                    this._rebuildForecasts(hourlyData);
                    fc.ease({ opacity: 255, duration: FADE_DURATION, mode: Clutter.AnimationMode.EASE_IN_QUAD });
                },
            });
            return;
        }
        this._rebuildForecasts(hourlyData);
    }

    _rebuildForecasts(hourlyData) {
        if (!this._forecastContainer || this._destroyed) return;
        this._forecastContainer.destroy_all_children();
        let maxSlots = this._getMaxForecastSlots();
        if (maxSlots <= 0 || !hourlyData) {
            if (this._forecastSection) this._forecastSection.hide();
            return;
        }
        let now = GLib.DateTime.new_now_local();
        if (!now) return;
        let currentHour = now.get_hour();
        let currentDate = now.format('%Y-%m-%d');
        let startIdx = -1;
        for (let i = 0; i < hourlyData.time.length; i++) {
            let t = hourlyData.time[i];
            let [date, time] = t.split('T');
            let hour = parseInt(time.split(':')[0], 10);
            if (date > currentDate || (date === currentDate && hour > currentHour)) {
                startIdx = i;
                break;
            }
        }
        if (startIdx < 0) { if (this._forecastSection) this._forecastSection.hide(); return; }
        let count = Math.min(maxSlots, hourlyData.time.length - startIdx);
        let isTall = this._rowSpan >= 2;
        let s = this._scale;
        let timeFontSize = isTall ? Math.round(10 * s) : Math.round(8 * s);
        let iconFontSize = isTall ? Math.round(18 * s) : Math.round(14 * s);
        let tempFontSize = isTall ? Math.round(11 * s) : Math.round(9 * s);
        let timeRowH = isTall ? Math.round(14 * s) : Math.round(12 * s);
        let iconRowH = isTall ? Math.round(24 * s) : Math.round(18 * s);
        let tempRowH = isTall ? Math.round(16 * s) : Math.round(13 * s);
        for (let i = 0; i < count; i++) {
            let idx = startIdx + i;
            let hour = hourlyData.time[idx].split('T')[1].substring(0, 5);
            let temp = Math.round(hourlyData.temperature_2m[idx]);
            let code = hourlyData.weather_code[idx];
            let info = WMO_CODES[code] || { desc: 'Unknown', icon: '\u2601' };
            let slot = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'convergence-widget-weather-forecast-slot',
                style: `spacing: ${Math.round(1 * s)}px; padding: ${Math.round(1 * s)}px ${Math.round(2 * s)}px;`,
            });
            slot.add_child(new St.Label({
                text: hour, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER, height: timeRowH,
                style_class: isTall ? 'convergence-widget-weather-forecast-time' : 'convergence-widget-weather-forecast-time-sm',
                style: `font-size: ${timeFontSize}px;`,
            }));
            slot.add_child(new St.Label({
                text: info.icon || '\u2601', x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER, height: iconRowH,
                style_class: isTall ? 'convergence-widget-weather-forecast-icon' : 'convergence-widget-weather-forecast-icon-sm',
                style: `font-size: ${iconFontSize}px; text-align: center;`,
            }));
            slot.add_child(new St.Label({
                text: `${temp}\u00B0`, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER, height: tempRowH,
                style_class: isTall ? 'convergence-widget-weather-forecast-temp' : 'convergence-widget-weather-forecast-temp-sm',
                style: `font-size: ${tempFontSize}px;`,
            }));
            this._forecastContainer.add_child(slot);
        }
        if (this._forecastSection) this._forecastSection.show();
    }

    _getLocation() {
        let widgetLocation = getWidgetPreference(this._item, 'location', null);
        if (typeof widgetLocation === 'string' && widgetLocation.trim() !== '')
            return widgetLocation.trim();
        if (this._settings) {
            try { if (this._settings.get_boolean('demo-mode')) return 'London'; } catch (_e) {}
            try {
                let loc = this._settings.get_string('widget-weather-location');
                if (loc && loc.trim() !== '') return loc.trim();
            } catch (_e) {}
        }
        return 'London, United Kingdom';
    }

    _fetchWeather() {
        if (this._destroyed) return;
        let city = this._getLocation();
        let now = nowWallSeconds();

        if (weatherCache.weatherData && weatherCache.location === city &&
            now - weatherCache.timestamp < WEATHER_REFRESH_SECONDS) {
            this._applyWeatherData(weatherCache.geoName || city, weatherCache.weatherData);
            return;
        }

        if (!_diskCacheLoaded) {
            _diskCacheLoaded = true;
            let disk = loadDiskCache();
            if (disk && disk.location === city) {
                applyCacheUpdate({ location: disk.location, geoName: disk.geoName, geoLat: disk.geoLat, geoLon: disk.geoLon, weatherData: disk.weatherData, timestamp: disk.timestamp || 0 });
                this._applyWeatherData(disk.geoName || city, disk.weatherData);
                if (disk.timestamp && now - disk.timestamp < WEATHER_REFRESH_SECONDS) return;
            }
        }

        if (_fetchInFlight) return;
        _fetchInFlight = true;
        clearSharedRetry();
        let requestSerial = ++_requestSerial;

        let onComplete = (displayName, wxData, errorMessage = null) => {
            if (requestSerial !== _requestSerial) return;
            _fetchInFlight = false;
            if (errorMessage) { broadcastError(errorMessage); scheduleSharedRetry(); return; }
            broadcastWeather(displayName, wxData);
            ensureRefreshTimer(true);
        };

        let fetchWeatherData = (latitude, longitude, displayName) => {
            let url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&hourly=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=2`;
            this._fetchUrl(url, (err, wxData) => {
                if (this._destroyed) { _fetchInFlight = false; return; }
                if (err || !wxData?.current) { onComplete(null, null, 'Data unavailable'); return; }
                applyCacheUpdate({ location: city, timestamp: nowWallSeconds(), geoName: displayName, weatherData: wxData });
                saveDiskCache(weatherCache);
                onComplete(displayName, wxData);
            });
        };

        if (weatherCache.geoLat != null && weatherCache.location === city) {
            fetchWeatherData(weatherCache.geoLat, weatherCache.geoLon, weatherCache.geoName || city);
            return;
        }

        this._fetchUrl(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
            (err, geoData) => {
                if (this._destroyed) { _fetchInFlight = false; return; }
                if (err || !geoData?.results?.length) {
                    onComplete(null, null, 'Location not found');
                    return;
                }
                let { latitude, longitude, name } = geoData.results[0];
                let displayName = name || city;
                this._locationLabel.set_text(displayName);
                weatherCache.geoLat = latitude;
                weatherCache.geoLon = longitude;
                weatherCache.location = city;
                weatherCache.geoName = displayName;
                fetchWeatherData(latitude, longitude, displayName);
            });
    }

    _showWeatherError(message) {
        if (this._destroyed) return;
        this._conditionLabel?.set_text(message);
        this._tempLabel?.set_text('--\u00B0');
        this._iconLabel?.set_text('\u2601');
    }

    _applyWeatherData(displayName, wxData) {
        if (this._destroyed) return;
        fadeLabel(this._locationLabel, displayName);
        let current = wxData.current;
        let temp = Math.round(current.temperature_2m);
        let code = current.weather_code;
        let info = WMO_CODES[code] || { desc: 'Unknown', icon: '\u2601' };
        fadeLabel(this._tempLabel, `${temp}\u00B0`);
        fadeLabel(this._conditionLabel, info.desc);
        fadeLabel(this._iconLabel, info.icon || '\u2601');
        if (this._highLowLabel && wxData.daily) {
            let high = Math.round(wxData.daily.temperature_2m_max[0]);
            let low = Math.round(wxData.daily.temperature_2m_min[0]);
            fadeLabel(this._highLowLabel, `H:${high}\u00B0  L:${low}\u00B0`);
        }
        if (this._detailsLabel) {
            fadeLabel(this._detailsLabel, `\uD83D\uDCA8 ${Math.round(current.wind_speed_10m)} km/h   \uD83D\uDCA7 ${Math.round(current.relative_humidity_2m)}%`);
        }
        if (wxData.hourly) this._populateForecasts(wxData.hourly);
        if (this._updatedLabel && weatherCache.timestamp) {
            let dt = GLib.DateTime.new_from_unix_local(weatherCache.timestamp);
            if (dt) fadeLabel(this._updatedLabel, dt.format('%H:%M'));
        }
    }

    _fetchUrl(url, callback) {
        let session = getSession();
        let msg = Soup.Message.new('GET', url);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                callback(null, JSON.parse(_utf8Decoder.decode(bytes.get_data())));
            } catch (e) {
                callback(e, null);
            }
        });
    }

    destroy() {
        this._destroyed = true;
        this._runtimeDisposer?.dispose?.();
        unsubscribeWidget(this);
        this._tempLabel = null;
        this._conditionLabel = null;
        this._locationLabel = null;
        this._iconLabel = null;
        this._highLowLabel = null;
        this._detailsLabel = null;
        this._forecastContainer = null;
        this._forecastSection = null;
        this._refreshButton = null;
        this._updatedLabel = null;
        this._runtimeDisposer = null;
    }
}

function _buildWeatherPreview({ runtimeEnv }) {
    _bindShellEnv(runtimeEnv);
    let box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    let topRow = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 12px;',
    });
    box.add_child(topRow);
    topRow.add_child(new St.Label({
        text: '12\u00B0',
        style: 'color: white; font-size: 36px; font-weight: 300;',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    topRow.add_child(new St.Label({
        text: '\u26C5',
        style: 'color: white; font-size: 32px;',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(new St.Label({
        text: 'Partly Cloudy',
        style: 'color: rgba(255,255,255,0.7); font-size: 13px; margin-top: 2px;',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    return box;
}

export const WEATHER_WIDGET_DEFINITION = {
    widgetType: 'weather',
    label: 'Weather',
    description: 'Current weather',
    defaultColSpan: 2,
    defaultRowSpan: 1,
    minColSpan: 1,
    minRowSpan: 1,

    createInstance({ settings, widgetItem }) {
        return new WeatherWidget(settings, widgetItem);
    },

    buildPreview({ runtimeEnv }) {
        return _buildWeatherPreview({ runtimeEnv });
    },

    buildPreferences({ settings, hasKey, page, helpers }) {
        if (!hasKey('widget-weather-location'))
            return;
        let { Adw } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'Weather Widget',
            description: 'Configure the weather widget on the home screen',
        });
        let locationRow = new Adw.EntryRow({
            title: 'Location',
            text: settings.get_string('widget-weather-location'),
            show_apply_button: true,
        });
        locationRow.connect('apply', () => {
            settings.set_string('widget-weather-location', locationRow.get_text());
        });
        group.add(locationRow);
        page.add(group);
    },

    buildInstanceSettings({ page, store, settings, helpers }) {
        let { Adw } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'Weather',
            description: 'Customize this weather widget instance',
        });
        helpers.addEntryPreference(group, {
            title: 'Location',
            subtitle: 'City, town, or area name for this widget instance',
            placeholder: 'London',
            getValue: () => store.getPreference('location', settings?.get_string?.('widget-weather-location') ?? ''),
            setValue: value => store.setPreference('location', value.trim()),
        });
        page.add(group);
    },
};
