// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Daniel Blandford

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { getWidgetPreference } from './widgetInstanceStore.js';

let Clutter = null;
let St = null;

function _bindShellEnv(runtimeEnv) {
    Clutter = runtimeEnv?.Clutter ?? Clutter;
    St = runtimeEnv?.St ?? St;
    if (!Clutter || !St)
        throw new Error('System monitor widget requires shell runtime env');
}

// ---------------------------------------------------------------------------
// ARM CPU implementer hex -> vendor mapping
// ---------------------------------------------------------------------------

const _IMPL_VENDOR = {
    0x41: '_arm',        // ARM Holdings (need DT to distinguish SoC vendor)
    0x42: 'broadcom',    // Broadcom (server ARM)
    0x48: 'hisilicon',   // HiSilicon (Huawei Kunpeng)
    0x4e: 'nvidia_arm',  // NVIDIA (Grace)
    0x51: 'qualcomm',    // Qualcomm (Snapdragon)
    0x53: 'samsung',     // Samsung (Exynos)
    0x61: 'apple',       // Apple (M-series)
    0xc0: 'ampere',      // Ampere (Altra/AmpereOne)
};

// ---------------------------------------------------------------------------
// Shared singleton poller — reads hardware sensors once per second and
// broadcasts results to all subscribed SystemMonitorWidget instances.
// ---------------------------------------------------------------------------

const _hwMonPoller = {
    _subscribers: new Set(),
    _timerId: 0,
    _pollCount: 0,
    _destroyed: false,
    _decoder: new TextDecoder(),
    _prevCores: {},
    _tempPaths: null,
    _powerPaths: null,
    _prevEnergy: null,
    _lastWatts: null,
    _gpus: [],
    _gpusDetected: false,
    _nvidiaSmiPending: false,

    /** Ensure GPU detection has run (safe to call before subscribe). */
    ensureGpuDetection() {
        if (!this._gpusDetected) this._detectAllGpus();
    },

    /**
     * Subscribe a widget to receive periodic sensor broadcasts.
     * @param {SystemMonitorWidget} widget
     */
    subscribe(widget) {
        this._subscribers.add(widget);
        if (this._subscribers.size === 1) this._start();
    },

    /**
     * Unsubscribe a widget; stops the poller when no subscribers remain.
     * @param {SystemMonitorWidget} widget
     */
    unsubscribe(widget) {
        this._subscribers.delete(widget);
        if (this._subscribers.size === 0) this._stop();
    },

    _start() {
        this._destroyed = false;
        this._pollCount = 0;
        this._prevCores = {};
        if (!this._gpusDetected) this._detectAllGpus();
        this._poll();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _stop() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    },

    // -----------------------------------------------------------------------
    // GPU detection
    // -----------------------------------------------------------------------

    /**
     * Probe devfreq directory for a GPU device path.
     * @param {string} devPath - sysfs device path
     * @param {object} gpu - GPU descriptor to populate
     */
    _probeDevfreq(devPath, gpu) {
        try {
            let dfDir = `${devPath}/devfreq`;
            let dfEnum = Gio.File.new_for_path(dfDir).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let dfInfo = dfEnum.next_file(null);
            if (dfInfo) {
                let dfPath = `${dfDir}/${dfInfo.get_name()}`;
                let maxFreq = this._readFile(`${dfPath}/max_freq`);
                if (maxFreq) {
                    gpu.devfreqPath = dfPath;
                    gpu._curFreqPath = `${dfPath}/cur_freq`;
                    gpu.maxFreq = parseInt(maxFreq, 10);
                }
            }
            dfEnum.close(null);
        } catch (_) {}
    },

    /** Detect all GPUs via sysfs DRM cards and platform paths. */
    _detectAllGpus() {
        this._gpusDetected = true;
        this._gpus = [];

        // Android-kernel Adreno: kgsl sysfs (not a DRM card)
        try {
            let hasBusy = this._readFile('/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage') !== null;
            let hasDevfreqBusy = !hasBusy &&
                this._readFile('/sys/class/kgsl/kgsl-3d0/devfreq/gpu_busy') !== null;
            if (hasBusy || hasDevfreqBusy) {
                this._gpus.push({ vendor: 'adreno', hasBusyPercent: hasBusy, hasDevfreqBusy, canRead: true });
                return;
            }
        } catch (_) {}

        // Driver name -> vendor mapping for platform GPUs (no PCI vendor ID)
        let _platformVendor = {
            panfrost: 'mali', panthor: 'mali', lima: 'mali',
            mali: 'mali', 'mali_kbase': 'mali',
            'mali-bifrost': 'mali', 'mali-valhall': 'mali',
            msm: 'adreno',
            asahi: 'apple',
            v3d: 'videocore', vc4: 'videocore', 'bcm2835-v3d': 'videocore',
            etnaviv: 'vivante',
        };
        let _pciVendor = {
            '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel',
        };
        let _socVendors = new Set(['mali', 'adreno', 'apple', 'vivante']);

        // Single pass over all DRM cards
        try {
            let dir = Gio.File.new_for_path('/sys/class/drm');
            let enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                if (!name.startsWith('card') || name.includes('-')) continue;
                let cardPath = `/sys/class/drm/${name}`;
                let devPath = `${cardPath}/device`;

                // Resolve driver name -> platform vendor, or PCI vendor ID
                let vendor = null, isPlatformGpu = false, driverName = null;
                try {
                    let target = Gio.File.new_for_path(`${devPath}/driver`).query_info(
                        'standard::symlink-target', Gio.FileQueryInfoFlags.NONE, null)
                        .get_symlink_target() ?? '';
                    driverName = target.split('/').pop();
                    vendor = _platformVendor[driverName];
                    if (vendor) isPlatformGpu = true;
                } catch (_) {}
                if (!vendor) {
                    let vid = this._readFile(`${devPath}/vendor`);
                    if (vid) vendor = _pciVendor[vid];
                }
                if (!vendor) continue;

                let gpu = { vendor, cardPath, sysfsPath: devPath, driverName };

                // Pre-cache sysfs paths for hot-path reads
                gpu._runtimePath = `${devPath}/power/runtime_status`;
                gpu._busyPath = `${devPath}/gpu_busy_percent`;
                gpu._vramUsedPath = `${devPath}/mem_info_vram_used`;
                gpu._vramTotalPath = `${devPath}/mem_info_vram_total`;

                // Unified capability probing
                let hasBusy = this._readFile(gpu._busyPath) !== null;
                if (hasBusy) gpu.hasBusyPercent = true;
                if (this._readFile(gpu._vramTotalPath) !== null)
                    gpu.hasVram = true;

                // Intel-specific: Arc (discrete) vs iGPU (frequency proxy)
                if (vendor === 'intel') {
                    if (hasBusy) {
                        gpu.isDiscreteIntel = true;
                    } else {
                        let maxFreq = this._readFile(`${cardPath}/gt_max_freq_mhz`);
                        if (maxFreq) {
                            gpu.maxFreqPath = `${cardPath}/gt_cur_freq_mhz`;
                            gpu.maxFreq = parseInt(maxFreq, 10);
                        }
                    }
                }
                // NVIDIA nouveau: devfreq fallback, no nvidia-smi
                if (vendor === 'nvidia' && driverName === 'nouveau') {
                    gpu.isNouveau = true;
                    if (!hasBusy) this._probeDevfreq(devPath, gpu);
                }
                // AMD radeon: no utilization metric
                if (vendor === 'amd' && driverName === 'radeon')
                    gpu.isRadeon = true;

                // Platform GPUs: devfreq + utilisation probing
                if (isPlatformGpu) {
                    this._probeDevfreq(devPath, gpu);
                    if (this._readFile(`${devPath}/utilisation`) !== null)
                        gpu.hasUtilisation = true;
                    else if (this._readFile(`${devPath}/gpu_utilization`) !== null)
                        gpu.hasGpuUtilization = true;
                    else if (vendor === 'mali') {
                        let misc = '/sys/class/misc/mali0/device';
                        if (this._readFile(`${misc}/utilisation`) !== null) {
                            gpu.miscMaliPath = misc; gpu.hasUtilisation = true;
                        } else if (this._readFile(`${misc}/gpu_utilization`) !== null) {
                            gpu.miscMaliPath = misc; gpu.hasGpuUtilization = true;
                        }
                    }
                }

                // Mark whether this GPU has any readable utilization metric
                gpu.canRead = !!(gpu.hasBusyPercent || gpu.hasBusyPercentage
                    || gpu.hasDevfreqBusy || gpu.hasUtilisation || gpu.hasGpuUtilization
                    || (gpu.devfreqPath && gpu.maxFreq) || (gpu.maxFreqPath && gpu.maxFreq)
                    || (vendor === 'nvidia' && !gpu.isNouveau && !gpu.hasBusyPercent));

                // Pi 4/5: prefer v3d (3D GPU) over vc4 (display-only)
                if (vendor === 'videocore' && this._gpus.length > 0 &&
                    this._gpus[this._gpus.length - 1].vendor === 'videocore') {
                    let prev = this._gpus[this._gpus.length - 1];
                    if ((gpu.devfreqPath || gpu.hasUtilisation) &&
                        !prev.devfreqPath && !prev.hasUtilisation)
                        this._gpus[this._gpus.length - 1] = gpu;
                    continue;
                }

                this._gpus.push(gpu);
                if (_socVendors.has(vendor)) { enumerator.close(null); return; }
            }
            enumerator.close(null);
        } catch (_) {}

        // Adreno devfreq fallback (no kgsl, no msm DRM card found)
        if (this._gpus.length === 0) {
            try {
                let dfDir = Gio.File.new_for_path('/sys/class/devfreq');
                let dfEnum = dfDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let dfInfo;
                while ((dfInfo = dfEnum.next_file(null)) !== null) {
                    let n = dfInfo.get_name();
                    if (!n.includes('gpu') && !n.includes('kgsl')) continue;
                    let dfPath = `/sys/class/devfreq/${n}`;
                    let maxFreq = this._readFile(`${dfPath}/max_freq`);
                    if (maxFreq) {
                        this._gpus.push({
                            vendor: 'adreno', devfreqPath: dfPath,
                            _curFreqPath: `${dfPath}/cur_freq`,
                            maxFreq: parseInt(maxFreq, 10),
                            canRead: true,
                        });
                        break;
                    }
                }
                dfEnum.close(null);
            } catch (_) {}
        }

        // Sort: discrete GPUs first, integrated second
        if (this._gpus.length > 1) {
            this._gpus.sort((a, b) => {
                let aDisc = (a.vendor !== 'intel' || a.isDiscreteIntel) ? 0 : 1;
                let bDisc = (b.vendor !== 'intel' || b.isDiscreteIntel) ? 0 : 1;
                return aDisc - bDisc;
            });
        }
    },

    get gpuCount() { return this._gpus.length; },
    gpuVendor(idx) { return this._gpus[idx]?.vendor ?? null; },
    gpuCanRead(idx) { return !!this._gpus[idx]?.canRead; },

    // -----------------------------------------------------------------------
    // File I/O helper
    // -----------------------------------------------------------------------

    /**
     * Read a sysfs/procfs file and return its trimmed text, or null.
     * @param {string} path
     * @returns {string|null}
     */
    _readFile(path) {
        try {
            let [ok, contents] = GLib.file_get_contents(path);
            if (ok && contents)
                return this._decoder.decode(contents).trim();
        } catch (_) {}
        return null;
    },

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    _poll() {
        if (this._destroyed) return;
        this._pollCount++;
        this._readCpu();
        this._readRam();
        if (this._pollCount % 2 === 1) {
            this._readGpu();
            this._readPower();
            this._readTemps();
        }
        if (this._pollCount % 5 === 1)
            this._readDisk();
    },

    /**
     * Send a bar update to all subscribers.
     * @param {string} key - bar identifier (cpu, ram, gpu, etc.)
     * @param {number} fraction - 0..1
     * @param {string} [label] - optional override label
     */
    _broadcast(key, fraction, label) {
        for (let w of this._subscribers) {
            if (!w._destroyed) w._setBar(key, fraction, label);
        }
    },

    /**
     * Send per-core usage data to all subscribers.
     * @param {Array<{idx: number, usage: number}>} coreUsages
     */
    _broadcastCores(coreUsages) {
        for (let w of this._subscribers) {
            if (!w._destroyed) w._applyCoreUsages(coreUsages);
        }
    },

    /**
     * Send temperature/power text to all subscribers.
     * @param {string} text
     */
    _broadcastTemps(text) {
        for (let w of this._subscribers) {
            if (!w._destroyed && w._tempLabel) w._tempLabel.text = text;
        }
    },

    // -----------------------------------------------------------------------
    // CPU — per-core delta calculation from /proc/stat
    // -----------------------------------------------------------------------

    _readCpu() {
        let stat = this._readFile('/proc/stat');
        if (!stat) return;
        let coreUsages = [];
        let i = 0, len = stat.length;
        while (i < len) {
            let eol = stat.indexOf('\n', i);
            if (eol === -1) eol = len;
            if (stat.charCodeAt(i) !== 99 || stat.charCodeAt(i + 1) !== 112)
                break;
            let line = stat.substring(i, eol);
            i = eol + 1;
            let spaceIdx = line.indexOf(' ');
            if (spaceIdx === -1) continue;
            let name = line.substring(0, spaceIdx);
            let numStart = spaceIdx + 1;
            while (numStart < line.length && line.charCodeAt(numStart) === 32) numStart++;
            let parts = line.substring(numStart).split(' ');
            let idle = (+parts[3]) + (+parts[4] || 0);
            let total = 0;
            for (let j = 0; j < parts.length; j++) total += +parts[j];
            let prev = this._prevCores[name];
            let usage = 0;
            if (prev) {
                let dTotal = total - prev.total;
                let dIdle = idle - prev.idle;
                if (dTotal > 0) usage = (dTotal - dIdle) / dTotal;
            }
            if (prev) { prev.total = total; prev.idle = idle; }
            else this._prevCores[name] = { total, idle };
            if (name === 'cpu') {
                this._broadcast('cpu', usage);
            } else {
                let idx = parseInt(name.substring(3), 10);
                coreUsages.push({ idx, usage });
            }
        }
        this._broadcastCores(coreUsages);
    },

    // -----------------------------------------------------------------------
    // RAM from /proc/meminfo
    // -----------------------------------------------------------------------

    _readRam() {
        let meminfo = this._readFile('/proc/meminfo');
        if (!meminfo) return;
        let total = 0, avail = 0;
        let idx = meminfo.indexOf('MemTotal:');
        if (idx !== -1) total = parseInt(meminfo.substring(idx + 9), 10);
        idx = meminfo.indexOf('MemAvailable:');
        if (idx !== -1) avail = parseInt(meminfo.substring(idx + 13), 10);
        if (total > 0) {
            let used = total - avail;
            this._broadcast('ram', used / total, SystemMonitorWidget._fmtBytes(used * 1024));
        }
    },

    // -----------------------------------------------------------------------
    // GPU utilization + VRAM
    // -----------------------------------------------------------------------

    _readGpu() {
        for (let i = 0; i < this._gpus.length; i++) {
            let gpu = this._gpus[i];
            let gpuKey = i === 0 ? 'gpu' : 'gpu2';
            let memKey = i === 0 ? 'gpuMem' : 'gpu2Mem';

            // Skip runtime-suspended discrete GPUs
            if (gpu._runtimePath) {
                let status = this._readFile(gpu._runtimePath);
                if (status === 'suspended') {
                    this._broadcast(gpuKey, 0, 'Off');
                    this._broadcast(memKey, 0, 'Off');
                    continue;
                }
            }

            let usageRead = false;

            // gpu_busy_percent (NVIDIA open, amdgpu, Intel Arc/xe)
            if (gpu.hasBusyPercent) {
                let val = this._readFile(gpu._busyPath);
                if (val !== null) {
                    this._broadcast(gpuKey, parseInt(val, 10) / 100);
                    usageRead = true;
                }
            }
            // kgsl busy percentage (Android Adreno)
            if (!usageRead && gpu.hasBusyPercent) {
                let val = this._readFile('/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage');
                if (val !== null) {
                    let pct = parseInt(val, 10);
                    if (!isNaN(pct)) { this._broadcast(gpuKey, pct / 100); usageRead = true; }
                }
            }
            // kgsl busy time ratio (Android Adreno alt)
            if (!usageRead && gpu.hasDevfreqBusy) {
                let val = this._readFile('/sys/class/kgsl/kgsl-3d0/devfreq/gpu_busy');
                if (val !== null) {
                    let parts = val.split(/\s+/);
                    let busy = +parts[0], total = +parts[1];
                    if (total > 0) { this._broadcast(gpuKey, busy / total); usageRead = true; }
                }
            }
            // utilisation file (panfrost/panthor/mali_kbase/msm)
            if (!usageRead && (gpu.hasUtilisation || gpu.hasGpuUtilization)) {
                let basePath = gpu.miscMaliPath || gpu.sysfsPath;
                let file = gpu.hasUtilisation ? 'utilisation' : 'gpu_utilization';
                let val = this._readFile(`${basePath}/${file}`);
                if (val !== null) {
                    let pct = parseInt(val, 10);
                    if (!isNaN(pct)) { this._broadcast(gpuKey, pct / 100); usageRead = true; }
                }
            }
            // Frequency ratio proxy (Intel iGPU, devfreq platform GPUs)
            if (!usageRead) {
                let freqPath = gpu.maxFreqPath || gpu._curFreqPath;
                if (freqPath && gpu.maxFreq) {
                    let val = this._readFile(freqPath);
                    if (val !== null)
                        this._broadcast(gpuKey, parseInt(val, 10) / gpu.maxFreq);
                }
            }

            // VRAM (discrete GPUs only)
            if (gpu.hasVram) {
                let memUsed = this._readFile(gpu._vramUsedPath);
                if (memUsed) {
                    if (gpu._vramTotal === undefined) {
                        let mt = this._readFile(gpu._vramTotalPath);
                        gpu._vramTotal = mt ? parseInt(mt, 10) : 0;
                    }
                    if (gpu._vramTotal > 0) {
                        let u = parseInt(memUsed, 10);
                        this._broadcast(memKey, u / gpu._vramTotal,
                            SystemMonitorWidget._fmtBytes(u));
                    }
                }
            }

            // nvidia-smi fallback (proprietary driver only, not nouveau)
            if (!usageRead && gpu.vendor === 'nvidia' && !gpu.hasBusyPercent && !gpu.isNouveau) {
                if (!this._nvidiaSmiPending) {
                    this._nvidiaSmiPending = true;
                    try {
                        let proc = Gio.Subprocess.new(
                            ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total',
                             '--format=csv,noheader,nounits'],
                            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                        proc.communicate_utf8_async(null, null, (_proc, res) => {
                            this._nvidiaSmiPending = false;
                            if (this._destroyed) return;
                            try {
                                let [, stdout] = _proc.communicate_utf8_finish(res);
                                if (stdout) {
                                    let parts = stdout.trim().split(',');
                                    let v0 = parseFloat(parts[0]);
                                    if (!isNaN(v0))
                                        this._broadcast(gpuKey, v0 / 100);
                                    if (parts.length >= 3) {
                                        let v1 = parseFloat(parts[1]), v2 = parseFloat(parts[2]);
                                        if (v2 > 0)
                                            this._broadcast(memKey, v1 / v2,
                                                SystemMonitorWidget._fmtBytes(v1 * 1048576));
                                    }
                                }
                            } catch (_) {}
                        });
                    } catch (_) {
                        this._nvidiaSmiPending = false;
                    }
                }
            }
        }
    },

    // -----------------------------------------------------------------------
    // Disk usage (root filesystem)
    // -----------------------------------------------------------------------

    _readDisk() {
        try {
            let file = Gio.File.new_for_path('/');
            let info = file.query_filesystem_info('filesystem::size,filesystem::free', null);
            let total = info.get_attribute_uint64('filesystem::size');
            let free = info.get_attribute_uint64('filesystem::free');
            if (total > 0)
                this._broadcast('disk', (total - free) / total);
        } catch (_) {}
    },

    // -----------------------------------------------------------------------
    // Power — RAPL, battery, GPU hwmon
    // -----------------------------------------------------------------------

    _discoverPowerPaths() {
        this._powerPaths = [];
        this._prevEnergy = null;
        this._lastWatts = null;

        // 1. RAPL — Intel/AMD CPU package energy counters (microjoules)
        try {
            let rapl = Gio.File.new_for_path('/sys/class/powercap');
            let enumerator = rapl.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                if (!name.startsWith('intel-rapl:') || name.split(':').length !== 2) continue;
                let path = `/sys/class/powercap/${name}/energy_uj`;
                if (this._readFile(path) !== null)
                    this._powerPaths.push({ type: 'rapl', path });
            }
            enumerator.close(null);
        } catch (_) {}

        // 2. Battery power_now (microWatts) — phones/laptops
        if (this._powerPaths.length === 0) {
            try {
                let psDir = Gio.File.new_for_path('/sys/class/power_supply');
                let psEnum = psDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let psInfo;
                while ((psInfo = psEnum.next_file(null)) !== null) {
                    let psName = psInfo.get_name();
                    let typePath = `/sys/class/power_supply/${psName}/type`;
                    let typeVal = this._readFile(typePath);
                    if (typeVal !== 'Battery') continue;
                    // Prefer current × voltage over power_now — some
                    // platforms (Qualcomm battmgr) report wildly wrong
                    // power_now values.
                    let curPath = `/sys/class/power_supply/${psName}/current_now`;
                    let volPath = `/sys/class/power_supply/${psName}/voltage_now`;
                    if (this._readFile(curPath) !== null && this._readFile(volPath) !== null) {
                        this._powerPaths.push({ type: 'battery_cv', curPath, volPath });
                        break;
                    }
                    let pwrPath = `/sys/class/power_supply/${psName}/power_now`;
                    if (this._readFile(pwrPath) !== null) {
                        this._powerPaths.push({ type: 'battery', path: pwrPath });
                        break;
                    }
                }
                psEnum.close(null);
            } catch (_) {}
        }

        // 3. GPU power via hwmon (AMD power1_average, NVIDIA power1_input)
        for (let gpu of this._gpus) {
            if (!gpu.sysfsPath) continue;
            try {
                let hwmonDir = Gio.File.new_for_path(`${gpu.sysfsPath}/hwmon`);
                let hwEnum = hwmonDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let hwInfo;
                while ((hwInfo = hwEnum.next_file(null)) !== null) {
                    let hwDir = `${gpu.sysfsPath}/hwmon/${hwInfo.get_name()}`;
                    let avgPath = `${hwDir}/power1_average`;
                    let inPath = `${hwDir}/power1_input`;
                    let p = this._readFile(avgPath) !== null ? avgPath
                        : this._readFile(inPath) !== null ? inPath : null;
                    if (p) {
                        this._powerPaths.push({ type: 'gpu_hwmon', path: p });
                        break;
                    }
                }
                hwEnum.close(null);
            } catch (_) {}
        }
    },

    _readPower() {
        if (!this._powerPaths) this._discoverPowerPaths();
        if (this._powerPaths.length === 0) {
            this._lastWatts = null;
            return;
        }

        let totalW = 0;
        let hasRapl = false;

        for (let src of this._powerPaths) {
            if (src.type === 'rapl') {
                hasRapl = true;
            } else if (src.type === 'battery') {
                let val = this._readFile(src.path);
                if (val !== null) totalW += Math.abs(parseInt(val, 10)) / 1e6;
            } else if (src.type === 'battery_cv') {
                let cur = this._readFile(src.curPath);
                let vol = this._readFile(src.volPath);
                if (cur !== null && vol !== null)
                    totalW += Math.abs(parseInt(cur, 10)) * parseInt(vol, 10) / 1e12;
            } else if (src.type === 'gpu_hwmon') {
                let val = this._readFile(src.path);
                if (val !== null) totalW += parseInt(val, 10) / 1e6;
            }
        }

        // RAPL energy delta
        if (hasRapl) {
            let nowUs = GLib.get_monotonic_time();
            let energySum = 0;
            for (let src of this._powerPaths) {
                if (src.type !== 'rapl') continue;
                let val = this._readFile(src.path);
                if (val !== null) energySum += parseInt(val, 10);
            }
            if (this._prevEnergy) {
                let dE = energySum - this._prevEnergy.total_uj;
                let dT = nowUs - this._prevEnergy.time_us;
                if (dE < 0) dE += 0x100000000;
                if (dT > 0) totalW += dE / dT;
            }
            this._prevEnergy = { total_uj: energySum, time_us: nowUs };
        }

        if (totalW > 0) {
            this._lastWatts = totalW < 10 ? `${totalW.toFixed(1)}W` : `${Math.round(totalW)}W`;
        } else {
            this._lastWatts = null;
        }
    },

    // -----------------------------------------------------------------------
    // Temperatures — hwmon sensors with thermal_zone fallback
    // -----------------------------------------------------------------------

    _discoverTempPaths() {
        this._tempPaths = [];
        // hwmon sensors — real hardware (coretemp, nvme, iwlwifi, pch, etc.)
        try {
            let hwmon = Gio.File.new_for_path('/sys/class/hwmon');
            let enumerator = hwmon.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let dir = `/sys/class/hwmon/${info.get_name()}`;
                for (let i = 1; i <= 20; i++) {
                    let path = `${dir}/temp${i}_input`;
                    if (this._readFile(path) !== null)
                        this._tempPaths.push(path);
                    else
                        break;
                }
            }
            enumerator.close(null);
        } catch (_) {}
        // Thermal zones only as fallback (mobile SoCs without hwmon).
        // On x86, thermal zones duplicate hwmon sensors and add virtual
        // management zones that report misleading values.
        if (this._tempPaths.length === 0) {
            try {
                let thermalDir = Gio.File.new_for_path('/sys/class/thermal');
                let tzEnum = thermalDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let tzInfo;
                while ((tzInfo = tzEnum.next_file(null)) !== null) {
                    let name = tzInfo.get_name();
                    if (!name.startsWith('thermal_zone')) continue;
                    let path = `/sys/class/thermal/${name}/temp`;
                    if (this._readFile(path) !== null)
                        this._tempPaths.push(path);
                }
                tzEnum.close(null);
            } catch (_) {}
        }
    },

    _readTemps() {
        if (!this._tempPaths) this._discoverTempPaths();
        let temps = [];
        for (let path of this._tempPaths) {
            let val = this._readFile(path);
            if (val !== null) {
                let t = parseInt(val, 10) / 1000;
                if (t > 0 && t < 150) temps.push(t);
            }
        }
        // NVIDIA GPU temp via sysfs
        for (let gpu of this._gpus) {
            if (gpu.vendor !== 'nvidia' || !gpu.sysfsPath) continue;
            let val = this._readFile(`${gpu.sysfsPath}/hwmon/hwmon0/temp1_input`)
                ?? this._readFile(`${gpu.sysfsPath}/hwmon/hwmon1/temp1_input`);
            if (val !== null) {
                let t = parseInt(val, 10) / 1000;
                if (t > 0 && t < 150) temps.push(t);
            }
        }
        if (temps.length === 0) {
            this._broadcastTemps(this._lastWatts ?? '');
            return;
        }

        let min = temps[0], max = temps[0], sum = 0;
        for (let j = 0; j < temps.length; j++) {
            let v = temps[j];
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
        }
        let avg = Math.round(sum / temps.length);

        let tempStr = `${Math.round(min)}\u00B0 / ${avg}\u00B0 / ${Math.round(max)}\u00B0`;
        let display = this._lastWatts ? `${this._lastWatts} | ${tempStr}` : tempStr;
        this._broadcastTemps(display);
    },
};

// ---------------------------------------------------------------------------
// SystemMonitorWidget — live CPU, RAM, GPU, Disk, and temperature bars
// ---------------------------------------------------------------------------

export class SystemMonitorWidget {
    /**
     * @param {object} settings - GSettings instance
     * @param {object} item - widget grid item descriptor
     */
    constructor(settings, item) {
        this._settings = settings ?? null;
        this._item = item;
        this._box = null;
        this._bars = {};
        this._tempLabel = null;
        this._destroyed = false;
    }

    /** Whether per-core bars should be displayed. */
    get showCores() {
        let widgetValue = getWidgetPreference(this._item, 'showCores', null);
        if (typeof widgetValue === 'boolean')
            return widgetValue;
        if (typeof this._item?.widgetData?.showCores === 'boolean')
            return this._item.widgetData.showCores;
        try { return this._settings?.get_boolean('widget-hwmon-show-cores') !== false; }
        catch (_) { return true; }
    }

    /**
     * Build the widget UI content.
     * @param {number} w - available width in px
     * @param {number} h - available height in px
     * @param {number} _colSpan - grid column span
     * @param {number} rowSpan - grid row span
     * @param {object} monitor - Clutter monitor info
     * @param {object} gridMetrics - scale, icon size, etc.
     * @returns {St.BoxLayout}
     */
    buildContent(w, h, _colSpan, rowSpan, monitor, gridMetrics, runtimeEnv = null) {
        _bindShellEnv(runtimeEnv);
        this._monitor = monitor;
        this._rowSpan = rowSpan;
        // Derive scale from the widget's available width, but cap it so
        // padding/fonts don't overflow the height on short widgets (e.g. 5×1).
        let refWidgetW = 188;
        let wScale = w / refWidgetW;
        // Estimate how much height one "row" of content needs at a given scale:
        // row ≈ max(barH, fontSize) + spacing ≈ (11 + 4) * s = 15s.
        // With padding (24s top+bottom), n bars need h ≥ 24s + 15s*n.
        // For 5 rows (4 bars + temp): h ≥ 24s + 75s = 99s → s ≤ h/99.
        // Use a slightly relaxed divisor to avoid over-shrinking.
        let maxScaleForH = h / 85;
        let s = Math.max(0.7, Math.min(1.6, Math.min(wScale, maxScaleForH)));
        let snap = v => {
            let gs = monitor?.geometry_scale ?? 1;
            return Math.round(v * gs) / gs;
        };
        let fontSize = snap(11 * s);
        let barH = Math.max(snap(6), snap(8 * s));
        let barRad = snap(barH / 2);
        let spacing = snap(4 * s);
        let padV = snap(12 * s);
        let padH = snap(16 * s);
        let pad = padV;
        let labelW = snap(30 * s);
        let pctW = snap(32 * s);
        let rad = snap(12 * s);

        this._box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: `background-color: rgba(0,0,0,0.50); border-radius: ${rad}px;`
                + ` padding: ${padV}px ${padH}px; spacing: ${spacing}px;`,
            clip_to_allocation: true,
        });

        // -------------------------------------------------------------------
        // CPU vendor detection for brand colors
        // -------------------------------------------------------------------
        let cpuVendor = 'unknown';
        try {
            let cpuinfo = _hwMonPoller._readFile('/proc/cpuinfo') ?? '';
            // x86: vendor string in cpuinfo
            if (/GenuineIntel/i.test(cpuinfo))
                cpuVendor = 'intel';
            else if (/AuthenticAMD|AMD/i.test(cpuinfo))
                cpuVendor = 'amd';
            // ARM: vendor name (some kernels include it)
            else if (/Qualcomm/i.test(cpuinfo))
                cpuVendor = 'qualcomm';
            else if (/MediaTek/i.test(cpuinfo))
                cpuVendor = 'mediatek';
            else if (/Samsung|Exynos/i.test(cpuinfo))
                cpuVendor = 'samsung';
            else if (/Apple/i.test(cpuinfo))
                cpuVendor = 'apple';
            // ARM fallback: CPU implementer hex code
            if (cpuVendor === 'unknown') {
                let impl = cpuinfo.match(/CPU implementer\s*:\s*(0x[0-9a-f]+)/i);
                if (impl)
                    cpuVendor = _IMPL_VENDOR[parseInt(impl[1], 16)] ?? '_arm';
            }
            // Device tree fallback (ARM SBCs, phones)
            if (cpuVendor === 'unknown' || cpuVendor === '_arm') {
                let dt = _hwMonPoller._readFile('/sys/firmware/devicetree/base/compatible');
                if (dt) {
                    if (/qcom|qualcomm/i.test(dt)) cpuVendor = 'qualcomm';
                    else if (/mediatek|mt[0-9]/i.test(dt)) cpuVendor = 'mediatek';
                    else if (/samsung|exynos/i.test(dt)) cpuVendor = 'samsung';
                    else if (/apple/i.test(dt)) cpuVendor = 'apple';
                    else if (/broadcom|brcm|raspberrypi/i.test(dt)) cpuVendor = 'broadcom';
                    else if (/rockchip|rk3/i.test(dt)) cpuVendor = 'rockchip';
                    else if (/amlogic|meson/i.test(dt)) cpuVendor = 'amlogic';
                    else if (/allwinner|sun[0-9]/i.test(dt)) cpuVendor = 'allwinner';
                    else if (/nvidia|tegra/i.test(dt)) cpuVendor = 'nvidia_arm';
                    else if (/freescale|fsl|imx/i.test(dt)) cpuVendor = 'nxp';
                    else if (/ampere/i.test(dt)) cpuVendor = 'ampere';
                }
            }
            // ACPI fallback (ARM servers: Ampere, Grace — no device tree)
            if (cpuVendor === 'unknown' || cpuVendor === '_arm') {
                let dmi = _hwMonPoller._readFile('/sys/class/dmi/id/sys_vendor')
                    ?? _hwMonPoller._readFile('/sys/class/dmi/id/board_vendor') ?? '';
                if (/ampere/i.test(dmi)) cpuVendor = 'ampere';
                else if (/nvidia/i.test(dmi)) cpuVendor = 'nvidia_arm';
                else if (/huawei|hisilicon/i.test(dmi)) cpuVendor = 'hisilicon';
                else if (/qualcomm/i.test(dmi)) cpuVendor = 'qualcomm';
            }
            // Final fallback
            if (cpuVendor === 'unknown' || cpuVendor === '_arm') {
                if (/model name/i.test(cpuinfo)) cpuVendor = 'intel';
                else cpuVendor = '_arm';
            }
        } catch (_) {}

        let cpuColor, ramColor;
        switch (cpuVendor) {
            case 'amd':        cpuColor = '#00a651'; ramColor = '#40c87a'; break;
            case 'qualcomm':   cpuColor = '#3253dc'; ramColor = '#6b80e8'; break;
            case 'mediatek':   cpuColor = '#f5a623'; ramColor = '#f7c463'; break;
            case 'samsung':    cpuColor = '#1428a0'; ramColor = '#4d5fc0'; break;
            case 'apple':      cpuColor = '#a3aaae'; ramColor = '#c0c5c8'; break;
            case 'broadcom':   cpuColor = '#c51a4a'; ramColor = '#d95070'; break;
            case 'rockchip':   cpuColor = '#2d8cf0'; ramColor = '#5da8f5'; break;
            case 'amlogic':    cpuColor = '#ff6b00'; ramColor = '#ff9640'; break;
            case 'allwinner':  cpuColor = '#e8602a'; ramColor = '#ee8860'; break;
            case 'nvidia_arm': cpuColor = '#76b900'; ramColor = '#a0d84a'; break;
            case 'nxp':        cpuColor = '#007d8a'; ramColor = '#40a0aa'; break;
            case 'ampere':     cpuColor = '#00c389'; ramColor = '#40d8a8'; break;
            case 'hisilicon':  cpuColor = '#cf0a2c'; ramColor = '#e04050'; break;
            default:           cpuColor = '#0071c5'; ramColor = '#4da3e8'; break;
        }

        // -------------------------------------------------------------------
        // GPU color mapping
        // -------------------------------------------------------------------
        _hwMonPoller.ensureGpuDetection();

        let _gpuColors = (gpuIdx) => {
            let vendor = _hwMonPoller.gpuVendor(gpuIdx);
            let gpuObj = _hwMonPoller._gpus[gpuIdx];
            switch (vendor) {
                case 'nvidia':
                    return { color: '#76b900',
                        mem: (gpuObj?.isNouveau && !gpuObj?.hasVram) ? null : '#a0d84a' };
                case 'amd':
                    return { color: '#e4002b',
                        mem: (gpuObj?.isRadeon && !gpuObj?.hasVram) ? null : '#f04060' };
                case 'intel':
                    return { color: '#0071c5', mem: gpuObj?.hasVram ? '#4a9fd9' : null };
                case 'adreno':    return { color: '#3253dc', mem: null };
                case 'mali':      return { color: '#f5a623', mem: null };
                case 'exynos':    return { color: '#1428a0', mem: null };
                case 'apple':     return { color: '#a3aaae', mem: null };
                case 'videocore': return { color: '#c51a4a', mem: null };
                case 'vivante':   return { color: '#007d8a', mem: null };
                default:          return { color: '#8a8a8a', mem: null };
            }
        };

        let gpu1Vendor = _hwMonPoller.gpuVendor(0);
        let gpu1 = _gpuColors(0);
        let hasGpu2 = _hwMonPoller.gpuCount > 1;
        let gpu2Vendor = hasGpu2 ? _hwMonPoller.gpuVendor(1) : null;
        let gpu2 = hasGpu2 ? _gpuColors(1) : null;

        // GPU label: adapt for single, hybrid (discrete+integrated), or multi-discrete
        let gpu1Label, gpu1MemLabel, gpu2Label, gpu2MemLabel;
        let _isIntegrated = (idx) => {
            let v = _hwMonPoller.gpuVendor(idx);
            if (v !== 'intel') return false;
            return !_hwMonPoller._gpus[idx]?.isDiscreteIntel;
        };
        if (!hasGpu2) {
            gpu1Label = 'GPU';
            gpu1MemLabel = 'GPU Mem';
        } else {
            let hasIntegrated = _isIntegrated(0) || _isIntegrated(1);
            if (hasIntegrated) {
                gpu1Label = _isIntegrated(0) ? 'iGPU' : 'dGPU';
                gpu1MemLabel = _isIntegrated(0) ? 'iMem' : 'dMem';
                gpu2Label = _isIntegrated(1) ? 'iGPU' : 'dGPU';
                gpu2MemLabel = _isIntegrated(1) ? 'iMem' : 'dMem';
            } else {
                gpu1Label = 'GPU 1';
                gpu1MemLabel = 'Mem 1';
                gpu2Label = 'GPU 2';
                gpu2MemLabel = 'Mem 2';
            }
        }

        // -------------------------------------------------------------------
        // Assemble bar definitions
        // -------------------------------------------------------------------
        let allBars = [
            { key: 'cpu',    label: 'CPU',  color: cpuColor },
            { key: 'ram',    label: 'RAM',  color: ramColor },
        ];
        if (_hwMonPoller.gpuCanRead(0)) {
            allBars.push({ key: 'gpu', label: gpu1Label, color: gpu1.color });
            if (gpu1.mem)
                allBars.push({ key: 'gpuMem', label: gpu1MemLabel, color: gpu1.mem });
        }
        if (hasGpu2 && _hwMonPoller.gpuCanRead(1)) {
            allBars.push({ key: 'gpu2', label: gpu2Label, color: gpu2.color });
            if (gpu2.mem)
                allBars.push({ key: 'gpu2Mem', label: gpu2MemLabel, color: gpu2.mem });
        }
        allBars.push({ key: 'disk', label: 'Disk', color: '#cccccc' });

        // -------------------------------------------------------------------
        // Layout: paired (wide) vs single-column
        // -------------------------------------------------------------------
        let mainPairGap = snap(8 * s);
        let mainBarMinW = labelW + snap(40 * s) + pctW + snap(12 * s);
        let innerW = w - padH * 2;
        this._pairedMainBars = innerW >= mainBarMinW * 2 + mainPairGap;
        this._pairedColW = this._pairedMainBars
            ? Math.floor((innerW - mainPairGap) / 2)
            : innerW;

        let _bar = key => allBars.find(b => b.key === key);
        let diskBar = _bar('disk');
        let barsWithoutDisk = allBars.filter(b => b.key !== 'disk');

        let barRows;
        if (this._pairedMainBars) {
            let paired = barsWithoutDisk.map(b => {
                if (b.key === 'gpuMem' || b.key === 'gpu2Mem')
                    return { ...b, label: 'Mem' };
                return b;
            });
            barRows = [];
            for (let i = 0; i < paired.length; i += 2) {
                if (i + 1 < paired.length)
                    barRows.push([paired[i], paired[i + 1]]);
                else
                    barRows.push([paired[i]]);
            }
            this._diskTempPaired = true;
        } else {
            barRows = barsWithoutDisk.map(b => [b]);
            this._diskTempPaired = false;
        }
        let mainRowCount = barRows.length + (this._diskTempPaired ? 1 : 0);

        // Compact mode: hide temps when widget is too short
        let usableH = h - padV * 2;
        let estRowH = Math.max(barH, fontSize) + spacing;
        let totalRowsNeeded = mainRowCount + 1;
        let maxVisualRows = estRowH > 0 ? Math.floor(usableH / estRowH) : totalRowsNeeded;
        this._compact = maxVisualRows < totalRowsNeeded;

        // -------------------------------------------------------------------
        // Core topology detection
        // -------------------------------------------------------------------
        let logicalCpus = [];
        try {
            let stat = _hwMonPoller._readFile('/proc/stat') ?? '';
            for (let line of stat.split('\n')) {
                let m = line.match(/^cpu(\d+)\s/);
                if (m) logicalCpus.push(parseInt(m[1], 10));
            }
        } catch (_) {}

        let isArm = !['intel', 'amd', 'unknown'].includes(cpuVendor);
        let primaryCpus = [];
        let secondaryCpus = [];
        this._coreTier = {};
        this._isArm = isArm;
        this._isHeterogeneousArm = false;

        let primeCpus = [];
        this._hasPrimeTier = false;

        if (isArm) {
            // ARM DynamIQ / big.LITTLE: classify by max frequency
            let freqs = {};
            let hasFreqData = false;
            for (let idx of logicalCpus) {
                let freq = _hwMonPoller._readFile(`/sys/devices/system/cpu/cpu${idx}/cpufreq/cpuinfo_max_freq`);
                if (freq) {
                    freqs[idx] = parseInt(freq, 10);
                    hasFreqData = true;
                } else {
                    freqs[idx] = 0;
                }
            }

            if (!hasFreqData) {
                // Fallback: cluster_id
                let clusters = {};
                for (let idx of logicalCpus) {
                    let cid = _hwMonPoller._readFile(`/sys/devices/system/cpu/cpu${idx}/topology/cluster_id`);
                    clusters[idx] = cid ? parseInt(cid, 10) : 0;
                }
                let minCluster = Math.min(...Object.values(clusters));
                for (let idx of logicalCpus) {
                    if (clusters[idx] === minCluster) {
                        primaryCpus.push(idx);
                        this._coreTier[idx] = 'primary';
                    } else {
                        secondaryCpus.push(idx);
                        this._coreTier[idx] = 'secondary';
                    }
                }
            } else {
                let uniqueFreqs = [...new Set(Object.values(freqs))].filter(f => f > 0).sort((a, b) => b - a);

                if (uniqueFreqs.length >= 3) {
                    // Tri-cluster: prime / big / LITTLE
                    this._hasPrimeTier = true;
                    this._isHeterogeneousArm = true;
                    let primeThresh = uniqueFreqs[0] * 0.95;
                    let bigThresh = uniqueFreqs[1] * 0.95;
                    for (let idx of logicalCpus) {
                        if (freqs[idx] >= primeThresh) {
                            primeCpus.push(idx);
                            this._coreTier[idx] = 'prime';
                        } else if (freqs[idx] >= bigThresh) {
                            primaryCpus.push(idx);
                            this._coreTier[idx] = 'primary';
                        } else {
                            secondaryCpus.push(idx);
                            this._coreTier[idx] = 'secondary';
                        }
                    }
                } else {
                    // Two-tier: big / LITTLE
                    let maxFreq = uniqueFreqs[0] || 0;
                    let bigThreshold = maxFreq * 0.8;
                    for (let idx of logicalCpus) {
                        if (freqs[idx] >= bigThreshold) {
                            primaryCpus.push(idx);
                            this._coreTier[idx] = 'primary';
                        } else {
                            secondaryCpus.push(idx);
                            this._coreTier[idx] = 'secondary';
                        }
                    }
                }
            }
            if (secondaryCpus.length > 0 && !this._isHeterogeneousArm)
                this._isHeterogeneousArm = true;
        } else {
            // x86: detect hybrid (P-core/E-core) and SMT threads
            let coreTypes = {};
            let hasHybrid = false;
            for (let idx of logicalCpus) {
                let ct = _hwMonPoller._readFile(`/sys/devices/system/cpu/cpu${idx}/topology/core_type`);
                if (ct !== null) {
                    let type = parseInt(ct, 10);
                    coreTypes[idx] = type >= 64 ? 'perf' : 'eff';
                    if (type < 64) hasHybrid = true;
                }
            }
            // Fallback: detect hybrid via max frequency differences
            if (!hasHybrid) {
                let freqs = {};
                for (let idx of logicalCpus) {
                    let f = _hwMonPoller._readFile(`/sys/devices/system/cpu/cpu${idx}/cpufreq/cpuinfo_max_freq`);
                    if (f) freqs[idx] = parseInt(f, 10);
                }
                let vals = Object.values(freqs);
                if (vals.length > 0) {
                    let maxF = Math.max(...vals);
                    let minF = Math.min(...vals);
                    if (maxF > 0 && minF > 0 && (maxF - minF) / maxF > 0.2) {
                        hasHybrid = true;
                        let threshold = maxF * 0.8;
                        for (let idx of logicalCpus)
                            coreTypes[idx] = (freqs[idx] ?? 0) >= threshold ? 'perf' : 'eff';
                    }
                }
            }

            this._isHybridX86 = hasHybrid;

            // Classify: physical vs SMT, then P-core vs E-core
            let seenCores = new Set();
            for (let idx of logicalCpus) {
                let siblings = _hwMonPoller._readFile(`/sys/devices/system/cpu/cpu${idx}/topology/thread_siblings_list`);
                let isPhysical = true;
                if (siblings) {
                    let primary = parseInt(siblings.split(/[,-]/)[0], 10);
                    if (seenCores.has(primary) && idx !== primary)
                        isPhysical = false;
                    else
                        seenCores.add(primary);
                }
                if (!isPhysical) {
                    secondaryCpus.push(idx);
                    this._coreTier[idx] = 'secondary';
                } else if (hasHybrid && coreTypes[idx] === 'eff') {
                    secondaryCpus.push(idx);
                    this._coreTier[idx] = 'efficiency';
                } else {
                    primaryCpus.push(idx);
                    this._coreTier[idx] = 'primary';
                }
            }
        }
        this._coreOrder = [...primeCpus, ...primaryCpus, ...secondaryCpus].sort((a, b) => a - b);
        this._physicalCount = primeCpus.length + primaryCpus.length;

        // -------------------------------------------------------------------
        // Per-core bar sizing
        // -------------------------------------------------------------------
        let coreBarH = Math.max(snap(3), snap(4 * s));
        let coreBarRad = snap(coreBarH / 2);
        let coreSpacing = snap(2 * s);
        let coreFontSize = snap(9 * s);
        let coreLabelW = snap(24 * s);
        let mainRowActualH = Math.max(barH, fontSize) + spacing;
        let tempActualH = this._compact ? 0 : this._diskTempPaired ? 0 : fontSize + spacing;

        let coreRowH = Math.max(coreBarH, coreFontSize) + spacing;
        let rowRealH = Math.max(barH, fontSize + 4) + spacing * 2;
        let mainContentH = (mainRowCount * rowRealH) + tempActualH + pad * 2;
        let availForCores = Math.max(0, h - mainContentH);
        let maxCoreH = Math.floor(h * 0.6);
        let maxCoreRows = !this.showCores ? 0
            : coreRowH > 0 ? Math.floor(Math.min(availForCores, maxCoreH) / coreRowH) : 0;

        // -------------------------------------------------------------------
        // Bar row builder
        // -------------------------------------------------------------------
        let _addBarRow = (parent, key, label, color, isCore) => {
            let bh = isCore ? coreBarH : barH;
            let br = isCore ? coreBarRad : barRad;
            let fs = isCore ? coreFontSize : fontSize;
            let lw = isCore ? coreLabelW : labelW;
            let row = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `spacing: ${snap(8 * s)}px;`,
            });
            parent.add_child(row);

            let nameLabel = new St.Label({
                text: label,
                style: `color: rgba(255,255,255,${isCore ? '0.5' : '0.7'}); font-size: ${fs}px;`
                    + ` min-width: ${lw}px;`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(nameLabel);

            let barBg = new St.Widget({
                x_expand: true,
                height: bh,
                y_align: Clutter.ActorAlign.CENTER,
                style: `background-color: rgba(255,255,255,0.15); border-radius: ${br}px;`,
            });
            row.add_child(barBg);

            let barFill = new St.Widget({
                width: 0,
                height: bh,
                style: `background-color: ${color}; border-radius: ${br}px;${isCore ? ' opacity: 180;' : ''}`,
            });
            barBg.add_child(barFill);

            let pctLabel = new St.Label({
                text: '--',
                style: `color: rgba(255,255,255,${isCore ? '0.5' : '0.8'}); font-size: ${fs}px;`
                    + ` min-width: ${pctW}px; text-align: right;`,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(pctLabel);

            this._bars[key] = { bg: barBg, fill: barFill, pct: pctLabel, name: nameLabel };
        };

        // Multi-column core layout
        let coreColGap = snap(8 * s);
        let coreColMinW = coreLabelW + snap(40 * s) + pctW + snap(12 * s);
        this._coreCols = Math.max(1, Math.floor((innerW + coreColGap) / (coreColMinW + coreColGap)));
        this._coreColW = this._coreCols > 1
            ? Math.floor((innerW - (this._coreCols - 1) * coreColGap) / this._coreCols)
            : innerW;
        this._coreCount = Math.min(this._coreOrder.length, Math.max(0, maxCoreRows * this._coreCols));

        this._coreSlots = [];
        let coresInserted = false;

        let sectionBoundaries = [];

        // -------------------------------------------------------------------
        // Build bar rows
        // -------------------------------------------------------------------
        for (let group of barRows) {
            sectionBoundaries.push(this._box.get_n_children());
            if (group.length === 1) {
                _addBarRow(this._box, group[0].key, group[0].label, group[0].color, false);
            } else {
                let pairRow = new St.BoxLayout({
                    x_expand: true,
                    style: `spacing: ${mainPairGap}px;`,
                });
                this._box.add_child(pairRow);
                for (let bar of group) {
                    let col = new St.BoxLayout({ vertical: true, width: this._pairedColW });
                    pairRow.add_child(col);
                    _addBarRow(col, bar.key, bar.label, bar.color, false);
                }
            }
            // Insert per-core grid after the CPU row
            if (!coresInserted && group.some(b => b.key === 'cpu') && this._coreCount > 0) {
                coresInserted = true;
                sectionBoundaries.push(this._box.get_n_children());
                let coreGridRows = Math.ceil(this._coreCount / this._coreCols);
                for (let r = 0; r < coreGridRows; r++) {
                    let gridRow = new St.BoxLayout({
                        x_expand: true,
                        style: `spacing: ${coreColGap}px;`,
                    });
                    this._box.add_child(gridRow);
                    for (let c = 0; c < this._coreCols; c++) {
                        let slotIdx = r * this._coreCols + c;
                        if (slotIdx >= this._coreCount) {
                            gridRow.add_child(new St.Widget({ width: this._coreColW }));
                            continue;
                        }
                        let slotKey = `coreSlot${slotIdx}`;
                        let colBox = new St.BoxLayout({
                            vertical: true,
                            width: this._coreColW,
                        });
                        gridRow.add_child(colBox);
                        _addBarRow(colBox, slotKey, '--', cpuColor, true);
                        this._coreSlots.push(slotKey);
                    }
                }
            }
        }

        // -------------------------------------------------------------------
        // Disk + Temps section
        // -------------------------------------------------------------------
        sectionBoundaries.push(this._box.get_n_children());
        if (this._diskTempPaired) {
            let diskTempRow = new St.BoxLayout({
                x_expand: true,
                style: `spacing: ${mainPairGap}px;`,
            });
            this._box.add_child(diskTempRow);
            let diskCol = new St.BoxLayout({ vertical: true, width: this._pairedColW });
            diskTempRow.add_child(diskCol);
            _addBarRow(diskCol, diskBar.key, diskBar.label, diskBar.color, false);

            if (!this._compact) {
                this._tempLabel = new St.Label({
                    text: '--',
                    style: `color: rgba(255,255,255,0.65); font-size: ${fontSize}px; text-align: right;`,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                });
                diskTempRow.add_child(this._tempLabel);
            }
        } else {
            _addBarRow(this._box, diskBar.key, diskBar.label, diskBar.color, false);
            if (!this._compact) {
                this._tempLabel = new St.Label({
                    text: '--',
                    style: `color: rgba(255,255,255,0.65); font-size: ${fontSize}px;`,
                    x_align: Clutter.ActorAlign.START,
                });
                this._box.add_child(this._tempLabel);
            }
        }

        // -------------------------------------------------------------------
        // Inter-section spacers for even vertical distribution
        // -------------------------------------------------------------------
        if (!this._compact) {
            for (let i = sectionBoundaries.length - 1; i > 0; i--) {
                let idx = sectionBoundaries[i];
                let spacer = new St.Widget({ y_expand: true });
                let sibling = this._box.get_child_at_index(idx);
                if (sibling)
                    this._box.insert_child_below(spacer, sibling);
                else
                    this._box.add_child(spacer);
            }
        }

        // Subscribe to shared poller
        _hwMonPoller.subscribe(this);

        return this._box;
    }

    // -----------------------------------------------------------------------
    // Poller callbacks
    // -----------------------------------------------------------------------

    /**
     * Called by the shared poller with per-core usage data.
     * @param {Array<{idx: number, usage: number}>} coreUsages
     */
    _applyCoreUsages(coreUsages) {
        if (!this._coreSlots || this._coreSlots.length === 0) return;

        let usageMap = {};
        for (let c of coreUsages) usageMap[c.idx] = c.usage;

        let _tierRank = { prime: 0, primary: 1, efficiency: 2, secondary: 3 };

        let sorted;
        if (this._coreCount >= this._coreOrder.length) {
            sorted = this._coreOrder.slice(0, this._coreCount).map(idx => ({
                idx, usage: usageMap[idx] ?? -1,
            }));
        } else {
            sorted = coreUsages.slice().sort((a, b) => {
                let aRank = _tierRank[this._coreTier[a.idx]] ?? 2;
                let bRank = _tierRank[this._coreTier[b.idx]] ?? 2;
                if (aRank !== bRank) return aRank - bRank;
                return b.usage - a.usage;
            });
        }

        /** Tier label prefix. */
        let _prefix = (tier) => {
            if (this._isArm && this._isHeterogeneousArm) {
                if (this._hasPrimeTier) {
                    if (tier === 'prime') return 'P';
                    if (tier === 'primary') return 'B';
                    return 'L';
                }
                return tier === 'primary' ? 'B' : 'L';
            }
            if (this._isHybridX86) {
                if (tier === 'primary') return 'P';
                if (tier === 'efficiency') return 'E';
                return 'T';
            }
            return tier === 'secondary' ? 'T' : 'C';
        };

        for (let i = 0; i < this._coreSlots.length; i++) {
            let slotKey = this._coreSlots[i];
            let entry = this._bars[slotKey];
            if (!entry) continue;
            if (i < sorted.length) {
                let c = sorted[i];
                let prefix = _prefix(this._coreTier[c.idx]);
                entry.name.text = `${prefix}${c.idx}`;
                if (c.usage < 0) {
                    this._setBar(slotKey, 0, 'Off');
                } else {
                    this._setBar(slotKey, c.usage);
                }
            } else {
                entry.name.text = '--';
                this._setBar(slotKey, 0);
            }
        }
    }

    /**
     * Update a single bar's fill width and percentage label.
     * @param {string} key - bar identifier
     * @param {number} fraction - 0..1
     * @param {string} [label] - optional override label
     */
    _setBar(key, fraction, label) {
        let entry = this._bars[key];
        if (!entry) return;
        let pct = Math.max(0, Math.min(1, fraction));
        let bgW = entry.bg.width;
        if (bgW > 0) {
            let gs = this._monitor?.geometry_scale ?? 1;
            let targetW = Math.round(bgW * pct * gs) / gs;
            entry.fill.remove_all_transitions();
            entry.fill.ease({
                width: targetW,
                duration: 800,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        entry.pct.text = label ?? `${Math.round(pct * 100)}%`;
    }

    /**
     * Format a byte count as a human-readable string.
     * @param {number} bytes
     * @returns {string}
     */
    static _fmtBytes(bytes) {
        if (bytes >= 1073741824)
            return `${(bytes / 1073741824).toFixed(1)}G`;
        if (bytes >= 1048576)
            return `${(bytes / 1048576).toFixed(0)}M`;
        return `${(bytes / 1024).toFixed(0)}K`;
    }

    /** Clean up and unsubscribe from the shared poller. */
    destroy() {
        this._destroyed = true;
        _hwMonPoller.unsubscribe(this);
        this._box = null;
        this._bars = {};
        this._tempLabel = null;
        this._settings = null;
    }
}

function _buildSystemMonitorPreview({ runtimeEnv }) {
    _bindShellEnv(runtimeEnv);
    let box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.style = 'background-color: rgba(0,0,0,0.50); border-radius: 8px; padding: 8px; spacing: 3px;';
    for (let [label, pct, color] of [['CPU', 45, '#5b9bd5'], ['RAM', 62, '#70c070'], ['GPU', 30, '#f0a050']]) {
        let row = new St.BoxLayout({ x_expand: true, style: 'spacing: 4px;' });
        box.add_child(row);
        row.add_child(new St.Label({
            text: label,
            style: 'color: rgba(255,255,255,0.7); font-size: 9px; min-width: 28px;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        let bg = new St.Widget({
            x_expand: true,
            height: 5,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'background-color: rgba(255,255,255,0.15); border-radius: 3px;',
        });
        row.add_child(bg);
        let bar = new St.Widget({
            height: 5,
            width: Math.round(pct * 0.6),
            style: `background-color: ${color}; border-radius: 3px;`,
        });
        bg.add_child(bar);
        row.add_child(new St.Label({
            text: `${pct}%`,
            style: 'color: rgba(255,255,255,0.5); font-size: 8px; min-width: 24px;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    return box;
}

export const SYSTEM_MONITOR_WIDGET_DEFINITION = {
    widgetType: 'hw_monitor',
    label: 'System Monitor',
    description: 'CPU, RAM, GPU & temps',
    defaultColSpan: 3,
    defaultRowSpan: 3,
    minColSpan: 2,
    minRowSpan: 1,
    unique: true,

    createInstance({ settings, widgetItem }) {
        return new SystemMonitorWidget(settings, widgetItem);
    },

    buildPreview({ runtimeEnv }) {
        return _buildSystemMonitorPreview({ runtimeEnv });
    },

    buildPreferences({ settings, hasKey, page, helpers }) {
        if (!hasKey('widget-hwmon-show-cores'))
            return;
        let { Adw, Gio } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'System Monitor Widget',
            description: 'Configure the system monitor widget on the home screen',
        });
        let row = new Adw.SwitchRow({
            title: 'Show cores',
            subtitle: 'Display per-core CPU usage bars',
        });
        settings.bind(
            'widget-hwmon-show-cores',
            row,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(row);
        page.add(group);
    },

    buildInstanceSettings({ page, store, settings, helpers }) {
        let { Adw } = helpers.gtk;
        let group = new Adw.PreferencesGroup({
            title: 'System Monitor',
            description: 'Customize this system monitor widget instance',
        });
        helpers.addSwitchPreference(group, {
            title: 'Show cores',
            subtitle: 'Display per-core CPU usage bars in this widget instance',
            getValue: () => store.getPreference('showCores', settings?.get_boolean?.('widget-hwmon-show-cores') ?? true),
            setValue: value => store.setPreference('showCores', value),
        });
        page.add(group);
    },
};
