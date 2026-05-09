# Convergence Shell

A modular GNOME Shell extension that adapts the desktop experience to the device it is running on — phone, tablet, laptop, or desktop. One installation, one set of preferences, behaviour that follows the hardware.

This is an early work in progress project and I opened it up to the public for others to contribute to the vision and to help resolve some of the remaining bugs to enable a full Linux Covergence experience.

## Demo

<video src="https://github.com/Daniel-Blandford/convergence-shell/releases/download/v0.1.0/LinuxMobileDemo.mp4" controls width="100%">
  Your browser doesn't support inline video.
  <a href="https://github.com/Daniel-Blandford/convergence-shell/releases/download/v0.1.0/LinuxMobileDemo.mp4">Download the demo video</a>.
</video>

## Why

GNOME Shell is built around a single interaction model. On a phone or convertible, that model breaks down: the panel is tuned for a mouse, gesture navigation is missing, the on-screen keyboard layout assumes desktop ergonomics, and there is no home screen.

Convergence Shell layers a second, mobile-aware shell on top of vanilla GNOME. The desktop experience stays untouched on devices where it already works; phones and tablets get a touch-first interface that reuses the same windowing, notification, and theming primitives.

## Features

### Phone and tablet

- Full-screen **app drawer** with search, gesture-driven open/close, and per-icon press feedback
- **Status bar** with cellular signal/tech, Bluetooth, network, and battery indicators sourced from ModemManager and NetworkManager
- **Notification panel** with quick toggles, including a hotspot toggle wired into NetworkManager
- **Home screen** with a customisable grid of app icons and widgets
- **Custom mobile on-screen keyboard layout** (`mobileOSK`) replacing GNOME's stock OSK with a touch-tuned variant
- **Edge gestures** for back / overview / app switching
- **Gesture bar** and **recent apps** flow
- **Splash screens** and a window stack tuned for a single-task-at-a-time feel
- **Volume OSD** with an Android-style vertical slider

### Desktop

- **Taskbar** with live window previews, hover animations, optional dynamic transparency and intellihide
- **App menu** — start-menu-style floating grid
- **Tray area** with `com.canonical.dbusmenu` support; can render in the GNOME top panel, the Convergence notification panel, or both
- **Window effects** and **workspace** tweaks

### Shared

- **Home-screen widgets**: clock, weather (Open-Meteo), battery, system monitor, sticky notes, trash, and an at-a-glance summary widget
- **Notification panel** with quick toggles and banner-swipe handling shared across phone and desktop modes

### Device-specific (optional, hardware-dependent)

These modules detect missing hardware at runtime and stay disabled if unsupported:

- **Auto-rotate** with optional suppression when the device is lying flat
- **Auto-brightness** (requires an ambient light sensor)
- **Call proximity** (screen off during calls)
- **Alert slider** support for phones with a physical 3-position switch - OnePlus 6 specific

## Requirements

- GNOME Shell **48, 49, or 50**
'Gnome-Shell-Mobile 48' was tested on a Fairphone 5 (running PostMarketOS edge), but please note that Gnome-Shell-Mobile 48 has several limitations that create bugs, you're best to use this on vanilla Gnome 50 to minimise bugs which I tested on a OnePlus 6 (running PostMarketOS edge).

## Installation

Clone into the GNOME extensions directory and enable:

```bash
git clone https://github.com/Daniel-Blandford/convergence-shell.git \
    ~/.local/share/gnome-shell/extensions/convergence@daniel-blandford.github.io

cd ~/.local/share/gnome-shell/extensions/convergence@daniel-blandford.github.io
glib-compile-schemas schemas/

# Log out and back in (Wayland) or press Alt+F2, "r", Enter (X11)
gnome-extensions enable convergence@daniel-blandford.github.io
```

## Architecture

Code is organised by device context under `src/`:

| Path | Purpose |
|---|---|
| `src/phone/` | Phone-specific modules (app drawer, gesture bar, edge gestures, status bar, …) |
| `src/desktop/` | Desktop-specific modules (taskbar, app menu, tray, window effects, …) |
| `src/shared/` | Used by both contexts (home screen, widgets, notification panel, utilities) |
| `src/device_specific/` | Hardware-dependent features (alert slider, auto-rotate, …). Removable without breaking other modules. |

Settings live in a single GSettings schema (`org.gnome.shell.extensions.convergence`) so all behaviour is configurable from one preferences window and survives extension updates.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

## Acknowledgments

- The GNOME Shell, Mutter, and `gnome-shell-mobile` projects whose APIs and design this extension builds on
- The Linux-mobile community for documenting hardware quirks and DBus interfaces
