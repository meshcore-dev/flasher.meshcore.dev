function delay(msecs) {
  return new Promise((resolve) => setTimeout(resolve, msecs));
}
class LineBreakTransformer {
  chunks = '';
  port = null;

  transform(chunk, controller) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // For each line breaks in chunks, send the parsed lines out.
    const lines = this.chunks.split('\r\n');
    this.chunks = lines.pop();
    lines.forEach((line) => controller.enqueue(line + '\r\n'));
  }

  flush(controller) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}

export class SerialConsole {
  connected = false;
  constructor(port) {
    this.port = port;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.onOutput = (text) => {
      console.log(text);
    };
  }

  async connect() {
    try {
      await this.port.open({ baudRate: 115200 });
      this.connected = true;
      await this.port.readable
        .pipeThrough(new TextDecoderStream(), { signal: this.signal })
        .pipeThrough(new TransformStream(new LineBreakTransformer()))
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              this.addLine(chunk.replace('\r', ''));
            },
          }),
        );

        // Check AFTER the pipeTo has completed (or been aborted)
      if (!this.signal.aborted) {
        this.addLine('\n\n*** Terminal disconnected');
        this.connected = false;
      }
    } catch (e) {
      this.addLine(`\n\n*** Terminal disconnected: ${e}`);
      this.connected = false;
    } finally {
      await delay(100);
    }
  }

  addLine(text) {
    this.onOutput(text);
  }

  async sendCommand(command) {
    const encoder = new TextEncoder();
    const writer = this.port.writable.getWriter(); // Get writer from 'this.port'
    await writer.write(encoder.encode(command + '\r\n'));
    try {
      writer.releaseLock();
    } catch (err) {
      console.error('Ignoring release lock error', err);
    }
  }

  async disconnect() {
    this.controller.abort();
    await delay(50);
    await this.port.close();
  }

  async reset() {
    console.debug('Triggering reset');
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: true,
    });
    await delay(250);
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: false,
    });

    await delay(1250);
  }
}