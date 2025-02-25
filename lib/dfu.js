import * as zip from "./zip.min.js";

// Constants adapted from dfu/dfu_transport_serial.py
const DFU_TOUCH_BAUD = 1200;
const SERIAL_PORT_OPEN_WAIT_TIME = 0.1;
const TOUCH_RESET_WAIT_TIME = 1.5;

const DEFAULT_SERIAL_PORT_TIMEOUT = 1.0; // Timeout time on serial port read
const FLASH_PAGE_SIZE = 4096;
const FLASH_PAGE_ERASE_TIME = 0.0897; // nRF52840 max erase time
const FLASH_WORD_WRITE_TIME = 0.000100; // nRF52840 max write time
const FLASH_PAGE_WRITE_TIME = (FLASH_PAGE_SIZE / 4) * FLASH_WORD_WRITE_TIME;
const DFU_PACKET_MAX_SIZE = 512;

const DATA_INTEGRITY_CHECK_PRESENT = 1;
const RELIABLE_PACKET = 1;
const HCI_PACKET_TYPE = 14;

const DFU_INIT_PACKET = 1;
const DFU_START_PACKET = 3;
const DFU_DATA_PACKET = 4;
const DFU_STOP_DATA_PACKET = 5;
const DFU_ERASE_PAGE = 6; // Added for explicit page erase

const DFU_UPDATE_MODE_APP = 4;

// --- Utility Functions (adapted from dfu/util.py) ---

function int32ToBytes(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value, true); // Little-endian
  return new Uint8Array(buffer);
}

function int16ToBytes(value) {
  const buffer = new ArrayBuffer(2);
  const view = new DataView(buffer);
  view.setUint16(0, value, true); // Little-endian
  return new Uint8Array(buffer);
}

function slipPartsToFourBytes(seq, dip, rp, pktType, pktLen) {
  const ints = new Uint8Array(4);
  ints[0] = seq | (((seq + 1) % 8) << 3) | (dip << 6) | (rp << 7);
  ints[1] = pktType | ((pktLen & 0x000F) << 4);
  ints[2] = (pktLen & 0x0FF0) >> 4;
  ints[3] = (~(ints[0] + ints[1] + ints[2]) + 1) & 0xFF;
  return ints;
}

function slipEncodeEscChars(data) {
  const result = [];
  for (const byte of data) {
    if (byte === 0xC0) {
      result.push(0xDB, 0xDC);
    } else if (byte === 0xDB) {
      result.push(0xDB, 0xDD);
    } else {
      result.push(byte);
    }
  }
  return new Uint8Array(result);
}

// --- CRC16 Calculation (adapted from dfu/crc16.py) ---

function calcCrc16(data, crc = 0xFFFF) {
  if (!(data instanceof Uint8Array)) {
    throw new Error("calcCrc16 requires Uint8Array input");
  }
  for (let i = 0; i < data.length; i++) {
    crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00);
    crc ^= data[i];
    crc ^= (crc & 0x00FF) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00FF) << 4) << 1;
  }
  return crc & 0xFFFF;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// --- HciPacket Class (adapted from dfu/dfu_transport_serial.py) ---

class HciPacket {
  static sequenceNumber = 0;

  constructor(data) {
    HciPacket.sequenceNumber = (HciPacket.sequenceNumber + 1) % 8;
    let tempData = [];

    const slipBytes = slipPartsToFourBytes(
      HciPacket.sequenceNumber,
      DATA_INTEGRITY_CHECK_PRESENT,
      RELIABLE_PACKET,
      HCI_PACKET_TYPE,
      data.length
    );
    tempData = tempData.concat(Array.from(slipBytes));

    tempData = tempData.concat(Array.from(data));

    // Add CRC
    const crc = calcCrc16(new Uint8Array(tempData));
    tempData.push(crc & 0xFF);
    tempData.push((crc & 0xFF00) >> 8);

    const encoded = slipEncodeEscChars(new Uint8Array(tempData));
    this.data = new Uint8Array([0xC0, ...encoded, 0xC0]);
  }
}


// --- Main DFU Class ---

export class Dfu {
  /**
   * @param {SerialPort} port - The Web Serial API port object.
   * @param {boolean} [eraseBeforeUpdate=false] - Whether to erase the entire flash before updating.
   */
  constructor(port, eraseBeforeUpdate = false) {
    this.port = port;
    this.transferInProgress = false;
    this.lastAck = -1;
    this.eraseBeforeUpdate = eraseBeforeUpdate; // Store the erase flag
  }

  async sendPacket(pkt) {
    if (!this.port || !this.port.writable) {
      throw new Error("Serial port not open or not writable.");
    }

    const writer = this.port.writable.getWriter();
    try {
      await writer.write(pkt.data);
      console.debug("Sent packet:", pkt.data.length);
    } finally {
      writer.releaseLock();
    }

    await this.getAck(); // Wait for ACK after sending
  }

  async getAck() {
    if (!this.port || !this.port.readable) {
      throw new Error("Serial port not open or not readable.");
    }

    const reader = this.port.readable.getReader();
    let buffer = [];
    let c0Count = 0;

    try {
      const startTime = Date.now();
      while (c0Count < 2) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("Stream closed before receiving full ACK.");
        }

        if (value) {
          for (const byte of value) {
            buffer.push(byte);
            if (byte === 0xC0) {
              c0Count++;
            }
          }
        }

        if (Date.now() - startTime > DEFAULT_SERIAL_PORT_TIMEOUT * 1000 * 5) { // Increased timeout for safety
          HciPacket.sequenceNumber = 0; // Reset sequence number on timeout.
          throw new Error("Timeout waiting for ACK.");
        }
      }
    } finally {
      reader.releaseLock();
    }
    // Decode SLIP
    const decodedData = this.decodeSlip(buffer);

    // Extract ACK number (assuming it's in the decoded data)
    if (decodedData.length < 2) { // Check for sufficient length
      throw new Error("Received incomplete ACK.");
    }
    const ack = (decodedData[0] >> 3) & 0x07;

    // Check for valid ACK sequence
    if (this.lastAck !== -1 && ack !== (this.lastAck + 1) % 8) {
      HciPacket.sequenceNumber = 0; // Reset on bad ack
      throw new Error(`Invalid ACK sequence. Expected ${(this.lastAck + 1) % 8}, got ${ack}`);
    }
    this.lastAck = ack;

    return ack;
  }

  decodeSlip(data) {
    const result = [];
    let i = 0;
    while (i < data.length) {
      if (data[i] === 0xDB) {
        i++;
        if (i >= data.length) {
          throw new Error("Invalid SLIP escape sequence: incomplete.");
        }
        if (data[i] === 0xDC) {
          result.push(0xC0);
        } else if (data[i] === 0xDD) {
          result.push(0xDB);
        } else {
          throw new Error(`Invalid SLIP escape sequence: DB followed by ${data[i].toString(16)}`);
        }
      } else if (data[i] === 0xC0) {
        // Ignore 0xC0 (start/end of packet)
      }
       else {
        result.push(data[i]);
      }
      i++;
    }
    return new Uint8Array(result);
  }

  async sendInitPacket(initPacket) {
    const frame = new Uint8Array([
      ...int32ToBytes(DFU_INIT_PACKET),
      ...initPacket,
      ...int16ToBytes(0x0000), // Padding
    ]);
    const packet = new HciPacket(frame);
    await this.sendPacket(packet);
  }

  // THANKS Liam!!!
  static async forceDfuMode(port) {
    // open port
    await port.open({
      baudRate: DFU_TOUCH_BAUD,
    });

    // wait SERIAL_PORT_OPEN_WAIT_TIME before closing port
    await sleep(SERIAL_PORT_OPEN_WAIT_TIME * 1000);

    // close port
    await port.close();

    // wait TOUCH_RESET_WAIT_TIME for device to enter into DFU mode
    await sleep(TOUCH_RESET_WAIT_TIME * 1000);
  }

  async sendStartDfu(mode, softdeviceSize = 0, bootloaderSize = 0, appSize = 0) {
    const frame = new Uint8Array([
      ...int32ToBytes(DFU_START_PACKET),
      ...int32ToBytes(mode),
      ...int32ToBytes(softdeviceSize),
      ...int32ToBytes(bootloaderSize),
      ...int32ToBytes(appSize),
    ]);

    const packet = new HciPacket(frame);
    await this.sendPacket(packet);

    // Calculate and apply erase wait time.
    const totalSize = softdeviceSize + bootloaderSize + appSize;
    const eraseWaitTime = Math.max(0.5, ((totalSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME);
    await sleep(eraseWaitTime * 1000);
  }


  async sendErasePage(pageAddress) {
    const frame = new Uint8Array([
      ...int32ToBytes(DFU_ERASE_PAGE),
      ...int32ToBytes(pageAddress),
    ]);
    const packet = new HciPacket(frame);
    await this.sendPacket(packet);
    await sleep(FLASH_PAGE_ERASE_TIME * 1000); // Wait for page erase
  }


  async eraseFlash(appSize) {
    console.log("Erasing flash...");
    const numPages = Math.ceil(appSize / FLASH_PAGE_SIZE);

    // Assuming application starts at address 0x00000000
    let startAddress = 0x00000000;

    for (let i = 0; i < numPages; i++) {
      const pageAddress = startAddress + (i * FLASH_PAGE_SIZE);
      console.log(`Erasing page ${i} at address 0x${pageAddress.toString(16)}`);
      await this.sendErasePage(pageAddress);
    }
    console.log("Flash erase complete.");
  }


  async sendFirmware(firmware, progressCallback) {
    const frames = [];
    let totalBytes = firmware.length;

    // Chunk firmware into DFU packets
    for (let i = 0; i < firmware.length; i += DFU_PACKET_MAX_SIZE) {
      const chunk = firmware.subarray(i, i + DFU_PACKET_MAX_SIZE);
      const frame = new Uint8Array([
        ...int32ToBytes(DFU_DATA_PACKET),
        ...chunk,
      ]);
      const dataPacket = new HciPacket(frame);
      frames.push(dataPacket);
    }

    let bytesSent = 0;
    // Send firmware packets
    for (const [index, pkt] of frames.entries()) {
      await this.sendPacket(pkt);
      bytesSent += pkt.data.length - 6; // Correctly calculate sent bytes, excluding SLIP overhead

      if (progressCallback) {
        const progress = Math.min(100, Math.round((bytesSent / totalBytes) * 100)); // Ensure progress doesn't exceed 100
        progressCallback(progress);
      }

      // Wait after every 8 frames (one flash page)
      if ((index + 1) % 8 === 0) {
        await sleep(FLASH_PAGE_WRITE_TIME * 1000);
      }
    }

    // Wait for the last page to be written
    await sleep(FLASH_PAGE_WRITE_TIME * 1000);

    // Send stop packet
    const stopPacket = new HciPacket(int32ToBytes(DFU_STOP_DATA_PACKET));
    await this.sendPacket(stopPacket);
  }

  async dfuUpdate(zipFile, progressCallback) {
    if (this.transferInProgress) {
      throw new Error("DFU update already in progress.");
    }
    this.transferInProgress = true;
    this.lastAck = -1; // Reset last ACK
    const decoder = new TextDecoder();
    try {
      await this.port.open({ baudRate: 115200 }); // Open with correct baudrate

      const reader = new zip.ZipReader(new zip.BlobReader(zipFile));
      const entries = await reader.getEntries();

      let manifest = null;
      let firmwareFiles = {};

      for (const entry of entries) {
        const filename = decoder.decode(entry.rawFilename);
        console.debug('Found zip filename: ', filename);
        if (filename === 'manifest.json') {
          const text = await entry.getData(new zip.TextWriter());
          manifest = JSON.parse(text);
        } else if (filename.endsWith('.bin') || filename.endsWith('.dat')) {
          firmwareFiles[filename] = await entry.getData(new zip.Uint8ArrayWriter());
        }
      }

      await reader.close();

      if (!manifest) {
        throw new Error("manifest.json not found in the ZIP file.");
      }
      if (!firmwareFiles[manifest.manifest.application.bin_file] ||
        !firmwareFiles[manifest.manifest.application.dat_file])
      {
        throw new Error("Application .bin or .dat file not found.");
      }

      const appBin = firmwareFiles[manifest.manifest.application.bin_file];
      const initPacket = firmwareFiles[manifest.manifest.application.dat_file];
      const appSize = appBin.length;

      // Erase flash if requested
      if (this.eraseBeforeUpdate) {
        await this.eraseFlash(appSize);
      }

      // Start DFU
      await this.sendStartDfu(DFU_UPDATE_MODE_APP, 0, 0, appSize);

      // Send Init Packet
      await this.sendInitPacket(initPacket);

      // Send Firmware
      await this.sendFirmware(appBin, progressCallback);

      console.log("DFU update complete.");

    } catch (error) {
      console.error("DFU Update failed:", error);
      throw error; // Re-throw the error for handling by the caller
    } finally {
      this.transferInProgress = false;
      if (this.port && this.port.readable) {
        try {
          const reader = this.port.readable.getReader();
          await reader.cancel();
          reader.releaseLock();

        } catch (error) {
          // Ignore errors when trying to cancel the reader
          console.debug(`Error: closing reader: ${error}`);
        }
      }
      if (this.port && this.port.writable) {
        try {
          const writer = this.port.writable.getWriter();
          await writer.close();
          writer.releaseLock();
        } catch(error) {
          // Ignore errors when trying to close the writer
          console.debug(`Error: closing writer: ${error}`);
        }
      }
      if (this.port) {
        try {
          await this.port.close();
        }
        catch (error) {
          // Ignore errors when trying to close the port
          console.debug(`Error: closing port: ${error}`);
        }
      }
    }
  }
}