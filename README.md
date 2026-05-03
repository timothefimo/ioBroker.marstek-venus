# ioBroker.marstek-venus

![Logo](admin/marstek-venus.png)

[![NPM version](https://img.shields.io/npm/v/iobroker.marstek-venus.svg)](https://www.npmjs.com/package/iobroker.marstek-venus)
[![Downloads](https://img.shields.io/npm/dm/iobroker.marstek-venus.svg)](https://www.npmjs.com/package/iobroker.marstek-venus)
[![License](https://img.shields.io/github/license/YourUser/ioBroker.marstek-venus)](LICENSE)

## Marstek Venus Adapter für ioBroker

Dieser Adapter integriert **Marstek Venus A / Venus D** Batteriespeicher in ioBroker über die lokale Open API (UDP-Protokoll). Er ermöglicht die vollständige Überwachung und Steuerung des Speichers ohne Cloud-Abhängigkeit.

---

## Voraussetzungen

1. **Marstek App** Version **1.6.51 oder neuer** auf deinem Smartphone.
2. In der App: **Einstellungen → Local API → aktivieren** und den UDP-Port notieren (Standard: `30000`).
3. Das Gerät muss im **selben lokalen Netzwerk** wie ioBroker erreichbar sein.

---

## Installation

### Via GitHub (Custom Adapter)

Im ioBroker Admin:
1. Reiter **Adapter** öffnen
2. Oben rechts auf das **GitHub-Symbol** klicken
3. Tab **"Beliebig"** wählen
4. URL eingeben: `https://github.com/YourUser/ioBroker.marstek-venus`
5. Installieren und eine Instanz erstellen

### Via npm (nach Veröffentlichung)

```bash
cd /opt/iobroker
iobroker add marstek-venus
```

---

## Konfiguration

| Feld | Beschreibung | Standard |
|------|-------------|---------|
| **IP-Adresse** | IP des Marstek-Geräts. Leer lassen → automatische Erkennung per UDP-Broadcast | *(leer)* |
| **UDP-Port** | Port wie in der Marstek App konfiguriert | `30000` |
| **Abfrageintervall** | Wie oft Werte abgefragt werden (Sekunden, min. 5) | `30` |
| **Passive Dauer** | Standard-Dauer für den Passivmodus (Minuten) | `60` |

---

## Datenpunkte

### `info.*`

| Datenpunkt | Beschreibung | Einheit |
|-----------|-------------|--------|
| `info.connection` | Verbindungsstatus | Boolean |
| `info.deviceName` | Gerätename (z.B. VenusA) | String |
| `info.bleMac` | Bluetooth MAC-Adresse | String |
| `info.wifiMac` | WLAN MAC-Adresse | String |
| `info.wifiSsid` | Verbundenes WLAN | String |
| `info.firmwareVersion` | Firmware-Version | String |

### `battery.*`

| Datenpunkt | Beschreibung | Einheit |
|-----------|-------------|--------|
| `battery.soc` | Ladestand (State of Charge) | % |
| `battery.voltage` | Batteriespannung | V |
| `battery.current` | Batteriestrom | A |
| `battery.power` | Batterieleistung (+ Laden, - Entladen) | W |
| `battery.temperature` | Batterietemperatur | °C |
| `battery.cycles` | Ladezyklen | – |
| `battery.health` | Batterie-Gesundheit (SOH) | % |
| `battery.capacity` | Gesamtkapazität | Wh |
| `battery.remainCapacity` | Verbleibende Kapazität | Wh |
| `battery.dod` | Entladetiefe (DOD) | % |

### `energySystem.*`

| Datenpunkt | Beschreibung | Einheit |
|-----------|-------------|--------|
| `energySystem.mode` | Aktueller Betriebsmodus (auto/manual/passive/ai/ups) | String |
| `energySystem.chargePower` | Ladeleistung | W |
| `energySystem.dischargePower` | Entladeleistung | W |
| `energySystem.gridPower` | Netzleistung (+ Bezug, - Einspeisung) | W |
| `energySystem.loadPower` | Verbrauchsleistung | W |

### `energyMeter.*`

| Datenpunkt | Beschreibung | Einheit |
|-----------|-------------|--------|
| `energyMeter.totalPower` | Gesamte Netzleistung (CT-Klemme) | W |
| `energyMeter.aPower` | Phase A Leistung | W |
| `energyMeter.bPower` | Phase B Leistung | W |
| `energyMeter.cPower` | Phase C Leistung | W |
| `energyMeter.ctState` | CT-Klemme verbunden | Boolean |

### `pv.*`

| Datenpunkt | Beschreibung | Einheit |
|-----------|-------------|--------|
| `pv.power` | Gesamt-PV-Leistung | W |
| `pv.input1Power` | PV-Eingang 1 Leistung | W |
| `pv.input1Voltage` | PV-Eingang 1 Spannung | V |
| `pv.input1Current` | PV-Eingang 1 Strom | A |
| `pv.input2Power` | PV-Eingang 2 Leistung | W |

### `control.*` (beschreibbar / writable)

| Datenpunkt | Beschreibung | Werte |
|-----------|-------------|-------|
| `control.setMode` | Betriebsmodus setzen | `auto`, `manual`, `passive`, `ai`, `ups` |
| `control.setPassivePower` | Passive Leistung setzen (W) | Zahl in Watt |
| `control.setDOD` | Entladetiefe setzen | 0–100 % |
| `control.setManualSchedule` | Manuellen Zeitplan setzen (JSON) | JSON-Array |
| `control.triggerDiscovery` | Geräteerkennung auslösen | true |

#### Beispiel: Manuellen Zeitplan setzen

Schreibe folgenden JSON-String in `control.setManualSchedule`:

```json
[
  { "start": "06:00", "end": "12:00", "power": 800, "mode": 1 },
  { "start": "18:00", "end": "22:00", "power": -600, "mode": 1 }
]
```

---

## Blockly / Skript-Beispiele

### Modus auf "Passiv" setzen (z.B. bei hohem Strompreis)

```javascript
setState('marstek-venus.0.control.setPassivePower', 0);
setState('marstek-venus.0.control.setMode', 'passive');
```

### Modus auf "Auto" zurücksetzen

```javascript
setState('marstek-venus.0.control.setMode', 'auto');
```

### Ladestand überwachen

```javascript
on({ id: 'marstek-venus.0.battery.soc', change: 'ne' }, (obj) => {
    log('Marstek SOC: ' + obj.state.val + '%');
});
```

---

## Hinweise

- Die API kommuniziert **nur im lokalen Netzwerk** per UDP – keine Cloud-Abhängigkeit.
- Auf manchen Geräten kann der Standard-Port `28416` statt `30000` sein. Überprüfe dies mit `nmap -sUV <IP> -p 28000-30001`.
- Nach dem Aktivieren der Local API in der App ist ggf. ein Neustart des Geräts nötig.
- Der Adapter unterstützt **Venus A und Venus D**. Venus C/E unterstützen EM und DOD leicht anders – Feedback willkommen!

---

## Changelog

### 0.1.0 (2025-xx-xx)
- Erstveröffentlichung / Initial release

---

## License

MIT License – Copyright (c) 2025 Your Name
