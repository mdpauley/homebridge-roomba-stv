let Service;
let Characteristic;

const dorita980 = require("dorita980");
const nodeCache = require("node-cache");
const timeout = require("promise-timeout").timeout;
const STATUS = "status";

const roombaAccessory = function(log, config) {
    this.log = log;
    this.name = config.name;
    this.model = config.model;
    this.blid = config.blid;
    this.robotpwd = config.robotpwd;
    this.ipaddress = config.ipaddress;
    this.firmware = "N/A";
    const refreshMode =
        config.autoRefreshEnabled !== undefined
            ? config.autoRefreshEnabled
                ? "autoRefresh"
                : "none"
            : config.refreshMode; //Backward compatibility
    this.keepAlive = refreshMode == "keepAlive";
    this.autoRefreshEnabled = refreshMode == "autoRefresh";
    this.pollingInterval = config.pollingInterval || 60;
    this.cacheTTL = config.cacheTTL || 30;
    this.roomba = null;

    this.accessoryInfo = new Service.AccessoryInformation();
    this.switchService = new Service.Switch(this.name);
    this.batteryService = new Service.BatteryService(this.name);

    this.cache = new nodeCache({
        stdTTL: this.cacheTTL,
        checkPeriod: 5,
        useClones: false
    });

    this.timer;

    if (this.autoRefreshEnabled) {
        this.autoRefresh();
    } else if (this.keepAlive) {
        this.registerStateUpdate();
    }
};

roombaAccessory.prototype = {
    getRoomba() {
        if (this.keepAlive) {
            if (this.roomba == null) {
                this.roomba = new dorita980.Local(this.blid, this.robotpwd, this.ipaddress);
            }
            return this.roomba;
        } else {
            return new dorita980.Local(this.blid, this.robotpwd, this.ipaddress);
        }
    },
    onConnected(roomba, callback) {
        if (this.keepAlive && roomba.connected) {
            callback();
        } else {
            roomba.on("connect", () => {
                callback();
            });
        }
    },
    setState(powerOn, callback) {
        let roomba = this.getRoomba();

        this.cache.del(STATUS);

        if (powerOn) {
            this.log("Starting Roomba");

            this.onConnected(roomba, async () => {
                try {
                    await roomba.start();
                    this.log("Roomba is running");
                    callback();
                } catch (error) {
                    this.log("Roomba failed: %s", error.message);
                    callback(error);
                } finally {
                    await this.sleep(2000);
                    this.endRoombaIfNeeded(roomba);
                }
            });
        } else {
            this.log("Roomba pause and dock");

            this.onConnected(roomba, async () => {
                try {
                    await roomba.pause();
                    this.log("Roomba is pausing");

                    callback();
                    this.log("Roomba paused, returning to Dock");
                    this.dockWhenStopped(roomba, 3000);
                } catch (error) {
                    this.log("Roomba failed: %s", error.message);
                    this.endRoombaIfNeeded(roomba);
                    callback(error);
                }
            });
        }
    },
    endRoombaIfNeeded(roomba) {
        if (!this.keepAlive) {
            roomba.end();
        }
    },
    async dockWhenStopped(roomba, pollingInterval) {
        try {
            this.sleep(pollingInterval);
            const state = await roomba.getRobotState(["cleanMissionStatus"]);

            switch (state.cleanMissionStatus.phase) {
                case "stop":
                    this.log("Roomba has stopped, issuing dock request");

                    await roomba.dock();
                    this.endRoombaIfNeeded(roomba);
                    this.log("Roomba docking");

                    break;
                case "run":
                    this.log("Roomba is still running. Will check again in 3 seconds");
                    this.dockWhenStopped(roomba, pollingInterval);

                    break;
                default:
                    this.endRoombaIfNeeded(roomba);
                    this.log("Roomba is not running");
                    break;
            }
        } catch (error) {
            this.log(error);
            this.endRoombaIfNeeded(roomba);
        }
    },
    sleep(delay) {
        return new Promise((resolve, reject) => {
            setTimeout(resolve, delay);
        });
    },
    getRunningStatus(callback) {
        this.log("Running status requested");

        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.running);
            }
        });
    },
    getIsCharging(callback) {
        this.log("Charging status requested");

        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.charging);
            }
        });
    },

    getBatteryLevel(callback) {
        this.log("Battery level requested");

        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.batteryLevel);
            }
        });
    },

    getLowBatteryStatus(callback) {
        this.log("Battery status requested");

        this.getStatus((error, status) => {
            if (error) {
                callback(error);
            } else {
                callback(null, status.batteryStatus);
            }
        });
    },

    identify(callback) {
        this.log("Identify requested. Not supported yet.");

        callback();
    },

    getStatus(callback, silent) {
        let status = this.cache.get(STATUS);
        if (status) {
            callback(null, status);
        } else {
            this.getStatusFromRoomba(callback, silent);
        }
    },

    getStatusFromRoomba(callback, silent) {
        let roomba = this.getRoomba();

        this.onConnected(roomba, async () => {
            try {
                if (!silent) this.log("Connected to Roomba");

                let response = await roomba.getRobotState(["cleanMissionStatus", "batPct", "bin"]);
                const status = this.parseState(response);

                callback(null, status);

                this.cache.set(STATUS, status);

                if (!silent) this.log("Roomba[%s]", JSON.stringify(status));
            } catch (error) {
                if (!silent) this.log("Unable to determine state of Roomba");

                this.log.debug(error);

                callback(error);

                this.cache.del(STATUS);
            } finally {
                this.endRoombaIfNeeded(roomba);
            }
        });
    },

    parseState(state) {
        let status = {
            running: 0,
            charging: 0,
            batteryLevel: "N/A",
            batteryStatus: "N/A",
            binFull: false
        };
        status.batteryLevel = state.batPct;
        status.binFull = state.bin.full;

        if (status.batteryLevel <= 20) {
            status.batteryStatus = Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
        } else {
            status.batteryStatus = Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        }
        switch (state.cleanMissionStatus.phase) {
            case "run":
                status.running = 1;
                status.charging = Characteristic.ChargingState.NOT_CHARGING;

                break;
            case "charge":
                status.running = 0;
                status.charging = Characteristic.ChargingState.CHARGING;

                break;
            default:
                status.running = 0;
                status.charging = Characteristic.ChargingState.NOT_CHARGING;

                break;
        }
        return status;
    },

    getServices() {
        this.accessoryInfo.setCharacteristic(Characteristic.Manufacturer, "iRobot");
        this.accessoryInfo.setCharacteristic(Characteristic.SerialNumber, "See iRobot App");
        this.accessoryInfo.setCharacteristic(Characteristic.Identify, false);
        this.accessoryInfo.setCharacteristic(Characteristic.Name, this.name);
        this.accessoryInfo.setCharacteristic(Characteristic.Model, this.model);
        this.accessoryInfo.setCharacteristic(Characteristic.FirmwareRevision, this.firmware);

        this.switchService
            .getCharacteristic(Characteristic.On)
            .on("set", this.setState.bind(this))
            .on("get", this.getRunningStatus.bind(this));

        this.batteryService
            .getCharacteristic(Characteristic.BatteryLevel)
            .on("get", this.getBatteryLevel.bind(this));
        this.batteryService
            .getCharacteristic(Characteristic.ChargingState)
            .on("get", this.getIsCharging.bind(this));
        this.batteryService
            .getCharacteristic(Characteristic.StatusLowBattery)
            .on("get", this.getLowBatteryStatus.bind(this));

        return [this.accessoryInfo, this.switchService, this.batteryService];
    },
    registerStateUpdate() {
        const roomba = this.getRoomba();
        roomba.on("state", state => {
            this.log("Got state from roomba");
            const status = this.parseState(state);

            this.cache.set(STATUS, status);
        });
    },
    autoRefresh() {
        if (this.autoRefreshEnabled) {
            clearTimeout(this.timer);

            this.timer = setTimeout(() => {
                this.log("Auto refresh");
                this.getStatusFromRoomba((error, status) => {
                    if (!error) {
                        this.switchService
                            .getCharacteristic(Characteristic.On)
                            .updateValue(status.running);
                        this.batteryService
                            .getCharacteristic(Characteristic.ChargingState)
                            .updateValue(status.charging);
                        this.batteryService
                            .getCharacteristic(Characteristic.BatteryLevel)
                            .updateValue(status.batteryLevel);
                        this.batteryService
                            .getCharacteristic(Characteristic.StatusLowBattery)
                            .updateValue(status.batteryStatus);
                    }
                }, true);

                this.autoRefresh();
            }, this.pollingInterval * 1000);
        }
    }
};

module.exports = homebridge => {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory("homebridge-roomba", "Roomba", roombaAccessory);
};
