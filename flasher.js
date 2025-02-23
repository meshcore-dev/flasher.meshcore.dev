import "./lib/beer.min.js";
import { createApp, reactive, ref, nextTick } from "./lib/vue.min.js";
import { Dfu } from "./lib/dfu.js";
import { ESPLoader, Transport, HardReset } from "./lib/esp32.js";
import { SerialConsole } from './lib/console.js';

const res = await fetch('./config.json');
const config = await res.json();
const commandReference  = {
  'set freq ': 'Set frequency {Mhz}',
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
  'set af ': 'Set Air-time factor',
  'set tx ': 'Set Tx power {dBm}',
  'set repeat ': 'Set repeater mode {on|off}',
  'set advert.interval ': 'Set advert rebroadcast interval {minutes}',
  'set guest.password ': 'Set guest password',
  'set name ': 'Set advertisement name',
  'set lat': 'Set the advertisement map latitude',
  'set lon': 'Set the advertisement map longitude',
};

function setup() {
  const consoleEditBox = ref();
  const consoleWindow = ref();

  const selected = reactive({
    device: null,
    firmware: null,
    wipe: false,
    port: null
  });

  const flashing = reactive({
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

  const flasherCleanup = async () => {
    const port = selected.port;
    flashing.active = false;
    flashing.log = '';
    flashing.error = '';
    flashing.dfuComplete = false;
    flashing.percentage = 0;
    selected.firmware = null;
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

  const flashDevice = async() => {
    const device = selected.device;
    const firmware = selected.firmware;
    const flashFile = firmware.files.find(f => f.type === 'flash');
    if(!flashFile) {
      alert('Cannot find configuration for flash file! please report this to Discord.')
      flasherCleanup();
      return;
    }
    const url = `${config.basePath}/${flashFile.name}`;
    const resp = await fetch(url);
    const port = selected.port = await navigator.serial.requestPort({});

    if(device.type === 'esp32') {
      let esploader;
      let fileData;
      let transport;

      try {
        const reader = new FileReader();
        fileData = await new Promise(async (resolve) => {
          reader.addEventListener('load', () => resolve(reader.result));
          reader.readAsBinaryString(await resp.blob());
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
        reportProgress: async (fileIndex, written, total) => {
          flashing.percentage = (written / total) * 100;

          // we're done with this file
          if (written === total) {
            return;
          }
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

      const zipFile = await resp.blob();
      flashing.active = true;

      try {
        await dfu.dfuUpdate(zipFile, async (progress) => {
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
    refresh, commandReference
  }
}

const template = `
<div class="flash-container">
  <div v-if="flashing.active">
    <header>
      <nav>
        <i>developer_board</i>
        <span class="small">{{ selected.device.name }}</span>
        <i>chevron_right</i>
        <i>{{ selected.firmware.icon }}</i>
        <span class="small">{{ selected.firmware.title }}</span>
      </nav>
    </header>
    <article v-if="flashing.error">
      <div class="row">
        <div class="max">
          <h6>Flashing failed!</h6>
          <p><span>{{ flashing.error }}</span></p>
          <p><button @click="refresh()">Retry</button></p>
        </div>
      </div>
    </article>
    <article v-else>
      <div class="row">
        <div class="max" v-if="flashing.percentage < 100">
          <h6><progress class="circle small"></progress> Flashing...</h6>
          <p>Please do not disconnect the device</p>
        </div>
        <div class="max" v-else=>
          <h6>Flashing complete!</h6>
          <p>
            <button @click="flasherCleanup()">Close</button>
          </p>
        </div>
      </div>
      <div class="autoscroller">
        <pre class="term" v-if="flashing.terminal">{{ flashing.terminal }}</pre>
      </div>
      <nav>
        <progress :value="flashing.percentage" max="100"></progress>
      </nav>
    </article>
  </div>
  <div v-else-if="selected.firmware">
    <header>
      <nav>
        <button class="circle transparent" @click="selected.firmware = null"><i>arrow_back</i></button>
        <i>developer_board</i>
        <a class="small" href="javascript:;" @click="selected.firmware = null">{{ selected.device.name }}</a>
        <i>chevron_right</i>
        <i>{{ selected.firmware.icon }}</i>
        <span class="small">{{ selected.firmware.desc }}</span>
      </nav>
      <nav class="no-margin">
        <h6 class="small max">Install options</h6>
      </nav>
    </header>
    <ul class="list border" v-if="selected.device.type === 'esp32'">
      <li>
        <label class="checkbox">
          <input type="checkbox" v-model="selected.wipe">
          <span>Erase device</span>
          <div class="tooltip right max">
            DO NOT carry out a full erase if you are simply updating your MeshCore device, otherwise it will erase your MeshCore identity for that device.
          </div>
        </label>
      </li>
    </ul>
    <button @click="dfuMode" :disabled="flashing.dfuComplete" v-if="selected.device.type === 'nrf52'">
      <i>{{ flashing.dfuComplete ? 'check' : 'code' }}</i>
      <span>{{ flashing.dfuComplete ? 'DFU mode active' : 'Enter DFU mode' }}</span>
      <div class="tooltip right max">
        Enter DFU mode - this mode enables you to flash your firmware.
        If you did not trigger the DFU mode manually, please click this button.
      </div>
    </button>
    <div class="medium-space"></div>
    <nav class="small-margin">
    <button @click="flashDevice">
      <i>bolt</i>
      <span>Flash!</span>
      <div class="tooltip right max">
        Upload the firmware into your device. Existing firwmare will get overwritten.
        <span v-if="selected.device.type === 'nrf52'">If you did not trigger DFU mode manually, use the <b>Enter DFU mode</b> before flashing</span>
      </div>
    </button>
    <div class="max"></div>
    <button data-ui="#down" class="active">
      <i>download</i>
      <span>Download</span><i>arrow_drop_down</i>
      <menu class="no-wrap" id="down" data-ui="#down">
        <li v-for="file in selected.firmware.files">
          <a data-ui="menu-selector" :href="config.basePath + '/' + file.name" download>{{ file.title }}</a>
        </li>
      </menu>
      <div class="tooltip left max">Download a copy of the firmware files for use with other flashers</div>
    </button>
    </nav>
  </div>
  <div v-else-if="selected.device">
    <header>
      <nav>
        <button class="circle transparent" @click="selected.device = null"><i>arrow_back</i></button>
        <i>developer_board</i>
        <span>{{ selected.device.name }}</span>
      </nav>
      <nav class="no-margin">
        <h6 class="small max">Choose role</h6>
      </nav>
    </header>
    <ul class="list border">
      <li v-for="firmware in selected.device.firmware" :class="firmware.class || config.role[firmware.role].class || ''">
        <button class="transparent" @click="selected.firmware = firmware">
          <i>{{ firmware.icon || config.role[firmware.role].icon }}</i>
          <span>{{ firmware.title || config.role[firmware.role].title }}</span>
          <div class="tooltip right max" v-if="firmware.tooltip || config.role[firmware.role].tooltip" v-html="firmware.tooltip || config.role[firmware.role].tooltip"></div>
        </button>
      </li>
    </ul>
  </div>
  <div v-else>
    <header>
      <nav>
        <i>bolt</i>
        <h5 class="small max">MeshCore flasher</h5>
        <button class="transparent" @click="openSerialCon()">
          <i>terminal</i>
          <span>Console</span>
          <div class="tooltip left max">Open serial console to manage Routers and Room servers via serial terminal</div>
        </button>
      </nav>
      <nav class="no-margin">
        <h6 class="small max">Choose device</h6>
      </nav>
    </header>
    <ul class="list border">
      <li v-for="device in config.device">
        <button class="transparent" @click="selected.device = device">
          <i>developer_board</i>
          <span>{{ device.name }}</span>
          <div class="tooltip right max" v-if="device.tooltip" v-html="device.tooltip"></div>
        </button>
      </li>
    </ul>
  </div>
</div>
<div v-if="serialCon.opened" class="overlay active">
  <datalist id="command-db">
    <option v-for="(desc, command) in commandReference" :value="command">{{ desc }}</option>
  </datalist>
  <header>
    <nav>
      <button class="circle transparent" @click="closeSerialCon()"><i>arrow_back</i></button>
      <h6 class="small max">Serial Console</h6>
    </nav>
  </header>
  <pre class="console" @click="consoleEditBox.focus()" ref="consoleWindow">
    <code>{{ serialCon.content }}</code>
    <div class="holder">
      <span>&gt;</span>
      <input ref="consoleEditBox" class="console-input" type="text" v-model="serialCon.edit" @keydown.enter.prevent="sendCommand(serialCon.edit)" list="command-db">
    </div>
  </pre>
</div>
`;

createApp({ setup, template }).mount('#flasher');
