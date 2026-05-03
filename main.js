'use strict';

const utils = require('@iobroker/adapter-core');
const dgram = require('dgram');

let requestId = 1;
const DISCOVERY_PORT = 30000;
const DISCOVERY_BROADCAST = '255.255.255.255';
const RESPONSE_TIMEOUT = 5000;

class MarstekVenus extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'marstek-venus' });

        this.udpClient = null;
        this.pollTimer = null;
        this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
        this.deviceIp = null;
        this.devicePort = DISCOVERY_PORT;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async onReady() {
        this.log.info('Marstek Venus adapter starting...');

        this.deviceIp = this.config.host || null;
        this.devicePort = parseInt(this.config.port, 10) || DISCOVERY_PORT;

        await this.createObjects();

        this.udpClient = dgram.createSocket('udp4');
        this.udpClient.on('message', (msg) => this.onUdpMessage(msg));
        this.udpClient.on('error', (err) => this.log.error('UDP socket error: ' + err.message));

        this.udpClient.bind(0, () => {
            this.udpClient.setBroadcast(true);
            this.log.info('UDP socket ready on port ' + this.udpClient.address().port);

            if (!this.deviceIp) {
                this.log.info('No IP configured – running UDP discovery...');
                this.discoverDevice().then(() => this.startPolling());
            } else {
                this.log.info(`Using configured device IP: ${this.deviceIp}:${this.devicePort}`);
                this.startPolling();
            }
        });

        // Subscribe to all writable states
        this.subscribeStates('control.*');
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) clearInterval(this.pollTimer);
            if (this.udpClient) {
                this.udpClient.close();
                this.udpClient = null;
            }
            // Reject all pending requests
            for (const [, req] of this.pendingRequests) {
                clearTimeout(req.timer);
                req.reject(new Error('Adapter unloading'));
            }
            this.pendingRequests.clear();
            callback();
        } catch (e) {
            callback();
        }
    }

    // ─── UDP Communication ────────────────────────────────────────────────────

    /**
     * Send a UDP JSON command and await its response.
     */
    sendCommand(method, params = {}, targetIp = null, targetPort = null) {
        return new Promise((resolve, reject) => {
            const id = requestId++;
            const payload = JSON.stringify({ id, method, params });
            const ip = targetIp || this.deviceIp;
            const port = targetPort || this.devicePort;

            if (!ip) {
                return reject(new Error('Device IP not known yet'));
            }

            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
            }, RESPONSE_TIMEOUT);

            this.pendingRequests.set(id, { resolve, reject, timer });

            const buf = Buffer.from(payload);
            this.udpClient.send(buf, 0, buf.length, port, ip, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }

    onUdpMessage(msg) {
        let data;
        try {
            data = JSON.parse(msg.toString());
        } catch (e) {
            return; // ignore non-JSON
        }

        // Discovery broadcast response (id=0 or contains src)
        if (data.id === 0 && data.result && data.result.ip) {
            // Discovery response
            const pending = this.pendingRequests.get(0);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRequests.delete(0);
                pending.resolve(data);
            }
            return;
        }

        const pending = this.pendingRequests.get(data.id);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingRequests.delete(data.id);

        if (data.error) {
            pending.reject(new Error(`API error: ${JSON.stringify(data.error)}`));
        } else {
            pending.resolve(data.result);
        }
    }

    // ─── Device Discovery ─────────────────────────────────────────────────────

    async discoverDevice() {
        this.log.info('Broadcasting discovery packet...');
        return new Promise((resolve, reject) => {
            const id = 0;
            const payload = JSON.stringify({ id, method: 'Marstek.GetDevice', params: { ble_mac: '0' } });
            const buf = Buffer.from(payload);

            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Discovery timeout – no Marstek device found on LAN'));
            }, RESPONSE_TIMEOUT);

            this.pendingRequests.set(id, {
                resolve: (data) => {
                    if (data.result && data.result.ip) {
                        this.deviceIp = data.result.ip;
                        this.log.info(`Discovered device: ${data.result.device} at ${this.deviceIp}`);
                        this.setState('info.deviceName', data.result.device, true);
                        this.setState('info.bleMac', data.result.ble_mac, true);
                        this.setState('info.wifiMac', data.result.wifi_mac, true);
                        this.setState('info.wifiSsid', data.result.wifi_name, true);
                        this.setState('info.firmwareVersion', String(data.result.ver), true);
                    }
                    resolve(data);
                },
                reject,
                timer,
            });

            this.udpClient.send(buf, 0, buf.length, this.devicePort, DISCOVERY_BROADCAST, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(id);
                    reject(err);
                }
            });
        }).catch((err) => {
            this.log.warn('Discovery failed: ' + err.message);
        });
    }

    // ─── Polling ──────────────────────────────────────────────────────────────

    startPolling() {
        const interval = Math.max(parseInt(this.config.pollInterval, 10) || 30, 5) * 1000;
        this.log.info(`Starting polling every ${interval / 1000}s`);
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), interval);
    }

    async poll() {
        if (!this.deviceIp) return;
        try {
            await this.pollBattery();
            await this.pollES();
            await this.pollEM();
            await this.pollPV();
            await this.setState('info.connection', true, true);
        } catch (err) {
            this.log.warn('Poll error: ' + err.message);
            await this.setState('info.connection', false, true);
        }
    }

    async pollBattery() {
        const r = await this.sendCommand('Bat.GetStatus', {});
        if (!r) return;
        await this.setState('battery.soc', r.soc ?? null, true);
        await this.setState('battery.voltage', r.vol ?? null, true);
        await this.setState('battery.current', r.cur ?? null, true);
        await this.setState('battery.power', r.pow ?? null, true);
        await this.setState('battery.temperature', r.temp ?? null, true);
        await this.setState('battery.cycles', r.cycle ?? null, true);
        await this.setState('battery.health', r.health ?? null, true);
        await this.setState('battery.capacity', r.cap ?? null, true);
        await this.setState('battery.remainCapacity', r.remain_cap ?? null, true);
        this.log.debug('Battery: SOC=' + r.soc + '% V=' + r.vol + 'V P=' + r.pow + 'W');
    }

    async pollES() {
        const modeRes = await this.sendCommand('ES.GetMode', {});
        if (modeRes) {
            const modeMap = { 0: 'auto', 1: 'manual', 2: 'passive', 3: 'ai', 4: 'ups' };
            await this.setState('energySystem.mode', modeMap[modeRes.mode] ?? String(modeRes.mode), true);
            await this.setState('energySystem.modeNum', modeRes.mode ?? null, true);
        }

        const r = await this.sendCommand('ES.GetStatus', {});
        if (!r) return;
        await this.setState('energySystem.chargePower', r.charge_power ?? null, true);
        await this.setState('energySystem.dischargePower', r.discharge_power ?? null, true);
        await this.setState('energySystem.gridPower', r.grid_power ?? null, true);
        await this.setState('energySystem.loadPower', r.load_power ?? null, true);
        await this.setState('energySystem.state', r.state ?? null, true);
        this.log.debug('ES: grid=' + r.grid_power + 'W load=' + r.load_power + 'W');
    }

    async pollEM() {
        const r = await this.sendCommand('EM.GetStatus', {});
        if (!r) return;
        await this.setState('energyMeter.aPower', r.a_power ?? null, true);
        await this.setState('energyMeter.bPower', r.b_power ?? null, true);
        await this.setState('energyMeter.cPower', r.c_power ?? null, true);
        await this.setState('energyMeter.totalPower', r.total_power ?? null, true);
        await this.setState('energyMeter.ctState', r.ct_state ?? null, true);
    }

    async pollPV() {
        const r = await this.sendCommand('PV.GetStatus', {});
        if (!r) return;
        await this.setState('pv.power', r.pv_power ?? null, true);
        await this.setState('pv.state', r.pv_state ?? null, true);
        for (let i = 1; i <= 4; i++) {
            if (r[`pv${i}_power`] !== undefined) {
                await this.setState(`pv.input${i}Power`, r[`pv${i}_power`] ?? null, true);
                await this.setState(`pv.input${i}Voltage`, r[`pv${i}_vol`] ?? null, true);
                await this.setState(`pv.input${i}Current`, r[`pv${i}_cur`] ?? null, true);
            }
        }
        this.log.debug('PV: total=' + r.pv_power + 'W');
    }

    // ─── State Changes (Control) ──────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return; // ignore feedback states
        const parts = id.split('.');
        const channel = parts[2];
        const stateName = parts[3];

        if (channel !== 'control') return;

        try {
            if (stateName === 'setMode') {
                await this.setMode(state.val);
            } else if (stateName === 'setPassivePower') {
                await this.setPassiveMode(state.val, this.config.passiveDuration || 60);
            } else if (stateName === 'triggerDiscovery') {
                await this.discoverDevice();
            } else if (stateName === 'setDOD') {
                await this.setDOD(parseInt(state.val, 10));
            } else if (stateName === 'setManualSchedule') {
                // Expects JSON string with schedule array
                const schedule = JSON.parse(state.val);
                await this.setManualSchedule(schedule);
            }
        } catch (err) {
            this.log.error(`Error handling state change for ${stateName}: ${err.message}`);
        }
    }

    async setMode(mode) {
        const modeMap = { auto: 0, manual: 1, passive: 2, ai: 3, ups: 4 };
        const modeNum = typeof mode === 'string' ? modeMap[mode.toLowerCase()] : parseInt(mode, 10);
        if (modeNum === undefined || isNaN(modeNum)) {
            this.log.warn(`Unknown mode: ${mode}. Use: auto, manual, passive, ai, ups`);
            return;
        }
        const r = await this.sendCommand('ES.SetMode', { mode: modeNum });
        this.log.debug('SetMode response: ' + JSON.stringify(r));
        if (r !== null && r !== undefined) {
            this.log.info(`Mode set to ${mode} (${modeNum})`);
            await this.setState('energySystem.mode', typeof mode === 'string' ? mode : String(mode), true);
        }
    }

    async setPassiveMode(power, duration) {
        const r = await this.sendCommand('ES.SetPassive', {
            power: parseInt(power, 10),
            duration: parseInt(duration, 10),
        });
        this.log.debug('SetPassive response: ' + JSON.stringify(r));
        if (r !== null && r !== undefined) {
            this.log.info(`Passive mode set: ${power}W for ${duration}min`);
        }
    }

    async setDOD(dod) {
        if (dod < 0 || dod > 100) {
            this.log.warn('DOD must be between 0 and 100');
            return;
        }
        const r = await this.sendCommand('DOD.Set', { dod });
        this.log.debug('SetDOD response: ' + JSON.stringify(r));
        if (r !== null && r !== undefined) {
            this.log.info(`DOD set to ${dod}%`);
            await this.setState('battery.dod', dod, true);
        }
    }

    async setManualSchedule(schedule) {
        if (!Array.isArray(schedule) || schedule.length === 0) {
            this.log.warn('setManualSchedule: expects a non-empty array of schedule entries');
            return;
        }
        const r = await this.sendCommand('ES.SetManual', { schedule });
        this.log.debug('SetManual response: ' + JSON.stringify(r));
        if (r !== null && r !== undefined) {
            this.log.info(`Manual schedule set with ${schedule.length} entries`);
        }
    }

    // ─── Object Creation ──────────────────────────────────────────────────────

    async createObjects() {
        const objs = {
            // Info channel
            'info.connection': { type: 'state', common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false } },
            'info.deviceName': { type: 'state', common: { name: 'Device Name', type: 'string', role: 'info.name', read: true, write: false } },
            'info.bleMac': { type: 'state', common: { name: 'BLE MAC Address', type: 'string', role: 'info.mac', read: true, write: false } },
            'info.wifiMac': { type: 'state', common: { name: 'WiFi MAC Address', type: 'string', role: 'info.mac', read: true, write: false } },
            'info.wifiSsid': { type: 'state', common: { name: 'WiFi SSID', type: 'string', role: 'info.name', read: true, write: false } },
            'info.firmwareVersion': { type: 'state', common: { name: 'Firmware Version', type: 'string', role: 'info.version', read: true, write: false } },

            // Battery channel
            'battery.soc': { type: 'state', common: { name: 'State of Charge', type: 'number', role: 'value.battery', unit: '%', read: true, write: false } },
            'battery.voltage': { type: 'state', common: { name: 'Battery Voltage', type: 'number', role: 'value.voltage', unit: 'V', read: true, write: false } },
            'battery.current': { type: 'state', common: { name: 'Battery Current', type: 'number', role: 'value.current', unit: 'A', read: true, write: false } },
            'battery.power': { type: 'state', common: { name: 'Battery Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'battery.temperature': { type: 'state', common: { name: 'Battery Temperature', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false } },
            'battery.cycles': { type: 'state', common: { name: 'Charge Cycles', type: 'number', role: 'value', read: true, write: false } },
            'battery.health': { type: 'state', common: { name: 'Battery Health (SOH)', type: 'number', role: 'value', unit: '%', read: true, write: false } },
            'battery.capacity': { type: 'state', common: { name: 'Total Capacity', type: 'number', role: 'value', unit: 'Wh', read: true, write: false } },
            'battery.remainCapacity': { type: 'state', common: { name: 'Remaining Capacity', type: 'number', role: 'value', unit: 'Wh', read: true, write: false } },
            'battery.dod': { type: 'state', common: { name: 'Depth of Discharge', type: 'number', role: 'value', unit: '%', read: true, write: false } },

            // Energy System channel
            'energySystem.mode': { type: 'state', common: { name: 'Operating Mode', type: 'string', role: 'text', read: true, write: false, states: { auto: 'Auto', manual: 'Manual', passive: 'Passive', ai: 'AI', ups: 'UPS' } } },
            'energySystem.modeNum': { type: 'state', common: { name: 'Operating Mode (Number)', type: 'number', role: 'value', read: true, write: false } },
            'energySystem.chargePower': { type: 'state', common: { name: 'Charge Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energySystem.dischargePower': { type: 'state', common: { name: 'Discharge Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energySystem.gridPower': { type: 'state', common: { name: 'Grid Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energySystem.loadPower': { type: 'state', common: { name: 'Load Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energySystem.state': { type: 'state', common: { name: 'ES State', type: 'number', role: 'value', read: true, write: false } },

            // Energy Meter channel
            'energyMeter.aPower': { type: 'state', common: { name: 'Phase A Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energyMeter.bPower': { type: 'state', common: { name: 'Phase B Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energyMeter.cPower': { type: 'state', common: { name: 'Phase C Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energyMeter.totalPower': { type: 'state', common: { name: 'Total Grid Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'energyMeter.ctState': { type: 'state', common: { name: 'CT Clamp Connected', type: 'boolean', role: 'indicator', read: true, write: false } },

            // PV channel
            'pv.power': { type: 'state', common: { name: 'Total PV Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'pv.state': { type: 'state', common: { name: 'PV State', type: 'number', role: 'value', read: true, write: false } },
            'pv.input1Power': { type: 'state', common: { name: 'PV Input 1 Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'pv.input1Voltage': { type: 'state', common: { name: 'PV Input 1 Voltage', type: 'number', role: 'value.voltage', unit: 'V', read: true, write: false } },
            'pv.input1Current': { type: 'state', common: { name: 'PV Input 1 Current', type: 'number', role: 'value.current', unit: 'A', read: true, write: false } },
            'pv.input2Power': { type: 'state', common: { name: 'PV Input 2 Power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false } },
            'pv.input2Voltage': { type: 'state', common: { name: 'PV Input 2 Voltage', type: 'number', role: 'value.voltage', unit: 'V', read: true, write: false } },
            'pv.input2Current': { type: 'state', common: { name: 'PV Input 2 Current', type: 'number', role: 'value.current', unit: 'A', read: true, write: false } },

            // Control channel (writable)
            'control.setMode': { type: 'state', common: { name: 'Set Mode', type: 'string', role: 'text', read: true, write: true, desc: 'auto | manual | passive | ai | ups' } },
            'control.setPassivePower': { type: 'state', common: { name: 'Set Passive Power (W)', type: 'number', role: 'value.power', unit: 'W', read: true, write: true } },
            'control.setDOD': { type: 'state', common: { name: 'Set Depth of Discharge (%)', type: 'number', role: 'value', unit: '%', min: 0, max: 100, read: true, write: true } },
            'control.setManualSchedule': { type: 'state', common: { name: 'Set Manual Schedule (JSON)', type: 'string', role: 'text', read: true, write: true } },
            'control.triggerDiscovery': { type: 'state', common: { name: 'Trigger Device Discovery', type: 'boolean', role: 'button', read: false, write: true } },
        };

        // Create channels
        for (const channel of ['info', 'battery', 'energySystem', 'energyMeter', 'pv', 'control']) {
            await this.setObjectNotExistsAsync(channel, { type: 'channel', common: { name: channel }, native: {} });
        }

        // Create states
        for (const [id, obj] of Object.entries(objs)) {
            await this.setObjectNotExistsAsync(id, { type: obj.type, common: obj.common, native: {} });
        }

        this.log.debug('All objects created');
    }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
if (require.main !== module) {
    module.exports = (options) => new MarstekVenus(options);
} else {
    new MarstekVenus();
}
