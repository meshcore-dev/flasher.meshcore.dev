import "./lib/beer.min.js";
import { createApp, reactive, ref, nextTick, watch, computed } from "./lib/vue.min.js";
import { Dfu } from "./lib/dfu.js";
import { ESPLoader, Transport, HardReset } from "./lib/esp32.js";
import { SerialConsole } from './lib/console.js';

const configRes = await fetch('./config.json');
const config = await configRes.json();

const githubRes = await fetch('/releases');
const github = await githubRes.json();

const commandReference  = {
  'time ': 'Set time {epoch-secs}',
  'erase': 'Erase filesystem',
  'advert': 'Send Advertisment packet',
  'reboot': 'Reboot device',
  'clock': 'Display current time',
  'password ': 'Set new password',
  'log': 'Ouput log',
  'log start': 'Start packet logging to file system',
  'log stop': 'Stop packet logging to file system',
  'log erase': 'Erase the packet logs from file system',
  'ver': 'Show device version',
  'set freq ': 'Set frequency {Mhz}',
  'set af ': 'Set Air-time factor',
  'set tx ': 'Set Tx power {dBm}',
  'set repeat ': 'Set repeater mode {on|off}',
  'set advert.interval ': 'Set advert rebroadcast interval {minutes}',
  'set guest.password ': 'Set guest password',
  'set name ': 'Set advertisement name',
  'set lat': 'Set the advertisement map latitude',
  'set lon': 'Set the advertisement map longitude',
  'get freq ': 'Get frequency (Mhz)',
  'get af': 'Get Air-time factor',
  'get tx': 'Get Tx power (dBm)',
  'get repeat': 'Get repeater mode',
  'get advert.interval': 'Get advert rebroadcast interval (minutes)',
  'get name': 'Get advertisement name',
  'get lat': 'Get the advertisement map latitude',
  'get lon': 'Get the advertisement map longitude',
};

function getGithubReleases(roleType, files) {
  const versions = {};
  for(const [fileType, [startsWith, endsWith]] of Object.entries(files)) {
    for(const versionType of github) {
      if(versionType.type !== roleType) { continue }
      const version = versions[versionType.version] ??= {
        notes: versionType.notes,
        files: []
      };
      for(const file of versionType.files) {
        if(!(file.name.startsWith(startsWith) && file.name.endsWith(endsWith))) { continue }
        version.files.push({
          type: fileType,
          name: file.url,
          title: file.name,
        })
      }
    }
  }

  return versions;
}

function addGithubFiles() {
  for(const device of config.device) {
    for(const firmware of device.firmware) {
      const gDef = firmware.github;
      if(!gDef?.files) { continue }
      firmware.version = getGithubReleases(gDef.type, gDef.files);
    }
  }

  return config;
}

console.log(addGithubFiles());

function setup() {
  const consoleEditBox = ref();
  const consoleWindow = ref();

  const selected = reactive({
    device: null,
    firmware: null,
    version: null,
    wipe: false,
    port: null,
  });

  const getRoleFwValue = (firmware, key) => {
    return firmware[key] || config.role[firmware.role][key] || '';
  }

  const getSelFwValue = (key) => {
    const fwVersion = selected.firmware.version[selected.version];

    return fwVersion ? fwVersion[key] || '' : '';
  }

  const flashing = reactive({
    supported: 'Serial' in window,
    instance: null,
    active: false,
    percentage: 0,
    log: '',
    error: '',
    dfuComplete: false,
  });

  const serialCon = reactive({
    instance: null,
    opened: false,
    content: '',
    edit: '',
  });

  window.app = { selected, flashing, serialCon };

  const log = {
    clean() { flashing.log = '' },
    write(data) { flashing.log += data },
    writeLine(data) { flashing.log += data + '\n' }
  };

  const refresh = () => {
    location.reload();
  }

  const getFirmwarePath = (file) => {
    return file.name.startsWith('/') ? file.name : `${config.staticPath}/${file.name}`;
  }

  const firmwareHasData = (firmware) => {
    const firstVersion = Object.keys(firmware.version)[0];
    if(!firstVersion) return false;

    return firmware.version[firstVersion].files.length > 0;
  }

  const stepBack = () => {
    if(selected.device && selected.firmware) {
      if(selected.firmware.version[selected.version].customFile) {
        selected.firmware = null;
        selected.device = null;
        return
      }

      selected.firmware = null;
      return;
    }

    if(selected.device) {
      selected.device = null;
    }
  }

  watch(() => selected.firmware, (firmware) => {
    if(firmware == null) return;
    selected.version = Object.keys(firmware.version)[0];
  });

  const flasherCleanup = async () => {
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percentage = 0;
    selected.firmware = null;
    selected.version = null;
    selected.wipe = false;
    selected.device = null;
    if(flashing.instance instanceof ESPLoader) {
      await flashing.instance?.hr.reset();
      await flashing.instance?.transport?.disconnect();
    }
    flashing.instance = null;
  }

  const openSerialCon = async() => {
    const port = selected.port = await navigator.serial.requestPort();
    const serialConsole = serialCon.instance = new SerialConsole(port);
    serialCon.content =  'Welcome to MeshCore serial console.\n';
    serialCon.content += 'If you came here right after flashing, please restart your device.\n';
    serialCon.content += 'Click on the cursor to get all supported commands.\n\n';
    serialConsole.onOutput = (text) => {
      serialCon.content += text;
    };
    serialConsole.connect();
    serialCon.opened = true;
    await nextTick();

    consoleEditBox.value.focus();
  }

  const closeSerialCon = async() => {
    serialCon.opened = false;
    await serialCon.instance.disconnect();
  }

  const sendCommand = async(text) => {
    const consoleEl = consoleWindow.value;
    serialCon.edit = '';
    await serialCon.instance.sendCommand(text);
    setTimeout(() => consoleEl.scrollTop = consoleEl.scrollHeight, 100);
  }

  const dfuMode = async() => {
    await Dfu.forceDfuMode(await navigator.serial.requestPort({}))
    flashing.dfuComplete = true;
  }

  const customFirmwareLoad = async(ev) => {
    const firmwareFile = ev.target.files[0];
    const type = firmwareFile.name.endsWith('.bin') ? 'esp32' : 'nrf52';
    selected.device = {
      name: 'Custom device',
      type,
    };

    selected.firmware = {
      icon: 'unknown_document',
      title: firmwareFile.name,
      version: {},
    }
    selected.version = firmwareFile.name;
    selected.firmware.version[selected.version] = {
      customFile: true,
      files: [{ type: 'flash', file: firmwareFile }]
    }
  }

  const flashDevice = async() => {
    const device = selected.device;
    const firmware = selected.firmware.version[selected.version];
    let flashFile;

    flashFile = firmware.files.find(f => f.type === 'flash');
    if(!flashFile) {
      alert('Cannot find configuration for flash file! please report this to Discord.')
      flasherCleanup();
      return;
    }

    console.log({flashFile, instanceFile: flashFile instanceof File});

    if(flashFile.file) {
      flashFile = flashFile.file;
    } else {
      const url = getFirmwarePath(flashFile);
      console.log('downloading: ' + url);
      const resp = await fetch(url);
      flashFile = await resp.blob();
    }

    const port = selected.port = await navigator.serial.requestPort({});

    if(device.type === 'esp32') {
      let esploader;
      let fileData;
      let transport;

      try {
        const reader = new FileReader();
        fileData = await new Promise((resolve, reject) => {
          reader.addEventListener('error', () => {
            reader.abort();
            reject(new DOMException('Problem parsing input file.'));
          });

          reader.addEventListener('load', () => resolve(reader.result));

          reader.readAsBinaryString(flashFile);
        });
      }
      catch(e) {
        console.error(e);
        flashing.error = `Cannot read flash file: ${e}`;
        return;
      }

      const flashOptions = {
        terminal: log,
        compress: true,
        eraseAll: selected.wipe,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        baudrate: 115200,
        romBaudrate: 115200,
        enableTracing: false,
        fileArray: [{
          data: fileData,
          address: 0
        }],
        reportProgress: async (_, written, total) => {
          flashing.percentage = (written / total) * 100;
        },
      };

      try {
        flashing.active = true;
        transport = new Transport(port, true);
        flashOptions.transport = transport
        flashing.instance = esploader = new ESPLoader(flashOptions);
        esploader.hr = new HardReset(transport);
        await esploader.main();
        await esploader.flashId();
      }
      catch(e) {
        console.error(e);
        flashing.error = `Failed to initialize. Did you place the device into firmware download mode? Detail: ${e}`;
        esploader = null;
        return;
      }

      try {
        await esploader.writeFlash(flashOptions);
        await esploader.after();
      }
      catch(e) {
        console.error(e);
        flashing.error = `ESP32 flashing failed: ${e}`;
        await esploader.hardReset();
        await transport.disconnect();
        return;
      }
    }
    else if(device.type === 'nrf52') {
      const dfu = flashing.instance = new Dfu(port, selected.wipe);

      flashing.active = true;

      try {
        await dfu.dfuUpdate(flashFile, async (progress) => {
          flashing.percentage = progress;
        });
      }
      catch(e) {
        console.error(e);
        flashing.error = `nRF flashing failed: ${e}`;
        return;
      }
    }
  };

  return {
    consoleEditBox, consoleWindow,
    config, selected, flashing,
    flashDevice, flasherCleanup, dfuMode,
    serialCon, openSerialCon, sendCommand, closeSerialCon,
    refresh, commandReference,
    stepBack,
    customFirmwareLoad, getFirmwarePath, getSelFwValue, getRoleFwValue,
    firmwareHasData
  }
}

createApp({ setup }).mount('#app');
