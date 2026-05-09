// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { createExtensionSettings } from './src/shared/home_screen/widgets/widgetInstanceStore.js';
import { openWidgetSettingsWindow } from './src/shared/home_screen/widgets/widgetSettingsWindow.js';

function _parseArgs(argv) {
    let parsed = { instanceId: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--instance-id' && i + 1 < argv.length)
            parsed.instanceId = argv[++i];
    }
    return parsed;
}

class WidgetSettingsApp extends Adw.Application {
    constructor(options) {
        super({
            application_id: 'com.convergence.WidgetSettings',
            flags: Gio.ApplicationFlags.NON_UNIQUE,
        });
        this._options = options;
        this._window = null;
    }

    vfunc_activate() {
        if (this._window) {
            this._window.present();
            return;
        }

        let extensionDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();
        let settings = createExtensionSettings(extensionDir ?? GLib.get_current_dir());
        this._window = openWidgetSettingsWindow({
            settings,
            instanceId: this._options.instanceId,
        });
        this._window.application = this;
        this._window.connect('close-request', () => {
            this.quit();
            return false;
        });
    }
}

Adw.init();
let app = new WidgetSettingsApp(_parseArgs(ARGV));
app.run(ARGV);
