// author: Tom Svoboda <svobot20@fit.cvut.cz>
import * as dgram from "dgram";
import * as fs from "fs";
import * as assert from 'assert';
import Timer = NodeJS.Timer;

const DOWNLOAD_IMAGE_PATH = 'foto.png';
const TIMEOUT = 100;
const DEBUG = true;

const debug = (value: string) => {
    DEBUG && console.log(value);
};

enum AppMode {
    DownloadImage,
    SendFirmware,
    Error,
}

enum ConnectionMode {
    DownloadImage = 0x1,
    SendFirmware = 0x2,
}

enum ConnectionFlag {
    DATA = 0x0,
    RST = 0x1,
    FIN = 0x2,
    SYN = 0x4,
}

type NetAddress = {
    host: string,
    port: number,
};

class Packet {
    private static CONNECTION_IDENTIFIER_SIZE = 4;
    private static SEQUENTIAL_NUMBER_SIZE = 2;
    private static ACK_NUMBER_SIZE = 2;
    private static FLAG_SIZE = 1;
    private static CONNECTION_IDENTIFIER_OFFSET = 0;
    private static SEQUENTIAL_NUMBER_OFFSET = Packet.CONNECTION_IDENTIFIER_OFFSET + Packet.CONNECTION_IDENTIFIER_SIZE;
    private static ACK_NUMBER_OFFSET = Packet.SEQUENTIAL_NUMBER_OFFSET + Packet.SEQUENTIAL_NUMBER_SIZE;
    private static FLAG_OFFSET = Packet.ACK_NUMBER_OFFSET + Packet.ACK_NUMBER_SIZE;
    private static DATA_OFFSET = Packet.FLAG_OFFSET + Packet.FLAG_SIZE;

    constructor(
        public readonly buffer: Buffer
    ) {
    }

    public static createFromParams(
        connectionIdentifier: number,
        sequentialNumber: number,
        ackNumber: number,
        flag: ConnectionFlag,
        data: Buffer) {
        return new Packet(Packet.computeBuffer(connectionIdentifier, sequentialNumber, ackNumber, flag, data));
    }

    private static computeBuffer(connectionIdentifier: number, sequentialNumber: number, ackNumber: number, flag: number, data: Buffer): Buffer {
        const buffer = Buffer.allocUnsafe(Packet.getPacketSize(data));
        let nextPos = 0;
        nextPos = buffer.writeUInt32BE(connectionIdentifier, nextPos);
        nextPos = buffer.writeUInt16BE(sequentialNumber, nextPos);
        nextPos = buffer.writeUInt16BE(ackNumber, nextPos);
        nextPos = buffer.writeUInt8(flag, nextPos);
        buffer.fill(data, nextPos);
        return buffer;
    }

    private static getPacketSize(data: Buffer) {
        return Packet.DATA_OFFSET + data.length;
    }

    public get connectionIdentifier() {
        return this.buffer.readUInt32BE(Packet.CONNECTION_IDENTIFIER_OFFSET);
    }

    public get sequentialNumber() {
        return this.buffer.readUInt16BE(Packet.SEQUENTIAL_NUMBER_OFFSET);
    }

    public get ackNumber() {
        return this.buffer.readUInt16BE(Packet.ACK_NUMBER_OFFSET);
    }

    public get flag() {
        return this.buffer.readUInt8(Packet.FLAG_OFFSET);
    }

    public get data() {
        return this.buffer.slice(Packet.DATA_OFFSET);
    }

    public isValid(mode: ConnectionMode, id: number) {
        if (this.ackNumber && (this.data.length || this.sequentialNumber)) {
            // ack number has no other data
            return false;
        }

        switch (this.flag) {
            case ConnectionFlag.SYN:
                return id === 0 && this.connectionIdentifier !== 0 && // valid id
                    this.data.length === 1 && this.data.readUInt8(0) === mode; // valid mode
            case ConnectionFlag.FIN:
                return this.data.length === 0;
            case ConnectionFlag.RST:
            case ConnectionFlag.DATA:
                return true;
            default:
                return false;
        }
    }

    public toString() {
        return `Packet ${
            this.connectionIdentifier.toString(16)
            }\tseq=${this.sequentialNumber
            }\tack=${this.ackNumber
            }\tflag=${
            this.flag.toString(16)
            }\tdata=${
            this.data.length}`;
    }
}

class Timeout {
    private timeoutId?: Timer;

    constructor(private handler: () => void, private TIME_OUT: number) {
    }

    stop() {
        this.timeoutId && clearTimeout(this.timeoutId);
    }

    debounce() {
        this.stop();
        this.timeoutId = setTimeout(this.handler, this.TIME_OUT);
    }
}

abstract class Connection {
    private readonly socket: dgram.Socket;
    public static PART_SIZE: number = 0xff;
    public static WINDOW_SIZE: number = 8;
    public static PACKET_REPEAT_THRESHOLD = 20;
    protected connectionId: number = 0;
    protected timeout = new Timeout(this.timeoutHandler.bind(this), TIMEOUT);
    private sendSynPacketCnt = 0;

    protected constructor(
        private server: NetAddress,
        protected connectionMode: ConnectionMode,
        private resolve: () => void, // success cb
        private reject: (error: string) => void, // error cb
    ) {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', this.socketMessageListener.bind(this));
        this.socket.on('listening', this.sendSynPacket.bind(this)); // initiate connection when ready
        this.socket.bind();
    }

    public log(text: string) {
        console.log(this.connectionId.toString(16), text);
    }

    private socketMessageListener(msg: Buffer) {
        const packet = new Packet(msg);
        this.log(`RECV - ${packet.toString()}`);
        this.processPacket(packet);
    }

    protected sendPacket(packet: Packet) {
        this.timeout.debounce();
        const buffer = packet.buffer;
        this.socket.send(buffer, 0, buffer.length, this.server.port, this.server.host, (err) => {
            assert(!err, 'sending packet on closed connection');
            this.log(`SENT - ${packet.toString()}`)
        });
    }

    private createDataPacket(seq: number, ack: number, flag: ConnectionFlag, data: Buffer) {
        return Packet.createFromParams(this.connectionId, seq, ack, flag, data)
    }

    protected createPacket(seq: number, ack: number, flag: ConnectionFlag) {
        return this.createDataPacket(seq, ack, flag, Buffer.allocUnsafe(0));
    }

    protected sendRstPacket() {
        this.connectionId && this.sendPacket(this.createPacket(0, 0, ConnectionFlag.RST));
    }

    protected abstract sendFinPacket(seq: number): void;

    protected sendAckPacket(ack: number) {
        this.sendPacket(this.createPacket(0, ack, ConnectionFlag.DATA));
    }

    protected sendDataPacket(seq: number, data: Buffer) {
        this.sendPacket(this.createDataPacket(seq, 0, ConnectionFlag.DATA, data));
    }

    protected sendSynPacket() {
        if (++this.sendSynPacketCnt > Connection.PACKET_REPEAT_THRESHOLD) {
            throw('could not establish connection');
        }
        const buff = Buffer.alloc(1);
        buff.writeUInt8(this.connectionMode, 0);
        this.sendPacket(this.createDataPacket(0, 0, ConnectionFlag.SYN, buff));
    }

    /**
     * Process received packet
     * @param {Packet} packet
     */
    private processPacket(packet: Packet) {
        if (!this.connectionId && packet.flag !== ConnectionFlag.SYN) {
            return; // waiting for SYN
        } else if (!this.connectionId || this.connectionId === packet.connectionIdentifier) {
            // current connection
            if (packet.isValid(this.connectionMode, this.connectionId)) {
                switch (packet.flag) {
                    case ConnectionFlag.SYN:
                        this.connectionId = packet.connectionIdentifier;
                        this.log('CONNECTION ACCEPTED');
                        this.timeout.stop();
                        this.processSynPacket(packet);
                        break;
                    case ConnectionFlag.RST:
                        this.forceCloseConnection('received RST flag');
                        break;
                    case ConnectionFlag.FIN:
                        this.processFinPacket(packet);
                        break;
                    case ConnectionFlag.DATA:
                        this.processDataPacket(packet);
                }
            } else {
                this.sendRstPacket();
                this.forceCloseConnection('received invalid packet');
            }
        }
    }

    protected forceCloseConnection(reason: string) {
        this.closeConnection();
        this.reject(reason);
    }

    protected successCloseConnection() {
        this.closeConnection();
        this.resolve();
    }

    private closeConnection() {
        this.timeout.stop();
        this.socket.close();
    }

    protected abstract processDataPacket(packet: Packet): void;

    protected abstract processFinPacket(packet: Packet): void;

    protected abstract processSynPacket(packet: Packet): void;

    protected abstract timeoutHandler(): void;
}

class DownloadConnection extends Connection {
    private lastSequentialNumber: number = 0;
    private window: Array<Buffer> = [];
    private finTimeout = new Timeout(this.successCloseConnection.bind(this), TIMEOUT * 10);

    constructor(
        private passData: (data: Buffer) => void,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
        resolve: () => void, // success cb
        reject: (error: string) => void, // error cb
    ) {
        super(server, COMMAND_TYPE, resolve, reject);
    }

    protected processDataPacket(packet: Packet): void {
        const packetSeq = packet.sequentialNumber;
        const windowPacketIndex = AutofillWindow.getPacketWindowIndex(packetSeq, this.lastSequentialNumber);
        debug(`process packet - index:${windowPacketIndex} current:${this.lastSequentialNumber} packet:${packetSeq}`);

        if (windowPacketIndex < 0 || this.window[windowPacketIndex] || windowPacketIndex >= Connection.WINDOW_SIZE) {
            console.log(`redundant packet(${packetSeq}) - IGNORE`);
        } else {
            this.window[windowPacketIndex] = packet.data;
            if (windowPacketIndex === 0) {
                this.consumeWindow();
            } else {
                console.log(`redundant packet(${packetSeq}) - STORE`);
            }
        }

        this.sendAckPacket(this.lastSequentialNumber);
    }

    protected processFinPacket(packet: Packet): void {
        this.sendFinPacket(packet.sequentialNumber);
        this.finTimeout.debounce();
    }

    protected sendFinPacket(seq: number): void {
        return this.sendPacket(this.createPacket(0, seq, ConnectionFlag.FIN));
    }

    protected processSynPacket(packet: Packet): void {
    }

    /**
     * Use window if data
     */
    private consumeWindow() {
        if (this.window[0]) {
            debug(`consuming buffer - ${this.lastSequentialNumber}`);
            const nextData = <Buffer> this.window.shift();
            this.passData(nextData);
            const sum = this.lastSequentialNumber + nextData.length;
            this.lastSequentialNumber = sum > 0xffff ? sum - 0x10000 : sum; // overflow
            this.consumeWindow();
        }
    }

    protected timeoutHandler(): void {
        this.log('TIMEOUT');
        if (!this.connectionId) {
            this.sendSynPacket();
        }
    }

    public static asPromise(
        passData: (data: Buffer) => void,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
    ): Promise<void> {
        return new Promise((res: () => void, rej: (error: string) => void) => {
            new DownloadConnection(passData, server, COMMAND_TYPE, res, rej);
        });
    }
}

/**
 * Async data buffer
 */
class AutoresolvedBuffer {
    public promise: Promise<Buffer>;
    public ctr: number = 0;

    constructor(
        public offset: number,
        private getData: (size: number) => Promise<Buffer>,
    ) {
        this.promise = getData(Connection.PART_SIZE);
    }
}

/**
 * Ensures connection window is fully used
 */
class AutofillWindow {
    private window: AutoresolvedBuffer[] = [];
    private nextDataOffset = 0; // for file reader only (probably will end up bigger then file size)
    public eof = false;
    public eofPosition: number = 0;

    constructor(
        private sendData: (seq: number, buffer: Buffer) => void,
        private getData: (size: number) => Promise<Buffer>,
    ) {
        // Initial fill window
        for (let i = 0; i < Connection.WINDOW_SIZE; i++) {
            this.window.push(this.getNextAutoresolver());
        }
    }

    private get(i: number) {
        return this.window[i];
    }

    public getSequence(seq: number) {
        const index = AutofillWindow.getPacketWindowIndex(seq, this.nextSequence);
        assert(index >= 0 && index < Connection.WINDOW_SIZE, `AutofillWindow.getSequence(${seq}) index(${index}) out of bounds`);
        return this.get(index);
    }

    public sendSequence(seq: number) {
        this.sendAutoresolver(this.getSequence(seq));
    }

    public get nextSequence(): number {
        return this.get(0).offset;
    }

    public sendAll() {
        debug('force send whole window');
        for (let i = 0; i < Connection.WINDOW_SIZE; i++) {
            this.sendAutoresolver(this.get(i));
        }
    }

    public acknowledge(ack: number) {
        while (true) {
            const index = AutofillWindow.getPacketWindowIndex(ack, this.get(0).offset);
            if (index > 0 && index <= Connection.WINDOW_SIZE) {
                debug(`acknowledge remove: ${index}`);
                this.removeNext();
            } else {
                debug(`acknowledge ignore: ${index}`);
                return;
            }
        }
    }

    public removeNext() {
        debug(`removeNext frame: ${this.window[0].offset}(${this.window[0].offset % 0x10000})`);
        this.window.shift();
        this.loadNextPart();
    }

    private sendAutoresolver(autoresolver: AutoresolvedBuffer) {
        if (autoresolver.ctr > Connection.PACKET_REPEAT_THRESHOLD) {
            throw('Packet was sent too many times');
        }

        autoresolver.promise.then((buff: Buffer) => {
            if (buff.length) {
                autoresolver.ctr++;
                this.sendData(AutofillWindow.getSequenceNumber(autoresolver.offset), buff);
            }
        });
    }

    private getNextAutoresolver(): AutoresolvedBuffer {
        const autoresolver = new AutoresolvedBuffer(this.nextDataOffset, this.getData);
        autoresolver.promise.then((buff: Buffer) => {
            if (buff.length < Connection.PART_SIZE && !this.eof) {
                this.eof = true;
                this.eofPosition = autoresolver.offset + buff.length;
            }
        });
        this.sendAutoresolver(autoresolver);
        this.nextDataOffset += Connection.PART_SIZE;
        return autoresolver;
    }

    private loadNextPart() {
        const autoresolver = this.getNextAutoresolver();
        this.window.push(autoresolver);
        return autoresolver.promise;
    }

    public get eofSeq(): number {
        return this.eofPosition % 0x10000;
    }

    private static getSequenceNumber(offset: number) {
        return offset % 0x10000;
    }

    private static fixOverflow(num: number) {
        return num < 0 ? num + 0xffff : num;
    }

    public static getPacketWindowIndex(packetSeq: number, mySeq: number) {
        return Math.ceil(AutofillWindow.fixOverflow(packetSeq - mySeq) / Connection.PART_SIZE);
    }
}

class AckController {
    private lastAck: number = 0;
    private count: number = 0;

    constructor(private window: AutofillWindow, private timeout: Timeout) {
    }

    /**
     * Handle ack number
     * @param {number} ackNumber
     * @returns {boolean} - is ackNumber valid
     */
    acknowledge(ackNumber: number): boolean {
        this.window.acknowledge(ackNumber);

        if (this.lastAck === ackNumber) {
            this.count++;
            if (this.count === 3) {
                console.log(`Resend sequence(ack=${ackNumber})`);
                this.window.sendSequence(ackNumber);
                this.timeout.debounce();
                this.count = 0; // reset counter
            }
        } else if (this.lastAck < ackNumber) {
            this.lastAck = ackNumber;
            this.count = 0;
        }

        return true;
    }
}

class UploadConnection extends Connection {
    private window?: AutofillWindow;
    private ackController?: AckController;
    private closingConnection: number = 0;

    constructor(
        private getData: (size: number) => Promise<Buffer>,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
        resolve: () => void, // success cb
        reject: (error: string) => void, // error cb
    ) {
        super(server, COMMAND_TYPE, resolve, reject);
    }

    protected timeoutHandler(): void {
        this.log('TIMEOUT');
        try {
            if (!this.connectionId) {
                this.sendSynPacket();
            } else if (this.window) {
                this.timeout.debounce();
                if (this.closingConnection) {
                    this.sendFinPacket(this.window.eofSeq);
                } else {
                    this.window.sendAll();
                }
            } else {
                assert(true, 'undefined timeout state');
            }
        } catch (e) {
            this.sendRstPacket();
            this.forceCloseConnection(e);
        }
    }

    protected processSynPacket(packet: Packet) {
        this.window = new AutofillWindow(this.sendDataPacket.bind(this), this.getData);
        this.ackController = new AckController(this.window, this.timeout);
    }

    protected sendFinPacket(seq: number): void {
        this.closingConnection++;
        if (this.closingConnection <= 20) {
            this.sendPacket(this.createPacket(seq, 0, ConnectionFlag.FIN));
        } else {
            throw 'Connection close was not confirmed';
        }
    }

    processDataPacket(packet: Packet) {
        if (!this.ackController || !this.window) {
            console.error('received data packet but connection undefined');
            return;
        }
        let valid = false;

        try {
            valid = this.ackController.acknowledge(packet.ackNumber);
        } catch (e) {
            this.sendRstPacket();
            return this.forceCloseConnection(e);
        }

        if (this.window.eof) {
            const eofSeq = this.window.eofSeq;
            debug(`eof(seq=${eofSeq})`);
            packet.ackNumber === eofSeq && this.sendFinPacket(eofSeq);
        } else if (!valid) {
            this.sendRstPacket();
            this.forceCloseConnection(`ackNumber out of bounds: ack=${packet.ackNumber}`);
        }
    }

    protected processFinPacket(packet: Packet): void {
        this.successCloseConnection();
    }

    public static asPromise(
        getData: (size: number) => Promise<Buffer>,
        server: NetAddress,
        COMMAND_TYPE: ConnectionMode,
    ): Promise<void> {
        return new Promise((res, rej: (error: string) => void) => {
            new UploadConnection(getData, server, COMMAND_TYPE, res, rej);
        });
    }
}

class File {
    protected fd?: number;
    protected fileReady: Promise<void>;

    constructor(path: string, flag: string) {
        this.fileReady = File.getFileDescriptor(path, flag).then((fd) => {
            this.fd = fd;
        });
    }

    public static getFileDescriptor(path: string, flags: string): Promise<number> {
        return new Promise((res, rej) => {
            fs.open(path, flags, (status, fd) => {
                if (status) rej(`file cannot be accessed: ${path}`);
                else res(fd);
            });
        });
    }

    public static closeFileDescriptor(fd: number) {
        fs.close(fd, (err) => {
            assert(!err, err?.message);
        });
    }

    public close() {
        this.fd && File.closeFileDescriptor(this.fd);
    }
}

class FileReader extends File {
    public ready: Promise<(size: number) => Promise<Buffer>>;

    constructor(path: string) {
        super(path, 'r');
        this.ready = this.fileReady.then(() => this.readPart.bind(this));
    }

    private readPart(size: number): Promise<Buffer> {
        const oldChain = this.fileReady;
        const newChain = new Promise<Buffer>((res, rej) => oldChain
            .then(() => FileReader.readFilePart(<number> this.fd, size))
            .then(res)
            .catch(rej)
        );
        this.fileReady = newChain.then();
        return newChain;
    }

    private static readFilePart(fd: number, size: number): Promise<Buffer> {
        const buffer = Buffer.allocUnsafe(size);
        return new Promise((res) => {
            fs.read(fd, buffer, 0, size, null, (err, bytesRead, buffer) => {
                assert(!err, err?.message);
                res(buffer.slice(0, bytesRead));
            });
        });
    }
}

class FileWriter extends File {
    public ready: Promise<(buffer: Buffer) => void>;

    constructor(path: string) {
        super(path, 'w');
        this.ready = this.fileReady.then(() => this.writePart.bind(this));
    }

    private writePart(buffer: Buffer) {
        const oldChain = this.fileReady;
        this.fileReady = new Promise<void>((res, rej) => oldChain
            .then(() => FileWriter.writeFilePart(<number> this.fd, buffer))
            .then(res)
            .catch(rej)
        );
    }

    private static writeFilePart(fd: number, data: Buffer): Promise<void> {
        return new Promise((res) => {
            fs.write(fd, data, (err) => {
                assert(!err, err?.message);
                res();
            });
        });
    }
}

class Client {
    constructor(private server: NetAddress) {
    }

    public downloadImage(path: string) {
        const fileWriter = new FileWriter(path);
        fileWriter.ready
            .then((writePart) => DownloadConnection.asPromise(writePart, this.server, ConnectionMode.DownloadImage))
            .then(() => console.log(`Image downloaded to: ${path}`))
            .catch(console.error)
            .finally(() => fileWriter.close());
    }

    public uploadFirmware(filePath: string) {
        const fileReader = new FileReader(filePath);
        fileReader.ready
            .then((readPart) => UploadConnection.asPromise(readPart, this.server, ConnectionMode.SendFirmware))
            .then(() => console.log('Firmware is uploaded.'))
            .catch(console.error)
            .finally(() => {
                fileReader.close()
            });
    }
}

// execute section
const client = new Client({host: getHost(), port: 4000});
switch (chooseMode()) {
    case AppMode.DownloadImage:
        console.log('download image');
        client.downloadImage(DOWNLOAD_IMAGE_PATH);
        break;
    case AppMode.SendFirmware:
        console.log('send firmware');
        client.uploadFirmware(getFirmwareFilePath());
        break;
    default:
        throw('invalid arguments');
}

// process args functions

function chooseMode(): AppMode {
    const numOfArgs = process.argv.length - 2;
    if (numOfArgs === 1) {
        return AppMode.DownloadImage;
    } else if (numOfArgs === 2) {
        return AppMode.SendFirmware;
    } else {
        return AppMode.Error;
    }
}

function getFirmwareFilePath(): string {
    return process.argv[3];
}

function getHost(): string {
    return process.argv[2];
}
