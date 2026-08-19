// Web Bluetooth transport for the Nordic UART Service.
// Raw frames only — no protocol knowledge lives here.

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // host -> device (write)
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device -> host (notify)

export class BleTransport extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.tx = null;
    this._onDisconnect = this._onDisconnect.bind(this);
    this._onNotify = this._onNotify.bind(this);
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  static get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!BleTransport.available) {
      throw new Error(
        'Web Bluetooth is unavailable. Use Chrome or Edge over http://localhost or https.'
      );
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);

    this.rx = await service.getCharacteristic(NUS_RX);
    this.tx = await service.getCharacteristic(NUS_TX);

    this.tx.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.tx.startNotifications();

    this.dispatchEvent(new CustomEvent('connected', { detail: { name: this.device.name } }));
    return this.device.name;
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  async write(frame) {
    if (!this.rx) throw new Error('not connected');
    const u = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    // Chrome allows one GATT operation per device at a time; a write issued
    // while another is still pending fails instantly with "GATT operation
    // already in progress" rather than queueing. That pending write can
    // outlive its own command — a stall long enough to trip the idle timeout
    // leaves the GATT layer busy after the protocol has moved on — so every
    // write chains behind the last, and a stuck one delays its successor
    // instead of poisoning it.
    const run = async () => {
      if (!this.rx) throw new Error('not connected');
      // writeValueWithResponse gives us backpressure; the device is slow
      // enough that write-without-response risks silently dropping frames.
      if (this.rx.writeValueWithResponse) {
        await this.rx.writeValueWithResponse(u);
      } else {
        await this.rx.writeValue(u);
      }
    };
    const p = (this._writeTail ?? Promise.resolve()).catch(() => {}).then(run);
    this._writeTail = p;
    return p;
  }

  _onNotify(event) {
    const value = event.target.value; // DataView
    const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.dispatchEvent(new CustomEvent('frame', { detail: bytes }));
  }

  _onDisconnect() {
    this.rx = null;
    this.tx = null;
    this.dispatchEvent(new CustomEvent('disconnected'));
  }
}
