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
        this.pendingRequests = new Map();
        this.deviceIp = null;
        this.devicePort = DISCOVERY_PORT;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    async onReady() {
        this.log.info('Marstek Venus adapter starting...');
        this.deviceIp   = this.config.host   || null;
        this.devicePort = parseInt(this.config.port, 10) || DISCOVERY_PORT;

        await this.createObjects();

        this.udpClient = dgram.createSocket('udp4');
        this.udpClient.on('message', (msg) => this.onUdpMessage(msg));
        this.udpClient.on('error',   (err) => this.log.error('UDP socket error: ' + err.message));

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

        this.subscribeStates('control.*');
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) clearInterval(this.pollTimer);
            if (this.udpClient) { this.udpClient.close(); this.udpClient = null; }
            for (const [, req] of this.pendingRequests) { clearTimeout(req.timer); req.reject(new Error('Adapter unloading')); }
            this.pendingRequests.clear();
            callback();
        } catch (e) { callback(); }
    }

    // ─── UDP ─────────────────────────────────────────────────────────────────

    sendCommand(method, params, targetIp, targetPort) {
        return new Promise((resolve, reject) => {
            const id      = requestId++;
            // Always include "id": 0 in params as required by Marstek API
            const fullParams = Object.assign({ id: 0 }, params || {});
            const payload = JSON.stringify({ id, method, params: fullParams });
            const ip      = targetIp   || this.deviceIp;
            const port    = targetPort || this.devicePort;

            if (!ip) return reject(new Error('Device IP not known yet'));

            this.log.debug(`>> ${method} ${JSON.stringify(fullParams)}`);

            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Timeout waiting for response to ${method}`));
            }, RESPONSE_TIMEOUT);

            this.pendingRequests.set(id, { resolve, reject, timer });

            const buf = Buffer.from(payload);
            this.udpClient.send(buf, 0, buf.length, port, ip, (err) => {
                if (err) { clearTimeout(timer); this.pendingRequests.delete(id); reject(err); }
            });
        });
    }

    onUdpMessage(msg) {
        let data;
        try { data = JSON.parse(msg.toString()); } catch (e) { return; }
        this.log.debug('<< ' + msg.toString());

        // Discovery response
        if (data.id === 0 && data.result && data.result.ip) {
            const pending = this.pendingRequests.get(0);
            if (pending) { clearTimeout(pending.timer); this.pendingRequests.delete(0); pending.resolve(data); }
            return;
        }

        const pending = this.pendingRequests.get(data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(data.id);

        if (data.error) {
            pending.reject(new Error(`API error: ${JSON.stringify(data.error)}`));
        } else {
            // result may be nested under data.result or directly in data
            pending.resolve(data.result !== undefined ? data.result : data);
        }
    }

    // ─── Discovery ────────────────────────────────────────────────────────────

    async discoverDevice() {
        this.log.info('Broadcasting discovery packet...');
        return new Promise((resolve, reject) => {
            const id      = 0;
            const payload = JSON.stringify({ id, method: 'Marstek.GetDevice', params: { ble_mac: '0' } });
            const buf     = Buffer.from(payload);

            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Discovery timeout'));
            }, RESPONSE_TIMEOUT);

            this.pendingRequests.set(id, {
                resolve: (data) => {
                    if (data.result && data.result.ip) {
                        this.deviceIp = data.result.ip;
                        this.log.info(`Discovered device at ${this.deviceIp}`);
                        this.setState('info.deviceName',      data.result.device,    true);
                        this.setState('info.bleMac',          data.result.ble_mac,   true);
                        this.setState('info.wifiMac',         data.result.wifi_mac,  true);
                        this.setState('info.wifiSsid',        data.result.wifi_name, true);
                        this.setState('info.firmwareVersion', String(data.result.ver), true);
                    }
                    resolve(data);
                },
                reject, timer,
            });

            this.udpClient.send(buf, 0, buf.length, this.devicePort, DISCOVERY_BROADCAST, (err) => {
                if (err) { clearTimeout(timer); this.pendingRequests.delete(id); reject(err); }
            });
        }).catch((err) => { this.log.warn('Discovery failed: ' + err.message); });
    }

    // ─── Polling ─────────────────────────────────────────────────────────────

    startPolling() {
        const interval = Math.max(parseInt(this.config.pollInterval, 10) || 30, 5) * 1000;
        this.log.info(`Polling every ${interval / 1000}s`);
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), interval);
    }

    async poll() {
        if (!this.deviceIp) return;
        try {
            await this.pollES();
            await this.pollEM();
            await this.setState('info.connection', true, true);
        } catch (err) {
            this.log.warn('Poll error: ' + err.message);
            await this.setState('info.connection', false, true);
        }
    }

    async pollES() {
        // ES.GetStatus returns: bat_soc, bat_power, ongrid_power, load_power, pv_power, mode, work_mode, etc.
        const r = await this.sendCommand('ES.GetStatus', {});
        if (!r) return;

        this.log.debug('ES.GetStatus result: ' + JSON.stringify(r));

        // Battery
        if (r.bat_soc       !== undefined) await this.setState('battery.soc',           r.bat_soc,       true);
        if (r.bat_power     !== undefined) await this.setState('battery.power',         r.bat_power,     true);
        if (r.bat_vol       !== undefined) await this.setState('battery.voltage',        r.bat_vol,       true);
        if (r.bat_cur       !== undefined) await this.setState('battery.current',        r.bat_cur,       true);
        if (r.bat_temp      !== undefined) await this.setState('battery.temperature',    r.bat_temp,      true);
        if (r.bat_cycle     !== undefined) await this.setState('battery.cycles',         r.bat_cycle,     true);
        if (r.bat_health    !== undefined) await this.setState('battery.health',         r.bat_health,    true);
        if (r.bat_cap       !== undefined) await this.setState('battery.capacity',       r.bat_cap,       true);
        if (r.bat_remain    !== undefined) await this.setState('battery.remainCapacity', r.bat_remain,    true);

        // Grid / Load / PV
        if (r.ongrid_power  !== undefined) await this.setState('energySystem.gridPower',      r.ongrid_power,  true);
        if (r.load_power    !== undefined) await this.setState('energySystem.loadPower',      r.load_power,    true);
        if (r.pv_power      !== undefined) await this.setState('pv.power',                    r.pv_power,      true);

        // Charge / discharge direction from bat_power sign
        if (r.bat_power !== undefined) {
            await this.setState('energySystem.chargePower',    r.bat_power > 0 ? r.bat_power : 0, true);
            await this.setState('energySystem.dischargePower', r.bat_power < 0 ? Math.abs(r.bat_power) : 0, true);
        }

        // Mode
        const mode = r.mode !== undefined ? r.mode : r.work_mode;
        if (mode !== undefined) {
            await this.setState('energySystem.mode', String(mode), true);
        }
    }

    async pollEM() {
        try {
            const r = await this.sendCommand('EM.GetStatus', {});
            if (!r) return;
            this.log.debug('EM.GetStatus result: ' + JSON.stringify(r));
            if (r.a_power     !== undefined) await this.setState('energyMeter.aPower',     r.a_power,     true);
            if (r.b_power     !== undefined) await this.setState('energyMeter.bPower',     r.b_power,     true);
            if (r.c_power     !== undefined) await this.setState('energyMeter.cPower',     r.c_power,     true);
            if (r.total_power !== undefined) await this.setState('energyMeter.totalPower', r.total_power, true);
            if (r.ct_state    !== undefined) await this.setState('energyMeter.ctState',    r.ct_state,    true);
        } catch (err) {
            this.log.debug('EM.GetStatus not available: ' + err.message);
        }
    }

    // ─── Control ─────────────────────────────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        const parts    = id.split('.');
        const channel  = parts[2];
        const stateName = parts[3];
        if (channel !== 'control') return;

        try {
            if (stateName === 'setMode')           await this.setMode(state.val);
            if (stateName === 'setPassivePower')   await this.setPassiveMode(state.val, this.config.passiveDuration || 60);
            if (stateName === 'triggerDiscovery')  await this.discoverDevice();
            if (stateName === 'setDOD')            await this.setDOD(parseInt(state.val, 10));
            if (stateName === 'setManualSchedule') await this.setManualSchedule(JSON.parse(state.val));
        } catch (err) {
            this.log.error(`Error handling ${stateName}: ${err.message}`);
        }
    }

    async setMode(mode) {
        // Marstek API: params must include id:0 and config object
        let config = { mode: String(mode) };
        const m = String(mode).toLowerCase();
        if (m === 'ai')     config = { mode: 'AI',     ai_cfg:   { enable: 1 } };
        if (m === 'auto')   config = { mode: 'Auto',   auto_cfg: { enable: 1 } };
        if (m === 'manual') config = { mode: 'Manual', man_cfg:  { enable: 0 } };
        if (m === 'passive') config = { mode: 'Passive' };
        if (m === 'ups')    config = { mode: 'UPS' };

        const r = await this.sendCommand('ES.SetMode', { config });
        this.log.debug('SetMode response: ' + JSON.stringify(r));
        this.log.info(`Mode set to ${mode}`);
        await this.setState('energySystem.mode', String(mode), true);
    }

    async setPassiveMode(power, duration) {
        const r = await this.sendCommand('ES.SetPassive', { power: parseInt(power, 10), duration: parseInt(duration, 10) });
        this.log.debug('SetPassive response: ' + JSON.stringify(r));
        this.log.info(`Passive mode: ${power}W for ${duration}min`);
    }

    async setDOD(dod) {
        if (dod < 0 || dod > 100) { this.log.warn('DOD must be 0-100'); return; }
        const r = await this.sendCommand('DOD.Set', { dod });
        this.log.debug('SetDOD response: ' + JSON.stringify(r));
        await this.setState('battery.dod', dod, true);
    }

    async setManualSchedule(schedule) {
        if (!Array.isArray(schedule) || !schedule.length) { this.log.warn('setManualSchedule: needs array'); return; }
        const r = await this.sendCommand('ES.SetManual', { schedule });
        this.log.debug('SetManual response: ' + JSON.stringify(r));
        this.log.info(`Manual schedule set: ${schedule.length} entries`);
    }

    // ─── Objects ─────────────────────────────────────────────────────────────

    async createObjects() {
        const objs = {
            'info.connection':          { common: { name: 'Connected',              type: 'boolean', role: 'indicator.connected',  read: true,  write: false, def: false } },
            'info.deviceName':          { common: { name: 'Device Name',            type: 'string',  role: 'info.name',            read: true,  write: false } },
            'info.bleMac':              { common: { name: 'BLE MAC',                type: 'string',  role: 'info.mac',             read: true,  write: false } },
            'info.wifiMac':             { common: { name: 'WiFi MAC',               type: 'string',  role: 'info.mac',             read: true,  write: false } },
            'info.wifiSsid':            { common: { name: 'WiFi SSID',              type: 'string',  role: 'info.name',            read: true,  write: false } },
            'info.firmwareVersion':     { common: { name: 'Firmware Version',       type: 'string',  role: 'info.version',         read: true,  write: false } },

            'battery.soc':              { common: { name: 'State of Charge',        type: 'number',  role: 'value.battery',        read: true,  write: false, unit: '%'  } },
            'battery.power':            { common: { name: 'Power (+ charge)',        type: 'number',  role: 'value.power',          read: true,  write: false, unit: 'W'  } },
            'battery.voltage':          { common: { name: 'Voltage',                type: 'number',  role: 'value.voltage',        read: true,  write: false, unit: 'V'  } },
            'battery.current':          { common: { name: 'Current',                type: 'number',  role: 'value.current',        read: true,  write: false, unit: 'A'  } },
            'battery.temperature':      { common: { name: 'Temperature',            type: 'number',  role: 'value.temperature',    read: true,  write: false, unit: '°C' } },
            'battery.cycles':           { common: { name: 'Charge Cycles',          type: 'number',  role: 'value',                read: true,  write: false } },
            'battery.health':           { common: { name: 'Health (SOH)',            type: 'number',  role: 'value',                read: true,  write: false, unit: '%'  } },
            'battery.capacity':         { common: { name: 'Total Capacity',         type: 'number',  role: 'value',                read: true,  write: false, unit: 'Wh' } },
            'battery.remainCapacity':   { common: { name: 'Remaining Capacity',     type: 'number',  role: 'value',                read: true,  write: false, unit: 'Wh' } },
            'battery.dod':              { common: { name: 'Depth of Discharge',     type: 'number',  role: 'value',                read: true,  write: false, unit: '%'  } },

            'energySystem.mode':            { common: { name: 'Operating Mode',         type: 'string',  role: 'text',             read: true,  write: false } },
            'energySystem.gridPower':       { common: { name: 'Grid Power',             type: 'number',  role: 'value.power',      read: true,  write: false, unit: 'W'  } },
            'energySystem.loadPower':       { common: { name: 'Load Power',             type: 'number',  role: 'value.power',      read: true,  write: false, unit: 'W'  } },
            'energySystem.chargePower':     { common: { name: 'Charge Power',           type: 'number',  role: 'value.power',      read: true,  write: false, unit: 'W'  } },
            'energySystem.dischargePower':  { common: { name: 'Discharge Power',        type: 'number',  role: 'value.power',      read: true,  write: false, unit: 'W'  } },

            'energyMeter.aPower':       { common: { name: 'Phase A Power',           type: 'number',  role: 'value.power',          read: true,  write: false, unit: 'W'  } },
            'energyMeter.bPower':       { common: { name: 'Phase B Power',           type: 'number',  role: 'value.power',          read: true,  write: false, unit: 'W'  } },
            'energyMeter.cPower':       { common: { name: 'Phase C Power',           type: 'number',  role: 'value.power',          read: true,  write: false, unit: 'W'  } },
            'energyMeter.totalPower':   { common: { name: 'Total Grid Power',        type: 'number',  role: 'value.power',          read: true,  write: false, unit: 'W'  } },
            'energyMeter.ctState':      { common: { name: 'CT Clamp Connected',      type: 'boolean', role: 'indicator',            read: true,  write: false } },

            'pv.power':                 { common: { name: 'Total PV Power',          type: 'number',  role: 'value.power',          read: true,  write: false, unit: 'W'  } },

            'control.setMode':          { common: { name: 'Set Mode',                type: 'string',  role: 'text',                 read: true,  write: true,  desc: 'AI | Auto | Manual | Passive | UPS' } },
            'control.setPassivePower':  { common: { name: 'Set Passive Power',       type: 'number',  role: 'value.power',          read: true,  write: true,  unit: 'W'  } },
            'control.setDOD':           { common: { name: 'Set Depth of Discharge',  type: 'number',  role: 'value',                read: true,  write: true,  unit: '%', min: 0, max: 100 } },
            'control.setManualSchedule':{ common: { name: 'Set Manual Schedule JSON',type: 'string',  role: 'text',                 read: true,  write: true  } },
            'control.triggerDiscovery': { common: { name: 'Trigger Discovery',       type: 'boolean', role: 'button',               read: false, write: true  } },
        };

        for (const ch of ['info', 'battery', 'energySystem', 'energyMeter', 'pv', 'control']) {
            await this.setObjectNotExistsAsync(ch, { type: 'channel', common: { name: ch }, native: {} });
        }
        for (const [id, obj] of Object.entries(objs)) {
            await this.setObjectNotExistsAsync(id, { type: 'state', common: obj.common, native: {} });
        }
        this.log.debug('All objects created');
    }
}

if (require.main !== module) {
    module.exports = (options) => new MarstekVenus(options);
} else {
    new MarstekVenus();
}
